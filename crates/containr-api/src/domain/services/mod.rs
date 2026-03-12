use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::net::IpAddr;
use std::path::{Component, Path as FsPath, PathBuf};
use std::str::FromStr;

use axum::{http::StatusCode, Json};
use chrono::Utc;
use croner::Cron;
use serde::{Deserialize, Serialize};
use tracing::warn;
use trust_dns_resolver::config::{ResolverConfig, ResolverOpts};
use trust_dns_resolver::proto::rr::RecordType;
use trust_dns_resolver::TokioAsyncResolver;
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::deployment_source::resolve_app_deployment_source;
use crate::github::DeploymentJob;
use crate::handlers::auth::ErrorResponse;
use crate::handlers::deployments::{
    can_rollback_to_deployment, create_and_queue_deployment,
    DeploymentResponse, DeploymentTriggerRequest, LogsQuery, RollbackRequest,
};
use crate::security::{encrypt_value, resolve_encryption_secret};
use crate::state::AppState;
use containr_common::managed_services::{
    DatabaseType, ManagedDatabase, ManagedQueue, QueueType, ServiceStatus,
};
use containr_common::models::{
    App, BuildArg, ContainerService, Deployment, DeploymentSource,
    DeploymentStatus, EnvVar, HealthCheck, HttpRequestLog, RestartPolicy,
    RolloutStrategy, ServiceDeployment, ServiceMount, ServiceRegistryAuth,
    ServiceType,
};
use containr_common::service_inventory::ServiceInventoryItem;
use containr_common::Config;
use containr_runtime::{
    AppServiceManager, DatabaseManager, DockerContainerManager,
    ProxyRouteUpdate, QueueManager,
};

pub type ApiResult<T> = Result<T, (StatusCode, Json<ErrorResponse>)>;

