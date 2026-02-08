//! container metrics, logs, and volume file operations

use axum::extract::Multipart;
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::{Deserialize, Serialize};
use std::path::{Path as FsPath, PathBuf};
use tokio::io::AsyncWriteExt;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use znskr_runtime::{
    DockerContainerManager, DockerContainerState, DockerContainerStats, DockerMountInfo,
};

#[derive(Debug, Serialize, ToSchema)]
pub struct ContainerListItem {
    pub id: String,
    pub resource_type: String,
    pub resource_id: String,
    pub name: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ContainerStatusResponse {
    pub status: String,
    pub health_status: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub restart_count: u64,
    pub cpu_percent: f64,
    pub mem_usage_bytes: u64,
    pub mem_limit_bytes: u64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ContainerLogsResponse {
    pub logs: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ContainerMountResponse {
    pub destination: String,
    pub mount_type: String,
    pub name: Option<String>,
    pub read_only: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct VolumeEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LogsQuery {
    pub tail: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct VolumeQuery {
    pub mount: String,
    pub path: Option<String>,
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

fn parse_app_id_from_container(container_id: &str) -> Option<Uuid> {
    if !container_id.starts_with("znskr-") {
        return None;
    }
    let suffix = &container_id["znskr-".len()..];
    if suffix.len() < 36 {
        return None;
    }
    let candidate = &suffix[..36];
    Uuid::parse_str(candidate).ok()
}

async fn ensure_container_owned(
    state: &AppState,
    user_id: Uuid,
    container_id: &str,
) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
    if let Some(id_str) = container_id.strip_prefix("znskr-db-") {
        if let Ok(id) = Uuid::parse_str(id_str) {
            if let Some(db) = state.db.get_managed_database(id).map_err(internal_error)? {
                if db.owner_id == user_id {
                    return Ok(());
                }
            }
        }
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "forbidden".to_string(),
            }),
        ));
    }

    if let Some(id_str) = container_id.strip_prefix("znskr-queue-") {
        if let Ok(id) = Uuid::parse_str(id_str) {
            if let Some(queue) = state.db.get_managed_queue(id).map_err(internal_error)? {
                if queue.owner_id == user_id {
                    return Ok(());
                }
            }
        }
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "forbidden".to_string(),
            }),
        ));
    }

    if let Some(app_id) = parse_app_id_from_container(container_id) {
        if let Some(app) = state.db.get_app(app_id).map_err(internal_error)? {
            if app.owner_id == user_id {
                return Ok(());
            }
        }
    }

    Err((
        StatusCode::FORBIDDEN,
        Json(ErrorResponse {
            error: "forbidden".to_string(),
        }),
    ))
}

#[utoipa::path(
    get,
    path = "/api/containers",
    tag = "containers",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "list of containers", body = Vec<ContainerListItem>),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn list_containers(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ContainerListItem>>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let mut containers = Vec::new();

    for db in state
        .db
        .list_managed_databases_by_owner(user_id)
        .map_err(internal_error)?
    {
        if let Some(container_id) = db.container_id.clone() {
            containers.push(ContainerListItem {
                id: container_id.clone(),
                resource_type: "database".to_string(),
                resource_id: db.id.to_string(),
                name: db.name.clone(),
            });
        }
    }

    for queue in state
        .db
        .list_managed_queues_by_owner(user_id)
        .map_err(internal_error)?
    {
        if let Some(container_id) = queue.container_id.clone() {
            containers.push(ContainerListItem {
                id: container_id.clone(),
                resource_type: "queue".to_string(),
                resource_id: queue.id.to_string(),
                name: queue.name.clone(),
            });
        }
    }

    let apps = state
        .db
        .list_apps_by_owner(user_id)
        .map_err(internal_error)?;
    for app in apps {
        if let Some(deployment) = state
            .db
            .get_latest_deployment(app.id)
            .map_err(internal_error)?
        {
            let mut service_names = std::collections::HashMap::new();
            for service in &app.services {
                service_names.insert(service.id, service.name.clone());
            }

            if let Some(container_id) = deployment.container_id.clone() {
                containers.push(ContainerListItem {
                    id: container_id.clone(),
                    resource_type: "app".to_string(),
                    resource_id: app.id.to_string(),
                    name: format!("{} (legacy)", app.name),
                });
            }
            for sd in deployment.service_deployments {
                if let Some(container_id) = sd.container_id.clone() {
                    let label = service_names
                        .get(&sd.service_id)
                        .cloned()
                        .unwrap_or_else(|| "service".to_string());
                    containers.push(ContainerListItem {
                        id: container_id.clone(),
                        resource_type: "app".to_string(),
                        resource_id: app.id.to_string(),
                        name: format!("{} ({})", app.name, label),
                    });
                }
            }
        }
    }

    Ok(Json(containers))
}

