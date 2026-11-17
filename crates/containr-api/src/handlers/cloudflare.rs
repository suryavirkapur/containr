//! cloudflare tunnel connection handlers

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::cloudflare::{CloudflareManager, DomainStatus};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use containr_runtime::ProxyRouteUpdate;

/// connect request: a cloudflare api token and the account it manages
#[derive(Debug, Deserialize, ToSchema)]
pub struct ConnectCloudflareRequest {
    /// api token with cloudflare tunnel edit and zone dns edit permissions
    pub api_token: String,
    /// the cloudflare account id the tunnel is created in
    pub account_id: String,
}

/// a dns zone the connected account can manage
#[derive(Debug, Serialize, ToSchema)]
pub struct CloudflareZoneResponse {
    pub id: String,
    pub name: String,
}

/// how a cloudflare domain is doing after the last sync
#[derive(Debug, Serialize, ToSchema)]
pub struct CloudflareDomainResponse {
    pub domain: String,
    /// whether the proxied cname exists on cloudflare
    pub dns_ready: bool,
    pub error: Option<String>,
}

/// cloudflare connection and runtime status
#[derive(Debug, Serialize, ToSchema)]
pub struct CloudflareStatusResponse {
    /// whether a cloudflare account is connected
    pub connected: bool,
    pub account_id: Option<String>,
    pub tunnel_id: Option<String>,
    pub tunnel_name: Option<String>,
    /// zones the account can manage, cached from the last sync
    pub zones: Vec<CloudflareZoneResponse>,
    /// whether a cloudflared binary is installed
    pub cloudflared_installed: bool,
    /// whether the tunnel connector is running
    pub cloudflared_running: bool,
    /// whether the firewall currently blocks public :80/:443
    pub firewall_active: bool,
    /// whether everything public is tunnel-fronted, so the firewall could
    /// close :80/:443 once active
    pub firewall_required: bool,
    /// configured cloudflare domains and their dns state
    pub domains: Vec<CloudflareDomainResponse>,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
}

/// get the cloudflare connection status
#[utoipa::path(
    get,
    path = "/api/cloudflare",
    tag = "settings",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "cloudflare status", body = CloudflareStatusResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse)
    )
)]
pub async fn get_cloudflare_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<CloudflareStatusResponse>, (StatusCode, Json<ErrorResponse>)> {
    let _ = require_admin_user(&state, &headers).await?;
    Ok(Json(status_response(&state).await))
}

/// connect the server to a cloudflare account; verifies the token and
/// creates the tunnel containr manages
#[utoipa::path(
    put,
    path = "/api/cloudflare",
    tag = "settings",
    security(("bearer" = [])),
    request_body = ConnectCloudflareRequest,
    responses(
        (status = 200, description = "cloudflare connected", body = CloudflareStatusResponse),
        (status = 400, description = "invalid credentials", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse)
    )
)]
pub async fn connect_cloudflare(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ConnectCloudflareRequest>,
) -> Result<Json<CloudflareStatusResponse>, (StatusCode, Json<ErrorResponse>)> {
    let _ = require_admin_user(&state, &headers).await?;
    let manager = require_cloudflare(&state)?;

    if req.api_token.trim().is_empty() || req.account_id.trim().is_empty() {
        return Err(bad_request("api_token and account_id are required"));
    }

    manager
        .connect(&req.api_token, &req.account_id)
        .await
        .map_err(|error| {
            tracing::warn!(error = %error, "cloudflare connect failed");
            (StatusCode::BAD_REQUEST, Json(ErrorResponse { error }))
        })?;

    Ok(Json(status_response(&state).await))
}

/// disconnect cloudflare: removes the tunnel and its dns records and turns
/// cloudflare domains back into direct routes
#[utoipa::path(
    delete,
    path = "/api/cloudflare",
    tag = "settings",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "cloudflare disconnected", body = CloudflareStatusResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse)
    )
)]
pub async fn disconnect_cloudflare(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<CloudflareStatusResponse>, (StatusCode, Json<ErrorResponse>)> {
    let _ = require_admin_user(&state, &headers).await?;
    let manager = require_cloudflare(&state)?;

    let affected_apps = manager.disconnect().await.map_err(internal_error)?;
    if let Some(sender) = &state.proxy_update_tx {
        for app_id in affected_apps {
            let _ = sender.send(ProxyRouteUpdate::RefreshApp { app_id }).await;
        }
    }

    Ok(Json(status_response(&state).await))
}

/// refresh the zone list from cloudflare
#[utoipa::path(
    get,
    path = "/api/cloudflare/zones",
    tag = "settings",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "cloudflare zones", body = [CloudflareZoneResponse]),
        (status = 400, description = "not connected", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse)
    )
)]
pub async fn list_cloudflare_zones(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<CloudflareZoneResponse>>, (StatusCode, Json<ErrorResponse>)>
{
    let _ = require_admin_user(&state, &headers).await?;
    let manager = require_cloudflare(&state)?;

    let zones = manager.refresh_zones().await.map_err(|error| {
        (StatusCode::BAD_REQUEST, Json(ErrorResponse { error }))
    })?;
    Ok(Json(
        zones
            .into_iter()
            .map(|zone| CloudflareZoneResponse {
                id: zone.id,
                name: zone.name,
            })
            .collect(),
    ))
}

async fn status_response(state: &AppState) -> CloudflareStatusResponse {
    let settings = state.db.get_cloudflare_settings().ok().flatten();
    let runtime = match &state.cloudflare {
        Some(manager) => manager.status().await,
        None => Default::default(),
    };
    CloudflareStatusResponse {
        connected: settings.is_some(),
        account_id: settings.as_ref().map(|s| s.account_id.clone()),
        tunnel_id: settings.as_ref().and_then(|s| s.tunnel_id.clone()),
        tunnel_name: settings.as_ref().and_then(|s| s.tunnel_name.clone()),
        zones: runtime
            .zones
            .into_iter()
            .map(|zone| CloudflareZoneResponse {
                id: zone.id,
                name: zone.name,
            })
            .collect(),
        cloudflared_installed: runtime.cloudflared_installed,
        cloudflared_running: runtime.cloudflared_running,
        firewall_active: runtime.firewall_active,
        firewall_required: runtime.firewall_required,
        domains: runtime.domains.into_iter().map(domain_response).collect(),
        last_sync_at: runtime.last_sync_at.map(|at| at.to_rfc3339()),
        last_error: runtime.last_error,
    }
}

fn domain_response(status: DomainStatus) -> CloudflareDomainResponse {
    CloudflareDomainResponse {
        domain: status.domain,
        dns_ready: status.dns_ready,
        error: status.error,
    }
}

fn require_cloudflare(
    state: &AppState,
) -> Result<&CloudflareManager, (StatusCode, Json<ErrorResponse>)> {
    state.cloudflare.as_deref().ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "cloudflare is not available on this server".to_string(),
            }),
        )
    })
}

async fn require_admin_user(
    state: &AppState,
    headers: &HeaderMap,
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
    let jwt_secret = state.config.read().await.auth.jwt_secret.clone();
    let claims = validate_token(token, &jwt_secret).map_err(|error| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: error.to_string(),
            }),
        )
    })?;

    let user = state
        .db
        .get_user(claims.sub)
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
    Ok(user.id)
}

fn bad_request(error: impl Into<String>) -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ErrorResponse {
            error: error.into(),
        }),
    )
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