#[derive(Debug, Deserialize, IntoParams)]
pub struct ListServicesQuery {
    pub group_id: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct ServiceLogsQuery {
    #[serde(default = "default_tail")]
    pub tail: usize,
}

fn default_tail() -> usize {
    100
}

#[derive(Debug, Serialize, ToSchema)]
pub struct InventoryServiceResponse {
    pub id: String,
    pub group_id: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub resource_kind: String,
    pub service_type: String,
    pub name: String,
    pub image: Option<String>,
    pub status: String,
    pub network_name: String,
    pub internal_host: Option<String>,
    pub port: Option<u16>,
    pub external_port: Option<u16>,
    pub proxy_port: Option<u16>,
    pub proxy_external_port: Option<u16>,
    pub public_ip: Option<String>,
    pub connection_string: Option<String>,
    pub proxy_connection_string: Option<String>,
    pub domains: Vec<String>,
    pub default_urls: Vec<String>,
    pub schedule: Option<String>,
    pub public_http: bool,
    pub desired_instances: u32,
    pub running_instances: u32,
    pub deployment_id: Option<String>,
    pub container_ids: Vec<String>,
    pub pitr_enabled: bool,
    pub proxy_enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ServiceLogsResponse {
    pub logs: String,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct HttpRequestLogsQuery {
    #[serde(default = "default_tail")]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct EditableEnvVarResponse {
    pub key: String,
    pub value: String,
    pub secret: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct HealthCheckResponse {
    pub path: String,
    pub interval_secs: u32,
    pub timeout_secs: u32,
    pub retries: u32,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ServiceRegistryAuthResponse {
    pub server: Option<String>,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ServiceSettingsServiceResponse {
    pub name: String,
    pub image: Option<String>,
    pub service_type: String,
    pub port: u16,
    pub expose_http: bool,
    pub domains: Vec<String>,
    pub additional_ports: Vec<u16>,
    pub replicas: u32,
    pub memory_limit_mb: Option<u64>,
    pub cpu_limit: Option<f64>,
    pub depends_on: Vec<String>,
    pub health_check: Option<HealthCheckResponse>,
    pub restart_policy: String,
    pub registry_auth: Option<ServiceRegistryAuthResponse>,
    pub env_vars: Vec<EditableEnvVarResponse>,
    pub build_context: Option<String>,
    pub dockerfile_path: Option<String>,
    pub build_target: Option<String>,
    pub build_args: Vec<EditableEnvVarResponse>,
    pub command: Option<Vec<String>>,
    pub entrypoint: Option<Vec<String>>,
    pub working_dir: Option<String>,
    pub schedule: Option<String>,
    pub mounts: Vec<ServiceMountRequest>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AutoDeploySettingsResponse {
    pub enabled: bool,
    pub watch_paths: Vec<String>,
    pub cleanup_stale_deployments: bool,
    pub webhook_path: String,
    pub webhook_token: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ServiceSettingsResponse {
    pub service_id: String,
    pub resource_kind: String,
    pub github_url: String,
    pub branch: String,
    pub env_vars: Vec<EditableEnvVarResponse>,
    pub rollout_strategy: String,
    pub auto_deploy: AutoDeploySettingsResponse,
    pub service: ServiceSettingsServiceResponse,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct AutoDeploySettingsRequest {
    pub enabled: Option<bool>,
    pub watch_paths: Option<Vec<String>>,
    pub cleanup_stale_deployments: Option<bool>,
    pub regenerate_webhook_token: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateServiceRequest {
    pub github_url: Option<String>,
    pub branch: Option<String>,
    pub env_vars: Option<Vec<EnvVarRequest>>,
    pub rollout_strategy: Option<String>,
    pub auto_deploy: Option<AutoDeploySettingsRequest>,
    pub service: Option<ServiceRequest>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct HttpRequestLogResponse {
    pub domain: String,
    pub method: String,
    pub path: String,
    pub status: u16,
    pub upstream: String,
    pub protocol: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct EnvVarRequest {
    pub key: String,
    pub value: String,
    pub secret: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct HealthCheckRequest {
    pub path: String,
    pub interval_secs: Option<u32>,
    pub timeout_secs: Option<u32>,
    pub retries: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct ServiceMountRequest {
    pub name: String,
    pub target: String,
    pub read_only: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ServiceRegistryAuthRequest {
    pub server: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ServiceRequest {
    pub name: String,
    pub image: Option<String>,
    pub service_type: Option<String>,
    pub port: u16,
    pub expose_http: Option<bool>,
    pub domains: Option<Vec<String>>,
    pub domain: Option<String>,
    pub additional_ports: Option<Vec<u16>>,
    pub replicas: Option<u32>,
    pub memory_limit_mb: Option<u64>,
    pub cpu_limit: Option<f64>,
    pub depends_on: Option<Vec<String>>,
    pub health_check: Option<HealthCheckRequest>,
    pub restart_policy: Option<String>,
    pub registry_auth: Option<ServiceRegistryAuthRequest>,
    pub env_vars: Option<Vec<EnvVarRequest>>,
    pub build_context: Option<String>,
    pub dockerfile_path: Option<String>,
    pub build_target: Option<String>,
    pub build_args: Option<Vec<EnvVarRequest>>,
    pub command: Option<Vec<String>>,
    pub entrypoint: Option<Vec<String>>,
    pub working_dir: Option<String>,
    pub schedule: Option<String>,
    pub mounts: Option<Vec<ServiceMountRequest>>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum CreateServiceRequest {
    GitRepository {
        name: String,
        github_url: String,
        branch: Option<String>,
        env_vars: Option<Vec<EnvVarRequest>>,
        service: ServiceRequest,
        rollout_strategy: Option<String>,
    },
    Template {
        name: String,
        template: String,
        version: Option<String>,
        memory_limit_mb: Option<u64>,
        cpu_limit: Option<f64>,
        group_id: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
}

impl ServiceAction {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "start" => Some(Self::Start),
            "stop" => Some(Self::Stop),
            "restart" => Some(Self::Restart),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TemplateKind {
    Postgresql,
    Redis,
    Mariadb,
    Qdrant,
    Rabbitmq,
}

impl TemplateKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "postgres" | "postgresql" => Some(Self::Postgresql),
            "redis" | "valkey" => Some(Self::Redis),
            "mariadb" | "mysql" => Some(Self::Mariadb),
            "qdrant" => Some(Self::Qdrant),
            "rabbitmq" => Some(Self::Rabbitmq),
            _ => None,
        }
    }

    fn api_name(self) -> &'static str {
        match self {
            Self::Postgresql => "postgresql",
            Self::Redis => "redis",
            Self::Mariadb => "mariadb",
            Self::Qdrant => "qdrant",
            Self::Rabbitmq => "rabbitmq",
        }
    }

    fn is_queue(self) -> bool {
        matches!(self, Self::Rabbitmq)
    }
}

enum OwnedServiceRecord {
    App { app: App, service: ContainerService },
    ManagedDatabase(ManagedDatabase),
    ManagedQueue(ManagedQueue),
}

pub fn supported_template_message() -> &'static str {
    "invalid template. supported: postgresql, redis, mariadb, qdrant, rabbitmq"
}

impl InventoryServiceResponse {
    fn from_inventory(
        service: &ServiceInventoryItem,
        base_domain: &str,
        public_ip: Option<&str>,
    ) -> Self {
        Self {
            id: service.id.to_string(),
            group_id: service.group_id.map(|value| value.to_string()),
            project_id: service.project_id.map(|value| value.to_string()),
            project_name: service.project_name.clone(),
            resource_kind: service.resource_kind.as_str().to_string(),
            service_type: service.service_type_name().to_string(),
            name: service.name.clone(),
            image: service.image.clone(),
            status: service.status.as_str().to_string(),
            network_name: service.network_name.clone(),
            internal_host: service.internal_host.clone(),
            port: service.port,
            external_port: service.external_port,
            proxy_port: service.proxy_port,
            proxy_external_port: service.proxy_external_port,
            public_ip: normalize_public_ip(public_ip),
            connection_string: service.connection_string.clone(),
            proxy_connection_string: service.proxy_connection_string.clone(),
            domains: service.domains.clone(),
            default_urls: build_default_urls(service, base_domain),
            schedule: service.schedule.clone(),
            public_http: service.public_http,
            desired_instances: service.desired_instances,
            running_instances: service.running_instances,
            deployment_id: service.deployment_id.map(|value| value.to_string()),
            container_ids: service.container_ids.clone(),
            pitr_enabled: service.pitr_enabled,
            proxy_enabled: service.proxy_enabled,
            created_at: service.created_at.to_rfc3339(),
            updated_at: service.updated_at.to_rfc3339(),
        }
    }
}

impl From<&HttpRequestLog> for HttpRequestLogResponse {
    fn from(log: &HttpRequestLog) -> Self {
        Self {
            domain: log.domain.clone(),
            method: log.method.clone(),
            path: log.path.clone(),
            status: log.status,
            upstream: log.upstream.clone(),
            protocol: log.protocol.clone(),
            created_at: log.created_at.to_rfc3339(),
        }
    }
}

#[derive(Clone)]
pub struct ServiceSvc {
    state: AppState,
}

impl ServiceSvc {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }

    pub async fn create_service(
        &self,
        user_id: Uuid,
        req: CreateServiceRequest,
    ) -> ApiResult<InventoryServiceResponse> {
        let config = self.state.config.read().await.clone();
        let service_id = match req {
            CreateServiceRequest::GitRepository {
                name,
                github_url,
                branch,
                env_vars,
                service,
                rollout_strategy,
            } => {
                self.create_repository_service(
                    &config,
                    user_id,
                    name,
                    github_url,
                    branch,
                    env_vars,
                    service,
                    rollout_strategy,
                )
                .await?
            }
            CreateServiceRequest::Template {
                name,
                template,
                version,
                memory_limit_mb,
                cpu_limit,
                group_id,
            } => {
                self.create_template_service(
                    &config,
                    user_id,
                    name,
                    template,
                    version,
                    memory_limit_mb,
                    cpu_limit,
                    group_id,
                )
                .await?
            }
        };

        self.service_response(
            user_id,
            service_id,
            &config.proxy.base_domain,
            config.proxy.public_ip.as_deref(),
        )
    }

    pub async fn list_services(
        &self,
        user_id: Uuid,
        query: ListServicesQuery,
    ) -> ApiResult<Vec<InventoryServiceResponse>> {
        let config = self.state.config.read().await.clone();
        let group_id =
            resolve_group_id(&self.state, user_id, query.group_id.as_deref())?;
        let inventory = self
            .state
            .db
            .list_service_inventory_by_owner_and_group(user_id, group_id)
            .map_err(internal_error)?;

        Ok(inventory
            .iter()
            .map(|service| {
                InventoryServiceResponse::from_inventory(
                    service,
                    &config.proxy.base_domain,
                    config.proxy.public_ip.as_deref(),
                )
            })
            .collect())
    }

    pub async fn get_service(
        &self,
        user_id: Uuid,
        service_id: Uuid,
    ) -> ApiResult<InventoryServiceResponse> {
        let config = self.state.config.read().await.clone();
        self.service_response(
            user_id,
            service_id,
            &config.proxy.base_domain,
            config.proxy.public_ip.as_deref(),
        )
    }

    pub async fn get_service_settings(
        &self,
        user_id: Uuid,
        service_id: Uuid,
    ) -> ApiResult<ServiceSettingsResponse> {
        let (mut app, service) =
            resolve_owned_app_service_record(&self.state, user_id, service_id)?;
        let webhook_token_missing = app
            .deploy_webhook_token
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .is_empty();
        let webhook_token = app.ensure_deploy_webhook_token().to_string();
        if webhook_token_missing {
            self.state.db.save_app(&app).map_err(internal_error)?;
        }

        Ok(ServiceSettingsResponse {
            service_id: service.id.to_string(),
            resource_kind: "app_service".to_string(),
            github_url: app.github_url.clone(),
            branch: app.branch.clone(),
            env_vars: app
                .env_vars
                .iter()
                .map(masked_env_var_response)
                .collect(),
            rollout_strategy: rollout_strategy_label(app.rollout_strategy)
                .to_string(),
            auto_deploy: AutoDeploySettingsResponse {
                enabled: app.auto_deploy_enabled,
                watch_paths: app.auto_deploy_watch_paths.clone(),
                cleanup_stale_deployments: app
                    .auto_deploy_cleanup_stale_deployments,
                webhook_path: format!(
                    "/webhooks/deploy/{}?token={}",
                    service.id, webhook_token
                ),
                webhook_token,
            },
            service: service_settings_service_response(&service),
        })
    }

    pub async fn update_service(
        &self,
        user_id: Uuid,
        service_id: Uuid,
        req: UpdateServiceRequest,
    ) -> ApiResult<InventoryServiceResponse> {
        let config = self.state.config.read().await.clone();
        let (mut app, service) =
            resolve_owned_app_service_record(&self.state, user_id, service_id)?;

        if let Some(github_url) = req.github_url {
            app.github_url = github_url.trim().to_string();
        }

        if let Some(branch) = req.branch {
            let branch = branch.trim();
            if branch.is_empty() {
                return Err(bad_request("branch cannot be empty"));
            }
            app.branch = branch.to_string();
        }

        if let Some(env_vars) = req.env_vars {
            app.env_vars = build_app_env_vars(Some(env_vars), &app.env_vars)?;
        }

        app.rollout_strategy = resolve_rollout_strategy(
            req.rollout_strategy.as_deref(),
            app.rollout_strategy,
        )?;

        if let Some(auto_deploy) = req.auto_deploy {
            if let Some(enabled) = auto_deploy.enabled {
                app.auto_deploy_enabled = enabled;
            }
            if let Some(watch_paths) = auto_deploy.watch_paths {
                app.auto_deploy_watch_paths =
                    normalize_watch_paths(watch_paths)?;
            }
            if let Some(cleanup_stale_deployments) =
                auto_deploy.cleanup_stale_deployments
            {
                app.auto_deploy_cleanup_stale_deployments =
                    cleanup_stale_deployments;
            }
            if auto_deploy.regenerate_webhook_token == Some(true) {
                app.deploy_webhook_token = None;
                let _ = app.ensure_deploy_webhook_token();
            }
        }

        if let Some(updated_service_request) = req.service {
            let service_requests = app
                .services
                .iter()
                .map(|existing_service| {
                    if existing_service.id == service_id {
                        updated_service_request.clone()
                    } else {
                        service_request_from_model(existing_service)
                    }
                })
                .collect::<Vec<_>>();
            app.services = build_services(
                &config,
                app.id,
                &app.services,
                service_requests,
            )?;
        }

        app.ensure_service_model();

        if app.requires_source_checkout() && app.github_url.trim().is_empty() {
            return Err(bad_request(
                "github_url is required when a service needs a source build",
            ));
        }

        validate_app_service_domains(&self.state, &config, &app).await?;
        app.updated_at = Utc::now();
        self.state.db.save_app(&app).map_err(internal_error)?;

        self.service_response(
            user_id,
            service.id,
            &config.proxy.base_domain,
            config.proxy.public_ip.as_deref(),
        )
    }

    pub async fn get_service_logs(
        &self,
        user_id: Uuid,
        service_id: Uuid,
        tail: usize,
    ) -> ApiResult<ServiceLogsResponse> {
        let config = self.state.config.read().await.clone();
        let logs = match resolve_owned_service_record(
            &self.state,
            user_id,
            service_id,
        )? {
            OwnedServiceRecord::App { app, service } => {
                get_app_service_logs(
                    &self.state,
                    &app,
                    &service,
                    tail,
                    resolve_encryption_secret(&config),
                )
                .await?
            }
            OwnedServiceRecord::ManagedDatabase(database) => {
                DatabaseManager::new()
                    .get_logs(&database, tail)
                    .await
                    .map_err(|error| {
                        service_manager_error("read service logs", error)
                    })?
            }
            OwnedServiceRecord::ManagedQueue(queue) => {
                let Some(container_id) = queue.container_id.as_deref() else {
                    return Ok(ServiceLogsResponse {
                        logs: String::new(),
                    });
                };
                DockerContainerManager::new()
                    .get_logs(container_id, tail)
                    .await
                    .map_err(|error| {
                        service_manager_error("read service logs", error)
                    })?
            }
        };

        Ok(ServiceLogsResponse { logs })
    }

    pub fn list_http_request_logs(
        &self,
        user_id: Uuid,
        service_id: Uuid,
        limit: usize,
        offset: usize,
    ) -> ApiResult<Vec<HttpRequestLogResponse>> {
        let (_, service) =
            resolve_owned_app_service_record(&self.state, user_id, service_id)?;
        if !service.is_public_http() {
            return Err(bad_request(
                "http request logs are only available for public web services",
            ));
        }

        let logs = self
            .state
            .db
            .list_http_request_logs(service_id, limit, offset)
            .map_err(internal_error)?;
        Ok(logs.iter().map(HttpRequestLogResponse::from).collect())
    }

    pub async fn run_action(
        &self,
        user_id: Uuid,
        service_id: Uuid,
        action: ServiceAction,
    ) -> ApiResult<InventoryServiceResponse> {
        let config = self.state.config.read().await.clone();

        match resolve_owned_service_record(&self.state, user_id, service_id)? {
            OwnedServiceRecord::App { app, service } => match action {
                ServiceAction::Start => {
                    start_app_service(
                        &self.state,
                        &app,
                        &service,
                        resolve_encryption_secret(&config),
                    )
                    .await?;
                }
                ServiceAction::Stop => {
                    stop_app_service(
                        &self.state,
                        &app,
                        &service,
                        resolve_encryption_secret(&config),
                    )
                    .await?;
                }
                ServiceAction::Restart => {
                    if service.is_cron_job() {
                        return Err(bad_request(
                            "cron jobs are scheduled and cannot be restarted manually",
                        ));
                    }
                    stop_app_service(
                        &self.state,
                        &app,
                        &service,
                        resolve_encryption_secret(&config),
                    )
                    .await?;
                    start_app_service(
                        &self.state,
                        &app,
                        &service,
                        resolve_encryption_secret(&config),
                    )
                    .await?;
                }
            },
            OwnedServiceRecord::ManagedDatabase(mut database) => {
                run_database_action(&self.state, action, &mut database).await?;
            }
            OwnedServiceRecord::ManagedQueue(mut queue) => {
                run_queue_action(&self.state, action, &mut queue).await?;
            }
        }

        self.service_response(
            user_id,
            service_id,
            &config.proxy.base_domain,
            config.proxy.public_ip.as_deref(),
        )
    }

    pub async fn delete_service(
        &self,
        user_id: Uuid,
        service_id: Uuid,
    ) -> ApiResult<()> {
        let config = self.state.config.read().await.clone();

        match resolve_owned_service_record(&self.state, user_id, service_id)? {
            OwnedServiceRecord::App { app, service } => {
                delete_app_service(
                    &self.state,
                    &config,
                    &app,
                    &service,
                    resolve_encryption_secret(&config),
                )
                .await?;
            }
            OwnedServiceRecord::ManagedDatabase(mut database) => {
                let _ =
                    DatabaseManager::new().stop_database(&mut database).await;
                let database_root = database.root_path();
                if database_root.starts_with(&config.storage.data_dir) {
                    let _ = tokio::fs::remove_dir_all(&database_root).await;
                }
                self.state
                    .db
                    .delete_managed_database(database.id)
                    .map_err(internal_error)?;
            }
            OwnedServiceRecord::ManagedQueue(mut queue) => {
                let _ = QueueManager::new().stop_queue(&mut queue).await;
                let queue_root = queue.root_path();
                if queue_root.starts_with(&config.storage.data_dir) {
                    let _ = tokio::fs::remove_dir_all(&queue_root).await;
                }
                self.state
                    .db
                    .delete_managed_queue(queue.id)
                    .map_err(internal_error)?;
            }
        }

        Ok(())
    }

    pub fn list_service_deployments(
        &self,
        user_id: Uuid,
        service_id: Uuid,
    ) -> ApiResult<Vec<DeploymentResponse>> {
        let (app, service) =
            resolve_owned_app_service_record(&self.state, user_id, service_id)?;
        let deployments = sort_deployments_desc(
            self.state
                .db
                .list_deployments_by_app(app.id)
                .map_err(internal_error)?,
        );

        Ok(deployments
            .iter()
            .filter(|deployment| {
                deployment_has_service_image(deployment, &service)
            })
            .map(DeploymentResponse::from)
            .collect())
    }

    pub fn resolve_owned_app_service(
        &self,
        user_id: Uuid,
        service_id: Uuid,
    ) -> ApiResult<(App, ContainerService)> {
        resolve_owned_app_service_record(&self.state, user_id, service_id)
    }

    pub fn get_service_deployment(
        &self,
        user_id: Uuid,
        service_id: Uuid,
        deployment_id: Uuid,
    ) -> ApiResult<DeploymentResponse> {
        let (app, service) =
            resolve_owned_app_service_record(&self.state, user_id, service_id)?;
        let deployment = self
            .state
            .db
            .get_deployment(deployment_id)
            .map_err(internal_error)?
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: "deployment not found".to_string(),
                    }),
                )
            })?;

        if deployment.app_id != app.id
            || !deployment_has_service_image(&deployment, &service)
        {
            return Err((
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "deployment not found".to_string(),
                }),
            ));
        }

        Ok(DeploymentResponse::from(&deployment))
    }

    pub async fn trigger_service_deployment(
        &self,
        user_id: Uuid,
        service_id: Uuid,
        body: Option<DeploymentTriggerRequest>,
    ) -> ApiResult<DeploymentResponse> {
        let (app, _) =
            resolve_owned_app_service_record(&self.state, user_id, service_id)?;
        let trigger = body;
        let commit_sha = trigger
            .as_ref()
            .and_then(|value| value.commit_sha.clone())
            .unwrap_or_else(|| "manual".to_string());
        let commit_message = trigger
            .as_ref()
            .and_then(|value| value.commit_message.clone())
            .or_else(|| Some("manual deployment".to_string()));
        let rollout_strategy = resolve_rollout_strategy(
            trigger
                .as_ref()
                .and_then(|value| value.rollout_strategy.as_deref()),
            app.rollout_strategy,
        )?;
        let branch = trigger
            .as_ref()
            .and_then(|value| value.branch.clone())
            .unwrap_or_else(|| app.branch.clone());

        let deployment = create_and_queue_deployment(
            &self.state,
            user_id,
            &app,
            commit_sha,
            commit_message,
            branch,
            rollout_strategy,
            None,
            None,
            false,
        )
        .await?;

        Ok(DeploymentResponse::from(&deployment))
    }

    pub async fn rollback_service_deployment(
        &self,
        user_id: Uuid,
        service_id: Uuid,
        target_deployment_id: Uuid,
        body: Option<RollbackRequest>,
    ) -> ApiResult<DeploymentResponse> {
        let (app, service) =
            resolve_owned_app_service_record(&self.state, user_id, service_id)?;
        let target = self
            .state
            .db
            .get_deployment(target_deployment_id)
            .map_err(internal_error)?
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: "deployment not found".to_string(),
                    }),
                )
            })?;

        if target.app_id != app.id
            || !deployment_has_service_image(&target, &service)
        {
            return Err((
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "deployment not found".to_string(),
                }),
            ));
        }

