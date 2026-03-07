//! managed databases api handlers

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use chrono::{DateTime, Utc};
use rand::Rng;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use containr_common::managed_services::{DatabaseType, ManagedDatabase, ServiceStatus};
use containr_runtime::{DatabaseManager, StorageManager};

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
    pub pitr_enabled: bool,
    pub pitr_last_base_backup_at: Option<String>,
    pub pitr_last_base_backup_label: Option<String>,
    pub proxy_enabled: bool,
    pub proxy_port: Option<u16>,
    pub proxy_external_port: Option<u16>,
    pub proxy_connection_string: Option<String>,
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
            internal_host: db.normalized_internal_host(),
            port: db.port,
            external_port: db.external_port,
            pitr_enabled: db.pitr_enabled,
            pitr_last_base_backup_at: db.pitr_last_base_backup_at.map(|value| value.to_rfc3339()),
            pitr_last_base_backup_label: db.pitr_last_base_backup_label.clone(),
            proxy_enabled: db.proxy_enabled,
            proxy_port: db.proxy_port(),
            proxy_external_port: db.proxy_external_port,
            proxy_connection_string: db.proxy_connection_string(),
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

fn bad_request(message: impl Into<String>) -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ErrorResponse {
            error: message.into(),
        }),
    )
}

fn allocate_public_port(
    requested_port: Option<u16>,
) -> Result<u16, (StatusCode, Json<ErrorResponse>)> {
    if let Some(port) = requested_port {
        if !(1024..=65535).contains(&port) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "external_port must be between 1024 and 65535".to_string(),
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

fn should_restart_service(status: ServiceStatus, container_id: &Option<String>) -> bool {
    container_id.is_some() || matches!(status, ServiceStatus::Running | ServiceStatus::Starting)
}

fn ensure_postgresql_database(
    db: &ManagedDatabase,
    feature: &str,
) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
    if db.db_type != DatabaseType::Postgresql {
        return Err(bad_request(format!(
            "{} is only supported for postgresql databases",
            feature
        )));
    }

    Ok(())
}

fn parse_recovery_target_time(
    value: &str,
) -> Result<DateTime<Utc>, (StatusCode, Json<ErrorResponse>)> {
    DateTime::parse_from_rfc3339(value)
        .map(|parsed| parsed.with_timezone(&Utc))
        .map_err(|_| bad_request("target_time must be a valid rfc3339 timestamp"))
}

fn is_client_database_operation_error(message: &str) -> bool {
    [
        "only supported",
        "not enabled",
        "must be running",
        "provide exactly one",
        "no base backup",
        "latest base backup directory is missing",
        "proxy host is not available",
        "already running",
    ]
    .iter()
    .any(|pattern| message.contains(pattern))
}

fn database_manager_error(
    action: &str,
    error: impl std::fmt::Display,
) -> (StatusCode, Json<ErrorResponse>) {
    let message = error.to_string();
    let status = if is_client_database_operation_error(&message) {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    tracing::error!("failed to {}: {}", action, message);
    (
        status,
        Json(ErrorResponse {
            error: format!("failed to {}: {}", action, message),
        }),
    )
}

fn build_backup_object_key(db_name: &str, filename: &str, prefix: Option<&str>) -> String {
    let normalized = prefix
        .map(|value| value.trim_matches('/'))
        .filter(|value| !value.is_empty());

    match normalized {
        Some(prefix) => format!("{prefix}/{filename}"),
        None => format!("databases/{db_name}/{filename}"),
    }
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

    let database_root = db.root_path();
    if database_root.starts_with(&config.storage.data_dir) {
        let _ = std::fs::remove_dir_all(database_root);
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
    pub external_port: Option<u16>,
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
    let restart_required = should_restart_service(db.status, &db.container_id);

    if req.enabled {
        db.external_port = Some(allocate_public_port(req.external_port)?);
    } else {
        db.external_port = None;
    }

    if restart_required {
        db_manager.stop_database(&mut db).await.map_err(|e| {
            tracing::error!("failed to stop database: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("failed to stop database: {}", e),
                }),
            )
        })?;

        db_manager.start_database(&mut db).await.map_err(|e| {
            tracing::error!("failed to start database: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("failed to start database: {}", e),
                }),
            )
        })?;
    } else {
        db.updated_at = chrono::Utc::now();
    }

    state
        .db
        .save_managed_database(&db)
        .map_err(internal_error)?;

    Ok(Json(DatabaseResponse::from(&db)))
}

