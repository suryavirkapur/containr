use std::io::ErrorKind;
use std::path::{Path as FsPath, PathBuf};

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::ErrorResponse;
use crate::handlers::{apps, databases, queues};
use crate::security::resolve_encryption_secret;
use crate::state::AppState;
use containr_common::managed_services::{
    ManagedDatabase, ManagedQueue, ServiceStatus,
};
use containr_common::models::{
    App, ContainerService, Deployment, DeploymentStatus, ServiceDeployment,
};
use containr_common::service_inventory::ServiceInventoryItem;
use containr_runtime::{
    AppServiceManager, DatabaseManager, DockerContainerManager,
    ProxyRouteUpdate, QueueManager,
};

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

#[derive(Debug, Deserialize, ToSchema)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum CreateServiceRequest {
    GitRepository {
        name: String,
        github_url: String,
        branch: Option<String>,
        env_vars: Option<Vec<apps::EnvVarRequest>>,
        service: apps::ServiceRequest,
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
enum TemplateKind {
    Postgresql,
    Redis,
    Mariadb,
    Qdrant,
    Rabbitmq,
}

impl TemplateKind {
    fn parse(value: &str) -> Option<Self> {
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

fn get_user_id(
    headers: &HeaderMap,
    jwt_secret: &str,
) -> Result<Uuid, (StatusCode, Json<ErrorResponse>)> {
    let auth_header = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: "missing authorization header".to_string(),
                }),
            )
        })?;

    let token = extract_bearer_token(auth_header).ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "invalid authorization header".to_string(),
            }),
        )
    })?;

    let claims = validate_token(token, jwt_secret).map_err(|error| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: error.to_string(),
            }),
        )
    })?;

    Ok(claims.sub)
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

fn supported_template_message() -> &'static str {
    "invalid template. supported: postgresql, redis, mariadb, qdrant, rabbitmq"
}

fn parse_created_service_id(
    id: &str,
) -> Result<Uuid, (StatusCode, Json<ErrorResponse>)> {
    Uuid::parse_str(id).map_err(internal_error)
}

fn first_app_service_id(
    app: &apps::AppResponse,
) -> Result<Uuid, (StatusCode, Json<ErrorResponse>)> {
    let service = app.services.first().ok_or_else(|| {
        internal_error("created project did not return a service")
    })?;

    parse_created_service_id(&service.id)
}

fn ensure_database_not_starting(
    database: &ManagedDatabase,
) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
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

fn resolve_group_id(
    state: &AppState,
    user_id: Uuid,
    group_id: Option<&str>,
) -> Result<Option<Uuid>, (StatusCode, Json<ErrorResponse>)> {
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
) -> Result<OwnedServiceRecord, (StatusCode, Json<ErrorResponse>)> {
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
                        error: "project not found".to_string(),
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

fn resolve_service_response(
    state: &AppState,
    user_id: Uuid,
    service_id: Uuid,
    base_domain: &str,
    public_ip: Option<&str>,
) -> Result<InventoryServiceResponse, (StatusCode, Json<ErrorResponse>)> {
    let inventory = state
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
) -> Result<Option<Deployment>, (StatusCode, Json<ErrorResponse>)> {
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
) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
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
) -> Result<AppServiceManager, (StatusCode, Json<ErrorResponse>)> {
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
) -> Result<String, (StatusCode, Json<ErrorResponse>)> {
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
) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
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
) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
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

async fn delete_app_service(
    state: &AppState,
    app: &App,
    service: &ContainerService,
    encryption_secret: Option<String>,
) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
    if app.services.len() <= 1 {
        return Err(bad_request(
            "cannot delete the last service from a project",
        ));
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

    Ok(())
}

#[utoipa::path(
    post,
    path = "/api/services",
    tag = "services",
    security(("bearer" = [])),
    request_body = CreateServiceRequest,
    responses(
        (status = 201, description = "service created", body = InventoryServiceResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 409, description = "conflict", body = ErrorResponse)
    )
)]
pub async fn create_service(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateServiceRequest>,
) -> Result<
    (StatusCode, Json<InventoryServiceResponse>),
    (StatusCode, Json<ErrorResponse>),
