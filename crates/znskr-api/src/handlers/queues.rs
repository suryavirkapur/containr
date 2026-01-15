//! managed queues api handlers

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use znskr_common::managed_services::{ManagedQueue, QueueType};
use znskr_runtime::QueueManager;

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
}

/// queue response
#[derive(Debug, Serialize, ToSchema)]
pub struct QueueResponse {
    pub id: String,
    pub name: String,
    pub queue_type: String,
    pub version: String,
    pub status: String,
    pub internal_host: String,
    pub port: u16,
    pub connection_string: String,
    pub username: String,
    pub memory_limit_mb: u64,
    pub cpu_limit: f64,
    pub created_at: String,
}

impl From<&ManagedQueue> for QueueResponse {
    fn from(queue: &ManagedQueue) -> Self {
        Self {
            id: queue.id.to_string(),
            name: queue.name.clone(),
            queue_type: format!("{:?}", queue.queue_type).to_lowercase(),
            version: queue.version.clone(),
            status: format!("{:?}", queue.status).to_lowercase(),
            internal_host: queue.internal_host.clone(),
            port: queue.port,
            connection_string: queue.connection_string(),
            username: queue.credentials.username.clone(),
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
fn internal_error<E: std::fmt::Display>(e: E) -> (StatusCode, Json<ErrorResponse>) {
    tracing::error!("internal error: {}", e);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: "internal server error".to_string(),
        }),
    )
}

/// list all queues for the authenticated user
#[utoipa::path(
    get,
    path = "/api/queues",
    tag = "queues",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "list of queues", body = Vec<QueueResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn list_queues(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<QueueResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let queues = state
        .db
        .list_managed_queues_by_owner(user_id)
        .map_err(internal_error)?;

    let responses: Vec<QueueResponse> = queues.iter().map(QueueResponse::from).collect();
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
) -> Result<(StatusCode, Json<QueueResponse>), (StatusCode, Json<ErrorResponse>)> {
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
        "nats" => QueueType::Nats,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "invalid queue_type. supported: rabbitmq, nats".to_string(),
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

    state.db.save_managed_queue(&queue).map_err(internal_error)?;

    Ok((StatusCode::CREATED, Json(QueueResponse::from(&queue))))
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

    Ok(Json(QueueResponse::from(&queue)))
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
    let _ = queue_manager.stop_queue(&mut queue_to_stop);

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
    queue_manager.start_queue(&mut queue).map_err(|e| {
        tracing::error!("failed to start queue: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("failed to start queue: {}", e),
            }),
        )
    })?;

    state.db.save_managed_queue(&queue).map_err(internal_error)?;
    Ok(Json(QueueResponse::from(&queue)))
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
    queue_manager.stop_queue(&mut queue).map_err(|e| {
        tracing::error!("failed to stop queue: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("failed to stop queue: {}", e),
            }),
        )
    })?;

    state.db.save_managed_queue(&queue).map_err(internal_error)?;
    Ok(Json(QueueResponse::from(&queue)))
}
