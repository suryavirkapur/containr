//! github integration - webhooks and oauth

use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use tracing::warn;

use containr_common::{Error, Result};

// re-export from common
pub use containr_common::models::DeploymentJob;
use containr_common::models::GithubAppConfig;

const GITHUB_PAGE_SIZE: u32 = 100;

/// github push event payload
#[derive(Debug, Deserialize)]
pub struct PushEvent {
    #[serde(rename = "ref")]
    pub ref_: String,
    pub after: String,
    pub repository: Repository,
    pub head_commit: Option<Commit>,
}

#[derive(Debug, Deserialize)]
pub struct Repository {
    pub full_name: String,
    pub clone_url: String,
    pub html_url: String,
}

#[derive(Debug, Deserialize)]
pub struct Commit {
    pub message: String,
    pub id: String,
}

/// github oauth token response
#[derive(Debug, Deserialize)]
pub struct OAuthTokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub scope: String,
}

/// github user info
#[derive(Debug, Deserialize)]
pub struct GithubUser {
    pub id: i64,
    pub login: String,
    pub email: Option<String>,
}

/// verifies the github webhook signature
pub fn verify_webhook_signature(payload: &[u8], signature: &str, secret: &str) -> Result<bool> {
    let sig = signature
        .strip_prefix("sha256=")
        .ok_or_else(|| Error::Validation("invalid signature format".to_string()))?;

    let sig_bytes =
        hex::decode(sig).map_err(|e| Error::Validation(format!("invalid signature hex: {}", e)))?;

    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|e| Error::Internal(format!("hmac error: {}", e)))?;

    mac.update(payload);

    Ok(mac.verify_slice(&sig_bytes).is_ok())
}

/// extracts the branch name from a git ref
pub fn extract_branch(ref_: &str) -> Option<&str> {
    ref_.strip_prefix("refs/heads/")
}

/// exchanges an oauth code for an access token
pub async fn exchange_code_for_token(
    client_id: &str,
    client_secret: &str,
    code: &str,
) -> Result<OAuthTokenResponse> {
    let client = reqwest::Client::new();

    let response = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code),
        ])
        .send()
        .await
        .map_err(|e| Error::Github(format!("failed to exchange code: {}", e)))?;

    if !response.status().is_success() {
        return Err(Error::Github(format!(
            "github oauth failed: {}",
            response.status()
        )));
    }

    let token_response: OAuthTokenResponse = response
        .json()
        .await
        .map_err(|e| Error::Github(format!("failed to parse token response: {}", e)))?;

    Ok(token_response)
}

/// fetches the authenticated user's info from github
pub async fn get_github_user(access_token: &str) -> Result<GithubUser> {
    let client = reqwest::Client::new();

    let response = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", access_token))
        .header("User-Agent", "containr")
        .send()
        .await
        .map_err(|e| Error::Github(format!("failed to get user: {}", e)))?;

    if !response.status().is_success() {
        return Err(Error::Github(format!(
            "github api failed: {}",
            response.status()
        )));
    }

    let user: GithubUser = response
        .json()
        .await
        .map_err(|e| Error::Github(format!("failed to parse user: {}", e)))?;

    Ok(user)
}

/// github repository info
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
pub struct GithubRepo {
    pub id: i64,
    pub name: String,
    pub full_name: String,
    pub html_url: String,
    pub clone_url: String,
    pub private: bool,
    pub default_branch: String,
    pub description: Option<String>,
}

/// fetches the authenticated user's repositories from github
pub async fn get_user_repos(
    access_token: &str,
    visibility: Option<&str>,
) -> Result<Vec<GithubRepo>> {
    let client = reqwest::Client::new();

    let visibility = visibility.unwrap_or("all");
    let url = format!(
        "https://api.github.com/user/repos?visibility={}&sort=updated&per_page=100",
        visibility
    );

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("User-Agent", "containr")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| Error::Github(format!("failed to get repos: {}", e)))?;

    if !response.status().is_success() {
        return Err(Error::Github(format!(
            "github api failed: {}",
            response.status()
        )));
    }

    let repos: Vec<GithubRepo> = response
        .json()
        .await
        .map_err(|e| Error::Github(format!("failed to parse repos: {}", e)))?;

    Ok(repos)
}

// ============================================================================
// github app integration
// ============================================================================

use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::Serialize;

/// jwt claims for github app authentication
#[derive(Debug, Serialize)]
struct AppJwtClaims {
    /// issued at time
    iat: i64,
    /// expiration time (max 10 minutes)
    exp: i64,
    /// github app id (issuer)
    iss: String,
}

/// installation access token response
#[derive(Debug, Deserialize)]
pub struct InstallationTokenResponse {
    pub token: String,
    pub expires_at: String,
}

/// github app manifest response after app creation
#[derive(Debug, Deserialize)]
pub struct AppManifestResponse {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub client_id: String,
    pub client_secret: String,
    pub pem: String,
    pub webhook_secret: String,
    pub html_url: String,
}

/// github installation info
#[derive(Debug, Deserialize)]
pub struct InstallationInfo {
    pub id: i64,
    pub account: InstallationAccount,
    pub repository_selection: String,
    #[serde(default)]
    pub repositories_url: String,
}

/// installation account info
#[derive(Debug, Deserialize)]
pub struct InstallationAccount {
    pub login: String,
    #[serde(rename = "type")]
    pub account_type: String,
}

