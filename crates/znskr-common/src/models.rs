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
    /// shared environment variables for all services
    pub env_vars: Vec<EnvVar>,
    /// deprecated: use services instead. kept for backward compat
    #[serde(default = "default_port")]
    pub port: u16,
    /// container services for multi-container apps
    #[serde(default)]
    pub services: Vec<ContainerService>,
    pub owner_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn default_port() -> u16 {
    8080
}

impl App {
    /// creates a new app with default values
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
            services: Vec::new(),
            owner_id,
            created_at: now,
            updated_at: now,
        }
    }

    /// returns true if this app uses multi-container services
    pub fn has_services(&self) -> bool {
        !self.services.is_empty()
    }
}

/// environment variable for an app
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
    pub secret: bool,
}

/// restart policy for container services
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RestartPolicy {
    /// never restart
    Never,
    /// always restart
    #[default]
    Always,
    /// restart only on failure
    OnFailure,
}

/// health check configuration for a service
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthCheck {
    /// http path to check (e.g. "/health")
    pub path: String,
    /// interval between checks in seconds
    #[serde(default = "default_health_interval")]
    pub interval_secs: u32,
    /// timeout for each check in seconds
    #[serde(default = "default_health_timeout")]
    pub timeout_secs: u32,
    /// number of retries before marking unhealthy
    #[serde(default = "default_health_retries")]
    pub retries: u32,
}

fn default_health_interval() -> u32 {
    30
}

fn default_health_timeout() -> u32 {
    5
}

fn default_health_retries() -> u32 {
    3
}

impl Default for HealthCheck {
    fn default() -> Self {
        Self {
            path: "/health".to_string(),
            interval_secs: 30,
            timeout_secs: 5,
            retries: 3,
        }
    }
}

/// represents a container service within an app
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerService {
    pub id: Uuid,
    pub app_id: Uuid,
    /// service name (e.g. "web", "api", "db")
    pub name: String,
    /// docker image to use
    pub image: String,
    /// internal container port
    pub port: u16,
    /// number of replicas to run
    #[serde(default = "default_replicas")]
    pub replicas: u32,
    /// memory limit in bytes
    pub memory_limit: Option<u64>,
    /// cpu limit (1.0 = 1 core)
    pub cpu_limit: Option<f64>,
    /// service names this service depends on
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// health check configuration
    pub health_check: Option<HealthCheck>,
    /// restart policy
    #[serde(default)]
    pub restart_policy: RestartPolicy,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn default_replicas() -> u32 {
    1
}

impl ContainerService {
    /// creates a new container service with default values
    pub fn new(app_id: Uuid, name: String, image: String, port: u16) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            app_id,
            name,
            image,
            port,
            replicas: 1,
            memory_limit: None,
            cpu_limit: None,
            depends_on: Vec::new(),
            health_check: None,
            restart_policy: RestartPolicy::default(),
            created_at: now,
            updated_at: now,
        }
    }
}

/// health status of a service instance
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ServiceHealth {
    #[default]
    Unknown,
    Healthy,
    Unhealthy,
    Starting,
}

/// deployment status for a single service instance
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceDeployment {
    pub id: Uuid,
    pub service_id: Uuid,
    pub deployment_id: Uuid,
    /// replica index (0-based)
    pub replica_index: u32,
    pub status: DeploymentStatus,
    pub container_id: Option<String>,
    pub health: ServiceHealth,
    pub logs: Vec<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl ServiceDeployment {
    /// creates a new pending service deployment
    pub fn new(service_id: Uuid, deployment_id: Uuid, replica_index: u32) -> Self {
        Self {
            id: Uuid::new_v4(),
            service_id,
            deployment_id,
            replica_index,
            status: DeploymentStatus::Pending,
            container_id: None,
            health: ServiceHealth::Unknown,
            logs: Vec::new(),
            started_at: None,
            finished_at: None,
            created_at: Utc::now(),
        }
    }
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
    /// deprecated: use service_deployments for multi-container apps
    pub container_id: Option<String>,
    pub image_id: Option<String>,
    /// per-service deployment status for multi-container apps
    #[serde(default)]
    pub service_deployments: Vec<ServiceDeployment>,
    pub logs: Vec<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl Deployment {
    /// creates a new pending deployment
    pub fn new(app_id: Uuid, commit_sha: String) -> Self {
        Self {
            id: Uuid::new_v4(),
            app_id,
            commit_sha,
            commit_message: None,
            status: DeploymentStatus::Pending,
            container_id: None,
            image_id: None,
            service_deployments: Vec::new(),
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
    pub fn new(
        domain: String,
        cert_pem: String,
        key_pem: String,
        expires_at: DateTime<Utc>,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            domain,
            cert_pem,
            key_pem,
            expires_at,
            created_at: Utc::now(),
        }
    }

    /// Returns the status of this certificate
    pub fn status(&self) -> CertificateStatus {
        let now = Utc::now();
        if self.expires_at < now {
            CertificateStatus::Expired
        } else if self.expires_at < now + chrono::Duration::days(30) {
            CertificateStatus::ExpiringSoon
        } else {
            CertificateStatus::Valid
        }
    }
}

/// Status of a TLS certificate
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CertificateStatus {
    /// No certificate exists
    None,
    /// Certificate is being issued
    Pending,
    /// Certificate is valid
    Valid,
    /// Certificate expires within 30 days
    ExpiringSoon,
    /// Certificate has expired
    Expired,
    /// Certificate issuance failed
    Failed,
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