/// pitr configuration request
#[derive(Debug, Deserialize, ToSchema)]
pub struct ConfigurePitrRequest {
    pub enabled: bool,
}

/// proxy configuration request
#[derive(Debug, Deserialize, ToSchema)]
pub struct ConfigureProxyRequest {
    pub enabled: bool,
    pub external_port: Option<u16>,
}

/// base backup request
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct CreateBaseBackupRequest {
    pub label: Option<String>,
}

/// base backup response
#[derive(Debug, Serialize, ToSchema)]
pub struct BaseBackupResponse {
    pub label: String,
    pub backup_path: String,
    pub created_at: String,
}

/// restore point request
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct CreateRestorePointRequest {
    pub restore_point: Option<String>,
}

/// restore point response
#[derive(Debug, Serialize, ToSchema)]
pub struct RestorePointResponse {
    pub restore_point: String,
    pub wal_lsn: String,
    pub created_at: String,
}

/// recover request
#[derive(Debug, Deserialize, ToSchema)]
pub struct RecoverDatabaseRequest {
    pub restore_point: Option<String>,
    pub target_time: Option<String>,
}

/// recover response
#[derive(Debug, Serialize, ToSchema)]
pub struct RecoverDatabaseResponse {
    pub recovered: bool,
    pub recovery_target: String,
    pub base_backup_label: String,
}