> {
    let config = state.config.read().await.clone();
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    let created_service_id = match req {
        CreateServiceRequest::GitRepository {
            name,
            github_url,
            branch,
            env_vars,
            mut service,
            rollout_strategy,
        } => {
            if service.name.trim().is_empty() {
                service.name = name.clone();
            }

            let (_, Json(app)) = apps::create_app(
                State(state.clone()),
                headers.clone(),
                Json(apps::CreateAppRequest {
                    name,
                    github_url,
                    branch,
                    domains: None,
                    domain: None,
                    port: None,
                    env_vars,
                    services: Some(vec![service]),
                    rollout_strategy,
                }),
            )
            .await?;

            first_app_service_id(&app)?
        }
        CreateServiceRequest::Template {
            name,
            template,
            version,
            memory_limit_mb,
            cpu_limit,
            group_id,
        } => {
            let template = TemplateKind::parse(&template)
                .ok_or_else(|| bad_request(supported_template_message()))?;

            if template.is_queue() {
                let (_, Json(queue)) = queues::create_queue(
                    State(state.clone()),
                    headers.clone(),
                    Json(queues::CreateQueueRequest {
                        name,
                        queue_type: template.api_name().to_string(),
                        version,
                        memory_limit_mb,
                        cpu_limit,
                        group_id,
                    }),
                )
                .await?;

                parse_created_service_id(&queue.id)?
            } else {
                let (_, Json(database)) = databases::create_database(
                    State(state.clone()),
                    headers.clone(),
                    Json(databases::CreateDatabaseRequest {
                        name,
                        db_type: template.api_name().to_string(),
                        version,
                        memory_limit_mb,
                        cpu_limit,
                        group_id,
                    }),
                )
                .await?;

                parse_created_service_id(&database.id)?
            }
        }
    };

    let response = resolve_service_response(
        &state,
        user_id,
        created_service_id,
        &config.proxy.base_domain,
        config.proxy.public_ip.as_deref(),
    )?;

    Ok((StatusCode::CREATED, Json(response)))
}

#[utoipa::path(
    get,
    path = "/api/services",
    tag = "services",
    params(ListServicesQuery),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "list of services", body = Vec<InventoryServiceResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn list_services(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListServicesQuery>,
) -> Result<
    Json<Vec<InventoryServiceResponse>>,
    (StatusCode, Json<ErrorResponse>),
> {
    let config = state.config.read().await.clone();
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    let group_id =
        resolve_group_id(&state, user_id, query.group_id.as_deref())?;
    let inventory = state
        .db
        .list_service_inventory_by_owner_and_group(user_id, group_id)
        .map_err(internal_error)?;
    let responses = inventory
        .iter()
        .map(|service| {
            InventoryServiceResponse::from_inventory(
                service,
                &config.proxy.base_domain,
                config.proxy.public_ip.as_deref(),
            )
        })
        .collect::<Vec<_>>();

    Ok(Json(responses))
}

#[utoipa::path(
    get,
    path = "/api/services/{id}",
    tag = "services",
    params(("id" = Uuid, Path, description = "service id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "service details", body = InventoryServiceResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse)
    )
)]
pub async fn get_service(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<InventoryServiceResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await.clone();
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    let response = resolve_service_response(
        &state,
        user_id,
        id,
        &config.proxy.base_domain,
        config.proxy.public_ip.as_deref(),
    )?;

    Ok(Json(response))
}

#[utoipa::path(
    get,
    path = "/api/services/{id}/logs",
    tag = "services",
    params(
        ("id" = Uuid, Path, description = "service id"),
        ServiceLogsQuery
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "service logs", body = ServiceLogsResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse)
    )
)]
pub async fn get_service_logs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(query): Query<ServiceLogsQuery>,
) -> Result<Json<ServiceLogsResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await.clone();
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    let logs = match resolve_owned_service_record(&state, user_id, id)? {
        OwnedServiceRecord::App { app, service } => {
            get_app_service_logs(
                &state,
                &app,
                &service,
                query.tail,
                resolve_encryption_secret(&config),
            )
            .await?
        }
        OwnedServiceRecord::ManagedDatabase(database) => DatabaseManager::new()
            .get_logs(&database, query.tail)
            .await
            .map_err(|error| {
                service_manager_error("read service logs", error)
            })?,
        OwnedServiceRecord::ManagedQueue(queue) => {
            let Some(container_id) = queue.container_id.as_deref() else {
                return Ok(Json(ServiceLogsResponse {
                    logs: String::new(),
                }));
            };
            DockerContainerManager::new()
                .get_logs(container_id, query.tail)
                .await
                .map_err(|error| {
                    service_manager_error("read service logs", error)
                })?
        }
    };

    Ok(Json(ServiceLogsResponse { logs }))
}

#[utoipa::path(
    post,
    path = "/api/services/{id}/start",
    tag = "services",
    params(("id" = Uuid, Path, description = "service id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "service started", body = InventoryServiceResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse)
    )
)]
pub async fn start_service(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<InventoryServiceResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await.clone();
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    match resolve_owned_service_record(&state, user_id, id)? {
        OwnedServiceRecord::App { app, service } => {
            start_app_service(
                &state,
                &app,
                &service,
                resolve_encryption_secret(&config),
            )
            .await?;
        }
        OwnedServiceRecord::ManagedDatabase(mut database) => {
            let manager = DatabaseManager::new();
            ensure_database_not_starting(&database)?;
            if manager.is_running(&database).await {
                return Err(bad_request("database is already running"));
            }

            mark_database_starting(&mut database);
            state
                .db
                .save_managed_database(&database)
                .map_err(internal_error)?;

            if let Err(error) = manager.start_database(&mut database).await {
                database.status = ServiceStatus::Failed;
                database.updated_at = Utc::now();
                let _ = state.db.save_managed_database(&database);
                return Err(service_manager_error("start service", error));
            }
            state
                .db
                .save_managed_database(&database)
                .map_err(internal_error)?;
        }
        OwnedServiceRecord::ManagedQueue(mut queue) => {
            QueueManager::new().start_queue(&mut queue).await.map_err(
                |error| service_manager_error("start service", error),
            )?;
            state
                .db
                .save_managed_queue(&queue)
                .map_err(internal_error)?;
        }
    }

    let response = resolve_service_response(
        &state,
        user_id,
        id,
        &config.proxy.base_domain,
        config.proxy.public_ip.as_deref(),
    )?;
    Ok(Json(response))
}

