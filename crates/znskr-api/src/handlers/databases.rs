//! managed databases api handlers

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use znskr_common::managed_services::{DatabaseType, ManagedDatabase};
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
    pub external_port: Option<u16>,
    pub connection_string: String,
    pub username: String,
    pub password: String,
    pub database_name: String,
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
            external_port: db.external_port,
            connection_string: db.connection_string(),
            username: db.credentials.username.clone(),
            password: db.credentials.password.clone(),
            database_name: db.credentials.database_name.clone(),
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
                    error: "invalid db_type. supported: postgresql, mariadb, valkey, qdrant"
                        .to_string(),
                }),
            ));
        }
    };

    // create database
    let mut db =
        ManagedDatabase::new_with_path(user_id, req.name, db_type, &config.storage.data_dir);

    if let Some(version) = req.version {
        db.version = version;
    }
    if let Some(mem) = req.memory_limit_mb {
        db.memory_limit = mem * 1024 * 1024;
    }
    if let Some(cpu) = req.cpu_limit {
        db.cpu_limit = cpu;
    }

    state
        .db
        .save_managed_database(&db)
        .map_err(internal_error)?;

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

    // stop container and remove data directory
    let db_manager = DatabaseManager::new();
    let mut db_to_stop = db.clone();
    let _ = db_manager.stop_database(&mut db_to_stop).await;

    let data_dir = std::path::Path::new(&db.host_data_path);
    if data_dir.starts_with(&config.storage.data_dir) {
        let _ = std::fs::remove_dir_all(data_dir);
    }

    state
        .db
        .delete_managed_database(id)
        .map_err(internal_error)?;

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
    db_manager.start_database(&mut db).await.map_err(|e| {
        tracing::error!("failed to start database: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("failed to start database: {}", e),
            }),
        )
    })?;

    state
        .db
        .save_managed_database(&db)
        .map_err(internal_error)?;

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
    db_manager.stop_database(&mut db).await.map_err(|e| {
        tracing::error!("failed to stop database: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("failed to stop database: {}", e),
            }),
        )
    })?;

    state
        .db
        .save_managed_database(&db)
        .map_err(internal_error)?;

    Ok(Json(DatabaseResponse::from(&db)))
}

/// logs query params
#[derive(Debug, Deserialize)]
pub struct LogsQuery {
    #[serde(default = "default_tail")]
    pub tail: usize,
}

fn default_tail() -> usize {
    100
}

/// logs response
#[derive(Debug, Serialize, ToSchema)]
pub struct LogsResponse {
    pub logs: String,
}

/// get database container logs
#[utoipa::path(
    get,
    path = "/api/databases/{id}/logs",
    tag = "databases",
    params(
        ("id" = Uuid, Path, description = "database id"),
        ("tail" = Option<usize>, Query, description = "number of log lines")
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "container logs", body = LogsResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn get_database_logs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(query): Query<LogsQuery>,
) -> Result<Json<LogsResponse>, (StatusCode, Json<ErrorResponse>)> {
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

    if db.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    let db_manager = DatabaseManager::new();
    let logs = db_manager.get_logs(&db, query.tail).await.map_err(|e| {
        tracing::error!("failed to get logs: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("failed to get logs: {}", e),
            }),
        )
    })?;

    Ok(Json(LogsResponse { logs }))
}

/// expose request
#[derive(Debug, Deserialize, ToSchema)]
pub struct ExposeRequest {
    pub enabled: bool,
}

/// toggle external exposure for a database
#[utoipa::path(
    post,
    path = "/api/databases/{id}/expose",
    tag = "databases",
    params(("id" = Uuid, Path, description = "database id")),
    request_body = ExposeRequest,
    security(("bearer" = [])),
    responses(
        (status = 200, description = "exposure toggled", body = DatabaseResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn expose_database(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<ExposeRequest>,
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

    let db_manager = DatabaseManager::new();

    // stop existing container
    db_manager.stop_database(&mut db).await.map_err(|e| {
        tracing::error!("failed to stop database: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("failed to stop database: {}", e),
            }),
        )
    })?;

    // set or clear external port
    if req.enabled {
        let mut rng = rand::rng();
        db.external_port = Some(rng.random_range(30000..40000));
    } else {
        db.external_port = None;
    }

    // restart container (start_database respects external_port if set)
    db_manager.start_database(&mut db).await.map_err(|e| {
        tracing::error!("failed to start database: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("failed to start database: {}", e),
            }),
        )
    })?;

    state
        .db
        .save_managed_database(&db)
        .map_err(internal_error)?;

    Ok(Json(DatabaseResponse::from(&db)))
}

