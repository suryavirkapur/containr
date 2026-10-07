//! authentication handlers

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Redirect,
    Json,
};
use base64::Engine;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{
    create_token, extract_bearer_token, hash_password, validate_token,
    verify_password,
};
use crate::github::{exchange_code_for_token, get_github_user};
use crate::security::encrypt_value;
use crate::state::{AppState, OAuthPurpose};
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
    /// true when this github round trip linked github to a signed-in
    /// account instead of signing in
    pub linked: bool,
}

/// where to send the browser to link a github account
#[derive(Debug, Serialize, ToSchema)]
pub struct GithubLinkResponse {
    /// github authorization url
    pub url: String,
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
    /// whether the account can sign in with a password
    pub has_password: bool,
}

/// public registration status
#[derive(Debug, Serialize, ToSchema)]
pub struct RegistrationStatusResponse {
    /// whether the first account can still be registered publicly
    pub registration_open: bool,
    /// total number of known users
    pub user_count: usize,
    /// whether sign in and linking with github are configured
    pub github_enabled: bool,
}

/// admin-managed local user creation request
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateUserRequest {
    /// user email address
    pub email: String,
    /// password (min 8 characters)
    pub password: String,
}

/// password change request
#[derive(Debug, Deserialize, ToSchema)]
pub struct ChangePasswordRequest {
    /// current password; not required for accounts without one
    pub current_password: Option<String>,
    /// new password (min 8 characters)
    pub new_password: String,
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
) -> Result<Json<RegistrationStatusResponse>, (StatusCode, Json<ErrorResponse>)>
{
    let user_count = state.db.list_users().map_err(internal_error)?.len();
    let github_enabled = github_oauth_configured(&state).await;

    Ok(Json(RegistrationStatusResponse {
        registration_open: user_count == 0,
        user_count,
        github_enabled,
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
    if !github_oauth_configured(&state).await {
        return Redirect::temporary("/login");
    }
    match github_authorize_url(&state, OAuthPurpose::Login).await {
        Ok(url) => Redirect::temporary(&url),
        Err(_) => Redirect::temporary("/login"),
    }
}

/// start linking github to the signed-in account
#[utoipa::path(
    post,
    path = "/api/auth/github/link",
    tag = "auth",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "github authorization url", body = GithubLinkResponse),
        (status = 400, description = "github sign in isn't configured", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn github_link_start(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<GithubLinkResponse>, (StatusCode, Json<ErrorResponse>)> {
    let user = require_authenticated_user(&state, &headers).await?;
    if !github_oauth_configured(&state).await {
        return Err(bad_request(
            "github isn't configured on this server: set [github] \
             client_id and client_secret in containr.toml",
        ));
    }
    let url = github_authorize_url(&state, OAuthPurpose::Link(user.id))
        .await
        .map_err(internal_error)?;
    Ok(Json(GithubLinkResponse { url }))
}

/// unlink github from the signed-in account
#[utoipa::path(
    delete,
    path = "/api/auth/github/link",
    tag = "auth",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "github unlinked", body = UserResponse),
        (status = 400, description = "no github account linked", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 409, description = "the account has no password", body = ErrorResponse)
    )
)]
pub async fn github_unlink(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<UserResponse>, (StatusCode, Json<ErrorResponse>)> {
    let mut user = require_authenticated_user(&state, &headers).await?;
    unlink_github(&mut user)?;
    user.updated_at = chrono::Utc::now();
    state.db.save_user(&user).map_err(internal_error)?;
    Ok(Json(user_response(&user)))
}

async fn github_oauth_configured(state: &AppState) -> bool {
    let config = state.config.read().await;
    !config.github.client_id.trim().is_empty()
        && !config.github.client_secret.trim().is_empty()
}

/// creates a single-use oauth state for `purpose` and returns the github
/// authorization url carrying it
async fn github_authorize_url(
    state: &AppState,
    purpose: OAuthPurpose,
) -> Result<String, url::ParseError> {
    let state_value = generate_oauth_state();
    let now = chrono::Utc::now().timestamp();
    state.cleanup_expired_oauth_states(now);
    state.insert_oauth_state(&state_value, now + 600, purpose);

    let config = state.config.read().await;
    let mut auth_url =
        url::Url::parse("https://github.com/login/oauth/authorize")?;
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", &config.github.client_id)
        .append_pair("state", &state_value)
        .append_pair("scope", "repo");
    Ok(auth_url.to_string())
}

/// attaches a github identity to `user`. a github account can belong to
/// one containr user only; `current_owner` is whoever has it now.
fn link_github(
    user: &mut User,
    current_owner: Option<&User>,
    github_id: i64,
    github_login: &str,
    encrypted_token: String,
) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
    if current_owner.is_some_and(|owner| owner.id != user.id) {
        return Err((
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: "this GitHub account is already linked to another \
                        containr account"
                    .to_string(),
            }),
        ));
    }
    user.github_id = Some(github_id);
    user.github_username = Some(github_login.to_string());
    user.github_access_token = Some(encrypted_token);
    Ok(())
}

