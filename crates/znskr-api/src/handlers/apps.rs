//! app management handlers

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
use znskr_common::models::{App, EnvVar};

/// create app request
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateAppRequest {
    /// app name
    pub name: String,
    /// github repository url
    pub github_url: String,
    /// branch to deploy (defaults to main)
    pub branch: Option<String>,
    /// custom domain
    pub domain: Option<String>,
    /// port for the app
    pub port: Option<u16>,
    /// environment variables
    pub env_vars: Option<Vec<EnvVarRequest>>,
}

/// env var in request
#[derive(Debug, Deserialize, ToSchema)]
pub struct EnvVarRequest {
    /// variable key
    pub key: String,
    /// variable value
    pub value: String,
    /// mark as secret (hides value)
    pub secret: Option<bool>,
}

/// env var in response (hides secret values)
#[derive(Debug, Serialize, ToSchema)]
pub struct EnvVarResponse {
    /// variable key
    pub key: String,
    /// variable value (masked if secret)
    pub value: String,
    /// whether value is secret
    pub secret: bool,
}

/// update app request
#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateAppRequest {
    /// new app name
    pub name: Option<String>,
    /// new github url
    pub github_url: Option<String>,
    /// new branch
    pub branch: Option<String>,
    /// new domain
    pub domain: Option<String>,
    /// new port
    pub port: Option<u16>,
    /// updated env vars
    pub env_vars: Option<Vec<EnvVarRequest>>,
}

/// app response
#[derive(Debug, Serialize, ToSchema)]
pub struct AppResponse {
    /// unique app id
    pub id: Uuid,
    /// app name
    pub name: String,
    /// github repository url
    pub github_url: String,
    /// branch being deployed
    pub branch: String,
    /// custom domain
    pub domain: Option<String>,
    /// app port
    pub port: u16,
    /// environment variables
    pub env_vars: Vec<EnvVarResponse>,
    /// creation timestamp
    pub created_at: String,
}

impl From<&App> for AppResponse {
    fn from(app: &App) -> Self {
        Self {
            id: app.id,
            name: app.name.clone(),
            github_url: app.github_url.clone(),
            branch: app.branch.clone(),
            domain: app.domain.clone(),
            port: app.port,
            env_vars: app
                .env_vars
                .iter()
                .map(|e| EnvVarResponse {
                    key: e.key.clone(),
                    // Hide secret values
                    value: if e.secret {
                        "********".to_string()
                    } else {
                        e.value.clone()
                    },
                    secret: e.secret,
                })
                .collect(),
            created_at: app.created_at.to_rfc3339(),
        }
    }
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

/// list all apps for the authenticated user
#[utoipa::path(
    get,
    path = "/api/apps",
    tag = "apps",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "list of apps", body = Vec<AppResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn list_apps(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AppResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let apps = state
        .db
        .list_apps_by_owner(user_id)
        .map_err(|e| internal_error(e))?;

    let responses: Vec<AppResponse> = apps.iter().map(AppResponse::from).collect();
    Ok(Json(responses))
}

/// create a new app
#[utoipa::path(
    post,
    path = "/api/apps",
    tag = "apps",
    security(("bearer" = [])),
    request_body = CreateAppRequest,
    responses(
        (status = 201, description = "app created", body = AppResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 409, description = "domain conflict", body = ErrorResponse)
    )
)]
pub async fn create_app(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateAppRequest>,
) -> Result<(StatusCode, Json<AppResponse>), (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    // validate name
    if req.name.is_empty() || req.name.len() > 64 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "name must be 1-64 characters".to_string(),
            }),
        ));
    }

    // check domain uniqueness
    if let Some(ref domain) = req.domain {
        if state
            .db
            .get_app_by_domain(domain)
            .map_err(internal_error)?
            .is_some()
        {
            return Err((
                StatusCode::CONFLICT,
                Json(ErrorResponse {
                    error: "domain already in use".to_string(),
                }),
            ));
        }
    }

    // create app
    let mut app = App::new(req.name, req.github_url, user_id);
    if let Some(branch) = req.branch {
        app.branch = branch;
    }
    app.domain = req.domain;
    if let Some(port) = req.port {
        app.port = port;
    }
    if let Some(env_vars) = req.env_vars {
        app.env_vars = env_vars
            .into_iter()
            .map(|e| EnvVar {
                key: e.key,
                value: e.value,
                secret: e.secret.unwrap_or(false),
            })
            .collect();
    }

    state.db.save_app(&app).map_err(internal_error)?;

    Ok((StatusCode::CREATED, Json(AppResponse::from(&app))))
}

/// get a single app by id
#[utoipa::path(
    get,
    path = "/api/apps/{id}",
    tag = "apps",
    params(("id" = Uuid, Path, description = "app id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "app details", body = AppResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn get_app(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<AppResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let app = state
        .db
        .get_app(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "app not found".to_string(),
                }),
            )
        })?;

    // check ownership
    if app.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    Ok(Json(AppResponse::from(&app)))
}

/// update an app
#[utoipa::path(
    put,
    path = "/api/apps/{id}",
    tag = "apps",
    params(("id" = Uuid, Path, description = "app id")),
    security(("bearer" = [])),
    request_body = UpdateAppRequest,
    responses(
        (status = 200, description = "app updated", body = AppResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse),
        (status = 409, description = "domain conflict", body = ErrorResponse)
    )
)]
pub async fn update_app(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateAppRequest>,
) -> Result<Json<AppResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let mut app = state
        .db
        .get_app(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "app not found".to_string(),
                }),
            )
        })?;

    // check ownership
    if app.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    // update fields
    if let Some(name) = req.name {
        app.name = name;
    }
    if let Some(branch) = req.branch {
        app.branch = branch;
    }
    if let Some(domain) = req.domain {
        // check domain uniqueness
        if let Some(existing) = state
            .db
            .get_app_by_domain(&domain)
            .map_err(internal_error)?
        {
            if existing.id != app.id {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ErrorResponse {
                        error: "domain already in use".to_string(),
                    }),
                ));
            }
        }
        app.domain = Some(domain);
    }
    if let Some(port) = req.port {
        app.port = port;
    }
    if let Some(env_vars) = req.env_vars {
        // Create a map of existing env vars for lookups
        let existing_vars: std::collections::HashMap<String, String> = app
            .env_vars
            .iter()
            .map(|e| (e.key.clone(), e.value.clone()))
            .collect();

        app.env_vars = env_vars
            .into_iter()
            .map(|e| {
                let value = if e.secret.unwrap_or(false) && e.value == "********" {
                    // unexpected: user sent back the mask, try to find existing value
                    existing_vars.get(&e.key).cloned().unwrap_or(e.value)
                } else {
                    e.value
                };

                EnvVar {
                    key: e.key,
                    value,
                    secret: e.secret.unwrap_or(false),
                }
            })
            .collect();
    }

    app.updated_at = chrono::Utc::now();
    state.db.save_app(&app).map_err(internal_error)?;

    Ok(Json(AppResponse::from(&app)))
}

/// delete an app
#[utoipa::path(
    delete,
    path = "/api/apps/{id}",
    tag = "apps",
    params(("id" = Uuid, Path, description = "app id")),
    security(("bearer" = [])),
    responses(
        (status = 204, description = "app deleted"),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn delete_app(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let app = state
        .db
        .get_app(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "app not found".to_string(),
                }),
            )
        })?;

    // check ownership
    if app.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    state.db.delete_app(id).map_err(internal_error)?;

    Ok(StatusCode::NO_CONTENT)
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
