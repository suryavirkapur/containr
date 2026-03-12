//! data models for containr

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// represents a deployed project
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: Uuid,
    pub name: String,
    pub github_url: String,
    pub branch: String,
    /// custom domains for the app
    #[serde(default)]
    pub domains: Vec<String>,
    /// deprecated: use domains instead
    pub domain: Option<String>,
    /// shared environment variables for all services
    pub env_vars: Vec<EnvVar>,
    /// whether github push webhooks should trigger deployments automatically
    #[serde(default = "default_true")]
    pub auto_deploy_enabled: bool,
    /// only deploy when changed files match these paths; empty means all paths
    #[serde(default)]
    pub auto_deploy_watch_paths: Vec<String>,
    /// stop stale queued or in-progress deployments before queueing a new auto-deploy
    #[serde(default = "default_true")]
    pub auto_deploy_cleanup_stale_deployments: bool,
    /// secret token used by the ci deploy webhook
    #[serde(default)]
    pub deploy_webhook_token: Option<String>,
    /// deprecated: use services instead. kept for backward compat
    #[serde(default = "default_port")]
    pub port: u16,
    /// container services for multi-container apps
    #[serde(default)]
    pub services: Vec<ContainerService>,
    /// rollout strategy used for deployments
    #[serde(default)]
    pub rollout_strategy: RolloutStrategy,
    pub owner_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn default_port() -> u16 {
    8080
}

fn default_true() -> bool {
    true
}

fn default_branch_name() -> String {
    "main".to_string()
}

fn new_deploy_webhook_token() -> String {
    Uuid::new_v4().simple().to_string()
}

pub type App = Project;

