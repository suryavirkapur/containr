//! server settings handlers

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use containr_common::models::User;

/// settings response - only exposes safe fields
#[derive(Debug, Serialize, ToSchema)]
pub struct SettingsResponse {
    /// dashboard url served by the proxy
    pub dashboard_url: Option<String>,
    /// wildcard suffix used for default service subdomains
    pub service_wildcard_domain: Option<String>,
    /// configured api port
    pub api_port: u16,
    /// base domain for all apps
    pub base_domain: String,
    /// public ip used for direct port access and domain validation
    pub public_ip: Option<String>,
    /// optional public s3 hostname routed to rustfs
    pub storage_public_hostname: Option<String>,
    /// rustfs endpoint used by containr for management operations
    pub storage_management_endpoint: String,
    /// rustfs hostname exposed on the shared docker network
    pub storage_internal_host: String,
    /// rustfs service port
    pub storage_port: u16,
    /// http port for proxy
    pub http_port: u16,
    /// https port for proxy
    pub https_port: u16,
    /// email for acme certificates
    pub acme_email: String,
    /// whether to use acme staging
    pub acme_staging: bool,
}

/// update settings request
#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateSettingsRequest {
    /// new base domain (optional)
    pub base_domain: Option<String>,
    /// public ip used for direct access and domain validation
    pub public_ip: Option<String>,
    /// optional public s3 hostname
    pub storage_public_hostname: Option<String>,
    /// rustfs endpoint used by containr for management operations
    pub storage_management_endpoint: Option<String>,
    /// rustfs hostname exposed on the shared docker network
    pub storage_internal_host: Option<String>,
    /// rustfs service port
    pub storage_port: Option<u16>,
    /// new acme email (optional)
    pub acme_email: Option<String>,
    /// use acme staging (optional)
    pub acme_staging: Option<bool>,
}

/// certificate issuance response
#[derive(Debug, Serialize, ToSchema)]
pub struct DashboardCertResponse {
    /// status message
    pub message: String,
    /// domains queued for issuance
    pub domains: Vec<String>,
}

/// get current server settings
#[utoipa::path(
    get,
    path = "/api/settings",
    tag = "settings",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "current settings", body = SettingsResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse)
    )
)]
pub async fn get_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SettingsResponse>, (StatusCode, Json<ErrorResponse>)> {
    let _ = require_admin_user(&state, &headers).await?;
    let config = state.config.read().await;
    let dashboard_url = dashboard_url(&config.proxy.base_domain);
    let service_wildcard_domain =
        service_wildcard_domain(&config.proxy.base_domain);

    Ok(Json(SettingsResponse {
        dashboard_url,
        service_wildcard_domain,
        api_port: config.server.port,
        base_domain: config.proxy.base_domain.clone(),
        public_ip: config.proxy.public_ip.clone(),
        storage_public_hostname: config.storage.rustfs_public_hostname.clone(),
        storage_management_endpoint: config
            .storage
            .rustfs_management_endpoint
            .clone(),
        storage_internal_host: config.storage.rustfs_internal_host.clone(),
        storage_port: config.storage.rustfs_port,
        http_port: config.proxy.http_port,
        https_port: config.proxy.https_port,
        acme_email: config.acme.email.clone(),
        acme_staging: config.acme.staging,
    }))
}

