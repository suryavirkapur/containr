//! github integration handlers

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::github::{get_user_repos, GithubRepo};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;

/// github connection status response
#[derive(Debug, Serialize, ToSchema)]
pub struct GithubStatusResponse {
    /// whether github is connected
    pub connected: bool,
    /// github username if connected
    pub username: Option<String>,
}

/// github repos response
#[derive(Debug, Serialize, ToSchema)]
pub struct GithubReposResponse {
    pub repos: Vec<RepoInfo>,
}

/// repository info
#[derive(Debug, Serialize, ToSchema)]
pub struct RepoInfo {
    pub id: i64,
    pub name: String,
    pub full_name: String,
    pub html_url: String,
    pub clone_url: String,
    pub private: bool,
    pub default_branch: String,
    pub description: Option<String>,
}

impl From<GithubRepo> for RepoInfo {
    fn from(repo: GithubRepo) -> Self {
        Self {
            id: repo.id,
            name: repo.name,
            full_name: repo.full_name,
            html_url: repo.html_url,
            clone_url: repo.clone_url,
            private: repo.private,
            default_branch: repo.default_branch,
            description: repo.description,
        }
    }
}

/// visibility query param
#[derive(Debug, Deserialize)]
pub struct ReposQuery {
    /// filter by visibility: all, public, private
    pub visibility: Option<String>,
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

/// get github connection status
#[utoipa::path(
    get,
    path = "/api/github/status",
    tag = "github",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "github connection status", body = GithubStatusResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn github_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<GithubStatusResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let user = state
        .db
        .get_user(user_id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "user not found".to_string(),
                }),
            )
        })?;

    Ok(Json(GithubStatusResponse {
        connected: user.github_access_token.is_some(),
        username: user.github_username,
    }))
}

/// get user's github repositories
#[utoipa::path(
    get,
    path = "/api/github/repos",
    tag = "github",
    security(("bearer" = [])),
    params(
        ("visibility" = Option<String>, Query, description = "filter: all, public, private")
    ),
    responses(
        (status = 200, description = "list of repositories", body = GithubReposResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 400, description = "github not connected", body = ErrorResponse)
    )
)]
pub async fn github_repos(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<ReposQuery>,
) -> Result<Json<GithubReposResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let user = state
        .db
        .get_user(user_id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "user not found".to_string(),
                }),
            )
        })?;

    let access_token = user.github_access_token.ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "github not connected".to_string(),
            }),
        )
    })?;

    // decrypt token
    let decrypted_token = znskr_common::encryption::decrypt(
        &access_token,
        config.security.encryption_key.as_bytes(),
    )
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("failed to decrypt token: {}", e),
                }),
            )
        })?;

    let visibility = query.visibility.as_deref();
    let repos = get_user_repos(&decrypted_token, visibility)
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                Json(ErrorResponse {
                    error: format!("github api error: {}", e),
                }),
            )
        })?;

    Ok(Json(GithubReposResponse {
        repos: repos.into_iter().map(RepoInfo::from).collect(),
    }))
}

/// disconnect github from user account
#[utoipa::path(
    post,
    path = "/api/github/disconnect",
    tag = "github",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "github disconnected"),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn github_disconnect(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let mut user = state
        .db
        .get_user(user_id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "user not found".to_string(),
                }),
            )
        })?;

    user.github_access_token = None;
    user.updated_at = chrono::Utc::now();

    state.db.save_user(&user).map_err(internal_error)?;

    Ok(StatusCode::OK)
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