impl Project {
    /// creates a new project with default values
    pub fn new(name: String, github_url: String, owner_id: Uuid) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            name,
            github_url,
            branch: default_branch_name(),
            domains: Vec::new(),
            domain: None,
            env_vars: Vec::new(),
            auto_deploy_enabled: true,
            auto_deploy_watch_paths: Vec::new(),
            auto_deploy_cleanup_stale_deployments: true,
            deploy_webhook_token: Some(new_deploy_webhook_token()),
            port: 8080,
            services: Vec::new(),
            rollout_strategy: RolloutStrategy::default(),
            owner_id,
            created_at: now,
            updated_at: now,
        }
    }

    /// returns true if this project uses multi-container services
    pub fn has_services(&self) -> bool {
        !self.services.is_empty()
    }

    /// returns true when at least one service needs source checkout/build input
    pub fn requires_source_checkout(&self) -> bool {
        self.services
            .iter()
            .any(ContainerService::requires_source_checkout)
    }

    /// returns the deterministic service id used when promoting a legacy app
    pub fn default_service_id(&self) -> Uuid {
        let seed = format!("containr-default-service:{}", self.id);
        Uuid::new_v5(&Uuid::NAMESPACE_OID, seed.as_bytes())
    }

    /// ensures the project is represented with at least one service
    pub fn ensure_service_model(&mut self) {
        if !self.services.is_empty() {
            return;
        }

        self.services.push(ContainerService {
            id: self.default_service_id(),
            app_id: self.id,
            name: "web".to_string(),
            image: String::new(),
            service_type: ServiceType::WebService,
            port: self.port,
            expose_http: true,
            additional_ports: Vec::new(),
            replicas: 1,
            memory_limit: None,
            cpu_limit: None,
            depends_on: Vec::new(),
            health_check: None,
            restart_policy: RestartPolicy::default(),
            registry_auth: None,
            env_vars: Vec::new(),
            domains: Vec::new(),
            build_context: None,
            dockerfile_path: None,
            build_target: None,
            build_args: Vec::new(),
            command: None,
            entrypoint: None,
            working_dir: None,
            schedule: None,
            mounts: Vec::new(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        });
    }

    /// returns a copy of the project using the service deployment model
    pub fn normalized_for_service_model(&self) -> Self {
        let mut project = self.clone();
        project.normalize_legacy_domains_into_services();
        project
    }

    /// returns the legacy project-level custom domains
    pub fn legacy_custom_domains(&self) -> Vec<String> {
        let mut domains = self.domains.clone();
        if let Some(domain) = &self.domain {
            if !domains.iter().any(|d| d == domain) {
                domains.push(domain.clone());
            }
        }
        domains
    }

    /// returns the primary public service index
    pub fn primary_public_service_index(&self) -> Option<usize> {
        self.services
            .iter()
            .position(|service| {
                service.is_public_http() && service.name == "web"
            })
            .or_else(|| {
                self.services
                    .iter()
                    .position(|service| service.is_public_http())
            })
    }

    /// returns a mutable reference to the primary public service
    pub fn primary_public_service_mut(
        &mut self,
    ) -> Option<&mut ContainerService> {
        let index = self.primary_public_service_index()?;
        self.services.get_mut(index)
    }

    /// migrates legacy project-level domains onto the primary public service
    pub fn normalize_legacy_domains_into_services(&mut self) {
        self.ensure_service_model();

        let legacy_domains = self.legacy_custom_domains();
        if legacy_domains.is_empty() {
            return;
        }

        if let Some(service) = self.primary_public_service_mut() {
            for domain in legacy_domains {
                if !service.domains.iter().any(|existing| existing == &domain) {
                    service.domains.push(domain);
                }
            }
        }

        self.domain = None;
        self.domains.clear();
    }

    /// returns all custom domains configured across the project's web services
    pub fn custom_domains(&self) -> Vec<String> {
        let mut domains = self.legacy_custom_domains();
        for service in &self.services {
            for domain in &service.domains {
                if !domains.iter().any(|existing| existing == domain) {
                    domains.push(domain.clone());
                }
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

    /// returns the docker network name for this project group
    pub fn network_name(&self) -> String {
        format!("containr-{}", self.id)
    }

    /// ensures a deploy webhook token exists and returns it
    pub fn ensure_deploy_webhook_token(&mut self) -> &str {
        if self
            .deploy_webhook_token
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
        {
            self.deploy_webhook_token = Some(new_deploy_webhook_token());
        }

        self.deploy_webhook_token
            .as_deref()
            .expect("deploy webhook token must exist")
    }
}

/// environment variable for an app
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
    pub secret: bool,
}

/// docker build argument for a service image
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildArg {
    pub key: String,
    pub value: String,
    pub secret: bool,
}

/// restart policy for container services
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default,
)]
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

/// rollout strategy for replacing running containers
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default,
)]
#[serde(rename_all = "snake_case")]
pub enum RolloutStrategy {
    /// stop old containers before starting new containers
    #[default]
    StopFirst,
    /// start new containers before stopping old containers
    StartFirst,
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

/// persistent mount configuration for a service
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceMount {
    /// unique mount name within the service
    pub name: String,
    /// container path where the volume is mounted
    pub target: String,
    /// whether the mount is read-only inside the container
    #[serde(default)]
    pub read_only: bool,
}

/// container registry credentials for pulling a service image
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceRegistryAuth {
    /// optional registry server override
    pub server: Option<String>,
    pub username: String,
    /// plaintext password before save, encrypted at rest in persistence
    pub password: String,
}

/// render-style service category
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default,
)]
#[serde(rename_all = "snake_case")]
pub enum ServiceType {
    /// routed public http service
    WebService,
    /// internal-only network service
    #[default]
    PrivateService,
    /// worker with no expected inbound traffic
    BackgroundWorker,
    /// scheduled one-shot job
    CronJob,
    /// managed postgresql service
    Postgres,
    /// managed redis/valkey service
    Redis,
    /// managed mariadb service
    Mariadb,
    /// managed qdrant service
    Qdrant,
    /// managed rabbitmq service
    RabbitMq,
}

