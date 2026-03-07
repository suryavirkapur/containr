//! health check handler

use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

/// health check response
#[derive(Serialize, ToSchema)]
pub struct HealthResponse {
    /// current service status
    pub status: String,
    /// api version string
    pub version: String,
}

/// health check endpoint
#[utoipa::path(
    get,
    path = "/health",
    tag = "health",
    responses(
        (status = 200, description = "service is healthy", body = HealthResponse)
    )
)]
pub async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}
