//! github integration - webhooks and oauth

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

use znskr_common::{Error, Result};

/// deployment job sent to the queue
#[derive(Debug, Clone)]
pub struct DeploymentJob {
    pub app_id: Uuid,
    pub commit_sha: String,
    pub commit_message: Option<String>,
    pub github_url: String,
    pub branch: String,
}

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

    let sig_bytes = hex::decode(sig)
        .map_err(|e| Error::Validation(format!("invalid signature hex: {}", e)))?;

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
        .header("User-Agent", "znskr")
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
