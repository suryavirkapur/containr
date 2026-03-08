//! system stats handler

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Serialize;
use std::time::Duration;
use tokio::fs;
use tokio::time::sleep;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;

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
    let config = state.config.read().await;
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

    Ok(Json(SystemStats {
        cpu_percent,
        memory_used_bytes,
        memory_total_bytes,
        network_rx_bytes,
        network_tx_bytes,
        load_avg,
        uptime_seconds,
    }))
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

fn internal_error<E: std::fmt::Display>(e: E) -> (StatusCode, Json<ErrorResponse>) {
    tracing::error!("internal error: {}", e);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: "internal server error".to_string(),
        }),
    )
}