        if !can_rollback_to_deployment(&app, &target) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error:
                        "target deployment cannot be rolled back (missing image artifact)"
                            .to_string(),
                }),
            ));
        }

        let req = body;
        let rollout_strategy = resolve_rollout_strategy(
            req.as_ref()
                .and_then(|value| value.rollout_strategy.as_deref()),
            app.rollout_strategy,
        )?;
        let deployment = create_and_queue_deployment(
            &self.state,
            user_id,
            &app,
            target.commit_sha.clone(),
            Some(format!("rollback to deployment {}", target_deployment_id)),
            app.branch.clone(),
            rollout_strategy,
            Some(target_deployment_id),
            None,
            false,
        )
        .await?;

        Ok(DeploymentResponse::from(&deployment))
    }

    pub fn get_service_deployment_logs(
        &self,
        user_id: Uuid,
        service_id: Uuid,
        deployment_id: Uuid,
        query: LogsQuery,
    ) -> ApiResult<Vec<String>> {
        let (app, service) =
            resolve_owned_app_service_record(&self.state, user_id, service_id)?;
        let deployment = self
            .state
            .db
            .get_deployment(deployment_id)
            .map_err(internal_error)?
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: "deployment not found".to_string(),
                    }),
                )
            })?;

        if deployment.app_id != app.id
            || !deployment_has_service_image(&deployment, &service)
        {
            return Err((
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "deployment not found".to_string(),
                }),
            ));
        }

        let limit = query.limit.unwrap_or(100);
        let offset = query.offset.unwrap_or(0);
        self.state
            .db
            .get_deployment_logs(deployment_id, limit, offset)
            .map_err(internal_error)
    }

    async fn create_repository_service(
        &self,
        config: &Config,
        user_id: Uuid,
        name: String,
        github_url: String,
        branch: Option<String>,
        env_vars: Option<Vec<EnvVarRequest>>,
        mut service: ServiceRequest,
        rollout_strategy: Option<String>,
    ) -> ApiResult<Uuid> {
        if name.is_empty() || name.len() > 64 {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "name must be 1-64 characters".to_string(),
                }),
            ));
        }

        if service.name.trim().is_empty() {
            service.name = name.clone();
        }

        let mut app = App::new(name, github_url, user_id);
        if let Some(branch) = branch {
            app.branch = branch;
        }
        if let Some(env_vars) = env_vars {
            app.env_vars = env_vars
                .into_iter()
                .map(|env_var| EnvVar {
                    key: env_var.key,
                    value: env_var.value,
                    secret: env_var.secret.unwrap_or(false),
                })
                .collect();
        }
        if let Some(strategy) = rollout_strategy.as_deref() {
            app.rollout_strategy = parse_rollout_strategy(strategy)
                .ok_or_else(|| {
                    (
                        StatusCode::BAD_REQUEST,
                        Json(ErrorResponse {
                            error:
                                "invalid rollout strategy. use stop_first or start_first"
                                    .to_string(),
                        }),
                    )
                })?;
        }

        app.services = build_services(config, app.id, &[], vec![service])?;
        app.ensure_service_model();

        if app.requires_source_checkout() && app.github_url.trim().is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error:
                        "github_url is required when a service needs a source build"
                            .to_string(),
                }),
            ));
        }

        let domains =
            validate_app_service_domains(&self.state, config, &app).await?;

        self.state.db.save_app(&app).map_err(internal_error)?;

        if let Err(error) = create_and_queue_deployment(
            &self.state,
            user_id,
            &app,
            "initial".to_string(),
            Some("initial deployment".to_string()),
            app.branch.clone(),
            app.rollout_strategy,
            None,
            None,
            false,
        )
        .await
        {
            let _ = self.state.db.delete_app(app.id);
            return Err(error);
        }

        if !domains.is_empty() {
            if let Some(tx) = &self.state.cert_request_tx {
                for domain in domains {
                    let _ = tx.try_send(domain);
                }
            } else {
                warn!("certificate issuance not available for new app domain");
            }
        }

        let service_id =
            app.services.first().map(|service| service.id).ok_or_else(
                || internal_error("created app did not contain a service"),
            )?;
        Ok(service_id)
    }

    async fn create_template_service(
        &self,
        config: &Config,
        user_id: Uuid,
        name: String,
        template: String,
        version: Option<String>,
        memory_limit_mb: Option<u64>,
        cpu_limit: Option<f64>,
        group_id: Option<String>,
    ) -> ApiResult<Uuid> {
        if name.is_empty() || name.len() > 64 {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "name must be 1-64 characters".to_string(),
                }),
            ));
        }

        let template = TemplateKind::parse(&template)
            .ok_or_else(|| bad_request(supported_template_message()))?;

        if template.is_queue() {
            let queue_type = match template {
                TemplateKind::Rabbitmq => QueueType::Rabbitmq,
                _ => {
                    return Err(bad_request(
                        "invalid queue_type. supported: rabbitmq",
                    ));
                }
            };
            let mut queue = ManagedQueue::new_with_path(
                user_id,
                name,
                queue_type,
                &config.storage.data_dir,
            );
            if let Some(version) = version {
                queue.version = version;
            }
            if let Some(memory_limit_mb) = memory_limit_mb {
                queue.memory_limit = memory_limit_mb * 1024 * 1024;
            }
            if let Some(cpu_limit) = cpu_limit {
                queue.cpu_limit = cpu_limit;
            }
            queue.group_id =
                resolve_group_id(&self.state, user_id, group_id.as_deref())?;

            self.state
                .db
                .save_managed_queue(&queue)
                .map_err(internal_error)?;

            let manager = QueueManager::new();
            if let Err(error) = manager.start_queue(&mut queue).await {
                queue.status = ServiceStatus::Failed;
                queue.updated_at = Utc::now();
                let _ = self.state.db.save_managed_queue(&queue);
                return Err(service_manager_error("create queue", error));
            }

            self.state
                .db
                .save_managed_queue(&queue)
                .map_err(internal_error)?;
            return Ok(queue.id);
        }

        let db_type = match template {
            TemplateKind::Postgresql => DatabaseType::Postgresql,
            TemplateKind::Redis => DatabaseType::Valkey,
            TemplateKind::Mariadb => DatabaseType::Mariadb,
            TemplateKind::Qdrant => DatabaseType::Qdrant,
            TemplateKind::Rabbitmq => unreachable!(),
        };
        let mut database = ManagedDatabase::new_with_path(
            user_id,
            name,
            db_type,
            &config.storage.data_dir,
        );
        if let Some(version) = version {
            database.version = version;
        }
        if let Some(memory_limit_mb) = memory_limit_mb {
            database.memory_limit = memory_limit_mb * 1024 * 1024;
        }
        if let Some(cpu_limit) = cpu_limit {
            database.cpu_limit = cpu_limit;
        }
        database.group_id =
            resolve_group_id(&self.state, user_id, group_id.as_deref())?;
        mark_database_starting(&mut database);

        self.state
            .db
            .save_managed_database(&database)
            .map_err(internal_error)?;

        let manager = DatabaseManager::new();
        if let Err(error) = manager.start_database(&mut database).await {
            database.status = ServiceStatus::Failed;
            database.updated_at = Utc::now();
            let _ = self.state.db.save_managed_database(&database);
            return Err(service_manager_error("create database", error));
        }

        self.state
            .db
            .save_managed_database(&database)
            .map_err(internal_error)?;
        Ok(database.id)
    }

    fn service_response(
        &self,
        user_id: Uuid,
        service_id: Uuid,
        base_domain: &str,
        public_ip: Option<&str>,
    ) -> ApiResult<InventoryServiceResponse> {
        let inventory = self
            .state
            .db
            .get_service_inventory_by_id(user_id, service_id)
            .map_err(internal_error)?
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: "service not found".to_string(),
                    }),
                )
            })?;

        Ok(InventoryServiceResponse::from_inventory(
            &inventory,
            base_domain,
            public_ip,
        ))
    }
}

