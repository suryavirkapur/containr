//! managed databases api handlers

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
use znskr_common::managed_services::{DatabaseType, ManagedDatabase, ServiceStatus};
use znskr_runtime::DatabaseManager;

/// database creation request
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateDatabaseRequest {
    /// database name
    pub name: String,
    /// database type
    pub db_type: String,
    /// version (optional, uses default)
    pub version: Option<String>,
    /// memory limit in mb (optional)
    pub memory_limit_mb: Option<u64>,
    /// cpu limit (optional)
    pub cpu_limit: Option<f64>,
}

/// database response
#[derive(Debug, Serialize, ToSchema)]
pub struct DatabaseResponse {
    pub id: String,
    pub name: String,
    pub db_type: String,
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

impl From<&ManagedDatabase> for DatabaseResponse {
    fn from(db: &ManagedDatabase) -> Self {
        Self {
            id: db.id.to_string(),
            name: db.name.clone(),
            db_type: format!("{:?}", db.db_type).to_lowercase(),
            version: db.version.clone(),
            status: format!("{:?}", db.status).to_lowercase(),
            internal_host: db.internal_host.clone(),
            port: db.port,
            connection_string: db.connection_string(),
            username: db.credentials.username.clone(),
            memory_limit_mb: db.memory_limit / (1024 * 1024),
            cpu_limit: db.cpu_limit,
            created_at: db.created_at.to_rfc3339(),
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

/// list all databases for the authenticated user
#[utoipa::path(
    get,
    path = "/api/databases",
    tag = "databases",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "list of databases", body = Vec<DatabaseResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn list_databases(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<DatabaseResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let databases = state
        .db
        .list_managed_databases_by_owner(user_id)
        .map_err(internal_error)?;

    let responses: Vec<DatabaseResponse> = databases.iter().map(DatabaseResponse::from).collect();
    Ok(Json(responses))
}

/// create a new managed database
#[utoipa::path(
    post,
    path = "/api/databases",
    tag = "databases",
    security(("bearer" = [])),
    request_body = CreateDatabaseRequest,
    responses(
        (status = 201, description = "database created", body = DatabaseResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn create_database(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateDatabaseRequest>,
) -> Result<(StatusCode, Json<DatabaseResponse>), (StatusCode, Json<ErrorResponse>)> {
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

    // parse database type
    let db_type = match req.db_type.to_lowercase().as_str() {
        "postgresql" | "postgres" => DatabaseType::Postgresql,
        "mariadb" | "mysql" => DatabaseType::Mariadb,
        "valkey" | "redis" => DatabaseType::Valkey,
        "qdrant" => DatabaseType::Qdrant,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "invalid db_type. supported: postgresql, mariadb, valkey, qdrant".to_string(),
                }),
            ));
        }
    };

    // create database
    let mut db = ManagedDatabase::new(user_id, req.name, db_type);

    if let Some(version) = req.version {
        db.version = version;
    }
    if let Some(mem) = req.memory_limit_mb {
        db.memory_limit = mem * 1024 * 1024;
    }
    if let Some(cpu) = req.cpu_limit {
        db.cpu_limit = cpu;
    }

    state.db.save_managed_database(&db).map_err(internal_error)?;

    Ok((StatusCode::CREATED, Json(DatabaseResponse::from(&db))))
}

/// get a single database by id
#[utoipa::path(
    get,
    path = "/api/databases/{id}",
    tag = "databases",
    params(("id" = Uuid, Path, description = "database id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "database details", body = DatabaseResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn get_database(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<DatabaseResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let db = state
        .db
        .get_managed_database(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "database not found".to_string(),
                }),
            )
        })?;

    // check ownership
    if db.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    Ok(Json(DatabaseResponse::from(&db)))
}

/// delete a managed database
#[utoipa::path(
    delete,
    path = "/api/databases/{id}",
    tag = "databases",
    params(("id" = Uuid, Path, description = "database id")),
    security(("bearer" = [])),
    responses(
        (status = 204, description = "database deleted"),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn delete_database(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let db = state
        .db
        .get_managed_database(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "database not found".to_string(),
                }),
            )
        })?;

    // check ownership
    if db.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    // todo: stop and remove container + volume

    state.db.delete_managed_database(id).map_err(internal_error)?;

    Ok(StatusCode::NO_CONTENT)
}

/// update database status (start/stop)
#[utoipa::path(
    post,
    path = "/api/databases/{id}/start",
    tag = "databases",
    params(("id" = Uuid, Path, description = "database id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "database started", body = DatabaseResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn start_database(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<DatabaseResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let mut db = state
        .db
        .get_managed_database(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "database not found".to_string(),
                }),
            )
        })?;

    if db.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    // start the container via database manager
    let db_manager = DatabaseManager::new();
    db_manager.start_database(&mut db).map_err(|e| {
        tracing::error!("failed to start database: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("failed to start database: {}", e),
            }),
        )
    })?;

    state.db.save_managed_database(&db).map_err(internal_error)?;

    Ok(Json(DatabaseResponse::from(&db)))
}

/// stop a database
#[utoipa::path(
    post,
    path = "/api/databases/{id}/stop",
    tag = "databases",
    params(("id" = Uuid, Path, description = "database id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "database stopped", body = DatabaseResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn stop_database(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<DatabaseResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let mut db = state
        .db
        .get_managed_database(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "database not found".to_string(),
                }),
            )
        })?;

    if db.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    // stop the container via database manager
    let db_manager = DatabaseManager::new();
    db_manager.stop_database(&mut db).map_err(|e| {
        tracing::error!("failed to stop database: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("failed to stop database: {}", e),
            }),
        )
    })?;

    state.db.save_managed_database(&db).map_err(internal_error)?;

    Ok(Json(DatabaseResponse::from(&db)))
}