/// container service definition for multi-container apps
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerService {
    pub id: Uuid,
    pub app_id: Uuid,
    pub name: String,
    pub image: String,
    #[serde(default)]
    pub service_type: ServiceType,
    pub port: u16,
    #[serde(default)]
    pub expose_http: bool,
    #[serde(default)]
    pub additional_ports: Vec<u16>,
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
    #[serde(default)]
    pub registry_auth: Option<ServiceRegistryAuth>,
    #[serde(default)]
    pub env_vars: Vec<EnvVar>,
    #[serde(default)]
    pub domains: Vec<String>,
    #[serde(default)]
    pub build_context: Option<String>,
    #[serde(default)]
    pub dockerfile_path: Option<String>,
    #[serde(default)]
    pub build_target: Option<String>,
    #[serde(default)]
    pub build_args: Vec<BuildArg>,
    #[serde(default)]
    pub command: Option<Vec<String>>,
    #[serde(default)]
    pub entrypoint: Option<Vec<String>>,
    #[serde(default)]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub schedule: Option<String>,
    #[serde(default)]
    pub mounts: Vec<ServiceMount>,
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
            service_type: ServiceType::PrivateService,
            port,
            expose_http: false,
            additional_ports: Vec::new(),
            replicas: 1,
            memory_limit: None,
            cpu_limit: None,
            depends_on: Vec::new(),
            health_check: None,
            restart_policy: RestartPolicy::default(),
            registry_auth: None,
            env_vars: Vec::new(),
            domains: Vec::new(),
            build_context: None,
            dockerfile_path: None,
            build_target: None,
            build_args: Vec::new(),
            command: None,
            entrypoint: None,
            working_dir: None,
            schedule: None,
            mounts: Vec::new(),
            created_at: now,
            updated_at: now,
        }
    }

    /// returns the stable api name for a service type
    pub fn service_type_name(service_type: ServiceType) -> &'static str {
        match service_type {
            ServiceType::WebService => "web_service",
            ServiceType::PrivateService => "private_service",
            ServiceType::BackgroundWorker => "background_worker",
            ServiceType::CronJob => "cron_job",
            ServiceType::Postgres => "postgres",
            ServiceType::Redis => "redis",
            ServiceType::Mariadb => "mariadb",
            ServiceType::Qdrant => "qdrant",
            ServiceType::RabbitMq => "rabbitmq",
        }
    }

    /// returns true when the service expects an inbound port
    pub fn expects_inbound_port(&self) -> bool {
        !matches!(
            self.service_type,
            ServiceType::BackgroundWorker | ServiceType::CronJob
        )
    }

    /// returns true when the service should be routed publicly
    pub fn is_public_http(&self) -> bool {
        matches!(self.service_type, ServiceType::WebService)
    }

    /// returns true when the service is triggered on a schedule
    pub fn is_cron_job(&self) -> bool {
        matches!(self.service_type, ServiceType::CronJob)
    }

    /// returns true when the service requires source checkout to build an image
    pub fn requires_source_checkout(&self) -> bool {
        self.image.trim().is_empty()
    }

    /// returns the custom domains configured for this service
    pub fn custom_domains(&self) -> Vec<String> {
        let mut domains = Vec::new();
        for domain in &self.domains {
            if !domain.trim().is_empty()
                && !domains.iter().any(|existing| existing == domain)
            {
                domains.push(domain.clone());
            }
        }
        domains
    }

    /// infers a service type from legacy fields
    pub fn infer_service_type(expose_http: bool, port: u16) -> ServiceType {
        if expose_http {
            ServiceType::WebService
        } else if port == 0 {
            ServiceType::BackgroundWorker
        } else {
            ServiceType::PrivateService
        }
    }
}

