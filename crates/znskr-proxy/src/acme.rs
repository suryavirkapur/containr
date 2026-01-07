//! acme certificate manager
//!
//! handles automatic ssl provisioning via let's encrypt.

use chrono::{DateTime, Duration, Utc};
use instant_acme::{
    Account, AuthorizationStatus, ChallengeType, Identifier, NewAccount, NewOrder, OrderStatus,
};
use rcgen::{CertificateParams, DistinguishedName, KeyPair};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use parking_lot::RwLock;
use tokio::fs;
use tracing::{error, info, warn};

use znskr_common::models::Certificate;
use znskr_common::Database;

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
        self.challenges.write().insert(token.to_string(), key_auth.to_string());
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
        if let Some(cert) = self.db.get_certificate(domain)? {
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
        let mut order = account
            .new_order(&NewOrder {
                identifiers: &identifiers,
            })
            .await?;

        // get authorizations
        let authorizations = order.authorizations().await?;

        for auth in &authorizations {
            if auth.status == AuthorizationStatus::Valid {
                continue;
            }

            // find http-01 challenge
            let challenge = auth
                .challenges
                .iter()
                .find(|c| c.r#type == ChallengeType::Http01)
                .ok_or_else(|| anyhow::anyhow!("http-01 challenge not found"))?;

            // store challenge response
            let key_auth = order.key_authorization(challenge);
            self.challenge_store.add(&challenge.token, key_auth.as_str());

            info!(
                domain = %domain,
                token = %challenge.token,
                "challenge ready - waiting for validation"
            );

            // tell acme to validate
            order.set_challenge_ready(&challenge.url).await?;
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

        // generate csr
        let key_pair = KeyPair::generate()?;
        let mut params = CertificateParams::default();
        params.distinguished_name = DistinguishedName::new();
        params.subject_alt_names = vec![rcgen::SanType::DnsName(domain.try_into()?)];

        let csr = params.serialize_request(&key_pair)?;
        let csr_der = csr.der();

        // finalize order
        order.finalize(csr_der).await?;

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
        let cert_chain = order.certificate().await?.ok_or_else(|| {
            anyhow::anyhow!("certificate not available")
        })?;

        // save certificate
        let cert = Certificate::new(
            domain.to_string(),
            cert_chain.clone(),
            key_pair.serialize_pem(),
            Utc::now() + Duration::days(90),
        );

        self.db.save_certificate(&cert)?;

        // also save to disk for pingora
        let cert_path = self.certs_dir.join(format!("{}.pem", domain));
        let key_path = self.certs_dir.join(format!("{}.key", domain));

        fs::create_dir_all(&self.certs_dir).await?;
        fs::write(&cert_path, &cert_chain).await?;
        fs::write(&key_path, key_pair.serialize_pem()).await?;

        // cleanup challenge
        for auth in &authorizations {
            for challenge in &auth.challenges {
                self.challenge_store.remove(&challenge.token);
            }
        }

        info!(domain = %domain, "certificate issued successfully");

        Ok(cert)
    }

    // gets or creates an acme account
    async fn get_or_create_account(&self) -> anyhow::Result<Account> {
        let server_url = if self.staging {
            instant_acme::LetsEncrypt::Staging.url()
        } else {
            instant_acme::LetsEncrypt::Production.url()
        };

        // check for existing account key
        let account_key_path = self.certs_dir.join("account.key");

        if account_key_path.exists() {
            // load existing account
            let key_pem = fs::read_to_string(&account_key_path).await?;
            // todo: implement account loading from key
            warn!("account reuse not fully implemented - creating new account");
        }

        // create new account
        let (account, _credentials) = Account::create(
            &NewAccount {
                contact: &[&format!("mailto:{}", self.email)],
                terms_of_service_agreed: true,
                only_return_existing: false,
            },
            server_url,
            None,
        )
        .await?;

        // save account key
        fs::create_dir_all(&self.certs_dir).await?;
        // todo: save credentials for reuse

        Ok(account)
    }

    // returns the challenge store for the proxy to serve challenges
    pub fn challenge_store(&self) -> ChallengeStore {
        self.challenge_store.clone()
    }
}
