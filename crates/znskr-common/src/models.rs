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
    /// custom domains for the app
    #[serde(default)]
    pub domains: Vec<String>,
    /// deprecated: use domains instead
    pub domain: Option<String>,
    /// git deploy token (encrypted, optional)
    #[serde(default)]
    pub git_deploy_token: Option<String>,
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
            domains: Vec::new(),
            domain: None,
            git_deploy_token: None,
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

    /// returns all custom domains for this app
    pub fn custom_domains(&self) -> Vec<String> {
        let mut domains = self.domains.clone();
        if let Some(domain) = &self.domain {
            if !domains.iter().any(|d| d == domain) {
                domains.push(domain.clone());
            }
        }
        domains
    }

    /// sets the custom domains, updating legacy domain field
    pub fn set_domains(&mut self, mut domains: Vec<String>) {
        domains.retain(|d| !d.trim().is_empty());
        self.domain = domains.first().cloned();
        self.domains = domains;
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

/// container service definition for multi-container apps
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerService {
    pub id: Uuid,
    pub app_id: Uuid,
    pub name: String,
    pub image: String,
    pub port: u16,
    #[serde(default = "default_replicas")]
    pub replicas: u32,
    #[serde(default)]
    pub memory_limit: Option<u64>,
    #[serde(default)]
    pub cpu_limit: Option<f64>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub health_check: Option<HealthCheck>,
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
    /// deprecated: logs are now stored in a separate tree
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
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

/// certificate status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CertificateStatus {
    None,
    Pending,
    Valid,
    ExpiringSoon,
    Expired,
    Failed,
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
    pub github_token: Option<String>,
    pub repo_path: Option<String>,
}

/// github app configuration for coolify-style integration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubAppConfig {
    pub id: Uuid,
    /// github app id
    pub app_id: i64,
    /// github app name (slug)
    pub app_name: String,
    /// github app client id
    pub client_id: String,
    /// github app client secret (encrypted)
    pub client_secret: String,
    /// github app private key (encrypted, pem format)
    pub private_key: String,
    /// webhook secret for verifying github webhooks (encrypted)
    pub webhook_secret: String,
    /// html url to the app on github
    pub html_url: String,
    /// owner user id
    pub owner_id: Uuid,
    /// installations of this app
    #[serde(default)]
    pub installations: Vec<GithubInstallation>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// builder for github app config
pub struct GithubAppConfigBuilder {
    app_id: i64,
    app_name: String,
    client_id: String,
    client_secret: String,
    private_key: String,
    webhook_secret: String,
    html_url: String,
    owner_id: Uuid,
}

impl GithubAppConfigBuilder {
    /// creates a new builder with required fields
    pub fn new(app_id: i64, app_name: impl Into<String>, owner_id: Uuid) -> Self {
        Self {
            app_id,
            app_name: app_name.into(),
            client_id: String::new(),
            client_secret: String::new(),
            private_key: String::new(),
            webhook_secret: String::new(),
            html_url: String::new(),
            owner_id,
        }
    }

    /// sets the client id
    pub fn client_id(mut self, client_id: impl Into<String>) -> Self {
        self.client_id = client_id.into();
        self
    }

    /// sets the client secret
    pub fn client_secret(mut self, client_secret: impl Into<String>) -> Self {
        self.client_secret = client_secret.into();
        self
    }

    /// sets the private key
    pub fn private_key(mut self, private_key: impl Into<String>) -> Self {
        self.private_key = private_key.into();
        self
    }

    /// sets the webhook secret
    pub fn webhook_secret(mut self, webhook_secret: impl Into<String>) -> Self {
        self.webhook_secret = webhook_secret.into();
        self
    }

    /// sets the html url
    pub fn html_url(mut self, html_url: impl Into<String>) -> Self {
        self.html_url = html_url.into();
        self
    }

    /// builds the github app config
    pub fn build(self) -> GithubAppConfig {
        let now = Utc::now();
        GithubAppConfig {
            id: Uuid::new_v4(),
            app_id: self.app_id,
            app_name: self.app_name,
            client_id: self.client_id,
            client_secret: self.client_secret,
            private_key: self.private_key,
            webhook_secret: self.webhook_secret,
            html_url: self.html_url,
            owner_id: self.owner_id,
            installations: Vec::new(),
            created_at: now,
            updated_at: now,
        }
    }
}

impl GithubAppConfig {
    /// creates a new github app config using the builder pattern
    ///
    /// # example
    /// ```
    /// use uuid::Uuid;
    /// use znskr_common::models::GithubAppConfig;
    ///
    /// let config = GithubAppConfig::builder(
    ///     12345,
    ///     "my-app",
    ///     Uuid::new_v4()
    /// )
    /// .client_id("client123")
    /// .client_secret("secret123")
    /// .build();
    /// ```
    pub fn builder(
        app_id: i64,
        app_name: impl Into<String>,
        owner_id: Uuid,
    ) -> GithubAppConfigBuilder {
        GithubAppConfigBuilder::new(app_id, app_name, owner_id)
    }
}

/// github app installation on a user/org account
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubInstallation {
    /// github installation id
    pub id: i64,
    /// account login (username or org name)
    pub account_login: String,
    /// account type: "User" or "Organization"
    pub account_type: String,
    /// number of repos accessible
    pub repository_count: Option<i32>,
    pub created_at: DateTime<Utc>,
}

impl GithubInstallation {
    /// creates a new github installation
    pub fn new(id: i64, account_login: String, account_type: String) -> Self {
        Self {
            id,
            account_login,
            account_type,
            repository_count: None,
            created_at: Utc::now(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_app_new() {
        let owner_id = Uuid::new_v4();
        let app = App::new(
            "test-app".to_string(),
            "https://github.com/user/repo".to_string(),
            owner_id,
        );

        assert_eq!(app.name, "test-app");
        assert_eq!(app.github_url, "https://github.com/user/repo");
        assert_eq!(app.branch, "main");
        assert_eq!(app.owner_id, owner_id);
        assert!(app.env_vars.is_empty());
        assert!(app.services.is_empty());
        assert_eq!(app.port, 8080);
        assert!(app.domain.is_none());
        assert!(app.domains.is_empty());
        assert_eq!(app.created_at, app.updated_at);
    }

    #[test]
    fn test_app_has_services() {
        let owner_id = Uuid::new_v4();
        let mut app = App::new(
            "test-app".to_string(),
            "https://github.com/user/repo".to_string(),
            owner_id,
        );

        assert!(!app.has_services());

        app.services.push(ContainerService::new(
            app.id,
            "web".to_string(),
            "nginx:latest".to_string(),
            80,
        ));

        assert!(app.has_services());
    }

    #[test]
    fn test_app_deserialize_defaults() {
        let now = Utc::now();
        let value = json!({
            "id": Uuid::new_v4(),
            "name": "test-app",
            "github_url": "https://github.com/user/repo",
            "branch": "main",
            "env_vars": [],
            "owner_id": Uuid::new_v4(),
            "created_at": now,
            "updated_at": now
        });

        let app: App = serde_json::from_value(value).unwrap();

        assert_eq!(app.port, 8080);
        assert!(app.services.is_empty());
        assert!(app.domain.is_none());
        assert!(app.domains.is_empty());
    }

    #[test]
    fn test_health_check_deserialize_defaults() {
        let value = json!({
            "path": "/health"
        });

        let health_check: HealthCheck = serde_json::from_value(value).unwrap();

        assert_eq!(health_check.interval_secs, 30);
        assert_eq!(health_check.timeout_secs, 5);
        assert_eq!(health_check.retries, 3);
    }

    #[test]
    fn test_container_service_new() {
        let app_id = Uuid::new_v4();
        let service = ContainerService::new(app_id, "api".to_string(), "node:18".to_string(), 3000);

        assert_eq!(service.app_id, app_id);
        assert_eq!(service.name, "api");
        assert_eq!(service.image, "node:18");
        assert_eq!(service.port, 3000);
        assert_eq!(service.replicas, 1);
        assert!(service.memory_limit.is_none());
        assert!(service.cpu_limit.is_none());
        assert!(service.depends_on.is_empty());
        assert!(service.health_check.is_none());
        assert_eq!(service.restart_policy, RestartPolicy::Always);
        assert_eq!(service.created_at, service.updated_at);
    }

    #[test]
    fn test_container_service_deserialize_defaults() {
        let now = Utc::now();
        let value = json!({
            "id": Uuid::new_v4(),
            "app_id": Uuid::new_v4(),
            "name": "api",
            "image": "node:18",
            "port": 3000,
            "created_at": now,
            "updated_at": now
        });

        let service: ContainerService = serde_json::from_value(value).unwrap();

        assert_eq!(service.replicas, 1);
        assert!(service.memory_limit.is_none());
        assert!(service.cpu_limit.is_none());
        assert!(service.depends_on.is_empty());
        assert!(service.health_check.is_none());
        assert_eq!(service.restart_policy, RestartPolicy::Always);
    }

    #[test]
    fn test_service_deployment_new() {
        let service_id = Uuid::new_v4();
        let deployment_id = Uuid::new_v4();
        let sd = ServiceDeployment::new(service_id, deployment_id, 0);

        assert_eq!(sd.service_id, service_id);
        assert_eq!(sd.deployment_id, deployment_id);
        assert_eq!(sd.replica_index, 0);
        assert_eq!(sd.status, DeploymentStatus::Pending);
        assert_eq!(sd.health, ServiceHealth::Unknown);
        assert!(sd.container_id.is_none());
        assert!(sd.logs.is_empty());
    }

    #[test]
    fn test_deployment_new() {
        let app_id = Uuid::new_v4();
        let deployment = Deployment::new(app_id, "abc123".to_string());

        assert_eq!(deployment.app_id, app_id);
        assert_eq!(deployment.commit_sha, "abc123");
        assert!(deployment.commit_message.is_none());
        assert_eq!(deployment.status, DeploymentStatus::Pending);
        assert!(deployment.container_id.is_none());
        assert!(deployment.image_id.is_none());
        assert!(deployment.service_deployments.is_empty());
        assert!(deployment.logs.is_empty());
        assert!(deployment.started_at.is_none());
        assert!(deployment.finished_at.is_none());
    }

    #[test]
    fn test_deployment_status_serialization_strings() {
        let cases = [
            (DeploymentStatus::Pending, "pending"),
            (DeploymentStatus::Cloning, "cloning"),
            (DeploymentStatus::Building, "building"),
            (DeploymentStatus::Pushing, "pushing"),
            (DeploymentStatus::Starting, "starting"),
            (DeploymentStatus::Running, "running"),
            (DeploymentStatus::Failed, "failed"),
            (DeploymentStatus::Stopped, "stopped"),
        ];

        for (status, expected) in cases {
            let encoded = serde_json::to_string(&status).unwrap();
            assert_eq!(encoded, format!("\"{}\"", expected));
        }
    }

    #[test]
    fn test_user_new_with_password() {
        let user =
            User::new_with_password("test@example.com".to_string(), "password_hash".to_string());

        assert_eq!(user.email, "test@example.com");
        assert_eq!(user.password_hash, Some("password_hash".to_string()));
        assert!(user.github_id.is_none());
        assert!(user.github_username.is_none());
        assert!(user.github_access_token.is_none());
    }

    #[test]
    fn test_user_new_with_github() {
        let user = User::new_with_github(
            "test@example.com".to_string(),
            12345,
            "github-user".to_string(),
        );

        assert_eq!(user.email, "test@example.com");
        assert_eq!(user.github_id, Some(12345));
        assert_eq!(user.github_username, Some("github-user".to_string()));
        assert!(user.password_hash.is_none());
        assert!(user.github_access_token.is_none());
    }

    #[test]
    fn test_github_app_config_builder() {
        let owner_id = Uuid::new_v4();
        let config = GithubAppConfig::builder(12345, "my-app", owner_id)
            .client_id("client123")
            .client_secret("secret123")
            .private_key("private-key-data")
            .webhook_secret("webhook-secret")
            .html_url("https://github.com/apps/my-app")
            .build();

        assert_eq!(config.app_id, 12345);
        assert_eq!(config.app_name, "my-app");
        assert_eq!(config.client_id, "client123");
        assert_eq!(config.client_secret, "secret123");
        assert_eq!(config.private_key, "private-key-data");
        assert_eq!(config.webhook_secret, "webhook-secret");
        assert_eq!(config.html_url, "https://github.com/apps/my-app");
        assert_eq!(config.owner_id, owner_id);
        assert!(config.installations.is_empty());
    }

    #[test]
    fn test_github_app_config_builder_minimal() {
        let owner_id = Uuid::new_v4();
        let config = GithubAppConfig::builder(12345, "minimal-app", owner_id).build();

        assert_eq!(config.app_id, 12345);
        assert_eq!(config.app_name, "minimal-app");
        assert!(config.client_id.is_empty());
        assert!(config.client_secret.is_empty());
        assert_eq!(config.owner_id, owner_id);
    }

    #[test]
    fn test_github_installation_new() {
        let installation =
            GithubInstallation::new(67890, "test-user".to_string(), "User".to_string());

        assert_eq!(installation.id, 67890);
        assert_eq!(installation.account_login, "test-user");
        assert_eq!(installation.account_type, "User");
        assert!(installation.repository_count.is_none());
    }

    #[test]
    fn test_certificate_new() {
        let expires_at = Utc::now() + chrono::Duration::days(90);
        let cert = Certificate::new(
            "example.com".to_string(),
            "cert-data".to_string(),
            "key-data".to_string(),
            expires_at,
        );

        assert_eq!(cert.domain, "example.com");
        assert_eq!(cert.cert_pem, "cert-data");
        assert_eq!(cert.key_pem, "key-data");
        assert_eq!(cert.expires_at, expires_at);
    }

    #[test]
    fn test_certificate_status_valid() {
        let expires_at = Utc::now() + chrono::Duration::days(90);
        let cert = Certificate::new(
            "example.com".to_string(),
            "cert-data".to_string(),
            "key-data".to_string(),
            expires_at,
        );

        assert_eq!(cert.status(), CertificateStatus::Valid);
    }

    #[test]
    fn test_certificate_status_expiring_soon() {
        let expires_at = Utc::now() + chrono::Duration::days(15);
        let cert = Certificate::new(
            "example.com".to_string(),
            "cert-data".to_string(),
            "key-data".to_string(),
            expires_at,
        );

        assert_eq!(cert.status(), CertificateStatus::ExpiringSoon);
    }

    #[test]
    fn test_certificate_status_expired() {
        let expires_at = Utc::now() - chrono::Duration::days(1);
        let cert = Certificate::new(
            "example.com".to_string(),
            "cert-data".to_string(),
            "key-data".to_string(),
            expires_at,
        );

        assert_eq!(cert.status(), CertificateStatus::Expired);
    }

    #[test]
    fn test_service_health_serialization_strings() {
        let cases = [
            (ServiceHealth::Unknown, "unknown"),
            (ServiceHealth::Healthy, "healthy"),
            (ServiceHealth::Unhealthy, "unhealthy"),
            (ServiceHealth::Starting, "starting"),
        ];

        for (health, expected) in cases {
            let encoded = serde_json::to_string(&health).unwrap();
            assert_eq!(encoded, format!("\"{}\"", expected));
        }
    }
}