#[utoipa::path(
    post,
    path = "/api/services/{id}/stop",
    tag = "services",
    params(("id" = Uuid, Path, description = "service id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "service stopped", body = InventoryServiceResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse)
    )
)]
pub async fn stop_service(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<InventoryServiceResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await.clone();
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    match resolve_owned_service_record(&state, user_id, id)? {
        OwnedServiceRecord::App { app, service } => {
            stop_app_service(
                &state,
                &app,
                &service,
                resolve_encryption_secret(&config),
            )
            .await?;
        }
        OwnedServiceRecord::ManagedDatabase(mut database) => {
            DatabaseManager::new()
                .stop_database(&mut database)
                .await
                .map_err(|error| {
                    service_manager_error("stop service", error)
                })?;
            state
                .db
                .save_managed_database(&database)
                .map_err(internal_error)?;
        }
        OwnedServiceRecord::ManagedQueue(mut queue) => {
            QueueManager::new().stop_queue(&mut queue).await.map_err(
                |error| service_manager_error("stop service", error),
            )?;
            state
                .db
                .save_managed_queue(&queue)
                .map_err(internal_error)?;
        }
    }

    let response = resolve_service_response(
        &state,
        user_id,
        id,
        &config.proxy.base_domain,
        config.proxy.public_ip.as_deref(),
    )?;
    Ok(Json(response))
}

#[utoipa::path(
    post,
    path = "/api/services/{id}/restart",
    tag = "services",
    params(("id" = Uuid, Path, description = "service id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "service restarted", body = InventoryServiceResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse)
    )
)]
pub async fn restart_service(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<InventoryServiceResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await.clone();
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    match resolve_owned_service_record(&state, user_id, id)? {
        OwnedServiceRecord::App { app, service } => {
            if service.is_cron_job() {
                return Err(bad_request(
                    "cron jobs are scheduled and cannot be restarted manually",
                ));
            }
            stop_app_service(
                &state,
                &app,
                &service,
                resolve_encryption_secret(&config),
            )
            .await?;
            start_app_service(
                &state,
                &app,
                &service,
                resolve_encryption_secret(&config),
            )
            .await?;
        }
        OwnedServiceRecord::ManagedDatabase(mut database) => {
            ensure_database_not_starting(&database)?;
            let manager = DatabaseManager::new();
            manager
                .stop_database(&mut database)
                .await
                .map_err(|error| {
                    service_manager_error("restart service", error)
                })?;

            mark_database_starting(&mut database);
            state
                .db
                .save_managed_database(&database)
                .map_err(internal_error)?;

            if let Err(error) = manager.start_database(&mut database).await {
                database.status = ServiceStatus::Failed;
                database.updated_at = Utc::now();
                let _ = state.db.save_managed_database(&database);
                return Err(service_manager_error("restart service", error));
            }
            state
                .db
                .save_managed_database(&database)
                .map_err(internal_error)?;
        }
        OwnedServiceRecord::ManagedQueue(mut queue) => {
            let manager = QueueManager::new();
            manager.stop_queue(&mut queue).await.map_err(|error| {
                service_manager_error("restart service", error)
            })?;
            manager.start_queue(&mut queue).await.map_err(|error| {
                service_manager_error("restart service", error)
            })?;
            state
                .db
                .save_managed_queue(&queue)
                .map_err(internal_error)?;
        }
    }

    let response = resolve_service_response(
        &state,
        user_id,
        id,
        &config.proxy.base_domain,
        config.proxy.public_ip.as_deref(),
    )?;
    Ok(Json(response))
}

#[utoipa::path(
    delete,
    path = "/api/services/{id}",
    tag = "services",
    params(("id" = Uuid, Path, description = "service id")),
    security(("bearer" = [])),
    responses(
        (status = 204, description = "service deleted"),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse)
    )
)]
pub async fn delete_service(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await.clone();
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    match resolve_owned_service_record(&state, user_id, id)? {
        OwnedServiceRecord::App { app, service } => {
            delete_app_service(
                &state,
                &app,
                &service,
                resolve_encryption_secret(&config),
            )
            .await?;
        }
        OwnedServiceRecord::ManagedDatabase(mut database) => {
            let _ = DatabaseManager::new().stop_database(&mut database).await;
            let database_root = database.root_path();
            if database_root.starts_with(&config.storage.data_dir) {
                let _ = tokio::fs::remove_dir_all(&database_root).await;
            }
            state
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
            state
                .db
                .delete_managed_queue(queue.id)
                .map_err(internal_error)?;
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
#[path = "services_test.rs"]
mod services_test;
