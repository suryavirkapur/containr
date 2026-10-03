//! system stats handler

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;
use tokio::fs;
use tokio::time::sleep;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::{
    require_admin_user, require_authenticated_user, ErrorResponse,
};
use crate::state::AppState;
use containr_runtime::{
    DockerContainerManager, DockerDiskUsage, DockerDiskUsageEntry,
};

/// system statistics response
#[derive(Serialize, ToSchema)]
pub struct SystemStats {
    pub cpu_percent: f64,
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    pub network_rx_bytes: u64,
    pub network_tx_bytes: u64,
    pub load_avg: [f64; 3],
    pub uptime_seconds: u64,
    /// bytes used on the filesystem holding the data dir
    pub disk_used_bytes: u64,
    /// size of the filesystem holding the data dir
    pub disk_total_bytes: u64,
    pub cpu_count: u32,
}

/// host and docker daemon information
#[derive(Serialize, ToSchema)]
pub struct SystemInfoResponse {
    pub version: String,
    pub hostname: Option<String>,
    pub os: Option<String>,
    pub kernel: Option<String>,
    pub docker_version: Option<String>,
    pub containers_running: u64,
    pub containers_total: u64,
    pub images: u64,
    pub base_domain: String,
    pub public_ip: Option<String>,
}

/// usage of one docker resource category
#[derive(Serialize, ToSchema)]
pub struct DiskUsageEntryResponse {
    pub count: u64,
    pub size_bytes: u64,
    pub reclaimable_bytes: u64,
}

impl From<DockerDiskUsageEntry> for DiskUsageEntryResponse {
    fn from(entry: DockerDiskUsageEntry) -> Self {
        Self {
            count: entry.count,
            size_bytes: entry.size_bytes,
            reclaimable_bytes: entry.reclaimable_bytes,
        }
    }
}

/// docker `system df` summary
#[derive(Serialize, ToSchema)]
pub struct DiskUsageResponse {
    pub images: DiskUsageEntryResponse,
    pub containers: DiskUsageEntryResponse,
    pub volumes: DiskUsageEntryResponse,
    pub build_cache: DiskUsageEntryResponse,
}

impl From<DockerDiskUsage> for DiskUsageResponse {
    fn from(usage: DockerDiskUsage) -> Self {
        Self {
            images: usage.images.into(),
            containers: usage.containers.into(),
            volumes: usage.volumes.into(),
            build_cache: usage.build_cache.into(),
        }
    }
}

/// what to prune. volumes are never pruned.
#[derive(Deserialize, ToSchema)]
pub struct CleanupRequest {
    /// prune images not used by any container
    #[serde(default)]
    pub images: bool,
    /// prune the build cache
    #[serde(default)]
    pub build_cache: bool,
    /// remove stopped containers created by containr
    #[serde(default)]
    pub containers: bool,
}

#[derive(Serialize, ToSchema)]
pub struct CleanupResponse {
    pub reclaimed_bytes: u64,
    pub images_deleted: u64,
}

struct CpuTimes {
    user: u64,
    nice: u64,
    system: u64,
    idle: u64,
    iowait: u64,
    irq: u64,
    softirq: u64,
    steal: u64,
}

impl CpuTimes {
    fn total(&self) -> u64 {
        self.user
            + self.nice
            + self.system
            + self.idle
            + self.iowait
            + self.irq
            + self.softirq
            + self.steal
    }

    fn idle_total(&self) -> u64 {
        self.idle + self.iowait
    }
}

async fn read_cpu_times() -> Option<CpuTimes> {
    let content = fs::read_to_string("/proc/stat").await.ok()?;
    let line = content.lines().next()?;
    if !line.starts_with("cpu ") {
        return None;
    }
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 9 {
        return None;
    }
    Some(CpuTimes {
        user: parts[1].parse().ok()?,
        nice: parts[2].parse().ok()?,
        system: parts[3].parse().ok()?,
        idle: parts[4].parse().ok()?,
        iowait: parts[5].parse().ok()?,
        irq: parts[6].parse().ok()?,
        softirq: parts[7].parse().ok()?,
        steal: parts[8].parse().ok()?,
    })
}

async fn get_cpu_percent() -> f64 {
    let Some(first) = read_cpu_times().await else {
        return 0.0;
    };
    sleep(Duration::from_millis(100)).await;
    let Some(second) = read_cpu_times().await else {
        return 0.0;
    };

    let total_diff = second.total().saturating_sub(first.total());
    let idle_diff = second.idle_total().saturating_sub(first.idle_total());

    if total_diff == 0 {
        return 0.0;
    }

    ((total_diff - idle_diff) as f64 / total_diff as f64) * 100.0
}