/// configure postgres point in time recovery
#[utoipa::path(
    post,
    path = "/api/databases/{id}/pitr",
    tag = "databases",
    params(("id" = Uuid, Path, description = "database id")),
    request_body = ConfigurePitrRequest,
    security(("bearer" = [])),
    responses(
        (status = 200, description = "pitr updated", body = DatabaseResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn configure_pitr(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<ConfigurePitrRequest>,
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

    ensure_postgresql_database(&db, "point in time recovery")?;

    let db_manager = DatabaseManager::new();
    let restart_required = should_restart_service(db.status, &db.container_id);
    db.pitr_enabled = req.enabled;

    if restart_required {
        db_manager
            .stop_database(&mut db)
            .await
            .map_err(|e| database_manager_error("stop database", e))?;
        db_manager
            .start_database(&mut db)
            .await
            .map_err(|e| database_manager_error("start database", e))?;
    } else {
        db.updated_at = Utc::now();
    }

    state
        .db
        .save_managed_database(&db)
        .map_err(internal_error)?;

    Ok(Json(DatabaseResponse::from(&db)))
}

/// configure postgres proxy frontend
#[utoipa::path(
    post,
    path = "/api/databases/{id}/proxy",
    tag = "databases",
    params(("id" = Uuid, Path, description = "database id")),
    request_body = ConfigureProxyRequest,
    security(("bearer" = [])),
    responses(
        (status = 200, description = "proxy updated", body = DatabaseResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn configure_proxy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<ConfigureProxyRequest>,
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

    ensure_postgresql_database(&db, "database proxy")?;

    let db_manager = DatabaseManager::new();
    let restart_required = should_restart_service(db.status, &db.container_id);
    let was_proxy_enabled = db.proxy_enabled;
    let existing_proxy_external_port = db.proxy_external_port;

    if req.enabled {
        db.proxy_enabled = true;
        db.proxy_external_port = match req.external_port {
            Some(port) if was_proxy_enabled && existing_proxy_external_port == Some(port) => {
                Some(port)
            }
            Some(port) => Some(allocate_public_port(Some(port))?),
            None if was_proxy_enabled => existing_proxy_external_port,
            None => None,
        };
    } else {
        db.proxy_enabled = false;
        db.proxy_external_port = None;
    }

    if restart_required {
        db_manager
            .stop_database(&mut db)
            .await
            .map_err(|e| database_manager_error("stop database", e))?;
        db_manager
            .start_database(&mut db)
            .await
            .map_err(|e| database_manager_error("start database", e))?;
    } else {
        db.updated_at = Utc::now();
    }

    state
        .db
        .save_managed_database(&db)
        .map_err(internal_error)?;

    Ok(Json(DatabaseResponse::from(&db)))
}

/// create a postgres base backup for pitr
#[utoipa::path(
    post,
    path = "/api/databases/{id}/pitr/base-backup",
    tag = "databases",
    params(("id" = Uuid, Path, description = "database id")),
    request_body = CreateBaseBackupRequest,
    security(("bearer" = [])),
    responses(
        (status = 200, description = "base backup created", body = BaseBackupResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn create_pitr_base_backup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    request: Option<Json<CreateBaseBackupRequest>>,
) -> Result<Json<BaseBackupResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    let request = request.map(|payload| payload.0).unwrap_or_default();

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

    ensure_postgresql_database(&db, "point in time recovery")?;
    drop(config);

    let db_manager = DatabaseManager::new();
    let (label, backup_path) = db_manager
        .create_postgres_base_backup(&mut db, request.label.as_deref())
        .await
        .map_err(|e| database_manager_error("create base backup", e))?;

    state
        .db
        .save_managed_database(&db)
        .map_err(internal_error)?;

    Ok(Json(BaseBackupResponse {
        label,
        backup_path,
        created_at: Utc::now().to_rfc3339(),
    }))
}

/// create a postgres restore point
#[utoipa::path(
    post,
    path = "/api/databases/{id}/pitr/restore-point",
    tag = "databases",
    params(("id" = Uuid, Path, description = "database id")),
    request_body = CreateRestorePointRequest,
    security(("bearer" = [])),
    responses(
        (status = 200, description = "restore point created", body = RestorePointResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn create_restore_point(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    request: Option<Json<CreateRestorePointRequest>>,
) -> Result<Json<RestorePointResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    let request = request.map(|payload| payload.0).unwrap_or_default();

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

    ensure_postgresql_database(&db, "point in time recovery")?;
    drop(config);

    let db_manager = DatabaseManager::new();
    let (restore_point, wal_lsn) = db_manager
        .create_postgres_restore_point(&db, request.restore_point.as_deref())
        .await
        .map_err(|e| database_manager_error("create restore point", e))?;

    Ok(Json(RestorePointResponse {
        restore_point,
        wal_lsn,
        created_at: Utc::now().to_rfc3339(),
    }))
}

/// recover a postgres database from local pitr backups and wal
#[utoipa::path(
    post,
    path = "/api/databases/{id}/pitr/recover",
    tag = "databases",
    params(("id" = Uuid, Path, description = "database id")),
    request_body = RecoverDatabaseRequest,
    security(("bearer" = [])),
    responses(
        (status = 200, description = "database recovered", body = RecoverDatabaseResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn recover_database(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<RecoverDatabaseRequest>,
) -> Result<Json<RecoverDatabaseResponse>, (StatusCode, Json<ErrorResponse>)> {
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

    ensure_postgresql_database(&db, "point in time recovery")?;

    if req.restore_point.is_some() == req.target_time.is_some() {
        return Err(bad_request(
            "provide exactly one of restore_point or target_time",
        ));
    }

    let target_time = req
        .target_time
        .as_deref()
        .map(parse_recovery_target_time)
        .transpose()?;

    let recovery_target = req
        .restore_point
        .clone()
        .unwrap_or_else(|| req.target_time.clone().unwrap_or_default());
    let base_backup_label = db
        .pitr_last_base_backup_label
        .clone()
        .ok_or_else(|| bad_request("no base backup available"))?;

    drop(config);

    let db_manager = DatabaseManager::new();
    db_manager
        .recover_postgres_to_target(&mut db, req.restore_point.as_deref(), target_time)
        .await
        .map_err(|e| database_manager_error("recover database", e))?;

    state
        .db
        .save_managed_database(&db)
        .map_err(internal_error)?;

    Ok(Json(RecoverDatabaseResponse {
        recovered: true,
        recovery_target,
        base_backup_label,
    }))
}

/// export response
#[derive(Debug, Serialize, ToSchema)]
pub struct ExportResponse {
    pub backup_path: String,
    pub bucket_name: Option<String>,
    pub object_key: Option<String>,
}

/// export request
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct ExportRequest {
    pub bucket_id: Option<Uuid>,
    pub object_key_prefix: Option<String>,
}

/// export database backup
#[utoipa::path(
    post,
    path = "/api/databases/{id}/export",
    tag = "databases",
    params(("id" = Uuid, Path, description = "database id")),
    request_body = ExportRequest,
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
    request: Option<Json<ExportRequest>>,
) -> Result<Json<ExportResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    let request = request.map(|payload| payload.0).unwrap_or_default();

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
    let rustfs_endpoint = config.storage.management_endpoint().to_string();
    let rustfs_access_key = config.storage.rustfs_access_key.clone();
    let rustfs_secret_key = config.storage.rustfs_secret_key.clone();
    std::fs::create_dir_all(&backup_dir).map_err(internal_error)?;
    drop(config);

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

    let mut bucket_name = None;
    let mut object_key = None;

    if let Some(bucket_id) = request.bucket_id {
        let mut bucket = state
            .db
            .get_storage_bucket(bucket_id)
            .map_err(internal_error)?
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: "bucket not found".to_string(),
                    }),
                )
            })?;

        if bucket.owner_id != user_id {
            return Err((
                StatusCode::FORBIDDEN,
                Json(ErrorResponse {
                    error: "access denied".to_string(),
                }),
            ));
        }

        if rustfs_access_key.is_empty() || rustfs_secret_key.is_empty() {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "storage service credentials are not configured".to_string(),
                }),
            ));
        }

        let storage_mgr =
            StorageManager::new(&rustfs_endpoint, &rustfs_access_key, &rustfs_secret_key)
                .await
                .map_err(|e| {
                    tracing::error!("failed to connect to rustfs: {}", e);
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ErrorResponse {
                            error: format!("storage service unavailable: {}", e),
                        }),
                    )
                })?;

        let bucket_exists = storage_mgr.bucket_exists(&bucket.name).await.map_err(|e| {
            tracing::error!("failed to verify bucket: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("failed to verify bucket: {}", e),
                }),
            )
        })?;

        if !bucket_exists {
            return Err((
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "bucket does not exist in storage service".to_string(),
                }),
            ));
        }

        let filename = std::path::Path::new(&backup_path)
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: "failed to derive backup filename".to_string(),
                    }),
                )
            })?;

        let upload_key =
            build_backup_object_key(&db.name, filename, request.object_key_prefix.as_deref());

        storage_mgr
            .upload_file(
                &bucket.name,
                &upload_key,
                std::path::Path::new(&backup_path),
            )
            .await
            .map_err(|e| {
                tracing::error!("failed to upload backup: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("failed to upload backup: {}", e),
                    }),
                )
            })?;

        let uploaded = storage_mgr
            .object_exists(&bucket.name, &upload_key)
            .await
            .map_err(|e| {
                tracing::error!("failed to verify uploaded backup: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("failed to verify uploaded backup: {}", e),
                    }),
                )
            })?;

        if !uploaded {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "backup upload could not be verified".to_string(),
                }),
            ));
        }

        bucket.size_bytes = storage_mgr
            .get_bucket_size(&bucket.name)
            .await
            .map_err(|e| {
                tracing::error!("failed to refresh bucket size: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("failed to refresh bucket size: {}", e),
                    }),
                )
            })?;

        state
            .db
            .save_storage_bucket(&bucket)
            .map_err(internal_error)?;

        bucket_name = Some(bucket.name);
        object_key = Some(upload_key);
    }

    Ok(Json(ExportResponse {
        backup_path,
        bucket_name,
        object_key,
    }))
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
