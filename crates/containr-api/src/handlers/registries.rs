//! per-owner private container registry credentials

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::handlers::auth::{require_authenticated_user, ErrorResponse};
use crate::security::encrypt_value;
use crate::state::AppState;
use containr_common::models::{normalize_registry_host, ContainerRegistry};

/// saved registry (the password is never returned)
#[derive(Debug, Serialize, ToSchema)]
pub struct RegistryResponse {
    pub id: Uuid,
    pub server: String,
    pub username: String,
    pub created_at: String,
}

impl From<&ContainerRegistry> for RegistryResponse {
    fn from(registry: &ContainerRegistry) -> Self {
        Self {
            id: registry.id,
            server: registry.server.clone(),
            username: registry.username.clone(),
            created_at: registry.created_at.to_rfc3339(),
        }
    }
}

/// registry credentials to save
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateRegistryRequest {
    /// registry host, e.g. ghcr.io or docker.io
    pub server: String,
    pub username: String,
    pub password: String,
}

/// list the caller's registries
#[utoipa::path(
    get,
    path = "/api/registries",
    tag = "registries",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "saved registries", body = Vec<RegistryResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn list_registries(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<RegistryResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let user = require_authenticated_user(&state, &headers).await?;
    let registries = state
        .db
        .list_registries_by_owner(user.id)
        .map_err(internal_error)?;
    Ok(Json(
        registries.iter().map(RegistryResponse::from).collect(),
    ))
}

/// save registry credentials
#[utoipa::path(
    post,
    path = "/api/registries",
    tag = "registries",
    security(("bearer" = [])),
    request_body = CreateRegistryRequest,
    responses(
        (status = 201, description = "registry saved", body = RegistryResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 409, description = "registry already saved", body = ErrorResponse)
    )
)]
pub async fn create_registry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateRegistryRequest>,
) -> Result<
    (StatusCode, Json<RegistryResponse>),
    (StatusCode, Json<ErrorResponse>),
> {
    let user = require_authenticated_user(&state, &headers).await?;
    let server = normalize_registry_host(&req.server);
    let username = req.username.trim().to_string();
    if req.server.trim().is_empty() {
        return Err(bad_request("server is required"));
    }
    if username.is_empty() {
        return Err(bad_request("username is required"));
    }
    if req.password.is_empty() {
        return Err(bad_request("password is required"));
    }

    let existing = state
        .db
        .list_registries_by_owner(user.id)
        .map_err(internal_error)?;
    if existing
        .iter()
        .any(|registry| normalize_registry_host(&registry.server) == server)
    {
        return Err((
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: format!("credentials for {} are already saved", server),
            }),
        ));
    }

    let config = state.config.read().await.clone();
    let password_enc =
        encrypt_value(&config, &req.password).map_err(internal_error)?;
    let registry =
        ContainerRegistry::new(user.id, server, username, password_enc);
    state.db.save_registry(&registry).map_err(internal_error)?;

    Ok((StatusCode::CREATED, Json(RegistryResponse::from(&registry))))
}

/// delete saved registry credentials
#[utoipa::path(
    delete,
    path = "/api/registries/{id}",
    tag = "registries",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "registry id")),
    responses(
        (status = 204, description = "registry deleted"),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "registry not found", body = ErrorResponse)
    )
)]
pub async fn delete_registry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let user = require_authenticated_user(&state, &headers).await?;
    let registry = state
        .db
        .get_registry(id)
        .map_err(internal_error)?
        .filter(|registry| registry.owner_id == user.id)
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "registry not found".to_string(),
                }),
            )
        })?;
    state
        .db
        .delete_registry(registry.id)
        .map_err(internal_error)?;
    Ok(StatusCode::NO_CONTENT)
}

fn bad_request(
    message: impl Into<String>,
) -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ErrorResponse {
            error: message.into(),
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