fn normalize_public_ip(public_ip: Option<&str>) -> Option<String> {
    let public_ip = public_ip?.trim();
    if public_ip.is_empty() {
        return None;
    }

    Some(public_ip.to_string())
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn build_default_urls(
    service: &ServiceInventoryItem,
    base_domain: &str,
) -> Vec<String> {
    let mut urls = Vec::new();
    for domain in &service.domains {
        let domain = domain.trim();
        if !domain.is_empty() {
            push_unique(&mut urls, format!("https://{}", domain));
        }
    }

    if !service.public_http {
        return urls;
    }

    let Some(project_name) = service.project_name.as_deref() else {
        return urls;
    };
    let base_domain = base_domain.trim().trim_end_matches('.');
    if base_domain.is_empty() {
        return urls;
    }

    if service.name == "web" {
        push_unique(
            &mut urls,
            format!("https://{}.{}", project_name, base_domain),
        );
    }

    push_unique(
        &mut urls,
        format!("https://{}.{}.{}", service.name, project_name, base_domain),
    );

    urls
}

fn internal_error<E: std::fmt::Display>(
    error: E,
) -> (StatusCode, Json<ErrorResponse>) {
    tracing::error!("internal error: {}", error);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: "internal server error".to_string(),
        }),
    )
}

fn bad_request(
    message: impl Into<String>,
) -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ErrorResponse {
            error: message.into(),
        }),
    )
}

fn conflict(message: impl Into<String>) -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::CONFLICT,
        Json(ErrorResponse {
            error: message.into(),
        }),
    )
}

fn service_manager_error<E: std::fmt::Display>(
    action: &str,
    error: E,
) -> (StatusCode, Json<ErrorResponse>) {
    tracing::error!("failed to {}: {}", action, error);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: format!("failed to {}: {}", action, error),
        }),
    )
}

fn resolve_group_id(
    state: &AppState,
    user_id: Uuid,
    group_id: Option<&str>,
) -> ApiResult<Option<Uuid>> {
    let Some(group_id) =
        group_id.map(str::trim).filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    let group_id = Uuid::parse_str(group_id)
        .map_err(|_| bad_request("group_id must be a valid uuid"))?;
    let group = state
        .db
        .get_app(group_id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "group not found".to_string(),
                }),
            )
        })?;

    if group.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    Ok(Some(group_id))
}

fn resolve_owned_service_record(
    state: &AppState,
    user_id: Uuid,
    service_id: Uuid,
) -> ApiResult<OwnedServiceRecord> {
    if let Some(service) =
        state.db.get_service(service_id).map_err(internal_error)?
    {
        let app = state
            .db
            .get_app(service.app_id)
            .map_err(internal_error)?
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: "service group not found".to_string(),
                    }),
                )
            })?;

        if app.owner_id != user_id {
            return Err((
                StatusCode::FORBIDDEN,
                Json(ErrorResponse {
                    error: "access denied".to_string(),
                }),
            ));
        }

        let service = app
            .services
            .iter()
            .find(|candidate| candidate.id == service_id)
            .cloned()
            .unwrap_or(service);

        return Ok(OwnedServiceRecord::App { app, service });
    }

    if let Some(database) = state
        .db
        .get_managed_database(service_id)
        .map_err(internal_error)?
    {
        if database.owner_id != user_id {
            return Err((
                StatusCode::FORBIDDEN,
                Json(ErrorResponse {
                    error: "access denied".to_string(),
                }),
            ));
        }

        return Ok(OwnedServiceRecord::ManagedDatabase(database));
    }

    if let Some(queue) = state
        .db
        .get_managed_queue(service_id)
        .map_err(internal_error)?
    {
        if queue.owner_id != user_id {
            return Err((
                StatusCode::FORBIDDEN,
                Json(ErrorResponse {
                    error: "access denied".to_string(),
                }),
            ));
        }

        return Ok(OwnedServiceRecord::ManagedQueue(queue));
    }

    Err((
        StatusCode::NOT_FOUND,
        Json(ErrorResponse {
            error: "service not found".to_string(),
        }),
    ))
}

fn resolve_owned_app_service_record(
    state: &AppState,
    user_id: Uuid,
    service_id: Uuid,
) -> ApiResult<(App, ContainerService)> {
    match resolve_owned_service_record(state, user_id, service_id)? {
        OwnedServiceRecord::App { app, service } => Ok((app, service)),
        OwnedServiceRecord::ManagedDatabase(_)
        | OwnedServiceRecord::ManagedQueue(_) => Err(bad_request(
            "deployments are only supported for repository services",
        )),
    }
}

fn parse_restart_policy(value: Option<&str>) -> RestartPolicy {
    match value.unwrap_or("always").to_lowercase().as_str() {
        "never" | "no" => RestartPolicy::Never,
        "onfailure" | "on-failure" => RestartPolicy::OnFailure,
        _ => RestartPolicy::Always,
    }
}

fn restart_policy_label(value: RestartPolicy) -> &'static str {
    match value {
        RestartPolicy::Never => "never",
        RestartPolicy::Always => "always",
        RestartPolicy::OnFailure => "on-failure",
    }
}

fn rollout_strategy_label(value: RolloutStrategy) -> &'static str {
    match value {
        RolloutStrategy::StopFirst => "stop_first",
        RolloutStrategy::StartFirst => "start_first",
    }
}

fn mask_secret_value(secret: bool, value: &str) -> String {
    if secret && !value.is_empty() {
        "********".to_string()
    } else {
        value.to_string()
    }
}

fn masked_env_var_response(env_var: &EnvVar) -> EditableEnvVarResponse {
    EditableEnvVarResponse {
        key: env_var.key.clone(),
        value: mask_secret_value(env_var.secret, &env_var.value),
        secret: env_var.secret,
    }
}

fn masked_build_arg_response(build_arg: &BuildArg) -> EditableEnvVarResponse {
    EditableEnvVarResponse {
        key: build_arg.key.clone(),
        value: mask_secret_value(build_arg.secret, &build_arg.value),
        secret: build_arg.secret,
    }
}

fn service_settings_service_response(
    service: &ContainerService,
) -> ServiceSettingsServiceResponse {
    ServiceSettingsServiceResponse {
        name: service.name.clone(),
        image: normalize_optional_string(Some(service.image.clone())),
        service_type: ContainerService::service_type_name(service.service_type)
            .to_string(),
        port: service.port,
        expose_http: service.expose_http,
        domains: service.domains.clone(),
        additional_ports: service.additional_ports.clone(),
        replicas: service.replicas,
        memory_limit_mb: service.memory_limit.map(|value| value / 1024 / 1024),
        cpu_limit: service.cpu_limit,
        depends_on: service.depends_on.clone(),
        health_check: service.health_check.as_ref().map(|health_check| {
            HealthCheckResponse {
                path: health_check.path.clone(),
                interval_secs: health_check.interval_secs,
                timeout_secs: health_check.timeout_secs,
                retries: health_check.retries,
            }
        }),
        restart_policy: restart_policy_label(service.restart_policy)
            .to_string(),
        registry_auth: service.registry_auth.as_ref().map(|auth| {
            ServiceRegistryAuthResponse {
                server: auth.server.clone(),
                username: auth.username.clone(),
                password: mask_secret_value(true, &auth.password),
            }
        }),
        env_vars: service
            .env_vars
            .iter()
            .map(masked_env_var_response)
            .collect(),
        build_context: service.build_context.clone(),
        dockerfile_path: service.dockerfile_path.clone(),
        build_target: service.build_target.clone(),
        build_args: service
            .build_args
            .iter()
            .map(masked_build_arg_response)
            .collect(),
        command: service.command.clone(),
        entrypoint: service.entrypoint.clone(),
        working_dir: service.working_dir.clone(),
        schedule: service.schedule.clone(),
        mounts: service
            .mounts
            .iter()
            .map(|mount| ServiceMountRequest {
                name: mount.name.clone(),
                target: mount.target.clone(),
                read_only: Some(mount.read_only),
            })
            .collect(),
    }
}