/// update server settings
#[utoipa::path(
    put,
    path = "/api/settings",
    tag = "settings",
    security(("bearer" = [])),
    request_body = UpdateSettingsRequest,
    responses(
        (status = 200, description = "updated settings", body = SettingsResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse)
    )
)]
pub async fn update_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<UpdateSettingsRequest>,
) -> Result<Json<SettingsResponse>, (StatusCode, Json<ErrorResponse>)> {
    let _ = require_admin_user(&state, &headers).await?;

    let mut requested_certificate_domains = Vec::new();

    // update config in memory
    {
        let mut config = state.config.write().await;

        if let Some(base_domain) = req.base_domain {
            config.proxy.base_domain = base_domain.trim().to_string();
            if !config.proxy.base_domain.is_empty() {
                requested_certificate_domains
                    .push(config.proxy.base_domain.clone());
            }
        }

        if let Some(public_ip) = req.public_ip {
            let normalized = public_ip.trim().to_string();
            config.proxy.public_ip = if normalized.is_empty() {
                None
            } else {
                Some(normalized)
            };
        }

        if let Some(storage_public_hostname) = req.storage_public_hostname {
            let normalized = storage_public_hostname
                .trim()
                .trim_end_matches('/')
                .to_string();
            config.storage.rustfs_public_hostname = if normalized.is_empty() {
                None
            } else {
                Some(normalized.clone())
            };
            if let Some(domain) = normalize_certificate_domain(&normalized) {
                requested_certificate_domains.push(domain);
            }
        }

        if let Some(storage_management_endpoint) =
            req.storage_management_endpoint
        {
            let normalized = storage_management_endpoint
                .trim()
                .trim_end_matches('/')
                .to_string();
            if !normalized.is_empty() {
                config.storage.rustfs_management_endpoint = normalized;
            }
        }

        if let Some(storage_internal_host) = req.storage_internal_host {
            let normalized = storage_internal_host.trim().to_string();
            if !normalized.is_empty() {
                config.storage.rustfs_internal_host = normalized;
            }
        }

        if let Some(storage_port) = req.storage_port {
            config.storage.rustfs_port = storage_port;
        }

        if let Some(acme_email) = req.acme_email {
            config.acme.email = acme_email;
        }

        if let Some(acme_staging) = req.acme_staging {
            config.acme.staging = acme_staging;
        }
    }

    // save config to file
    save_config(&state).await.map_err(internal_error)?;

    let config = state.config.read().await;

    if let Some(tx) = &state.cert_request_tx {
        for domain in requested_certificate_domains {
            if !domain.is_empty() {
                let _ = tx.try_send(domain);
            }
        }
    }

    tracing::info!(base_domain = %config.proxy.base_domain, "settings updated");

    Ok(Json(SettingsResponse {
        dashboard_url: dashboard_url(&config.proxy.base_domain),
        service_wildcard_domain: service_wildcard_domain(
            &config.proxy.base_domain,
        ),
        api_port: config.server.port,
        base_domain: config.proxy.base_domain.clone(),
        public_ip: config.proxy.public_ip.clone(),
        storage_public_hostname: config.storage.rustfs_public_hostname.clone(),
        storage_management_endpoint: config
            .storage
            .rustfs_management_endpoint
            .clone(),
        storage_internal_host: config.storage.rustfs_internal_host.clone(),
        storage_port: config.storage.rustfs_port,
        http_port: config.proxy.http_port,
        https_port: config.proxy.https_port,
        acme_email: config.acme.email.clone(),
        acme_staging: config.acme.staging,
    }))
}

fn dashboard_url(base_domain: &str) -> Option<String> {
    let base_domain = base_domain.trim().trim_end_matches('/');
    if base_domain.is_empty() {
        return None;
    }

    Some(format!("https://{}", base_domain))
}

fn service_wildcard_domain(base_domain: &str) -> Option<String> {
    let base_domain = base_domain.trim().trim_end_matches('.');
    if base_domain.is_empty() {
        return None;
    }

    Some(format!("*.{}", base_domain))
}

/// request certificate for dashboard domain
#[utoipa::path(
    post,
    path = "/api/settings/certificate",
    tag = "settings",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "certificate issuance initiated", body = DashboardCertResponse),
        (status = 400, description = "bad request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse)
    )
)]
pub async fn issue_dashboard_certificate(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DashboardCertResponse>, (StatusCode, Json<ErrorResponse>)> {
    let _ = require_admin_user(&state, &headers).await?;

    let config = state.config.read().await;
    let mut domains = Vec::new();
    if !config.proxy.base_domain.is_empty() {
        domains.push(config.proxy.base_domain.clone());
    }
    if let Some(storage_hostname) = config
        .storage
        .rustfs_public_hostname
        .as_deref()
        .map(str::trim)
        .filter(|hostname| !hostname.is_empty())
    {
        if let Some(domain) = normalize_certificate_domain(storage_hostname) {
            domains.push(domain);
        }
    }

    if domains.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "no managed certificate domains configured".to_string(),
            }),
        ));
    }

    for domain in &domains {
        let _ = state.db.delete_certificate(domain);
    }

    if let Some(ref tx) = state.cert_request_tx {
        for domain in &domains {
            let _ = tx.try_send(domain.clone());
        }
    }

    tracing::info!(domains = ?domains, "managed certificate issuance requested");

    Ok(Json(DashboardCertResponse {
        message: "certificate issuance initiated. the new certificates will be issued shortly."
            .to_string(),
        domains,
    }))
}

/// saves current config to toml file
async fn save_config(state: &AppState) -> Result<(), String> {
    let config = state.config.read().await;
    let content = toml::to_string_pretty(&*config)
        .map_err(|e| format!("failed to serialize config: {}", e))?;

    tokio::fs::write(&state.config_path, &content)
        .await
        .map_err(|e| format!("failed to write config file: {}", e))?;

    Ok(())
}

async fn require_admin_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<User, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(headers, &config.auth.jwt_secret)?;
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

    Ok(user)
}

/// helper to extract user id from auth header
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

fn normalize_certificate_domain(value: &str) -> Option<String> {
    let normalized = value
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string();

    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}
