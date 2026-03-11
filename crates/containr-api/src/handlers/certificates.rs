//! Certificate management handlers

use std::net::ToSocketAddrs;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use containr_common::models::CertificateStatus;

/// Certificate status response
#[derive(Debug, Serialize, ToSchema)]
pub struct CertificateResponse {
    pub domain: String,
    #[schema(value_type = String)]
    pub status: CertificateStatus,
    pub expires_at: Option<String>,
    pub issued_at: Option<String>,
}

/// reissue request
#[derive(Debug, Deserialize, ToSchema)]
pub struct ReissueRequest {
    /// specific domain to reissue (optional)
    pub domain: Option<String>,
}

/// Reissue certificate response
#[derive(Debug, Serialize, ToSchema)]
pub struct ReissueResponse {
    pub message: String,
    pub domains: Vec<String>,
}

/// Get certificate status for an app
#[utoipa::path(
    get,
    path = "/api/services/{id}/certificate",
    tag = "services",
    params(("id" = Uuid, Path, description = "service id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "certificate status", body = Vec<CertificateResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse)
    )
)]
pub async fn get_certificate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(service_id): Path<Uuid>,
) -> Result<Json<Vec<CertificateResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let svc = crate::domain::services::ServiceSvc::new(state.clone());
    let (app, _container_service) =
        svc.resolve_owned_app_service(user_id, service_id)?;

    let domains = app.custom_domains();
    if domains.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let mut responses = Vec::new();
    for domain in domains {
        match state.db.get_certificate(&domain).map_err(internal_error)? {
            Some(cert) => {
                let status = cert.status();
                responses.push(CertificateResponse {
                    domain: cert.domain,
                    status,
                    expires_at: Some(cert.expires_at.to_rfc3339()),
                    issued_at: Some(cert.created_at.to_rfc3339()),
                });
            }
            None => {
                responses.push(CertificateResponse {
                    domain,
                    status: CertificateStatus::None,
                    expires_at: None,
                    issued_at: None,
                });
            }
        }
    }
    Ok(Json(responses))
}

/// Trigger certificate reissue for an app
#[utoipa::path(
    post,
    path = "/api/services/{id}/certificate/reissue",
    tag = "services",
    params(("id" = Uuid, Path, description = "service id")),
    security(("bearer" = [])),
    request_body = ReissueRequest,
    responses(
        (status = 200, description = "certificate reissue initiated", body = ReissueResponse),
        (status = 400, description = "bad request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse),
        (status = 503, description = "service unavailable", body = ErrorResponse)
    )
)]
pub async fn reissue_certificate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(service_id): Path<Uuid>,
    body: Option<Json<ReissueRequest>>,
) -> Result<Json<ReissueResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    let svc = crate::domain::services::ServiceSvc::new(state.clone());
    let (app, _container_service) =
        svc.resolve_owned_app_service(user_id, service_id)?;

    let mut domains = app.custom_domains();
    if domains.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "service has no domains configured".to_string(),
            }),
        ));
    }

    if let Some(Json(req)) = body {
        if let Some(domain) = req.domain {
            let normalized = domain.trim().to_lowercase();
            if normalized.is_empty()
                || !domains.iter().any(|d| d == &normalized)
            {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: "domain not found on service".to_string(),
                    }),
                ));
            }
            domains = vec![normalized];
        }
    }

    for domain in &domains {
        // perform dns a record check
        let dns_ok = format!("{}:443", domain)
            .to_socket_addrs()
            .map(|mut addrs| addrs.next().is_some())
            .unwrap_or(false);

        if !dns_ok {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!(
                        "dns check failed: no a record found for {}. configure dns before requesting a certificate.",
                        domain
                    ),
                }),
            ));
        }

        // delete existing certificate to force reissue
        let _ = state.db.delete_certificate(domain);
    }

    // trigger certificate issuance
    if let Some(ref tx) = state.cert_request_tx {
        for domain in &domains {
            tx.try_send(domain.clone()).map_err(|_| {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(ErrorResponse {
                        error: "certificate service unavailable".to_string(),
                    }),
                )
            })?;
        }
    } else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                error: "certificate issuance not available".to_string(),
            }),
        ));
    }

    for domain in &domains {
        tracing::info!(domain = %domain, "certificate issuance requested");
    }

    Ok(Json(ReissueResponse {
        message: "certificate issuance initiated. this may take a few moments."
            .to_string(),
        domains,
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