fn service_request_from_model(service: &ContainerService) -> ServiceRequest {
    ServiceRequest {
        name: service.name.clone(),
        image: normalize_optional_string(Some(service.image.clone())),
        service_type: Some(
            ContainerService::service_type_name(service.service_type)
                .to_string(),
        ),
        port: service.port,
        expose_http: Some(service.expose_http),
        domains: if service.domains.is_empty() {
            None
        } else {
            Some(service.domains.clone())
        },
        domain: None,
        additional_ports: if service.additional_ports.is_empty() {
            None
        } else {
            Some(service.additional_ports.clone())
        },
        replicas: Some(service.replicas),
        memory_limit_mb: service.memory_limit.map(|value| value / 1024 / 1024),
        cpu_limit: service.cpu_limit,
        depends_on: if service.depends_on.is_empty() {
            None
        } else {
            Some(service.depends_on.clone())
        },
        health_check: service.health_check.as_ref().map(|health_check| {
            HealthCheckRequest {
                path: health_check.path.clone(),
                interval_secs: Some(health_check.interval_secs),
                timeout_secs: Some(health_check.timeout_secs),
                retries: Some(health_check.retries),
            }
        }),
        restart_policy: Some(
            restart_policy_label(service.restart_policy).to_string(),
        ),
        registry_auth: service.registry_auth.as_ref().map(|auth| {
            ServiceRegistryAuthRequest {
                server: auth.server.clone(),
                username: Some(auth.username.clone()),
                password: Some(mask_secret_value(true, &auth.password)),
            }
        }),
        env_vars: if service.env_vars.is_empty() {
            None
        } else {
            Some(
                service
                    .env_vars
                    .iter()
                    .map(|env_var| EnvVarRequest {
                        key: env_var.key.clone(),
                        value: mask_secret_value(
                            env_var.secret,
                            &env_var.value,
                        ),
                        secret: Some(env_var.secret),
                    })
                    .collect(),
            )
        },
        build_context: service.build_context.clone(),
        dockerfile_path: service.dockerfile_path.clone(),
        build_target: service.build_target.clone(),
        build_args: if service.build_args.is_empty() {
            None
        } else {
            Some(
                service
                    .build_args
                    .iter()
                    .map(|build_arg| EnvVarRequest {
                        key: build_arg.key.clone(),
                        value: mask_secret_value(
                            build_arg.secret,
                            &build_arg.value,
                        ),
                        secret: Some(build_arg.secret),
                    })
                    .collect(),
            )
        },
        command: service.command.clone(),
        entrypoint: service.entrypoint.clone(),
        working_dir: service.working_dir.clone(),
        schedule: service.schedule.clone(),
        mounts: if service.mounts.is_empty() {
            None
        } else {
            Some(
                service
                    .mounts
                    .iter()
                    .map(|mount| ServiceMountRequest {
                        name: mount.name.clone(),
                        target: mount.target.clone(),
                        read_only: Some(mount.read_only),
                    })
                    .collect(),
            )
        },
    }
}

fn normalize_watch_paths(paths: Vec<String>) -> ApiResult<Vec<String>> {
    let mut normalized = Vec::new();
    for path in paths {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('/') {
            return Err(bad_request(
                "watch paths must be relative repository paths or glob patterns",
            ));
        }
        if !normalized.iter().any(|existing| existing == trimmed) {
            normalized.push(trimmed.to_string());
        }
    }
    Ok(normalized)
}

fn parse_service_type(value: &str) -> Option<ServiceType> {
    match value.trim().to_ascii_lowercase().as_str() {
        "web_service" | "web-service" | "webservice" | "web" => {
            Some(ServiceType::WebService)
        }
        "private_service" | "private-service" | "privateservice"
        | "private" => Some(ServiceType::PrivateService),
        "background_worker" | "background-worker" | "backgroundworker"
        | "worker" | "background" => Some(ServiceType::BackgroundWorker),
        "cron_job" | "cron-job" | "cronjob" | "cron" => {
            Some(ServiceType::CronJob)
        }
        _ => None,
    }
}

fn resolve_service_type(
    request: &ServiceRequest,
    existing: Option<&ContainerService>,
) -> ApiResult<ServiceType> {
    if let Some(service_type) = request.service_type.as_deref() {
        return parse_service_type(service_type).ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error:
                        "invalid service type. use web_service, private_service, background_worker, or cron_job"
                            .to_string(),
                }),
            )
        });
    }

    if request.expose_http == Some(true) {
        return Ok(ServiceType::WebService);
    }

    if request.expose_http == Some(false) {
        if request.port == 0 {
            return Ok(ServiceType::BackgroundWorker);
        }
        return Ok(ServiceType::PrivateService);
    }

    if request.port == 0 {
        return Ok(ServiceType::BackgroundWorker);
    }

    Ok(existing
        .map(|service| service.service_type)
        .unwrap_or(ServiceType::PrivateService))
}

fn validate_mount_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn build_service_mounts(
    mounts: Option<Vec<ServiceMountRequest>>,
) -> ApiResult<Vec<ServiceMount>> {
    let mut seen_names = HashSet::new();
    let mut seen_targets = HashSet::new();
    let mut parsed = Vec::new();

    for mount in mounts.unwrap_or_default() {
        let name = mount.name.trim().to_string();
        let target = mount.target.trim().to_string();

        if !validate_mount_name(&name) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error:
                        "invalid mount name. use letters, numbers, hyphens, or underscores"
                            .to_string(),
                }),
            ));
        }

        if !target.starts_with('/') {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "mount target must be an absolute container path"
                        .to_string(),
                }),
            ));
        }

        if !seen_names.insert(name.clone()) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("duplicate mount name: {}", name),
                }),
            ));
        }

        if !seen_targets.insert(target.clone()) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("duplicate mount target: {}", target),
                }),
            ));
        }

        parsed.push(ServiceMount {
            name,
            target,
            read_only: mount.read_only.unwrap_or(false),
        });
    }

    Ok(parsed)
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_cron_schedule(
    value: Option<String>,
    existing: Option<&str>,
) -> ApiResult<Option<String>> {
    match value {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }

            Cron::from_str(trimmed).map_err(|error| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: format!("invalid cron schedule: {}", error),
                    }),
                )
            })?;

            Ok(Some(trimmed.to_string()))
        }
        None => Ok(existing.map(|existing| existing.to_string())),
    }
}

fn normalize_optional_args(
    value: Option<Vec<String>>,
    existing: Option<&[String]>,
) -> Option<Vec<String>> {
    match value {
        Some(value) => {
            let normalized = value
                .into_iter()
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect::<Vec<_>>();
            if normalized.is_empty() {
                None
            } else {
                Some(normalized)
            }
        }
        None => existing.map(|existing| existing.to_vec()),
    }
}

fn normalize_additional_ports(
    value: Option<Vec<u16>>,
    existing: &[u16],
    primary_port: u16,
) -> ApiResult<Vec<u16>> {
    let ports = value.unwrap_or_else(|| existing.to_vec());
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for port in ports {
        if port == 0 {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error:
                        "additional service ports must be between 1 and 65535"
                            .to_string(),
                }),
            ));
        }
        if port == primary_port {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!(
                        "additional port {} duplicates the primary port",
                        port
                    ),
                }),
            ));
        }
        if !seen.insert(port) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("duplicate additional port: {}", port),
                }),
            ));
        }
        normalized.push(port);
    }

    Ok(normalized)
}

fn normalize_working_dir(
    value: Option<String>,
    existing: Option<&str>,
) -> ApiResult<Option<String>> {
    match value {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            if !trimmed.starts_with('/') {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error:
                            "working directory must be an absolute container path"
                                .to_string(),
                    }),
                ));
            }
            Ok(Some(trimmed.to_string()))
        }
        None => Ok(existing.map(|existing| existing.to_string())),
    }
}

fn normalize_repo_relative_path(
    field: &str,
    value: Option<String>,
    existing: Option<&str>,
) -> ApiResult<Option<String>> {
    match value {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }

            let path = FsPath::new(trimmed);
            if path.is_absolute() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: format!(
                            "{field} must be relative to the repository root"
                        ),
                    }),
                ));
            }

            for component in path.components() {
                match component {
                    Component::Normal(_) | Component::CurDir => {}
                    _ => {
                        return Err((
                            StatusCode::BAD_REQUEST,
                            Json(ErrorResponse {
                                error: format!(
                                    "{field} cannot contain parent traversal or absolute components"
                                ),
                            }),
                        ));
                    }
                }
            }

            Ok(Some(trimmed.to_string()))
        }
        None => Ok(existing.map(|existing| existing.to_string())),
    }
}

fn build_service_env_vars(
    requests: Option<Vec<EnvVarRequest>>,
    existing: &[EnvVar],
) -> ApiResult<Vec<EnvVar>> {
    let Some(requests) = requests else {
        return Ok(existing.to_vec());
    };

    let existing_by_key = existing
        .iter()
        .map(|env_var| (env_var.key.clone(), env_var.clone()))
        .collect::<HashMap<_, _>>();
    let mut seen_keys = HashSet::new();
    let mut env_vars = Vec::new();

    for request in requests {
        let key = request.key.trim().to_string();
        if key.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "service env var key cannot be empty".to_string(),
                }),
            ));
        }

        if !seen_keys.insert(key.clone()) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("duplicate service env var key: {}", key),
                }),
            ));
        }

        let existing_value = existing_by_key.get(&key);
        let secret = request.secret.unwrap_or_else(|| {
            existing_value.map(|item| item.secret).unwrap_or(false)
        });
        let value = if secret && request.value == "********" {
            existing_value
                .map(|item| item.value.clone())
                .ok_or_else(|| {
                    (
                        StatusCode::BAD_REQUEST,
                        Json(ErrorResponse {
                            error: format!(
                                "missing original value for masked service env var {}",
                                key
                            ),
                        }),
                    )
                })?
        } else {
            request.value
        };

        env_vars.push(EnvVar { key, value, secret });
    }

    Ok(env_vars)
}

fn build_app_env_vars(
    requests: Option<Vec<EnvVarRequest>>,
    existing: &[EnvVar],
) -> ApiResult<Vec<EnvVar>> {
    let Some(requests) = requests else {
        return Ok(existing.to_vec());
    };

    let existing_by_key = existing
        .iter()
        .map(|env_var| (env_var.key.clone(), env_var.clone()))
        .collect::<HashMap<_, _>>();
    let mut seen_keys = HashSet::new();
    let mut env_vars = Vec::new();

    for request in requests {
        let key = request.key.trim().to_string();
        if key.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "shared env var key cannot be empty".to_string(),
                }),
            ));
        }

        if !seen_keys.insert(key.clone()) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("duplicate shared env var key: {}", key),
                }),
            ));
        }

        let existing_value = existing_by_key.get(&key);
        let secret = request.secret.unwrap_or_else(|| {
            existing_value.map(|item| item.secret).unwrap_or(false)
        });
        let value = if secret && request.value == "********" {
            existing_value
                .map(|item| item.value.clone())
                .ok_or_else(|| {
                    (
                        StatusCode::BAD_REQUEST,
                        Json(ErrorResponse {
                            error: format!(
                                "missing original value for masked shared env var {}",
                                key
                            ),
                        }),
                    )
                })?
        } else {
            request.value
        };

        env_vars.push(EnvVar { key, value, secret });
    }

    Ok(env_vars)
}

fn build_service_build_args(
    requests: Option<Vec<EnvVarRequest>>,
    existing: &[BuildArg],
) -> ApiResult<Vec<BuildArg>> {
    let Some(requests) = requests else {
        return Ok(existing.to_vec());
    };

    let existing_by_key = existing
        .iter()
        .map(|build_arg| (build_arg.key.clone(), build_arg.clone()))
        .collect::<HashMap<_, _>>();
    let mut seen_keys = HashSet::new();
    let mut build_args = Vec::new();

    for request in requests {
        let key = request.key.trim().to_string();
        if key.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "service build arg key cannot be empty".to_string(),
                }),
            ));
        }

        if !seen_keys.insert(key.clone()) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("duplicate service build arg key: {}", key),
                }),
            ));
        }

        let existing_value = existing_by_key.get(&key);
        let secret = request.secret.unwrap_or_else(|| {
            existing_value.map(|item| item.secret).unwrap_or(false)
        });
        let value = if secret && request.value == "********" {
            existing_value
                .map(|item| item.value.clone())
                .ok_or_else(|| {
                    (
                        StatusCode::BAD_REQUEST,
                        Json(ErrorResponse {
                            error: format!(
                                "missing original value for masked service build arg {}",
                                key
                            ),
                        }),
                    )
                })?
        } else {
            request.value
        };

        build_args.push(BuildArg { key, value, secret });
    }

    Ok(build_args)
}

