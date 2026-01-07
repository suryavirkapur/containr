//! data models for znskr

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// represents a deployed application
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct App {
    pub id: Uuid,
    pub name: String,
    pub github_url: String,
    pub branch: String,
    pub domain: Option<String>,
    pub env_vars: Vec<EnvVar>,
    pub port: u16,
    pub owner_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl App {
    // creates a new app with default values
    pub fn new(name: String, github_url: String, owner_id: Uuid) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            name,
            github_url,
            branch: "main".to_string(),
            domain: None,
            env_vars: Vec::new(),
            port: 8080,
            owner_id,
            created_at: now,
            updated_at: now,
        }
    }
}

/// environment variable for an app
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
    pub secret: bool,
}

/// deployment status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeploymentStatus {
    Pending,
    Cloning,
    Building,
    Pushing,
    Starting,
    Running,
    Failed,
    Stopped,
}

/// represents a single deployment of an app
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Deployment {
    pub id: Uuid,
    pub app_id: Uuid,
    pub commit_sha: String,
    pub commit_message: Option<String>,
    pub status: DeploymentStatus,
    pub container_id: Option<String>,
    pub image_id: Option<String>,
    pub logs: Vec<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl Deployment {
    // creates a new pending deployment
    pub fn new(app_id: Uuid, commit_sha: String) -> Self {
        Self {
            id: Uuid::new_v4(),
            app_id,
            commit_sha,
            commit_message: None,
            status: DeploymentStatus::Pending,
            container_id: None,
            image_id: None,
            logs: Vec::new(),
            started_at: None,
            finished_at: None,
            created_at: Utc::now(),
        }
    }
}

/// user account
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub password_hash: Option<String>,
    pub github_id: Option<i64>,
    pub github_username: Option<String>,
    pub github_access_token: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl User {
    // creates a new user with email/password
    pub fn new_with_password(email: String, password_hash: String) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            email,
            password_hash: Some(password_hash),
            github_id: None,
            github_username: None,
            github_access_token: None,
            created_at: now,
            updated_at: now,
        }
    }

    // creates a new user via github oauth
    pub fn new_with_github(email: String, github_id: i64, github_username: String) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            email,
            password_hash: None,
            github_id: Some(github_id),
            github_username: Some(github_username),
            github_access_token: None,
            created_at: now,
            updated_at: now,
        }
    }
}

/// ssl certificate managed by acme
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Certificate {
    pub id: Uuid,
    pub domain: String,
    pub cert_pem: String,
    pub key_pem: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

impl Certificate {
    // creates a new certificate record
    pub fn new(domain: String, cert_pem: String, key_pem: String, expires_at: DateTime<Utc>) -> Self {
        Self {
            id: Uuid::new_v4(),
            domain,
            cert_pem,
            key_pem,
            expires_at,
            created_at: Utc::now(),
        }
    }
}

/// route configuration for the proxy
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Route {
    pub domain: String,
    pub upstream_host: String,
    pub upstream_port: u16,
    pub ssl_enabled: bool,
}

/// deployment job sent between api and worker
#[derive(Debug, Clone)]
pub struct DeploymentJob {
    pub app_id: Uuid,
    pub commit_sha: String,
    pub commit_message: Option<String>,
    pub github_url: String,
    pub branch: String,
}