/// generates a jwt for github app authentication
pub fn generate_app_jwt(app_id: i64, private_key_pem: &str) -> Result<String> {
    let now = chrono::Utc::now().timestamp();
    let claims = AppJwtClaims {
        iat: now - 60,  // allow 60s clock drift
        exp: now + 600, // 10 min expiry (max allowed)
        iss: app_id.to_string(),
    };

    let key = EncodingKey::from_rsa_pem(private_key_pem.as_bytes())
        .map_err(|e| Error::Github(format!("invalid private key: {}", e)))?;

    let header = Header::new(Algorithm::RS256);

    encode(&header, &claims, &key)
        .map_err(|e| Error::Github(format!("failed to generate jwt: {}", e)))
}

/// exchanges a jwt for an installation access token
pub async fn get_installation_token(
    jwt: &str,
    installation_id: i64,
) -> Result<InstallationTokenResponse> {
    let client = reqwest::Client::new();

    let url = format!(
        "https://api.github.com/app/installations/{}/access_tokens",
        installation_id
    );

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", jwt))
        .header("User-Agent", "containr")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| Error::Github(format!("failed to get installation token: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(Error::Github(format!(
            "github api failed: {} - {}",
            status, body
        )));
    }

    let token: InstallationTokenResponse = response
        .json()
        .await
        .map_err(|e| Error::Github(format!("failed to parse token: {}", e)))?;

    Ok(token)
}

/// lists all installations for a github app
pub async fn list_app_installations(jwt: &str) -> Result<Vec<InstallationInfo>> {
    let client = reqwest::Client::new();
    let mut installations = Vec::new();
    let mut page = 1;

    loop {
        let url = format!(
            "https://api.github.com/app/installations?per_page={}&page={}",
            GITHUB_PAGE_SIZE, page
        );
        let response = client
            .get(url)
            .header("Authorization", format!("Bearer {}", jwt))
            .header("User-Agent", "containr")
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await
            .map_err(|e| Error::Github(format!("failed to list installations: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(Error::Github(format!(
                "github api failed: {} - {}",
                status, body
            )));
        }

        let mut page_installations: Vec<InstallationInfo> = response
            .json()
            .await
            .map_err(|e| Error::Github(format!("failed to parse installations: {}", e)))?;
        let page_len = page_installations.len();
        installations.append(&mut page_installations);

        if page_len < GITHUB_PAGE_SIZE as usize {
            break;
        }

        page += 1;
    }

    Ok(installations)
}

/// fetches repos accessible to an installation
pub async fn get_installation_repos(installation_token: &str) -> Result<Vec<GithubRepo>> {
    let client = reqwest::Client::new();
    let mut repositories = Vec::new();
    let mut page = 1;

    #[derive(Deserialize)]
    struct ReposResponse {
        repositories: Vec<GithubRepo>,
    }

    loop {
        let url = format!(
            "https://api.github.com/installation/repositories?per_page={}&page={}",
            GITHUB_PAGE_SIZE, page
        );
        let response = client
            .get(url)
            .header("Authorization", format!("Bearer {}", installation_token))
            .header("User-Agent", "containr")
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await
            .map_err(|e| Error::Github(format!("failed to get repos: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(Error::Github(format!(
                "github api failed: {} - {}",
                status, body
            )));
        }

        let data: ReposResponse = response
            .json()
            .await
            .map_err(|e| Error::Github(format!("failed to parse repos: {}", e)))?;
        let page_len = data.repositories.len();
        repositories.extend(data.repositories);

        if page_len < GITHUB_PAGE_SIZE as usize {
            break;
        }

        page += 1;
    }

    Ok(repositories)
}

/// converts a github app manifest code to app credentials
pub async fn convert_manifest_code(code: &str) -> Result<AppManifestResponse> {
    let client = reqwest::Client::new();

    let url = format!("https://api.github.com/app-manifests/{}/conversions", code);

    let response = client
        .post(&url)
        .header("User-Agent", "containr")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| Error::Github(format!("failed to convert manifest: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(Error::Github(format!(
            "github manifest conversion failed: {} - {}",
            status, body
        )));
    }

    let app: AppManifestResponse = response
        .json()
        .await
        .map_err(|e| Error::Github(format!("failed to parse app: {}", e)))?;

    Ok(app)
}

/// finds an installation token for a repo, if the app has access
pub async fn get_repo_installation_token(
    app_config: &GithubAppConfig,
    private_key_pem: &str,
    repo_url: &str,
) -> Result<Option<String>> {
    let normalized_repo = repo_url.trim_end_matches(".git");

    let jwt = generate_app_jwt(app_config.app_id, private_key_pem)?;

    let fresh_installation_ids: Vec<i64> = match list_app_installations(&jwt).await {
        Ok(installations) => installations
            .into_iter()
            .map(|installation| installation.id)
            .collect(),
        Err(error) => {
            warn!(error = %error, "failed to refresh github installations; using stored ids");
            app_config
                .installations
                .iter()
                .map(|installation| installation.id)
                .collect()
        }
    };

    for installation_id in fresh_installation_ids {
        let token_response = get_installation_token(&jwt, installation_id).await?;
        let repos = get_installation_repos(&token_response.token).await?;

        if repos.iter().any(|repo| {
            let clone_url = repo.clone_url.trim_end_matches(".git");
            let html_url = repo.html_url.trim_end_matches(".git");
            normalized_repo == clone_url || normalized_repo == html_url
        }) {
            return Ok(Some(token_response.token));
        }
    }

    Ok(None)
}
