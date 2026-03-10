//! managed queues api handlers

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use containr_common::managed_services::{
    ManagedQueue, QueueType, ServiceStatus,
};
use containr_runtime::QueueManager;

/// queue creation request
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateQueueRequest {
    /// queue name
    pub name: String,
    /// queue type
    pub queue_type: String,
    /// version (optional, uses default)
    pub version: Option<String>,
    /// memory limit in mb (optional)
    pub memory_limit_mb: Option<u64>,
    /// cpu limit (optional)
    pub cpu_limit: Option<f64>,
    /// attach this service to a project group
    pub group_id: Option<String>,
}

/// queue response
#[derive(Debug, Serialize, ToSchema)]
pub struct QueueResponse {
    pub id: String,
    pub name: String,
    pub queue_type: String,
    pub service_type: String,
    pub group_id: Option<String>,
    pub network_name: String,
    pub version: String,
    pub status: String,
    pub internal_host: String,
    pub port: u16,
    pub external_port: Option<u16>,
    pub public_ip: Option<String>,
    pub public_connection_string: Option<String>,
    pub connection_string: String,
    pub username: String,
    pub password: String,
    pub memory_limit_mb: u64,
    pub cpu_limit: f64,
    pub created_at: String,
}

impl From<&ManagedQueue> for QueueResponse {
    fn from(queue: &ManagedQueue) -> Self {
        Self::from_queue(queue, None)
    }
}

impl QueueResponse {
    fn from_queue(queue: &ManagedQueue, public_ip: Option<&str>) -> Self {
        Self {
            id: queue.id.to_string(),
            name: queue.name.clone(),
            queue_type: queue.queue_type.api_name().to_string(),
            service_type: queue.service_type_name().to_string(),
            group_id: queue.group_id.map(|value| value.to_string()),
            network_name: queue.network_name(),
            version: queue.version.clone(),
            status: format!("{:?}", queue.status).to_lowercase(),
            internal_host: queue.normalized_internal_host(),
            port: queue.port,
            external_port: queue.external_port,
            public_ip: public_ip.map(|value| value.to_string()),
            public_connection_string: queue.external_port.and_then(|port| {
                build_public_queue_connection_string(queue, public_ip, port)
            }),
            connection_string: queue.connection_string(),
            username: queue.credentials.username.clone(),
            password: queue.credentials.password.clone(),
            memory_limit_mb: queue.memory_limit / (1024 * 1024),
            cpu_limit: queue.cpu_limit,
            created_at: queue.created_at.to_rfc3339(),
        }
    }
}

/// extracts user id from authorization header
fn get_user_id(
    headers: &HeaderMap,
    jwt_secret: &str,
) -> Result<Uuid, (StatusCode, Json<ErrorResponse>)> {
    let auth_header = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
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

    let claims = validate_token(token, jwt_secret).map_err(|e| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;

    Ok(claims.sub)
}

/// helper for internal errors
fn internal_error<E: std::fmt::Display>(
    e: E,
) -> (StatusCode, Json<ErrorResponse>) {
    tracing::error!("internal error: {}", e);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: "internal server error".to_string(),
        }),
    )
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct ListQueuesQuery {
    pub group_id: Option<String>,
}

fn allocate_public_port(
    requested_port: Option<u16>,
) -> Result<u16, (StatusCode, Json<ErrorResponse>)> {
    if let Some(port) = requested_port {
        if !(1024..=65535).contains(&port) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "external_port must be between 1024 and 65535"
                        .to_string(),
                }),
            ));
        }

        if std::net::TcpListener::bind(("0.0.0.0", port)).is_err() {
            return Err((
                StatusCode::CONFLICT,
                Json(ErrorResponse {
                    error: "external_port is already in use".to_string(),
                }),
            ));
        }

        return Ok(port);
    }

    let mut rng = rand::rng();
    for _ in 0..64 {
        let candidate = rng.random_range(30000..40000);
        if std::net::TcpListener::bind(("0.0.0.0", candidate)).is_ok() {
            return Ok(candidate);
        }
    }

    Err((
        StatusCode::CONFLICT,
        Json(ErrorResponse {
            error: "failed to allocate an external port".to_string(),
        }),
    ))
}

fn should_restart_service(
    status: ServiceStatus,
    container_id: &Option<String>,
) -> bool {
    container_id.is_some()
        || matches!(status, ServiceStatus::Running | ServiceStatus::Starting)
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

    let group_id = Uuid::parse_str(group_id).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "group_id must be a valid uuid".to_string(),
            }),
        )
    })?;
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