fn build_service_registry_auth(
    config: &Config,
    existing_auth: Option<&ServiceRegistryAuth>,
    registry_auth: Option<ServiceRegistryAuthRequest>,
) -> ApiResult<Option<ServiceRegistryAuth>> {
    let Some(registry_auth) = registry_auth else {
        return Ok(existing_auth.cloned());
    };

    let server = normalize_optional_string(registry_auth.server);
    let username = normalize_optional_string(registry_auth.username);
    let password = normalize_optional_string(registry_auth.password);

    if server.is_none() && username.is_none() && password.is_none() {
        return Ok(None);
    }

    let username = username.ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error:
                    "registry username is required when registry auth is set"
                        .to_string(),
            }),
        )
    })?;

    let password = match password.as_deref() {
        Some("********") | None => existing_auth
            .map(|existing| existing.password.clone())
            .ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error:
                            "registry password is required for new registry auth"
                                .to_string(),
                    }),
                )
            })?,
        Some(password) => encrypt_value(config, password).map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error }),
            )
        })?,
    };

    Ok(Some(ServiceRegistryAuth {
        server,
        username,
        password,
    }))
}

fn build_services(
    config: &Config,
    app_id: Uuid,
    existing_services: &[ContainerService],
    requests: Vec<ServiceRequest>,
) -> ApiResult<Vec<ContainerService>> {
    if requests.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "services must define at least one service".to_string(),
            }),
        ));
    }

    let existing_by_name = existing_services
        .iter()
        .map(|service| (service.name.clone(), service.clone()))
        .collect::<HashMap<_, _>>();
    let mut seen_names = HashSet::new();
    let mut services = Vec::new();

    for request in requests {
        let service_name = request.name.trim().to_string();
        if service_name.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "service name cannot be empty".to_string(),
                }),
            ));
        }
        if !seen_names.insert(service_name.clone()) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("duplicate service name: {}", service_name),
                }),
            ));
        }

        let mut service = existing_by_name
            .get(&service_name)
            .cloned()
            .unwrap_or_else(|| {
                ContainerService::new(
                    app_id,
                    service_name.clone(),
                    request.image.clone().unwrap_or_default(),
                    request.port,
                )
            });
        let service_type = resolve_service_type(&request, Some(&service))?;
        let requested_domains = requested_service_domains(&request);
        let port = request.port;
        let schedule = normalize_cron_schedule(
            request.schedule,
            service.schedule.as_deref(),
        )?;

        if matches!(
            service_type,
            ServiceType::BackgroundWorker | ServiceType::CronJob
        ) {
            if request.expose_http == Some(true) {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error:
                            "background workers cannot receive public http traffic"
                                .to_string(),
                    }),
                ));
            }
            if requested_domains
                .as_ref()
                .is_some_and(|domains| !domains.is_empty())
            {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: "only web services can use custom domains"
                            .to_string(),
                    }),
                ));
            }
        } else if port == 0 {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "web and private services require a container port"
                        .to_string(),
                }),
            ));
        }

        if matches!(service_type, ServiceType::PrivateService)
            && requested_domains
                .as_ref()
                .is_some_and(|domains| !domains.is_empty())
        {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "only web services can use custom domains"
                        .to_string(),
                }),
            ));
        }

        if matches!(
            service_type,
            ServiceType::BackgroundWorker | ServiceType::CronJob
        ) && port == 0
            && request.health_check.is_some()
        {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error:
                        "background workers need a port before enabling http health checks"
                            .to_string(),
                }),
            ));
        }

        if matches!(service_type, ServiceType::CronJob) {
            if port != 0 {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: "cron jobs must use port 0".to_string(),
                    }),
                ));
            }
            if request.replicas.unwrap_or(1) != 1 {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: "cron jobs support exactly one replica"
                            .to_string(),
                    }),
                ));
            }
            if request
                .additional_ports
                .as_ref()
                .is_some_and(|ports| !ports.is_empty())
            {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: "cron jobs cannot expose additional ports"
                            .to_string(),
                    }),
                ));
            }
            if schedule.is_none() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: "cron jobs require a schedule".to_string(),
                    }),
                ));
            }
        } else if schedule.is_some() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "schedule is only supported for cron jobs"
                        .to_string(),
                }),
            ));
        }

        service.app_id = app_id;
        service.name = service_name;
        service.image = request.image.unwrap_or_default();
        service.service_type = service_type;
        service.port = port;
        service.expose_http = service.is_public_http();
        service.additional_ports = normalize_additional_ports(
            request.additional_ports,
            &service.additional_ports,
            service.port,
        )?;
        service.replicas = request.replicas.unwrap_or(1);
        service.memory_limit = request.memory_limit_mb.map(|m| m * 1024 * 1024);
        service.cpu_limit = request.cpu_limit;
        service.depends_on = request.depends_on.unwrap_or_default();
        service.registry_auth = build_service_registry_auth(
            config,
            service.registry_auth.as_ref(),
            request.registry_auth,
        )?;
        service.env_vars =
            build_service_env_vars(request.env_vars, &service.env_vars)?;
        service.domains = if matches!(service_type, ServiceType::WebService) {
            requested_domains.unwrap_or_else(|| service.custom_domains())
        } else {
            Vec::new()
        };
        service.build_context = normalize_repo_relative_path(
            "service build context",
            request.build_context,
            service.build_context.as_deref(),
        )?;
        service.dockerfile_path = normalize_repo_relative_path(
            "service dockerfile path",
            request.dockerfile_path,
            service.dockerfile_path.as_deref(),
        )?;
        service.build_target = match request.build_target {
            Some(build_target) => normalize_optional_string(Some(build_target)),
            None => service.build_target.clone(),
        };
        service.build_args =
            build_service_build_args(request.build_args, &service.build_args)?;
        service.command = normalize_optional_args(
            request.command,
            service.command.as_deref(),
        );
        service.entrypoint = normalize_optional_args(
            request.entrypoint,
            service.entrypoint.as_deref(),
        );
        service.working_dir = normalize_working_dir(
            request.working_dir,
            service.working_dir.as_deref(),
        )?;
        service.schedule = schedule;
        service.mounts = build_service_mounts(request.mounts)?;
        service.health_check =
            request.health_check.map(|health_check| HealthCheck {
                path: health_check.path,
                interval_secs: health_check.interval_secs.unwrap_or(30),
                timeout_secs: health_check.timeout_secs.unwrap_or(5),
                retries: health_check.retries.unwrap_or(3),
            });
        service.restart_policy =
            parse_restart_policy(request.restart_policy.as_deref());
        service.updated_at = Utc::now();
        services.push(service);
    }

    Ok(services)
}

fn normalize_domain(input: &str) -> Option<String> {
    let trimmed = input.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_lowercase())
}

fn normalize_domains(domains: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for domain in domains {
        if let Some(value) = normalize_domain(&domain) {
            if !normalized.iter().any(|existing| existing == &value) {
                normalized.push(value);
            }
        }
    }
    normalized
}

fn merge_domains(
    domain: Option<String>,
    domains: Option<Vec<String>>,
) -> Vec<String> {
    let mut combined = Vec::new();
    if let Some(domains) = domains {
        combined.extend(domains);
    }
    if let Some(domain) = domain {
        combined.push(domain);
    }
    normalize_domains(combined)
}

fn requested_service_domains(request: &ServiceRequest) -> Option<Vec<String>> {
    if request.domain.is_none() && request.domains.is_none() {
        return None;
    }

    Some(merge_domains(
        request.domain.clone(),
        request.domains.clone(),
    ))
}

async fn validate_app_service_domains(
    state: &AppState,
    config: &Config,
    app: &App,
) -> ApiResult<Vec<String>> {
    let mut domains = Vec::new();
    let mut seen = HashSet::new();

    for service in &app.services {
        if !service.domains.is_empty() && !service.is_public_http() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "only web services can use custom domains"
                        .to_string(),
                }),
            ));
        }

        for domain in service.custom_domains() {
            if !seen.insert(domain.clone()) {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: format!("duplicate custom domain: {}", domain),
                    }),
                ));
            }
            domains.push(domain);
        }
    }

    if domains.is_empty() {
        return Ok(domains);
    }

    validate_domains(
        &domains,
        &config.proxy.base_domain,
        config.proxy.public_ip.as_deref(),
    )
    .await
    .map_err(|error| {
        (StatusCode::BAD_REQUEST, Json(ErrorResponse { error }))
    })?;

    for domain in &domains {
        if let Some(existing) =
            state.db.get_app_by_domain(domain).map_err(internal_error)?
        {
            if existing.id != app.id {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ErrorResponse {
                        error: "domain already in use".to_string(),
                    }),
                ));
            }
        }
    }

    Ok(domains)
}

async fn validate_domains(
    domains: &[String],
    base_domain: &str,
    public_ip: Option<&str>,
) -> Result<(), String> {
    for domain in domains {
        validate_domain(domain, base_domain, public_ip).await?;
    }
    Ok(())
}

async fn validate_domain(
    domain: &str,
    base_domain: &str,
    public_ip: Option<&str>,
) -> Result<(), String> {
    let base_domain = base_domain.trim().to_lowercase();

    if domain == base_domain {
        return Err("domain is reserved for the dashboard".to_string());
    }

    if domain.starts_with("www.") {
        return Err("www subdomains are not supported".to_string());
    }

    let public_ip = public_ip.ok_or_else(|| {
        "public_ip must be configured for domain validation".to_string()
    })?;
    let public_ip: IpAddr = public_ip
        .parse()
        .map_err(|_| "public_ip is not a valid IP address".to_string())?;

    let resolver = TokioAsyncResolver::tokio(
        ResolverConfig::default(),
        ResolverOpts::default(),
    );

    if let Ok(lookup) = resolver.lookup_ip(domain).await {
        if lookup.iter().any(|ip| ip == public_ip) {
            return Ok(());
        }
    }

    let cname_lookup = resolver
        .lookup(domain, RecordType::CNAME)
        .await
        .map_err(|_| {
            "domain does not resolve to required records".to_string()
        })?;

    let suffix = format!(".{}", base_domain.trim_end_matches('.'));
    for record in cname_lookup.iter() {
        if let trust_dns_resolver::proto::rr::RData::CNAME(cname) = record {
            let target = cname.to_utf8();
            if target.trim_end_matches('.').ends_with(&suffix) {
                return Ok(());
            }
        }
    }

    Err(
        "domain must have an A record pointing to the public IP or CNAME to the base domain"
            .to_string(),
    )
}