async fn get_memory_info() -> (u64, u64) {
    let Ok(content) = fs::read_to_string("/proc/meminfo").await else {
        return (0, 0);
    };

    let mut total: u64 = 0;
    let mut available: u64 = 0;

    for line in content.lines() {
        if line.starts_with("MemTotal:") {
            if let Some(val) = parse_meminfo_value(line) {
                total = val * 1024;
            }
        } else if line.starts_with("MemAvailable:") {
            if let Some(val) = parse_meminfo_value(line) {
                available = val * 1024;
            }
        }
    }

    let used = total.saturating_sub(available);
    (used, total)
}

fn parse_meminfo_value(line: &str) -> Option<u64> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    parts.get(1)?.parse().ok()
}

async fn get_network_bytes() -> (u64, u64) {
    let Ok(content) = fs::read_to_string("/proc/net/dev").await else {
        return (0, 0);
    };

    let mut rx_total: u64 = 0;
    let mut tx_total: u64 = 0;

    for line in content.lines().skip(2) {
        let line = line.trim();
        if line.starts_with("lo:") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 10 {
            if let Ok(rx) = parts[1].parse::<u64>() {
                rx_total += rx;
            }
            if let Ok(tx) = parts[9].parse::<u64>() {
                tx_total += tx;
            }
        }
    }

    (rx_total, tx_total)
}

async fn get_load_avg() -> [f64; 3] {
    let Ok(content) = fs::read_to_string("/proc/loadavg").await else {
        return [0.0, 0.0, 0.0];
    };

    let parts: Vec<&str> = content.split_whitespace().collect();
    if parts.len() < 3 {
        return [0.0, 0.0, 0.0];
    }

    [
        parts[0].parse().unwrap_or(0.0),
        parts[1].parse().unwrap_or(0.0),
        parts[2].parse().unwrap_or(0.0),
    ]
}

async fn get_uptime() -> u64 {
    let Ok(content) = fs::read_to_string("/proc/uptime").await else {
        return 0;
    };

    content
        .split_whitespace()
        .next()
        .and_then(|s| s.parse::<f64>().ok())
        .map(|v| v as u64)
        .unwrap_or(0)
}

/// get system statistics
#[utoipa::path(
    get,
    path = "/api/system/stats",
    tag = "system",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "system statistics", body = SystemStats),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse)
    )
)]
pub async fn get_system_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SystemStats>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await.clone();
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    drop(config);

    let user = state
        .db
        .get_user(user_id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: "user not found".to_string(),
                }),
            )
        })?;

    if !user.is_admin {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "admin access required".to_string(),
            }),
        ));
    }

    let cpu_percent = get_cpu_percent().await;
    let (memory_used_bytes, memory_total_bytes) = get_memory_info().await;
    let (network_rx_bytes, network_tx_bytes) = get_network_bytes().await;
    let load_avg = get_load_avg().await;
    let uptime_seconds = get_uptime().await;
    let (disk_used_bytes, disk_total_bytes) =
        filesystem_usage(&state.data_dir).unwrap_or((0, 0));
    let cpu_count = std::thread::available_parallelism()
        .map(|count| count.get() as u32)
        .unwrap_or(1);

    Ok(Json(SystemStats {
        cpu_percent,
        memory_used_bytes,
        memory_total_bytes,
        network_rx_bytes,
        network_tx_bytes,
        load_avg,
        uptime_seconds,
        disk_used_bytes,
        disk_total_bytes,
        cpu_count,
    }))
}

/// returns (used, total) bytes of the filesystem holding `path`
fn filesystem_usage(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;

    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // safety: c_path is a valid nul-terminated string and stats points to
    // writable memory sized for a statvfs struct
    let result = unsafe { libc::statvfs(c_path.as_ptr(), stats.as_mut_ptr()) };
    if result != 0 {
        return None;
    }
    // safety: statvfs returned success, so the struct is initialized
    let stats = unsafe { stats.assume_init() };

    #[allow(clippy::unnecessary_cast)]
    let fragment_size = if stats.f_frsize > 0 {
        stats.f_frsize as u64
    } else {
        stats.f_bsize as u64
    };
    #[allow(clippy::unnecessary_cast)]
    let total = (stats.f_blocks as u64).saturating_mul(fragment_size);
    #[allow(clippy::unnecessary_cast)]
    let free = (stats.f_bfree as u64).saturating_mul(fragment_size);
    Some((total.saturating_sub(free), total))
}

const DOCKER_INFO_TIMEOUT: Duration = Duration::from_secs(5);
const DOCKER_DISK_USAGE_TIMEOUT: Duration = Duration::from_secs(60);