fn build_public_queue_connection_string(
    queue: &ManagedQueue,
    public_ip: Option<&str>,
    port: u16,
) -> Option<String> {
    let public_ip = public_ip?.trim();
    if public_ip.is_empty() {
        return None;
    }

    Some(match queue.queue_type {
        QueueType::Rabbitmq => format!(
            "amqp://{}:{}@{}:{}",
            queue.credentials.username,
            queue.credentials.password,
            public_ip,
            port
        ),
        QueueType::Nats => format!(
            "nats://{}:{}@{}:{}",
            queue.credentials.username,
            queue.credentials.password,
            public_ip,
            port
        ),
    })
}

/// list all queues for the authenticated user
#[utoipa::path(
    get,
    path = "/api/queues",
    tag = "queues",
    params(ListQueuesQuery),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "list of queues", body = Vec<QueueResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn list_queues(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQueuesQuery>,
) -> Result<Json<Vec<QueueResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    let public_ip = config.proxy.public_ip.clone();
    drop(config);
    let group_id =
        resolve_group_id(&state, user_id, query.group_id.as_deref())?;

    let queues = state
        .db
        .list_managed_queues_by_owner(user_id)
        .map_err(internal_error)?
        .into_iter()
        .filter(|queue| match group_id {
            Some(group_id) => queue.group_id == Some(group_id),
            None => true,
        })
        .collect::<Vec<_>>();

    let responses = queues
        .iter()
        .map(|queue| QueueResponse::from_queue(queue, public_ip.as_deref()))
        .collect::<Vec<_>>();
    Ok(Json(responses))
}

/// create a new managed queue
#[utoipa::path(
    post,
    path = "/api/queues",
    tag = "queues",
    security(("bearer" = [])),
    request_body = CreateQueueRequest,
    responses(
        (status = 201, description = "queue created", body = QueueResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn create_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateQueueRequest>,
) -> Result<(StatusCode, Json<QueueResponse>), (StatusCode, Json<ErrorResponse>)>
{
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    // validate name
    if req.name.is_empty() || req.name.len() > 64 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "name must be 1-64 characters".to_string(),
            }),
        ));
    }

    // parse queue type
    let queue_type = match req.queue_type.to_lowercase().as_str() {
        "rabbitmq" => QueueType::Rabbitmq,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "invalid queue_type. supported: rabbitmq"
                        .to_string(),
                }),
            ));
        }
    };

    // create queue
    let mut queue = ManagedQueue::new_with_path(
        user_id,
        req.name,
        queue_type,
        &config.storage.data_dir,
    );

    if let Some(version) = req.version {
        queue.version = version;
    }
    if let Some(mem) = req.memory_limit_mb {
        queue.memory_limit = mem * 1024 * 1024;
    }
    if let Some(cpu) = req.cpu_limit {
        queue.cpu_limit = cpu;
    }
    queue.group_id =
        resolve_group_id(&state, user_id, req.group_id.as_deref())?;

    state
        .db
        .save_managed_queue(&queue)
        .map_err(internal_error)?;

    let queue_manager = QueueManager::new();
    if let Err(error) = queue_manager.start_queue(&mut queue).await {
        queue.status = ServiceStatus::Failed;
        queue.updated_at = chrono::Utc::now();

        if let Err(save_error) = state.db.save_managed_queue(&queue) {
            return Err(internal_error(format!(
                "failed to persist queue failure: {}",
                save_error
            )));
        }

        tracing::error!("failed to start queue: {}", error);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("failed to start queue: {}", error),
            }),
        ));
    }

    state
        .db
        .save_managed_queue(&queue)
        .map_err(internal_error)?;

    Ok((
        StatusCode::CREATED,
        Json(QueueResponse::from_queue(
            &queue,
            config.proxy.public_ip.as_deref(),
        )),
    ))
}

/// get a single queue by id
#[utoipa::path(
    get,
    path = "/api/queues/{id}",
    tag = "queues",
    params(("id" = Uuid, Path, description = "queue id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "queue details", body = QueueResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "queue not found", body = ErrorResponse)
    )
)]
pub async fn get_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<QueueResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let queue = state
        .db
        .get_managed_queue(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "queue not found".to_string(),
                }),
            )
        })?;

    if queue.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "forbidden".to_string(),
            }),
        ));
    }

    Ok(Json(QueueResponse::from_queue(
        &queue,
        config.proxy.public_ip.as_deref(),
    )))
}