fn sort_deployments_desc(mut deployments: Vec<Deployment>) -> Vec<Deployment> {
    deployments.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    deployments
}

fn deployment_has_service_image(
    deployment: &Deployment,
    service: &ContainerService,
) -> bool {
    if !service.image.trim().is_empty() {
        return true;
    }

    if deployment.image_id.is_some() {
        return true;
    }

    deployment
        .service_deployments
        .iter()
        .any(|service_deployment| {
            service_deployment.service_id == service.id
                && service_deployment.image_id.is_some()
        })
}

fn resolve_app_service_deployment(
    state: &AppState,
    app: &App,
    service: &ContainerService,
) -> ApiResult<Option<Deployment>> {
    let deployments = sort_deployments_desc(
        state
            .db
            .list_deployments_by_app(app.id)
            .map_err(internal_error)?,
    );

    Ok(deployments
        .iter()
        .find(|deployment| {
            deployment.status == DeploymentStatus::Running
                && deployment_has_service_image(deployment, service)
        })
        .cloned()
        .or_else(|| {
            deployments.into_iter().find(|deployment| {
                deployment_has_service_image(&deployment, service)
            })
        }))
}

fn resolve_service_image(
    deployment: &Deployment,
    service: &ContainerService,
    replica_index: u32,
) -> Option<String> {
    deployment
        .service_deployments
        .iter()
        .find(|service_deployment| {
            service_deployment.service_id == service.id
                && service_deployment.replica_index == replica_index
                && service_deployment.image_id.is_some()
        })
        .and_then(|service_deployment| service_deployment.image_id.clone())
        .or_else(|| {
            deployment
                .service_deployments
                .iter()
                .find(|service_deployment| {
                    service_deployment.service_id == service.id
                })
                .and_then(|service_deployment| {
                    service_deployment.image_id.clone()
                })
        })
        .or_else(|| {
            if service.image.trim().is_empty() {
                deployment.image_id.clone()
            } else {
                Some(service.image.clone())
            }
        })
}

fn ensure_service_deployment_index(
    deployment: &mut Deployment,
    service_id: Uuid,
    replica_index: u32,
) -> usize {
    if let Some(index) =
        deployment
            .service_deployments
            .iter()
            .position(|service_deployment| {
                service_deployment.service_id == service_id
                    && service_deployment.replica_index == replica_index
            })
    {
        return index;
    }

    deployment.service_deployments.push(ServiceDeployment::new(
        service_id,
        deployment.id,
        replica_index,
    ));
    deployment.service_deployments.len() - 1
}

fn persist_deployment(
    state: &AppState,
    deployment: &Deployment,
) -> ApiResult<()> {
    state
        .db
        .save_deployment(deployment)
        .map_err(internal_error)?;
    for service_deployment in &deployment.service_deployments {
        state
            .db
            .save_service_deployment(service_deployment)
            .map_err(internal_error)?;
    }
    Ok(())
}

async fn refresh_proxy_routes(state: &AppState, app_id: Uuid) {
    if let Some(sender) = &state.proxy_update_tx {
        let _ = sender.send(ProxyRouteUpdate::RefreshApp { app_id }).await;
    }
}

fn service_mount_root(
    data_dir: &FsPath,
    app_id: Uuid,
    service_id: Uuid,
) -> PathBuf {
    data_dir
        .join("builds")
        .join("app-mounts")
        .join(app_id.to_string())
        .join(service_id.to_string())
}

async fn app_service_manager(
    state: &AppState,
    encryption_secret: Option<String>,
) -> ApiResult<AppServiceManager> {
    AppServiceManager::new(state.data_dir.join("builds"), encryption_secret)
        .await
        .map_err(internal_error)
}

async fn get_app_service_logs(
    state: &AppState,
    app: &App,
    service: &ContainerService,
    tail: usize,
    encryption_secret: Option<String>,
) -> ApiResult<String> {
    let manager = app_service_manager(state, encryption_secret).await?;

    if service.is_cron_job() {
        let containers = manager
            .list_cron_job_containers(app, service)
            .await
            .map_err(|error| {
            service_manager_error("list cron logs", error)
        })?;
        let mut output = Vec::new();

        for container in containers {
            let logs =
                manager.get_service_logs(&container, tail).await.map_err(
                    |error| service_manager_error("read service logs", error),
                )?;
            if !logs.trim().is_empty() {
                output.push(format!(
                    "==> {} <==\n{}",
                    container,
                    logs.trim_end()
                ));
            }
        }

        return Ok(output.join("\n\n"));
    }

    let deployment = resolve_app_service_deployment(state, app, service)?
        .ok_or_else(|| bad_request("service has not been deployed"))?;
    let container_ids = deployment
        .service_deployments
        .iter()
        .filter(|service_deployment| {
            service_deployment.service_id == service.id
        })
        .filter_map(|service_deployment| {
            service_deployment.container_id.clone()
        })
        .collect::<Vec<_>>();

    if container_ids.is_empty() {
        return Ok(String::new());
    }

    let mut output = Vec::new();
    let multi_container = container_ids.len() > 1;
    for container_id in container_ids {
        let logs = manager
            .get_service_logs(&container_id, tail)
            .await
            .map_err(|error| {
                service_manager_error("read service logs", error)
            })?;
        if multi_container {
            output.push(format!(
                "==> {} <==\n{}",
                container_id,
                logs.trim_end()
            ));
        } else {
            output.push(logs.trim_end().to_string());
        }
    }

    Ok(output.join("\n\n"))
}

async fn stop_app_service(
    state: &AppState,
    app: &App,
    service: &ContainerService,
    encryption_secret: Option<String>,
) -> ApiResult<()> {
    let mut deployment =
        resolve_app_service_deployment(state, app, service)?
            .ok_or_else(|| bad_request("service has not been deployed"))?;
    let manager = app_service_manager(state, encryption_secret).await?;
    let mut changed = false;

    if service.is_cron_job() {
        let containers = manager
            .list_cron_job_containers(app, service)
            .await
            .map_err(|error| {
            service_manager_error("stop service", error)
        })?;
        for container in containers {
            let _ = manager.stop_service_replica(&container).await;
            changed = true;
        }
    }

    for service_deployment in
        deployment
            .service_deployments
            .iter_mut()
            .filter(|service_deployment| {
                service_deployment.service_id == service.id
            })
    {
        if let Some(container_id) = service_deployment.container_id.clone() {
            let _ = manager.stop_service_replica(&container_id).await;
        }
        service_deployment.status = DeploymentStatus::Stopped;
        service_deployment.finished_at = Some(Utc::now());
        service_deployment.container_id = None;
        changed = true;
    }

    if changed {
        persist_deployment(state, &deployment)?;
        if service.is_public_http() {
            refresh_proxy_routes(state, app.id).await;
        }
    }

    Ok(())
}

async fn start_app_service(
    state: &AppState,
    app: &App,
    service: &ContainerService,
    encryption_secret: Option<String>,
) -> ApiResult<()> {
    if service.is_cron_job() {
        return Err(bad_request(
            "cron jobs are scheduled and cannot be started manually",
        ));
    }

    let mut deployment =
        resolve_app_service_deployment(state, app, service)?
            .ok_or_else(|| bad_request("service has no deployed image"))?;
    let manager = app_service_manager(state, encryption_secret).await?;
    let mut changed = false;

    for replica_index in 0..service.replicas.max(1) {
        let index = ensure_service_deployment_index(
            &mut deployment,
            service.id,
            replica_index,
        );
        let already_running = deployment.service_deployments[index].status
            == DeploymentStatus::Running
            && deployment.service_deployments[index].container_id.is_some();
        if already_running {
            continue;
        }

        let image = resolve_service_image(&deployment, service, replica_index)
            .ok_or_else(|| bad_request("service has no deployed image"))?;
        let container_id = manager
            .start_service_replica(
                app,
                service,
                &deployment,
                &image,
                replica_index,
            )
            .await
            .map_err(|error| service_manager_error("start service", error))?;

        let service_deployment = &mut deployment.service_deployments[index];
        service_deployment.image_id = Some(image);
        service_deployment.container_id = Some(container_id);
        service_deployment.status = DeploymentStatus::Running;
        service_deployment.started_at = Some(Utc::now());
        service_deployment.finished_at = None;
        changed = true;
    }

    if changed {
        deployment.status = DeploymentStatus::Running;
        if deployment.started_at.is_none() {
            deployment.started_at = Some(Utc::now());
        }
        deployment.finished_at = Some(Utc::now());
        persist_deployment(state, &deployment)?;
        if service.is_public_http() {
            refresh_proxy_routes(state, app.id).await;
        }
    }

    Ok(())
}

async fn delete_app_runtime(state: &AppState, app: &App) -> ApiResult<()> {
    let db_manager = DatabaseManager::new();
    let grouped_databases = state
        .db
        .list_managed_databases_by_owner(app.owner_id)
        .map_err(internal_error)?
        .into_iter()
        .filter(|database| database.group_id == Some(app.id))
        .collect::<Vec<_>>();

    for mut database in grouped_databases {
        let _ = db_manager.stop_database(&mut database).await;
        let database_root = database.root_path();
        if database_root.starts_with(&state.data_dir) {
            if let Err(error) = tokio::fs::remove_dir_all(&database_root).await
            {
                if error.kind() != ErrorKind::NotFound {
                    warn!(
                        database_id = %database.id,
                        error = %error,
                        "failed to remove database data"
                    );
                }
            }
        }
        state
            .db
            .delete_managed_database(database.id)
            .map_err(internal_error)?;
    }

    let queue_manager = QueueManager::new();
    let grouped_queues = state
        .db
        .list_managed_queues_by_owner(app.owner_id)
        .map_err(internal_error)?
        .into_iter()
        .filter(|queue| queue.group_id == Some(app.id))
        .collect::<Vec<_>>();

    for mut queue in grouped_queues {
        let _ = queue_manager.stop_queue(&mut queue).await;
        let queue_root = queue.root_path();
        if queue_root.starts_with(&state.data_dir) {
            if let Err(error) = tokio::fs::remove_dir_all(&queue_root).await {
                if error.kind() != ErrorKind::NotFound {
                    warn!(
                        queue_id = %queue.id,
                        error = %error,
                        "failed to remove queue data"
                    );
                }
            }
        }
        state
            .db
            .delete_managed_queue(queue.id)
            .map_err(internal_error)?;
    }

    let docker_manager = DockerContainerManager::new();
    let container_prefix = format!("containr-{}", app.id);
    let cron_prefix = format!(
        "containr-cron-{}-",
        app.id.to_string().split('-').next().unwrap_or_default()
    );
    let container_names = docker_manager
        .list_containers()
        .await
        .map_err(internal_error)?
        .into_iter()
        .map(|container| container.id)
        .filter(|name| {
            name.starts_with(&container_prefix)
                || name.starts_with(&cron_prefix)
        })
        .collect::<Vec<_>>();

    docker_manager
        .stop_service_group(container_names)
        .await
        .map_err(internal_error)?;
    docker_manager
        .remove_network(&app.network_name())
        .await
        .map_err(internal_error)?;

    for service in &app.services {
        let mount_root =
            service_mount_root(&state.data_dir, app.id, service.id);
        if let Err(error) = tokio::fs::remove_dir_all(&mount_root).await {
            if error.kind() != ErrorKind::NotFound {
                return Err(internal_error(format!(
                    "failed to remove service mount data: {}",
                    error
                )));
            }
        }
    }

    Ok(())
}