/// export response
#[derive(Debug, Serialize, ToSchema)]
pub struct ExportResponse {
    pub backup_path: String,
}

/// export database backup
#[utoipa::path(
    post,
    path = "/api/databases/{id}/export",
    tag = "databases",
    params(("id" = Uuid, Path, description = "database id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "backup created", body = ExportResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn export_database(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<ExportResponse>, (StatusCode, Json<ErrorResponse>)> {
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

    if db.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    let backup_dir = std::path::Path::new(&config.storage.data_dir).join("backups");
    std::fs::create_dir_all(&backup_dir).map_err(internal_error)?;

    let db_manager = DatabaseManager::new();
    let backup_path = db_manager
        .export_database(&db, &backup_dir)
        .await
        .map_err(|e| {
            tracing::error!("failed to export database: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("failed to export database: {}", e),
                }),
            )
        })?;

    Ok(Json(ExportResponse { backup_path }))
}

/// backup info
#[derive(Debug, Serialize, ToSchema)]
pub struct BackupInfo {
    pub filename: String,
    pub size_bytes: u64,
    pub created_at: String,
}

/// list database backups
#[utoipa::path(
    get,
    path = "/api/databases/{id}/backups",
    tag = "databases",
    params(("id" = Uuid, Path, description = "database id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "list of backups", body = Vec<BackupInfo>),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn list_backups(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<BackupInfo>>, (StatusCode, Json<ErrorResponse>)> {
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

    if db.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    let backup_dir = std::path::Path::new(&config.storage.data_dir).join("backups");
    let mut backups = Vec::new();

    if backup_dir.exists() {
        let prefix = format!("{}_", db.name);
        if let Ok(entries) = std::fs::read_dir(&backup_dir) {
            for entry in entries.flatten() {
                let filename = entry.file_name().to_string_lossy().to_string();
                if filename.starts_with(&prefix) {
                    if let Ok(meta) = entry.metadata() {
                        let created_at = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0))
                            .map(|dt| dt.to_rfc3339())
                            .unwrap_or_default();

                        backups.push(BackupInfo {
                            filename,
                            size_bytes: meta.len(),
                            created_at,
                        });
                    }
                }
            }
        }
    }

    backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(Json(backups))
}

/// download query params
#[derive(Debug, Deserialize)]
pub struct DownloadQuery {
    pub filename: String,
}

/// download a backup file
#[utoipa::path(
    get,
    path = "/api/databases/{id}/backups/download",
    tag = "databases",
    params(
        ("id" = Uuid, Path, description = "database id"),
        ("filename" = String, Query, description = "backup filename")
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "backup file", content_type = "application/octet-stream"),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn download_backup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(query): Query<DownloadQuery>,
) -> Result<axum::response::Response, (StatusCode, Json<ErrorResponse>)> {
    use axum::body::Body;
    use axum::response::IntoResponse;

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

    if db.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    // validate filename belongs to this database
    let prefix = format!("{}_", db.name);
    if !query.filename.starts_with(&prefix) || query.filename.contains("..") {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "invalid filename".to_string(),
            }),
        ));
    }

    let backup_path = std::path::Path::new(&config.storage.data_dir)
        .join("backups")
        .join(&query.filename);

    if !backup_path.exists() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "backup not found".to_string(),
            }),
        ));
    }

    let contents = tokio::fs::read(&backup_path)
        .await
        .map_err(internal_error)?;

    let response = (
        [
            (axum::http::header::CONTENT_TYPE, "application/octet-stream"),
            (
                axum::http::header::CONTENT_DISPOSITION,
                &format!("attachment; filename=\"{}\"", query.filename),
            ),
        ],
        Body::from(contents),
    )
        .into_response();

    Ok(response)
}
