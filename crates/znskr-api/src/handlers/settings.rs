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

/// settings response - only exposes safe fields
#[derive(Debug, Serialize, ToSchema)]
pub struct SettingsResponse {
    /// base domain for all apps
    pub base_domain: String,
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
    /// domain for certificate
    pub domain: String,
}

/// get current server settings
#[utoipa::path(
    get,
    path = "/api/settings",
    tag = "settings",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "current settings", body = SettingsResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn get_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SettingsResponse>, (StatusCode, Json<ErrorResponse>)> {
    // verify auth
    let config = state.config.read().await;
    let _ = get_user_id(&headers, &config.auth.jwt_secret)?;

    Ok(Json(SettingsResponse {
        base_domain: config.proxy.base_domain.clone(),
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
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn update_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<UpdateSettingsRequest>,
) -> Result<Json<SettingsResponse>, (StatusCode, Json<ErrorResponse>)> {
    // verify auth
    let _ = get_user_id(&headers, &state.config.read().await.auth.jwt_secret)?;

    let mut requested_base_domain: Option<String> = None;

    // update config in memory
    {
        let mut config = state.config.write().await;

        if let Some(base_domain) = req.base_domain {
            config.proxy.base_domain = base_domain;
            requested_base_domain = Some(config.proxy.base_domain.clone());
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

    if let Some(domain) = requested_base_domain {
        if !domain.is_empty() {
            if let Some(tx) = &state.cert_request_tx {
                let _ = tx.try_send(domain);
            }
        }
    }

    tracing::info!(base_domain = %config.proxy.base_domain, "settings updated");

    Ok(Json(SettingsResponse {
        base_domain: config.proxy.base_domain.clone(),
        http_port: config.proxy.http_port,
        https_port: config.proxy.https_port,
        acme_email: config.acme.email.clone(),
        acme_staging: config.acme.staging,
    }))
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
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn issue_dashboard_certificate(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DashboardCertResponse>, (StatusCode, Json<ErrorResponse>)> {
    // verify auth
    let _ = get_user_id(&headers, &state.config.read().await.auth.jwt_secret)?;

    let config = state.config.read().await;
    let domain = config.proxy.base_domain.clone();

    if domain.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "no base domain configured".to_string(),
            }),
        ));
    }

    // delete existing certificate to force reissue
    let _ = state.db.delete_certificate(&domain);

    if let Some(ref tx) = state.cert_request_tx {
        let _ = tx.try_send(domain.clone());
    }

    tracing::info!(domain = %domain, "dashboard certificate issuance requested");

    Ok(Json(DashboardCertResponse {
        message: "certificate issuance initiated. the new certificate will be issued shortly."
            .to_string(),
        domain,
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
fn internal_error<E: std::fmt::Display>(e: E) -> (StatusCode, Json<ErrorResponse>) {
    tracing::error!("internal error: {}", e);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: "internal server error".to_string(),
        }),
    )
}