async fn delete_app_service(
    state: &AppState,
    config: &Config,
    app: &App,
    service: &ContainerService,
    encryption_secret: Option<String>,
) -> ApiResult<()> {
    if app.services.len() == 1 {
        let _ = stop_app_service(state, app, service, encryption_secret).await;
        delete_app_runtime(state, app).await?;
        state.db.delete_app(app.id).map_err(internal_error)?;
        return Ok(());
    }

    let _ = stop_app_service(state, app, service, encryption_secret).await;

    let mut updated_app = app.clone();
    updated_app
        .services
        .retain(|candidate| candidate.id != service.id);
    updated_app.updated_at = Utc::now();
    state.db.save_app(&updated_app).map_err(internal_error)?;

    for mut deployment in state
        .db
        .list_deployments_by_app(app.id)
        .map_err(internal_error)?
    {
        let mut changed = false;
        for service_deployment in deployment
            .service_deployments
            .iter_mut()
            .filter(|service_deployment| {
                service_deployment.service_id == service.id
            })
        {
            service_deployment.status = DeploymentStatus::Stopped;
            service_deployment.finished_at = Some(Utc::now());
            service_deployment.container_id = None;
            changed = true;
        }

        if changed {
            persist_deployment(state, &deployment)?;
        }
    }

    let mount_root = service_mount_root(&state.data_dir, app.id, service.id);
    if let Err(error) = tokio::fs::remove_dir_all(&mount_root).await {
        if error.kind() != ErrorKind::NotFound {
            return Err(internal_error(error));
        }
    }

    if service.is_public_http() {
        refresh_proxy_routes(state, app.id).await;
    }

    let domains = updated_app.custom_domains();
    if !domains.is_empty() {
        if let Some(tx) = &state.cert_request_tx {
            for domain in domains {
                let _ = tx.try_send(domain);
            }
        } else {
            warn!("certificate issuance not available for updated app domain");
        }
    } else if !config.proxy.base_domain.is_empty() {
        let _ = &config.proxy.base_domain;
    }

    Ok(())
}

fn ensure_database_not_starting(database: &ManagedDatabase) -> ApiResult<()> {
    if database.status == ServiceStatus::Starting {
        return Err(conflict("database is already starting"));
    }

    Ok(())
}

fn mark_database_starting(database: &mut ManagedDatabase) {
    database.status = ServiceStatus::Starting;
    database.container_id = None;
    database.updated_at = Utc::now();
}

async fn run_database_action(
    state: &AppState,
    action: ServiceAction,
    database: &mut ManagedDatabase,
) -> ApiResult<()> {
    let manager = DatabaseManager::new();

    match action {
        ServiceAction::Start => {
            ensure_database_not_starting(database)?;
            if manager.is_running(database).await {
                return Err(bad_request("database is already running"));
            }

            mark_database_starting(database);
            state
                .db
                .save_managed_database(database)
                .map_err(internal_error)?;

            if let Err(error) = manager.start_database(database).await {
                database.status = ServiceStatus::Failed;
                database.updated_at = Utc::now();
                let _ = state.db.save_managed_database(database);
                return Err(service_manager_error("start service", error));
            }
        }
        ServiceAction::Stop => {
            manager.stop_database(database).await.map_err(|error| {
                service_manager_error("stop service", error)
            })?;
        }
        ServiceAction::Restart => {
            ensure_database_not_starting(database)?;
            manager.stop_database(database).await.map_err(|error| {
                service_manager_error("restart service", error)
            })?;

            mark_database_starting(database);
            state
                .db
                .save_managed_database(database)
                .map_err(internal_error)?;

            if let Err(error) = manager.start_database(database).await {
                database.status = ServiceStatus::Failed;
                database.updated_at = Utc::now();
                let _ = state.db.save_managed_database(database);
                return Err(service_manager_error("restart service", error));
            }
        }
    }

    state
        .db
        .save_managed_database(database)
        .map_err(internal_error)?;
    Ok(())
}

async fn run_queue_action(
    state: &AppState,
    action: ServiceAction,
    queue: &mut ManagedQueue,
) -> ApiResult<()> {
    let manager = QueueManager::new();

    match action {
        ServiceAction::Start => {
            manager.start_queue(queue).await.map_err(|error| {
                service_manager_error("start service", error)
            })?;
        }
        ServiceAction::Stop => {
            manager.stop_queue(queue).await.map_err(|error| {
                service_manager_error("stop service", error)
            })?;
        }
        ServiceAction::Restart => {
            manager.stop_queue(queue).await.map_err(|error| {
                service_manager_error("restart service", error)
            })?;
            manager.start_queue(queue).await.map_err(|error| {
                service_manager_error("restart service", error)
            })?;
        }
    }

    state.db.save_managed_queue(queue).map_err(internal_error)?;
    Ok(())
}

fn resolve_rollout_strategy(
    override_value: Option<&str>,
    default_value: RolloutStrategy,
) -> ApiResult<RolloutStrategy> {
    match override_value {
        None => Ok(default_value),
        Some(value) => parse_rollout_strategy(value).ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error:
                        "invalid rollout strategy. use stop_first or start_first"
                            .to_string(),
                }),
            )
        }),
    }
}

fn parse_rollout_strategy(value: &str) -> Option<RolloutStrategy> {
    match value.trim().to_ascii_lowercase().as_str() {
        "stop_first" | "stop-first" | "stopfirst" => {
            Some(RolloutStrategy::StopFirst)
        }
        "start_first" | "start-first" | "startfirst" => {
            Some(RolloutStrategy::StartFirst)
        }
        _ => None,
    }
}

pub(crate) async fn replay_deployment_job(
    state: &AppState,
    app: &App,
    deployment: &Deployment,
) -> anyhow::Result<()> {
    let source_url = deployment
        .source_url
        .clone()
        .unwrap_or_else(|| app.github_url.clone());
    let source =
        resolve_source_deployment_source(state, app.owner_id, &source_url)
            .await
            .map_err(|(status, error)| {
                anyhow::anyhow!(
                    "source recovery failed with status {}: {}",
                    status,
                    error.error
                )
            })?;

    state.db.append_deployment_log(
        deployment.id,
        "deployment requeued after containr restart",
    )?;

    let job = DeploymentJob {
        deployment_id: deployment.id,
        app_id: app.id,
        commit_sha: deployment.commit_sha.clone(),
        commit_message: deployment.commit_message.clone(),
        branch: deployment.branch.clone(),
        source,
        rollout_strategy: deployment.rollout_strategy,
        rollback_from_deployment_id: deployment.rollback_from_deployment_id,
    };

    state.deployment_tx.send(job).await.map_err(|error| {
        anyhow::anyhow!("failed to requeue deployment: {}", error)
    })?;

    Ok(())
}

fn deployment_source_url(source: &DeploymentSource) -> String {
    match source {
        DeploymentSource::RemoteGit { url, .. } => url.clone(),
        DeploymentSource::LocalPath { path } => path.clone(),
        DeploymentSource::None => String::new(),
    }
}

pub(crate) async fn resolve_source_deployment_source(
    state: &AppState,
    owner_id: Uuid,
    source_url: &str,
) -> ApiResult<DeploymentSource> {
    let app = App {
        id: Uuid::nil(),
        name: "replay".to_string(),
        github_url: source_url.to_string(),
        branch: "main".to_string(),
        domains: Vec::new(),
        domain: None,
        env_vars: Vec::new(),
        auto_deploy_enabled: true,
        auto_deploy_watch_paths: Vec::new(),
        auto_deploy_cleanup_stale_deployments: true,
        deploy_webhook_token: None,
        port: 8080,
        services: Vec::new(),
        rollout_strategy: RolloutStrategy::StopFirst,
        owner_id,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    };

    resolve_app_deployment_source(state, owner_id, &app).await
}

#[cfg(test)]
mod services_test {
    use super::{supported_template_message, ServiceAction, TemplateKind};

    #[test]
    fn service_action_parser_accepts_canonical_actions() {
        assert_eq!(ServiceAction::parse("start"), Some(ServiceAction::Start));
        assert_eq!(ServiceAction::parse("stop"), Some(ServiceAction::Stop));
        assert_eq!(
            ServiceAction::parse("restart"),
            Some(ServiceAction::Restart)
        );
        assert_eq!(ServiceAction::parse("unknown"), None);
    }

    #[test]
    fn template_kind_accepts_current_service_templates() {
        assert_eq!(
            TemplateKind::parse("postgresql"),
            Some(TemplateKind::Postgresql)
        );
        assert_eq!(TemplateKind::parse("valkey"), Some(TemplateKind::Redis));
        assert_eq!(TemplateKind::parse("mariadb"), Some(TemplateKind::Mariadb));
        assert_eq!(TemplateKind::parse("qdrant"), Some(TemplateKind::Qdrant));
        assert_eq!(
            TemplateKind::parse("rabbitmq"),
            Some(TemplateKind::Rabbitmq)
        );
        assert_eq!(TemplateKind::parse("unknown"), None);
    }

    #[test]
    fn template_kind_reports_queue_template_only_for_rabbitmq() {
        assert!(TemplateKind::Rabbitmq.is_queue());
        assert!(!TemplateKind::Postgresql.is_queue());
    }

    #[test]
    fn supported_template_message_lists_current_templates() {
        assert_eq!(
            supported_template_message(),
            "invalid template. supported: postgresql, redis, mariadb, qdrant, rabbitmq"
        );
    }
}