/// health status of a service instance
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default,
)]
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
    #[serde(default)]
    pub image_id: Option<String>,
    pub health: ServiceHealth,
    pub logs: Vec<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl ServiceDeployment {
    /// creates a new pending service deployment
    pub fn new(
        service_id: Uuid,
        deployment_id: Uuid,
        replica_index: u32,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            service_id,
            deployment_id,
            replica_index,
            status: DeploymentStatus::Pending,
            container_id: None,
            image_id: None,
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
    #[serde(default = "default_branch_name")]
    pub branch: String,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub rollout_strategy: RolloutStrategy,
    #[serde(default)]
    pub rollback_from_deployment_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_snapshot: Option<App>,
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
            branch: default_branch_name(),
            source_url: None,
            rollout_strategy: RolloutStrategy::default(),
            rollback_from_deployment_id: None,
            app_snapshot: None,
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

/// request-level http access log for a public service
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpRequestLog {
    pub service_id: Uuid,
    pub app_id: Uuid,
    pub domain: String,
    pub method: String,
    pub path: String,
    pub status: u16,
    pub upstream: String,
    pub protocol: String,
    pub created_at: DateTime<Utc>,
}

impl HttpRequestLog {
    pub fn new(
        service_id: Uuid,
        app_id: Uuid,
        domain: String,
        method: String,
        path: String,
        status: u16,
        upstream: String,
        protocol: String,
    ) -> Self {
        Self {
            service_id,
            app_id,
            domain,
            method,
            path,
            status,
            upstream,
            protocol,
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
    #[serde(default)]
    pub is_admin: bool,
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
            is_admin: false,
            created_at: now,
            updated_at: now,
        }
    }

    // creates a new user via github oauth
    pub fn new_with_github(
        email: String,
        github_id: i64,
        github_username: String,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            email,
            password_hash: None,
            github_id: Some(github_id),
            github_username: Some(github_username),
            github_access_token: None,
            is_admin: false,
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

/// source material used to prepare a deployment workspace
#[derive(Debug, Clone)]
pub enum DeploymentSource {
    RemoteGit { url: String, token: Option<String> },
    LocalPath { path: String },
    None,
}

/// deployment job sent between api and worker
#[derive(Debug, Clone)]
pub struct DeploymentJob {
    pub deployment_id: Uuid,
    pub app_id: Uuid,
    pub commit_sha: String,
    pub commit_message: Option<String>,
    pub branch: String,
    pub source: DeploymentSource,
    pub rollout_strategy: RolloutStrategy,
    pub rollback_from_deployment_id: Option<Uuid>,
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
    pub fn new(
        app_id: i64,
        app_name: impl Into<String>,
        owner_id: Uuid,
    ) -> Self {
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
    /// use containr_common::models::GithubAppConfig;
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
        assert_eq!(app.rollout_strategy, RolloutStrategy::StopFirst);
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
    fn test_app_requires_source_checkout_for_built_services() {
        let owner_id = Uuid::new_v4();
        let mut app = App::new("test-app".to_string(), String::new(), owner_id);

        app.services.push(ContainerService::new(
            app.id,
            "web".to_string(),
            "nginx:stable".to_string(),
            80,
        ));
        assert!(!app.requires_source_checkout());

        app.services.push(ContainerService::new(
            app.id,
            "worker".to_string(),
            String::new(),
            0,
        ));
        assert!(app.requires_source_checkout());
    }

    #[test]
    fn test_app_ensure_service_model_promotes_legacy_app() {
        let owner_id = Uuid::new_v4();
        let mut app = App::new(
            "test-app".to_string(),
            "https://github.com/user/repo".to_string(),
            owner_id,
        );
        app.port = 9090;

        app.ensure_service_model();

        assert_eq!(app.services.len(), 1);
        assert_eq!(app.services[0].id, app.default_service_id());
        assert_eq!(app.services[0].name, "web");
        assert_eq!(app.services[0].port, 9090);
        assert!(app.services[0].expose_http);
        assert_eq!(app.services[0].replicas, 1);
        assert!(app.services[0].domains.is_empty());
    }

    #[test]
    fn test_app_normalized_for_service_model_moves_legacy_domains_to_web_service(
    ) {
        let owner_id = Uuid::new_v4();
        let mut app = App::new(
            "test-app".to_string(),
            "https://github.com/user/repo".to_string(),
            owner_id,
        );
        app.set_domains(vec![
            "demo.example.com".to_string(),
            "api.example.com".to_string(),
        ]);

        let normalized = app.normalized_for_service_model();

        assert!(normalized.domain.is_none());
        assert!(normalized.domains.is_empty());
        assert_eq!(
            normalized.services[0].domains,
            vec![
                "demo.example.com".to_string(),
                "api.example.com".to_string()
            ]
        );
        assert_eq!(
            normalized.custom_domains(),
            vec![
                "demo.example.com".to_string(),
                "api.example.com".to_string()
            ]
        );
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
        assert_eq!(app.rollout_strategy, RolloutStrategy::StopFirst);
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
        let service = ContainerService::new(
            app_id,
            "api".to_string(),
            "node:18".to_string(),
            3000,
        );

        assert_eq!(service.app_id, app_id);
        assert_eq!(service.name, "api");
        assert_eq!(service.image, "node:18");
        assert_eq!(service.port, 3000);
        assert!(!service.expose_http);
        assert!(service.additional_ports.is_empty());
        assert_eq!(service.replicas, 1);
        assert!(service.memory_limit.is_none());
        assert!(service.cpu_limit.is_none());
        assert!(service.depends_on.is_empty());
        assert!(service.health_check.is_none());
        assert_eq!(service.restart_policy, RestartPolicy::Always);
        assert!(service.registry_auth.is_none());
        assert!(service.domains.is_empty());
        assert!(service.command.is_none());
        assert!(service.entrypoint.is_none());
        assert!(service.working_dir.is_none());
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

        assert!(!service.expose_http);
        assert_eq!(service.replicas, 1);
        assert!(service.additional_ports.is_empty());
        assert!(service.memory_limit.is_none());
        assert!(service.cpu_limit.is_none());
        assert!(service.depends_on.is_empty());
        assert!(service.health_check.is_none());
        assert_eq!(service.restart_policy, RestartPolicy::Always);
        assert!(service.registry_auth.is_none());
        assert!(service.domains.is_empty());
        assert!(service.command.is_none());
        assert!(service.entrypoint.is_none());
        assert!(service.working_dir.is_none());
        assert!(service.schedule.is_none());
    }

    #[test]
    fn test_cron_service_does_not_expect_inbound_port() {
        let app_id = Uuid::new_v4();
        let mut service = ContainerService::new(
            app_id,
            "cleanup".to_string(),
            "alpine:3.22".to_string(),
            0,
        );
        service.service_type = ServiceType::CronJob;
        service.schedule = Some("*/5 * * * *".to_string());

        assert!(service.is_cron_job());
        assert!(!service.expects_inbound_port());
        assert!(!service.requires_source_checkout());
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
    fn test_rollout_strategy_serialization_strings() {
        let cases = [
            (RolloutStrategy::StopFirst, "stop_first"),
            (RolloutStrategy::StartFirst, "start_first"),
        ];

        for (strategy, expected) in cases {
            let encoded = serde_json::to_string(&strategy).unwrap();
            assert_eq!(encoded, format!("\"{}\"", expected));
        }
    }

    #[test]
    fn test_user_new_with_password() {
        let user = User::new_with_password(
            "test@example.com".to_string(),
            "password_hash".to_string(),
        );

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
        let config =
            GithubAppConfig::builder(12345, "minimal-app", owner_id).build();

        assert_eq!(config.app_id, 12345);
        assert_eq!(config.app_name, "minimal-app");
        assert!(config.client_id.is_empty());
        assert!(config.client_secret.is_empty());
        assert_eq!(config.owner_id, owner_id);
    }

    #[test]
    fn test_github_installation_new() {
        let installation = GithubInstallation::new(
            67890,
            "test-user".to_string(),
            "User".to_string(),
        );

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