#[utoipa::path(
    get,
    path = "/api/containers/{id}/status",
    tag = "containers",
    params(("id" = String, Path, description = "container id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "container status", body = ContainerStatusResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse)
    )
)]
pub async fn get_container_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<ContainerStatusResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    ensure_container_owned(&state, user_id, &id).await?;

    let docker = DockerContainerManager::new();
    let state_info: DockerContainerState = docker.get_state(&id).await.map_err(internal_error)?;
    let stats: DockerContainerStats = docker.get_stats(&id).await.map_err(internal_error)?;

    Ok(Json(ContainerStatusResponse {
        status: state_info.status,
        health_status: state_info.health_status,
        started_at: state_info.started_at,
        finished_at: state_info.finished_at,
        restart_count: state_info.restart_count,
        cpu_percent: stats.cpu_percent,
        mem_usage_bytes: stats.mem_usage_bytes,
        mem_limit_bytes: stats.mem_limit_bytes,
    }))
}

#[utoipa::path(
    get,
    path = "/api/containers/{id}/logs",
    tag = "containers",
    params(
        ("id" = String, Path, description = "container id"),
        ("tail" = Option<usize>, Query, description = "number of log lines")
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "container logs", body = ContainerLogsResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse)
    )
)]
pub async fn get_container_logs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(params): Query<LogsQuery>,
) -> Result<Json<ContainerLogsResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    ensure_container_owned(&state, user_id, &id).await?;

    let docker = DockerContainerManager::new();
    let logs = docker
        .get_logs(&id, params.tail.unwrap_or(200))
        .await
        .map_err(internal_error)?;
    Ok(Json(ContainerLogsResponse { logs }))
}

#[utoipa::path(
    get,
    path = "/api/containers/{id}/mounts",
    tag = "containers",
    params(("id" = String, Path, description = "container id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "container mounts", body = Vec<ContainerMountResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse)
    )
)]
pub async fn list_container_mounts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Vec<ContainerMountResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    ensure_container_owned(&state, user_id, &id).await?;

    let docker = DockerContainerManager::new();
    let mounts = docker.list_mounts(&id).await.map_err(internal_error)?;
    let response = mounts
        .into_iter()
        .map(|mount| ContainerMountResponse {
            destination: mount.destination,
            mount_type: mount.mount_type,
            name: mount.name,
            read_only: mount.rw.map(|rw| !rw).unwrap_or(false),
        })
        .collect();

    Ok(Json(response))
}

fn find_mount<'a>(mounts: &'a [DockerMountInfo], destination: &str) -> Option<&'a DockerMountInfo> {
    mounts.iter().find(|mount| mount.destination == destination)
}

fn validate_rel_path(rel_path: &str) -> Result<PathBuf, (StatusCode, Json<ErrorResponse>)> {
    let path = FsPath::new(rel_path);
    if path.is_absolute() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "path must be relative".to_string(),
            }),
        ));
    }

    for component in path.components() {
        if matches!(
            component,
            std::path::Component::ParentDir | std::path::Component::RootDir
        ) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "invalid path".to_string(),
                }),
            ));
        }
    }

    Ok(path.to_path_buf())
}

async fn resolve_mount_path(
    docker: &DockerContainerManager,
    container_id: &str,
    mount: &str,
    rel_path: Option<String>,
) -> Result<(PathBuf, PathBuf, bool), (StatusCode, Json<ErrorResponse>)> {
    let mounts = docker
        .list_mounts(container_id)
        .await
        .map_err(internal_error)?;
    let mount_info = find_mount(&mounts, mount).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "mount not found".to_string(),
            }),
        )
    })?;

    let base = PathBuf::from(&mount_info.source);
    let rel = if let Some(rel_path) = rel_path {
        validate_rel_path(&rel_path)?
    } else {
        PathBuf::new()
    };

    let read_only = mount_info.rw.map(|rw| !rw).unwrap_or(false);
    Ok((base, rel, read_only))
}

