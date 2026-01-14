//! authentication handlers

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{create_token, hash_password, verify_password};
use crate::github::{exchange_code_for_token, get_github_user};
use crate::state::AppState;
use znskr_common::models::User;

/// login request body
#[derive(Debug, Deserialize, ToSchema)]
pub struct LoginRequest {
    /// user email address
    pub email: String,
    /// user password
    pub password: String,
}

/// register request body
#[derive(Debug, Deserialize, ToSchema)]
pub struct RegisterRequest {
    /// user email address
    pub email: String,
    /// password (min 8 characters)
    pub password: String,
}

/// auth response with token
#[derive(Debug, Serialize, ToSchema)]
pub struct AuthResponse {
    /// jwt authentication token
    pub token: String,
    /// authenticated user info
    pub user: UserResponse,
}

/// user info in responses
#[derive(Debug, Serialize, ToSchema)]
pub struct UserResponse {
    /// unique user id
    pub id: Uuid,
    /// user email
    pub email: String,
    /// github username if linked
    pub github_username: Option<String>,
}

/// error response
#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorResponse {
    /// error message
    pub error: String,
}

/// github oauth callback query params
#[derive(Debug, Deserialize)]
pub struct GithubCallbackQuery {
    pub code: String,
}

/// register a new user with email/password
#[utoipa::path(
    post,
    path = "/api/auth/register",
    tag = "auth",
    request_body = RegisterRequest,
    responses(
        (status = 200, description = "successfully registered", body = AuthResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 409, description = "email already registered", body = ErrorResponse)
    )
)]
pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<ErrorResponse>)> {
    // check if user already exists
    if state
        .db
        .get_user_by_email(&req.email)
        .map_err(internal_error)?
        .is_some()
    {
        return Err((
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: "email already registered".to_string(),
            }),
        ));
    }

    // validate password
    if req.password.len() < 8 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "password must be at least 8 characters".to_string(),
            }),
        ));
    }

    // hash password and create user
    let password_hash = hash_password(&req.password).map_err(internal_error)?;
    let user = User::new_with_password(req.email.clone(), password_hash);

    state.db.save_user(&user).map_err(internal_error)?;

    // create token
    let config = state.config.read().await;
    let token = create_token(
        user.id,
        &user.email,
        &config.auth.jwt_secret,
        config.auth.jwt_expiry_hours,
    )
    .map_err(internal_error)?;

    Ok(Json(AuthResponse {
        token,
        user: UserResponse {
            id: user.id,
            email: user.email,
            github_username: user.github_username,
        },
    }))
}

/// login with email/password
#[utoipa::path(
    post,
    path = "/api/auth/login",
    tag = "auth",
    request_body = LoginRequest,
    responses(
        (status = 200, description = "successfully logged in", body = AuthResponse),
        (status = 401, description = "invalid credentials", body = ErrorResponse)
    )
)]
pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<ErrorResponse>)> {
    // find user
    let user = state
        .db
        .get_user_by_email(&req.email)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: "invalid credentials".to_string(),
                }),
            )
        })?;

    // verify password
    let password_hash = user.password_hash.as_ref().ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "this account uses github login".to_string(),
            }),
        )
    })?;

    let valid = verify_password(&req.password, password_hash).map_err(internal_error)?;
    if !valid {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "invalid credentials".to_string(),
            }),
        ));
    }

    // create token
    let config = state.config.read().await;
    let token = create_token(
        user.id,
        &user.email,
        &config.auth.jwt_secret,
        config.auth.jwt_expiry_hours,
    )
    .map_err(internal_error)?;

    Ok(Json(AuthResponse {
        token,
        user: UserResponse {
            id: user.id,
            email: user.email,
            github_username: user.github_username,
        },
    }))
}

/// github oauth callback
#[utoipa::path(
    get,
    path = "/api/auth/github/callback",
    tag = "auth",
    params(
        ("code" = String, Query, description = "github oauth authorization code")
    ),
    responses(
        (status = 200, description = "successfully authenticated with github", body = AuthResponse),
        (status = 400, description = "invalid oauth code", body = ErrorResponse)
    )
)]
pub async fn github_callback(
    State(state): State<AppState>,
    Query(query): Query<GithubCallbackQuery>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<ErrorResponse>)> {
    // exchange code for token
    let config = state.config.read().await;
    let token_response = exchange_code_for_token(
        &config.github.client_id,
        &config.github.client_secret,
        &query.code,
    )
    .await
    .map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;

    // get github user info
    let github_user = get_github_user(&token_response.access_token)
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: e.to_string(),
                }),
            )
        })?;

    // find or create user
    let user = if let Some(mut user) = state
        .db
        .get_user_by_github_id(github_user.id)
        .map_err(internal_error)?
    {
        // update access token
        user.github_access_token = Some(token_response.access_token);
        state.db.save_user(&user).map_err(internal_error)?;
        user
    } else {
        // create new user
        let email = github_user
            .email
            .unwrap_or_else(|| format!("{}@github.local", github_user.login));
        let mut user = User::new_with_github(email, github_user.id, github_user.login);
        user.github_access_token = Some(token_response.access_token);
        state.db.save_user(&user).map_err(internal_error)?;
        user
    };

    // create jwt token
    let config = state.config.read().await;
    let token = create_token(
        user.id,
        &user.email,
        &config.auth.jwt_secret,
        config.auth.jwt_expiry_hours,
    )
    .map_err(internal_error)?;

    Ok(Json(AuthResponse {
        token,
        user: UserResponse {
            id: user.id,
            email: user.email,
            github_username: user.github_username,
        },
    }))
}

/// helper to convert errors to internal server error
fn internal_error<E: std::fmt::Display>(e: E) -> (StatusCode, Json<ErrorResponse>) {
    tracing::error!("internal error: {}", e);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: "internal server error".to_string(),
        }),
    )
}