/// delete a managed queue
#[utoipa::path(
    delete,
    path = "/api/queues/{id}",
    tag = "queues",
    params(("id" = Uuid, Path, description = "queue id")),
    security(("bearer" = [])),
    responses(
        (status = 204, description = "queue deleted"),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "queue not found", body = ErrorResponse)
    )
)]
pub async fn delete_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let queue = state
        .db
        .get_managed_queue(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "queue not found".to_string(),
                }),
            )
        })?;

    if queue.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "forbidden".to_string(),
            }),
        ));
    }

    // stop container and remove data directory
    let queue_manager = QueueManager::new();
    let mut queue_to_stop = queue.clone();
    let _ = queue_manager.stop_queue(&mut queue_to_stop).await;

    let data_dir = std::path::Path::new(&queue.host_data_path);
    if data_dir.starts_with(&config.storage.data_dir) {
        let _ = std::fs::remove_dir_all(data_dir);
    }

    state.db.delete_managed_queue(id).map_err(internal_error)?;
    Ok(StatusCode::NO_CONTENT)
}

/// start a queue
#[utoipa::path(
    post,
    path = "/api/queues/{id}/start",
    tag = "queues",
    params(("id" = Uuid, Path, description = "queue id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "queue started", body = QueueResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "queue not found", body = ErrorResponse)
    )
)]
pub async fn start_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<QueueResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let mut queue = state
        .db
        .get_managed_queue(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "queue not found".to_string(),
                }),
            )
        })?;

    if queue.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "forbidden".to_string(),
            }),
        ));
    }

    // start the container via queue manager
    let queue_manager = QueueManager::new();
    queue_manager.start_queue(&mut queue).await.map_err(|e| {
        tracing::error!("failed to start queue: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("failed to start queue: {}", e),
            }),
        )
    })?;

    state
        .db
        .save_managed_queue(&queue)
        .map_err(internal_error)?;
    Ok(Json(QueueResponse::from_queue(
        &queue,
        config.proxy.public_ip.as_deref(),
    )))
}

/// stop a queue
#[utoipa::path(
    post,
    path = "/api/queues/{id}/stop",
    tag = "queues",
    params(("id" = Uuid, Path, description = "queue id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "queue stopped", body = QueueResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "queue not found", body = ErrorResponse)
    )
)]
pub async fn stop_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<QueueResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let mut queue = state
        .db
        .get_managed_queue(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "queue not found".to_string(),
                }),
            )
        })?;

    if queue.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "forbidden".to_string(),
            }),
        ));
    }

    // stop the container via queue manager
    let queue_manager = QueueManager::new();
    queue_manager.stop_queue(&mut queue).await.map_err(|e| {
        tracing::error!("failed to stop queue: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("failed to stop queue: {}", e),
            }),
        )
    })?;

    state
        .db
        .save_managed_queue(&queue)
        .map_err(internal_error)?;
    Ok(Json(QueueResponse::from_queue(
        &queue,
        config.proxy.public_ip.as_deref(),
    )))
}

/// queue expose request
#[derive(Debug, Deserialize, ToSchema)]
pub struct ExposeQueueRequest {
    pub enabled: bool,
    pub external_port: Option<u16>,
}

/// toggle external exposure for a queue
#[utoipa::path(
    post,
    path = "/api/queues/{id}/expose",
    tag = "queues",
    params(("id" = Uuid, Path, description = "queue id")),
    request_body = ExposeQueueRequest,
    security(("bearer" = [])),
    responses(
        (status = 200, description = "exposure toggled", body = QueueResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "queue not found", body = ErrorResponse)
    )
)]
pub async fn expose_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<ExposeQueueRequest>,
) -> Result<Json<QueueResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let mut queue = state
        .db
        .get_managed_queue(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "queue not found".to_string(),
                }),
            )
        })?;

    if queue.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "forbidden".to_string(),
            }),
        ));
    }

    if req.enabled {
        queue.external_port = Some(allocate_public_port(req.external_port)?);
    } else {
        queue.external_port = None;
    }

    let restart_required =
        should_restart_service(queue.status, &queue.container_id);
    let queue_manager = QueueManager::new();

    if restart_required {
        queue_manager.stop_queue(&mut queue).await.map_err(|e| {
            tracing::error!("failed to stop queue: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("failed to stop queue: {}", e),
                }),
            )
        })?;

        queue_manager.start_queue(&mut queue).await.map_err(|e| {
            tracing::error!("failed to start queue: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("failed to start queue: {}", e),
                }),
            )
        })?;
    } else {
        queue.updated_at = chrono::Utc::now();
    }

    state
        .db
        .save_managed_queue(&queue)
        .map_err(internal_error)?;

    Ok(Json(QueueResponse::from_queue(
        &queue,
        config.proxy.public_ip.as_deref(),
    )))
}
