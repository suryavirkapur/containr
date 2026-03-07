//! acme certificate manager
//!
//! handles automatic ssl provisioning via let's encrypt.

use chrono::{Duration, Utc};
use instant_acme::{
    Account, AuthorizationStatus, ChallengeType, Identifier, KeyAuthorization, LetsEncrypt,
    NewAccount, NewOrder, OrderStatus,
};
use parking_lot::RwLock;
use pingora_core::tls::x509::X509;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;
use tracing::{info, warn};

use containr_common::models::Certificate;
use containr_common::Database;

/// acme challenge token store
#[derive(Clone)]
pub struct ChallengeStore {
    // maps token -> key_authorization
    challenges: Arc<RwLock<HashMap<String, String>>>,
}

impl ChallengeStore {
    // creates a new challenge store
    pub fn new() -> Self {
        Self {
            challenges: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    // adds a challenge
    pub fn add(&self, token: &str, key_auth: &str) {
        self.challenges
            .write()
            .insert(token.to_string(), key_auth.to_string());
    }

    // gets a challenge response
    pub fn get(&self, token: &str) -> Option<String> {
        self.challenges.read().get(token).cloned()
    }

    // removes a challenge
    pub fn remove(&self, token: &str) {
        self.challenges.write().remove(token);
    }
}

impl Default for ChallengeStore {
    fn default() -> Self {
        Self::new()
    }
}

/// acme certificate manager
pub struct AcmeManager {
    db: Database,
    certs_dir: PathBuf,
    email: String,
    staging: bool,
    challenge_store: ChallengeStore,
}

impl AcmeManager {
    // creates a new acme manager
    pub fn new(
        db: Database,
        certs_dir: PathBuf,
        email: String,
        staging: bool,
        challenge_store: ChallengeStore,
    ) -> Self {
        Self {
            db,
            certs_dir,
            email,
            staging,
            challenge_store,
        }
    }

    // ensures a certificate exists for a domain
    pub async fn ensure_certificate(&self, domain: &str) -> anyhow::Result<Certificate> {
        // check if we have a valid certificate
        if let Some(mut cert) = self.db.get_certificate(domain)? {
            if let Ok(expires_at) = parse_certificate_expiry(&cert.cert_pem) {
                if cert.expires_at != expires_at {
                    cert.expires_at = expires_at;
                    self.db.save_certificate(&cert)?;
                }
            }

            self.persist_certificate_files(&cert.domain, &cert.cert_pem, &cert.key_pem)
                .await?;

            // check expiry (renew if less than 30 days left)
            let renewal_threshold = Utc::now() + Duration::days(30);
            if cert.expires_at > renewal_threshold {
                info!(domain = %domain, "using existing certificate");
                return Ok(cert);
            }
            info!(domain = %domain, "certificate needs renewal");
        }

        // request new certificate
        self.request_certificate(domain).await
    }

    // requests a new certificate from let's encrypt
    async fn request_certificate(&self, domain: &str) -> anyhow::Result<Certificate> {
        info!(domain = %domain, staging = %self.staging, "requesting certificate");

        // create/load acme account
        let account = self.get_or_create_account().await?;

        // create order
        let identifiers = vec![Identifier::Dns(domain.to_string())];
        let mut order = account.new_order(&NewOrder::new(&identifiers)).await?;

        // collect challenge tokens for cleanup
        let mut challenge_tokens: Vec<String> = Vec::new();

        // get authorizations and process them
        let mut authorizations = order.authorizations();
        while let Some(result) = authorizations.next().await {
            let mut authz = result?;

            if authz.status == AuthorizationStatus::Valid {
                continue;
            }

            // find http-01 challenge
            let mut challenge = authz
                .challenge(ChallengeType::Http01)
                .ok_or_else(|| anyhow::anyhow!("http-01 challenge not found"))?;

            // store challenge response
            let key_auth: KeyAuthorization = challenge.key_authorization();
            let token = challenge.token.clone();
            self.challenge_store.add(&token, key_auth.as_str());
            challenge_tokens.push(token.clone());

            info!(
                domain = %domain,
                token = %token,
                "challenge ready - waiting for validation"
            );

            // tell acme to validate
            challenge.set_ready().await?;
        }

        // wait for order to be ready
        let mut attempts = 0;
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
            order.refresh().await?;

            match order.state().status {
                OrderStatus::Ready => break,
                OrderStatus::Invalid => {
                    return Err(anyhow::anyhow!("order became invalid"));
                }
                OrderStatus::Pending => {
                    attempts += 1;
                    if attempts > 30 {
                        return Err(anyhow::anyhow!("order validation timeout"));
                    }
                }
                _ => {}
            }
        }

        // generate csr and finalize - order.finalize() generates csr internally and returns pem key
        let private_key_pem = order.finalize().await?;

        // wait for certificate
        let mut attempts = 0;
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
            order.refresh().await?;

            match order.state().status {
                OrderStatus::Valid => break,
                OrderStatus::Invalid => {
                    return Err(anyhow::anyhow!("order became invalid"));
                }
                _ => {
                    attempts += 1;
                    if attempts > 30 {
                        return Err(anyhow::anyhow!("certificate issuance timeout"));
                    }
                }
            }
        }

        // download certificate
        let cert_chain = order
            .certificate()
            .await?
            .ok_or_else(|| anyhow::anyhow!("certificate not available"))?;

        let expires_at = match parse_certificate_expiry(&cert_chain) {
            Ok(expires_at) => expires_at,
            Err(error) => {
                warn!(
                    domain = %domain,
                    error = %error,
                    "failed to parse certificate expiry; using 90 day fallback"
                );
                Utc::now() + Duration::days(90)
            }
        };

        // save certificate
        let cert = Certificate::new(
            domain.to_string(),
            cert_chain.clone(),
            private_key_pem.clone(),
            expires_at,
        );

        self.db.save_certificate(&cert)?;

        // also save to disk for pingora
        self.persist_certificate_files(domain, &cert_chain, &private_key_pem)
            .await?;

        // cleanup challenges
        for token in challenge_tokens {
            self.challenge_store.remove(&token);
        }

        info!(domain = %domain, "certificate issued successfully");

        Ok(cert)
    }

