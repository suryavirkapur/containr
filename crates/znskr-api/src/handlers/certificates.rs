//! Certificate management handlers

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Serialize;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use znskr_common::models::CertificateStatus;

/// Certificate status response
#[derive(Debug, Serialize)]
pub struct CertificateResponse {
    pub domain: String,
    pub status: CertificateStatus,
    pub expires_at: Option<String>,
    pub issued_at: Option<String>,
}

/// Reissue certificate response
#[derive(Debug, Serialize)]
pub struct ReissueResponse {
    pub message: String,
    pub domain: String,
}

/// Get certificate status for an app
pub async fn get_certificate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(app_id): Path<Uuid>,
) -> Result<Json<CertificateResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    // Get the app
    let app = state
        .db
        .get_app(app_id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "app not found".to_string(),
                }),
            )
        })?;

    // Check ownership
    if app.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    // Check if app has a domain
    let domain = match &app.domain {
        Some(d) => d.clone(),
        None => {
            return Ok(Json(CertificateResponse {
                domain: String::new(),
                status: CertificateStatus::None,
                expires_at: None,
                issued_at: None,
            }));
        }
    };

    // Get certificate for domain
    match state.db.get_certificate(&domain).map_err(internal_error)? {
        Some(cert) => {
            let status = cert.status();
            Ok(Json(CertificateResponse {
                domain: cert.domain,
                status,
                expires_at: Some(cert.expires_at.to_rfc3339()),
                issued_at: Some(cert.created_at.to_rfc3339()),
            }))
        }
        None => Ok(Json(CertificateResponse {
            domain,
            status: CertificateStatus::None,
            expires_at: None,
            issued_at: None,
        })),
    }
}

/// Trigger certificate reissue for an app
pub async fn reissue_certificate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(app_id): Path<Uuid>,
) -> Result<Json<ReissueResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    // Get the app
    let app = state
        .db
        .get_app(app_id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "app not found".to_string(),
                }),
            )
        })?;

    // Check ownership
    if app.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    // Check if app has a domain
    let domain = app.domain.ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "app has no domain configured".to_string(),
            }),
        )
    })?;

    // Delete existing certificate to force reissue
    // The ACME manager will issue a new one on next request
    let _ = state.db.delete_certificate(&domain);

    tracing::info!(domain = %domain, "certificate reissue requested");

    Ok(Json(ReissueResponse {
        message: "Certificate reissue initiated. The new certificate will be issued on the next HTTPS request.".to_string(),
        domain,
    }))
}

/// Helper to extract user ID from auth header
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

/// Helper for internal errors
fn internal_error<E: std::fmt::Display>(e: E) -> (StatusCode, Json<ErrorResponse>) {
    tracing::error!("internal error: {}", e);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: "internal server error".to_string(),
        }),
    )
}