#[utoipa::path(
    get,
    path = "/api/containers/{id}/files",
    tag = "containers",
    params(
        ("id" = String, Path, description = "container id"),
        ("mount" = String, Query, description = "mount point"),
        ("path" = Option<String>, Query, description = "relative path within mount")
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "volume entries", body = Vec<VolumeEntry>),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse)
    )
)]
pub async fn list_volume_entries(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<VolumeQuery>,
) -> Result<Json<Vec<VolumeEntry>>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    ensure_container_owned(&state, user_id, &id).await?;

    let docker = DockerContainerManager::new();
    let (base, rel, _read_only) =
        resolve_mount_path(&docker, &id, &query.mount, query.path).await?;
    let target = base.join(&rel);

    let metadata = std::fs::metadata(&target).map_err(internal_error)?;
    if !metadata.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "path is not a directory".to_string(),
            }),
        ));
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&target).map_err(internal_error)? {
        let entry = entry.map_err(internal_error)?;
        let file_type = entry.file_type().map_err(internal_error)?;
        let meta = entry.metadata().map_err(internal_error)?;
        let name = entry.file_name().to_string_lossy().to_string();
        let rel_path = rel.join(&name).to_string_lossy().to_string();
        let modified_at = meta
            .modified()
            .ok()
            .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339());

        entries.push(VolumeEntry {
            name,
            path: rel_path,
            is_dir: file_type.is_dir(),
            size_bytes: meta.len(),
            modified_at,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(Json(entries))
}

#[utoipa::path(
    delete,
    path = "/api/containers/{id}/files",
    tag = "containers",
    params(
        ("id" = String, Path, description = "container id"),
        ("mount" = String, Query, description = "mount point"),
        ("path" = Option<String>, Query, description = "relative path within mount")
    ),
    security(("bearer" = [])),
    responses(
        (status = 204, description = "entry deleted"),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse)
    )
)]
pub async fn delete_volume_entry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<VolumeQuery>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    ensure_container_owned(&state, user_id, &id).await?;

    let docker = DockerContainerManager::new();
    let (base, rel, read_only) = resolve_mount_path(&docker, &id, &query.mount, query.path).await?;
    if read_only {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "mount is read-only".to_string(),
            }),
        ));
    }
    let target = base.join(&rel);

    let metadata = std::fs::metadata(&target).map_err(internal_error)?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(&target).map_err(internal_error)?;
    } else {
        std::fs::remove_file(&target).map_err(internal_error)?;
    }

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/api/containers/{id}/files/download",
    tag = "containers",
    params(
        ("id" = String, Path, description = "container id"),
        ("mount" = String, Query, description = "mount point"),
        ("path" = Option<String>, Query, description = "relative path within mount")
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "file download"),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse)
    )
)]
pub async fn download_volume_entry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<VolumeQuery>,
) -> Result<Response, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    ensure_container_owned(&state, user_id, &id).await?;

    let docker = DockerContainerManager::new();
    let (base, rel, _read_only) =
        resolve_mount_path(&docker, &id, &query.mount, query.path).await?;
    let target = base.join(&rel);

    let metadata = std::fs::metadata(&target).map_err(internal_error)?;
    if metadata.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "path is a directory".to_string(),
            }),
        ));
    }

    let data = tokio::fs::read(&target).await.map_err(internal_error)?;
    let filename = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");

    let mut response = Response::new(data.into());
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/octet-stream"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        header::HeaderValue::from_str(&format!("attachment; filename=\"{}\"", filename))
            .unwrap_or_else(|_| header::HeaderValue::from_static("attachment")),
    );

    Ok(response)
}

#[utoipa::path(
    post,
    path = "/api/containers/{id}/files/upload",
    tag = "containers",
    params(
        ("id" = String, Path, description = "container id"),
        ("mount" = String, Query, description = "mount point"),
        ("path" = Option<String>, Query, description = "relative path within mount")
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "file uploaded"),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse)
    )
)]
pub async fn upload_volume_entry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<VolumeQuery>,
    mut multipart: Multipart,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    ensure_container_owned(&state, user_id, &id).await?;

    let docker = DockerContainerManager::new();
    let (base, rel, read_only) = resolve_mount_path(&docker, &id, &query.mount, query.path).await?;
    if read_only {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "mount is read-only".to_string(),
            }),
        ));
    }
    let target_dir = base.join(&rel);
    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(internal_error)?;

    while let Some(field) = multipart.next_field().await.map_err(internal_error)? {
        let file_name = field
            .file_name()
            .map(|name| name.to_string())
            .ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: "missing filename".to_string(),
                    }),
                )
            })?;

        let file_name_path = validate_rel_path(&file_name)?;
        let file_path = target_dir.join(file_name_path);

        let mut file = tokio::fs::File::create(&file_path)
            .await
            .map_err(internal_error)?;
        let data = field.bytes().await.map_err(internal_error)?;
        file.write_all(&data).await.map_err(internal_error)?;
    }

    Ok(StatusCode::OK)
}

#[utoipa::path(
    post,
    path = "/api/containers/{id}/files/mkdir",
    tag = "containers",
    params(
        ("id" = String, Path, description = "container id"),
        ("mount" = String, Query, description = "mount point"),
        ("path" = String, Query, description = "directory path to create")
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "directory created"),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse)
    )
)]
pub async fn create_volume_directory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<VolumeQuery>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    ensure_container_owned(&state, user_id, &id).await?;

    let docker = DockerContainerManager::new();
    let (base, rel, read_only) = resolve_mount_path(&docker, &id, &query.mount, query.path).await?;
    if read_only {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "mount is read-only".to_string(),
            }),
        ));
    }

    let target_dir = base.join(&rel);
    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(internal_error)?;

    Ok(StatusCode::OK)
}