fn docker_error<E: std::fmt::Display>(
    error: E,
) -> (StatusCode, Json<ErrorResponse>) {
    tracing::error!("docker error: {}", error);
    (
        StatusCode::BAD_GATEWAY,
        Json(ErrorResponse {
            error: format!("docker error: {}", error),
        }),
    )
}

fn read_kernel_release() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn read_hostname() -> Option<String> {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok())
}

/// get host and docker information
#[utoipa::path(
    get,
    path = "/api/system/info",
    tag = "system",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "system information", body = SystemInfoResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn get_system_info(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SystemInfoResponse>, (StatusCode, Json<ErrorResponse>)> {
    let _user = require_authenticated_user(&state, &headers).await?;
    let config = state.config.read().await.clone();

    // an unresponsive docker daemon must not hang the dashboard
    let docker = match tokio::time::timeout(
        DOCKER_INFO_TIMEOUT,
        DockerContainerManager::new().system_info(),
    )
    .await
    {
        Ok(Ok(info)) => info,
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "failed to read docker info");
            Default::default()
        }
        Err(_) => {
            tracing::warn!("timed out reading docker info");
            Default::default()
        }
    };
    let public_ip = config
        .proxy
        .public_ip
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    Ok(Json(SystemInfoResponse {
        version: env!("CARGO_PKG_VERSION").to_string(),
        hostname: read_hostname().or(docker.hostname),
        os: docker
            .operating_system
            .or_else(|| Some(std::env::consts::OS.to_string())),
        kernel: read_kernel_release().or(docker.kernel_version),
        docker_version: docker.docker_version,
        containers_running: docker.containers_running,
        containers_total: docker.containers_total,
        images: docker.images,
        base_domain: config.proxy.base_domain.clone(),
        public_ip,
    }))
}

/// get docker disk usage (admin)
#[utoipa::path(
    get,
    path = "/api/system/disk-usage",
    tag = "system",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "docker disk usage", body = DiskUsageResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "admin access required", body = ErrorResponse),
        (status = 502, description = "docker error", body = ErrorResponse)
    )
)]
pub async fn get_disk_usage(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DiskUsageResponse>, (StatusCode, Json<ErrorResponse>)> {
    let _admin = require_admin_user(&state, &headers).await?;
    let usage = tokio::time::timeout(
        DOCKER_DISK_USAGE_TIMEOUT,
        DockerContainerManager::new().disk_usage(),
    )
    .await
    .map_err(|_| docker_error("timed out reading disk usage"))?
    .map_err(docker_error)?;
    Ok(Json(usage.into()))
}

/// prune unused docker resources (admin)
#[utoipa::path(
    post,
    path = "/api/system/cleanup",
    tag = "system",
    security(("bearer" = [])),
    request_body = CleanupRequest,
    responses(
        (status = 200, description = "cleanup result", body = CleanupResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "admin access required", body = ErrorResponse),
        (status = 502, description = "docker error", body = ErrorResponse)
    )
)]
pub async fn run_cleanup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CleanupRequest>,
) -> Result<Json<CleanupResponse>, (StatusCode, Json<ErrorResponse>)> {
    let _admin = require_admin_user(&state, &headers).await?;
    let result = DockerContainerManager::new()
        .cleanup(req.images, req.build_cache, req.containers)
        .await
        .map_err(docker_error)?;
    Ok(Json(CleanupResponse {
        reclaimed_bytes: result.reclaimed_bytes,
        images_deleted: result.images_deleted,
    }))
}

/// download a consistent sqlite snapshot (admin)
#[utoipa::path(
    get,
    path = "/api/system/backup",
    tag = "system",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "sqlite database snapshot", content_type = "application/octet-stream", body = Vec<u8>),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "admin access required", body = ErrorResponse)
    )
)]
pub async fn download_backup(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, Json<ErrorResponse>)> {
    let _admin = require_admin_user(&state, &headers).await?;

    let backups_dir = state.data_dir.join("backups");
    fs::create_dir_all(&backups_dir)
        .await
        .map_err(internal_error)?;
    let snapshot_path =
        backups_dir.join(format!("snapshot-{}.sqlite3", Uuid::new_v4()));

    let db = state.db.clone();
    let target = snapshot_path.clone();
    tokio::task::spawn_blocking(move || db.backup_to(&target))
        .await
        .map_err(internal_error)?
        .map_err(internal_error)?;

    let file = fs::File::open(&snapshot_path).await;
    // unlink right away; the open handle keeps the data readable
    let _ = fs::remove_file(&snapshot_path).await;
    let file = file.map_err(internal_error)?;
    let size = file.metadata().await.map_err(internal_error)?.len();

    let filename = format!(
        "containr-backup-{}.sqlite3",
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, size)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename),
        )
        .body(Body::from_stream(tokio_util::io::ReaderStream::new(file)))
        .map_err(internal_error)
}

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