    // writes certificate files to disk for pingora
    async fn persist_certificate_files(
        &self,
        domain: &str,
        cert_pem: &str,
        key_pem: &str,
    ) -> anyhow::Result<()> {
        let cert_path = self.certs_dir.join(format!("{}.pem", domain));
        let key_path = self.certs_dir.join(format!("{}.key", domain));

        fs::create_dir_all(&self.certs_dir).await?;
        fs::write(cert_path, cert_pem).await?;
        fs::write(key_path, key_pem).await?;

        Ok(())
    }

    // restores persisted certificates from the database onto disk
    pub async fn sync_stored_certificates_to_disk(&self) -> anyhow::Result<()> {
        let certs = self.db.list_certificates()?;
        for cert in certs {
            self.persist_certificate_files(&cert.domain, &cert.cert_pem, &cert.key_pem)
                .await?;
        }

        Ok(())
    }

    // gets or creates an acme account
    async fn get_or_create_account(&self) -> anyhow::Result<Account> {
        let server_url = if self.staging {
            LetsEncrypt::Staging.url().to_owned()
        } else {
            LetsEncrypt::Production.url().to_owned()
        };

        // path to persisted account credentials
        let account_creds_path = self.certs_dir.join("account.json");

        // try to load existing account from saved credentials
        if account_creds_path.exists() {
            match fs::read_to_string(&account_creds_path).await {
                Ok(json_str) => {
                    match serde_json::from_str::<instant_acme::AccountCredentials>(&json_str) {
                        Ok(credentials) => match Account::builder() {
                            Ok(builder) => match builder.from_credentials(credentials).await {
                                Ok(account) => {
                                    info!("restored acme account from saved credentials");
                                    return Ok(account);
                                }
                                Err(e) => {
                                    warn!(error = %e, "failed to restore account - creating new");
                                }
                            },
                            Err(e) => {
                                warn!(error = %e, "failed to create account builder - creating new");
                            }
                        },
                        Err(e) => {
                            warn!(error = %e, "failed to parse account credentials - creating new");
                        }
                    }
                }
                Err(e) => {
                    warn!(error = %e, "failed to read account credentials file - creating new");
                }
            }
        }

        // create new account
        let (account, credentials) = Account::builder()?
            .create(
                &NewAccount {
                    contact: &[&format!("mailto:{}", self.email)],
                    terms_of_service_agreed: true,
                    only_return_existing: false,
                },
                server_url,
                None,
            )
            .await?;

        // save account credentials for reuse
        fs::create_dir_all(&self.certs_dir).await?;
        let json_str = serde_json::to_string_pretty(&credentials)?;
        fs::write(&account_creds_path, &json_str).await?;
        info!("created and saved new acme account");

        Ok(account)
    }

    // returns the challenge store for the proxy to serve challenges
    pub fn challenge_store(&self) -> ChallengeStore {
        self.challenge_store.clone()
    }
}

fn parse_certificate_expiry(cert_chain: &str) -> anyhow::Result<chrono::DateTime<Utc>> {
    let mut certs = X509::stack_from_pem(cert_chain.as_bytes())?;
    let leaf = certs
        .drain(..)
        .next()
        .ok_or_else(|| anyhow::anyhow!("certificate chain is empty"))?;
    let not_after = leaf.not_after().to_string();
    let not_after = not_after
        .strip_suffix(" GMT")
        .ok_or_else(|| anyhow::anyhow!("unexpected certificate expiry format"))?;
    let expires_at = chrono::NaiveDateTime::parse_from_str(not_after, "%b %e %H:%M:%S %Y")?;
    let expires_at = chrono::DateTime::<Utc>::from_naive_utc_and_offset(expires_at, Utc);

    Ok(expires_at)
}
