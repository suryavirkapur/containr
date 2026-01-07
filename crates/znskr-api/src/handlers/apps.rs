//! app management handlers

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use znskr_common::models::{App, EnvVar};

/// create app request
#[derive(Debug, Deserialize)]
pub struct CreateAppRequest {
    pub name: String,
    pub github_url: String,
    pub branch: Option<String>,
    pub domain: Option<String>,
    pub port: Option<u16>,
    pub env_vars: Option<Vec<EnvVarRequest>>,
}

/// env var in request
#[derive(Debug, Deserialize)]
pub struct EnvVarRequest {
    pub key: String,
    pub value: String,
    pub secret: Option<bool>,
}

/// update app request
#[derive(Debug, Deserialize)]
pub struct UpdateAppRequest {
    pub name: Option<String>,
    pub branch: Option<String>,
    pub domain: Option<String>,
    pub port: Option<u16>,
    pub env_vars: Option<Vec<EnvVarRequest>>,
}

/// app response
#[derive(Debug, Serialize)]
pub struct AppResponse {
    pub id: Uuid,
    pub name: String,
    pub github_url: String,
    pub branch: String,
    pub domain: Option<String>,
    pub port: u16,
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
pub async fn list_apps(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AppResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let user_id = get_user_id(&headers, &state.config.auth.jwt_secret)?;

    let apps = state
        .db
        .list_apps_by_owner(user_id)
        .map_err(|e| internal_error(e))?;

    let responses: Vec<AppResponse> = apps.iter().map(AppResponse::from).collect();
    Ok(Json(responses))
}

/// create a new app
pub async fn create_app(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateAppRequest>,
) -> Result<(StatusCode, Json<AppResponse>), (StatusCode, Json<ErrorResponse>)> {
    let user_id = get_user_id(&headers, &state.config.auth.jwt_secret)?;

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
pub async fn get_app(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<AppResponse>, (StatusCode, Json<ErrorResponse>)> {
    let user_id = get_user_id(&headers, &state.config.auth.jwt_secret)?;

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
pub async fn update_app(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateAppRequest>,
) -> Result<Json<AppResponse>, (StatusCode, Json<ErrorResponse>)> {
    let user_id = get_user_id(&headers, &state.config.auth.jwt_secret)?;

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
        if let Some(existing) = state.db.get_app_by_domain(&domain).map_err(internal_error)? {
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
        app.env_vars = env_vars
            .into_iter()
            .map(|e| EnvVar {
                key: e.key,
                value: e.value,
                secret: e.secret.unwrap_or(false),
            })
            .collect();
    }

    app.updated_at = chrono::Utc::now();
    state.db.save_app(&app).map_err(internal_error)?;

    Ok(Json(AppResponse::from(&app)))
}

/// delete an app
pub async fn delete_app(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let user_id = get_user_id(&headers, &state.config.auth.jwt_secret)?;

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
