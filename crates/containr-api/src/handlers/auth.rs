//! authentication handlers

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Redirect,
    Json,
};
use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{
    create_token, extract_bearer_token, hash_password, validate_token,
    verify_password,
};
use crate::github::{exchange_code_for_token, get_github_user};
use crate::security::encrypt_value;
use crate::state::AppState;
use containr_common::models::User;

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
    /// whether this user can manage server settings and users
    pub is_admin: bool,
}

/// public registration status
#[derive(Debug, Serialize, ToSchema)]
pub struct RegistrationStatusResponse {
    /// whether the first account can still be registered publicly
    pub registration_open: bool,
    /// total number of known users
    pub user_count: usize,
}

/// admin-managed local user creation request
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateUserRequest {
    /// user email address
    pub email: String,
    /// password (min 8 characters)
    pub password: String,
}

/// error response
#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorResponse {
    /// error message
    pub error: String,
}

/// get public registration status
#[utoipa::path(
    get,
    path = "/api/auth/status",
    tag = "auth",
    responses((status = 200, description = "registration status", body = RegistrationStatusResponse))
)]
pub async fn status(
    State(state): State<AppState>,
) -> Result<Json<RegistrationStatusResponse>, (StatusCode, Json<ErrorResponse>)> {
    let user_count = state.db.list_users().map_err(internal_error)?.len();

    Ok(Json(RegistrationStatusResponse {
        registration_open: user_count == 0,
        user_count,
    }))
}

/// github oauth callback query params
#[derive(Debug, Deserialize)]
pub struct GithubCallbackQuery {
    pub code: String,
    pub state: String,
}

/// start github oauth flow
#[utoipa::path(
    get,
    path = "/api/auth/github",
    tag = "auth",
    responses((status = 302, description = "redirect to github oauth"))
)]
pub async fn github_start(State(state): State<AppState>) -> Redirect {
    let state_value = generate_oauth_state();
    let now = chrono::Utc::now().timestamp();
    let expires_at = now + 600;
    if let Ok(cache) = state.cache.lock() {
        let _ = cache.cleanup_expired_oauth_states(now);
        if let Err(error) = cache.insert_oauth_state(&state_value, expires_at) {
            tracing::warn!(
                error = %error,
                "failed to persist github oauth state"
            );
        }
    } else {
        tracing::warn!("failed to lock github oauth state cache");
    }

    let config = state.config.read().await;
    let mut auth_url =
        url::Url::parse("https://github.com/login/oauth/authorize")
            .expect("valid github oauth url");
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", &config.github.client_id)
        .append_pair("state", &state_value)
        .append_pair("scope", "repo");

    Redirect::temporary(auth_url.as_str())
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
    headers: HeaderMap,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<ErrorResponse>)> {
    let user_count = state.db.list_users().map_err(internal_error)?.len();
    if user_count > 0 {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "public registration is closed; ask the admin to create your account"
                    .to_string(),
            }),
        ));
    }

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
    let mut user = User::new_with_password(req.email.clone(), password_hash);
    let _ = headers;
    user.is_admin = true;

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
            is_admin: user.is_admin,
        },
    }))
}

/// get the current authenticated user
#[utoipa::path(
    get,
    path = "/api/auth/me",
    tag = "auth",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "current user", body = UserResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<UserResponse>, (StatusCode, Json<ErrorResponse>)> {
    let user = require_authenticated_user(&state, &headers).await?;
    Ok(Json(user_response(&user)))
}

/// list all local users
#[utoipa::path(
    get,
    path = "/api/admin/users",
    tag = "auth",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "list users", body = [UserResponse]),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "admin access required", body = ErrorResponse)
    )
)]
pub async fn list_users(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<UserResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let _admin = require_admin_user(&state, &headers).await?;
    let users = state
        .db
        .list_users()
        .map_err(internal_error)?
        .into_iter()
        .map(|user| user_response(&user))
        .collect();

    Ok(Json(users))
}

/// create a new local user as the bootstrap admin
#[utoipa::path(
    post,
    path = "/api/admin/users",
    tag = "auth",
    security(("bearer" = [])),
    request_body = CreateUserRequest,
    responses(
        (status = 200, description = "user created", body = UserResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "admin access required", body = ErrorResponse),
        (status = 409, description = "email already registered", body = ErrorResponse)
    )
)]
pub async fn create_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateUserRequest>,
) -> Result<Json<UserResponse>, (StatusCode, Json<ErrorResponse>)> {
    let _admin = require_admin_user(&state, &headers).await?;

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

    if req.password.len() < 8 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "password must be at least 8 characters".to_string(),
            }),
        ));
    }

    let password_hash = hash_password(&req.password).map_err(internal_error)?;
    let user = User::new_with_password(req.email.clone(), password_hash);
    state.db.save_user(&user).map_err(internal_error)?;

    Ok(Json(user_response(&user)))
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

    let valid = verify_password(&req.password, password_hash)
        .map_err(internal_error)?;
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
            is_admin: user.is_admin,
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
    // verify state
    let now = chrono::Utc::now().timestamp();
    let expires_at = {
        let cache = state.cache.lock().map_err(internal_error)?;
        cache
            .take_oauth_state(&query.state)
            .map_err(internal_error)?
    };
    if expires_at.is_none() || expires_at.unwrap_or(0) < now {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "invalid oauth state".to_string(),
            }),
        ));
    }

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
    let token_to_store = encrypt_value(&config, &token_response.access_token)
        .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("token encryption failed: {}", e),
            }),
        )
    })?;

    let user = if let Some(mut user) = state
        .db
        .get_user_by_github_id(github_user.id)
        .map_err(internal_error)?
    {
        if !user.is_admin
            && !state.db.has_admin_user().map_err(internal_error)?
        {
            user.is_admin = true;
        }

        // update access token
        user.github_access_token = Some(token_to_store);
        state.db.save_user(&user).map_err(internal_error)?;
        user
    } else {
        let existing_users = state.db.list_users().map_err(internal_error)?.len();
        if existing_users > 0 {
            return Err((
                StatusCode::FORBIDDEN,
                Json(ErrorResponse {
                    error:
                        "github signups are closed; ask the admin to provision your account"
                            .to_string(),
                }),
            ));
        }

        // create new user
        let email = github_user
            .email
            .unwrap_or_else(|| format!("{}@github.local", github_user.login));
        let mut user =
            User::new_with_github(email, github_user.id, github_user.login);
        user.is_admin = true;
        user.github_access_token = Some(token_to_store);
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
            is_admin: user.is_admin,
        },
    }))
}

fn user_response(user: &User) -> UserResponse {
    UserResponse {
        id: user.id,
        email: user.email.clone(),
        github_username: user.github_username.clone(),
        is_admin: user.is_admin,
    }
}

async fn require_authenticated_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<User, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(headers, &config.auth.jwt_secret)?;
    drop(config);

    state
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
        })
}

async fn require_admin_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<User, (StatusCode, Json<ErrorResponse>)> {
    let user = require_authenticated_user(state, headers).await?;
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

    let claims = validate_token(token, jwt_secret).map_err(|error| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: error.to_string(),
            }),
        )
    })?;

    Ok(claims.sub)
}

/// helper to convert errors to internal server error
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

fn generate_oauth_state() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