/// removes the github identity and token. refused for accounts without a
/// password, which could no longer sign in.
fn unlink_github(
    user: &mut User,
) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
    if user.github_id.is_none() && user.github_access_token.is_none() {
        return Err(bad_request("no GitHub account is linked"));
    }
    if user.password_hash.is_none() {
        return Err((
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: "set a password before unlinking GitHub, or you \
                        won't be able to sign in"
                    .to_string(),
            }),
        ));
    }
    user.github_id = None;
    user.github_username = None;
    user.github_access_token = None;
    Ok(())
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
    let config = state.config.read().await.clone();
    let token = create_token(
        user.id,
        &user.email,
        &config.auth.jwt_secret,
        config.auth.jwt_expiry_hours,
    )
    .map_err(internal_error)?;

    Ok(Json(AuthResponse {
        token,
        user: user_response(&user),
        linked: false,
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

/// change the current user's password
#[utoipa::path(
    post,
    path = "/api/auth/password",
    tag = "auth",
    security(("bearer" = [])),
    request_body = ChangePasswordRequest,
    responses(
        (status = 204, description = "password changed"),
        (status = 400, description = "invalid request or wrong current password", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let mut user = require_authenticated_user(&state, &headers).await?;

    if req.new_password.len() < 8 {
        return Err(bad_request("password must be at least 8 characters"));
    }

    // github-only accounts have no password yet and may set one directly
    if let Some(password_hash) = user.password_hash.as_deref() {
        let current = req.current_password.as_deref().unwrap_or_default();
        let valid =
            verify_password(current, password_hash).map_err(internal_error)?;
        if !valid {
            return Err(bad_request("current password is incorrect"));
        }
    }

    user.password_hash =
        Some(hash_password(&req.new_password).map_err(internal_error)?);
    user.updated_at = chrono::Utc::now();
    state.db.save_user(&user).map_err(internal_error)?;

    Ok(StatusCode::NO_CONTENT)
}

/// delete a user and tear down their services (admin)
#[utoipa::path(
    delete,
    path = "/api/admin/users/{id}",
    tag = "auth",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "user id")),
    responses(
        (status = 204, description = "user deleted"),
        (status = 400, description = "cannot delete yourself", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "admin access required", body = ErrorResponse),
        (status = 404, description = "user not found", body = ErrorResponse)
    )
)]
pub async fn delete_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let admin = require_admin_user(&state, &headers).await?;
    if admin.id == id {
        return Err(bad_request("you cannot delete your own account"));
    }
    if state.db.get_user(id).map_err(internal_error)?.is_none() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "user not found".to_string(),
            }),
        ));
    }

    // stop the user's containers before the rows cascade away
    let inventory = state
        .db
        .list_service_inventory_by_owner(id)
        .map_err(internal_error)?;
    let svc = crate::domain::services::ServiceSvc::new(state.clone());
    for item in inventory {
        if let Err((_, error)) = svc.delete_service(id, item.id).await {
            tracing::warn!(
                user_id = %id,
                service_id = %item.id,
                error = %error.error,
                "failed to delete service while deleting user"
            );
        }
    }

    state.db.delete_user(id).map_err(internal_error)?;
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
    let config = state.config.read().await.clone();
    let token = create_token(
        user.id,
        &user.email,
        &config.auth.jwt_secret,
        config.auth.jwt_expiry_hours,
    )
    .map_err(internal_error)?;

    Ok(Json(AuthResponse {
        token,
        user: user_response(&user),
        linked: false,
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
    headers: HeaderMap,
    Query(query): Query<GithubCallbackQuery>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<ErrorResponse>)> {
    // verify state
    let now = chrono::Utc::now().timestamp();
    let purpose = match state.take_oauth_state(&query.state) {
        Some((expires_at, purpose)) if expires_at >= now => purpose,
        _ => return Err(bad_request("invalid oauth state")),
    };
    // a link must finish in the session that started it
    let linking_user = match purpose {
        OAuthPurpose::Login => None,
        OAuthPurpose::Link(user_id) => {
            let user = require_authenticated_user(&state, &headers).await?;
            if user.id != user_id {
                return Err((
                    StatusCode::FORBIDDEN,
                    Json(ErrorResponse {
                        error: "this GitHub link was started by another \
                                account"
                            .to_string(),
                    }),
                ));
            }
            Some(user)
        }
    };

    // exchange code for token
    let config = state.config.read().await.clone();
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

    let current_owner = state
        .db
        .get_user_by_github_id(github_user.id)
        .map_err(internal_error)?;
    let linked = linking_user.is_some();
    let user = if let Some(mut user) = linking_user {
        link_github(
            &mut user,
            current_owner.as_ref(),
            github_user.id,
            &github_user.login,
            token_to_store,
        )?;
        user.updated_at = chrono::Utc::now();
        state.db.save_user(&user).map_err(internal_error)?;
        user
    } else if let Some(mut user) = current_owner {
        if !user.is_admin
            && !state.db.has_admin_user().map_err(internal_error)?
        {
            user.is_admin = true;
        }

        // refresh the token and the (renameable) github login
        user.github_access_token = Some(token_to_store);
        user.github_username = Some(github_user.login.clone());
        state.db.save_user(&user).map_err(internal_error)?;
        user
    } else {
        let existing_users =
            state.db.list_users().map_err(internal_error)?.len();
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
    let config = state.config.read().await.clone();
    let token = create_token(
        user.id,
        &user.email,
        &config.auth.jwt_secret,
        config.auth.jwt_expiry_hours,
    )
    .map_err(internal_error)?;

    Ok(Json(AuthResponse {
        token,
        user: user_response(&user),
        linked,
    }))
}

fn user_response(user: &User) -> UserResponse {
    UserResponse {
        id: user.id,
        email: user.email.clone(),
        github_username: user.github_username.clone(),
        is_admin: user.is_admin,
        has_password: user.password_hash.is_some(),
    }
}

pub(crate) async fn require_authenticated_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<User, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await.clone();
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

pub(crate) async fn require_admin_user(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn password_user() -> User {
        User::new_with_password(
            "dev@example.com".to_string(),
            "$argon2id$hash".to_string(),
        )
    }

    #[test]
    fn linking_attaches_the_github_identity() {
        let mut user = password_user();
        link_github(&mut user, None, 42, "octocat", "enc:token".to_string())
            .expect("link");
        assert_eq!(user.github_id, Some(42));
        assert_eq!(user.github_username.as_deref(), Some("octocat"));
        assert_eq!(user.github_access_token.as_deref(), Some("enc:token"));

        // relinking the same account (e.g. a renamed login) is fine
        let same = user.clone();
        link_github(&mut user, Some(&same), 42, "octo", "enc:new".to_string())
            .expect("relink");
        assert_eq!(user.github_username.as_deref(), Some("octo"));
    }

    #[test]
    fn a_github_account_belongs_to_one_user() {
        let mut user = password_user();
        let other =
            User::new_with_github("o@example.com".into(), 42, "octo".into());
        let error =
            link_github(&mut user, Some(&other), 42, "octo", "enc:t".into())
                .expect_err("taken");
        assert_eq!(error.0, StatusCode::CONFLICT);
        assert_eq!(user.github_id, None);
    }

    #[test]
    fn unlinking_needs_a_password_to_fall_back_on() {
        let mut github_only =
            User::new_with_github("g@example.com".into(), 7, "gh".into());
        let error = unlink_github(&mut github_only).expect_err("no password");
        assert_eq!(error.0, StatusCode::CONFLICT);
        assert_eq!(github_only.github_id, Some(7));

        let mut user = password_user();
        assert_eq!(
            unlink_github(&mut user).expect_err("nothing linked").0,
            StatusCode::BAD_REQUEST
        );
        link_github(&mut user, None, 7, "gh", "enc:t".into()).expect("link");
        unlink_github(&mut user).expect("unlink");
        assert!(user.github_id.is_none());
        assert!(user.github_username.is_none());
        assert!(user.github_access_token.is_none());
    }
}
