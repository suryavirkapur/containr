//! authentication handlers

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{create_token, hash_password, verify_password};
use crate::github::{exchange_code_for_token, get_github_user};
use crate::state::AppState;
use znskr_common::models::User;

/// login request body
#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

/// register request body
#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
}

/// auth response with token
#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: UserResponse,
}

/// user info in responses
#[derive(Debug, Serialize)]
pub struct UserResponse {
    pub id: Uuid,
    pub email: String,
    pub github_username: Option<String>,
}

/// error response
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

/// github oauth callback query params
#[derive(Debug, Deserialize)]
pub struct GithubCallbackQuery {
    pub code: String,
}

/// register a new user with email/password
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
