//! personal access tokens for the rest api and the mcp endpoint
//!
//! tokens look like `ctr_<43 url-safe characters>`. only a sha-256 hash is
//! stored. a middleware swaps a valid token for a short-lived session jwt
//! before the request reaches a handler, so every endpoint accepts them
//! without knowing they exist.

use axum::{
    extract::{Path, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use base64::Engine;
use chrono::{Duration, Utc};
use rand::RngExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{create_token, extract_bearer_token};
use crate::handlers::auth::{require_authenticated_user, ErrorResponse};
use crate::state::AppState;
use containr_common::models::{ApiToken, ApiTokenScope};

/// prefix every api token starts with
pub const TOKEN_PREFIX: &str = "ctr_";
/// characters of the secret kept to tell tokens apart
const DISPLAY_PREFIX_LEN: usize = 12;
/// longest lifetime a token can be given
const MAX_EXPIRY_DAYS: i64 = 3650;
/// how often last-used timestamps are written
const TOUCH_INTERVAL_SECS: i64 = 60;

/// what the caller's credentials allow, set on every authenticated request
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestScope {
    pub scope: ApiTokenScope,
    /// true when the caller used an api token rather than a session
    pub via_api_token: bool,
}

/// api token as listed (the secret is never returned again)
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiTokenResponse {
    pub id: Uuid,
    pub name: String,
    /// first characters of the token, e.g. `ctr_AbCd1234`
    pub prefix: String,
    /// `read` or `full`
    pub scope: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub expires_at: Option<String>,
}

impl From<&ApiToken> for ApiTokenResponse {
    fn from(token: &ApiToken) -> Self {
        Self {
            id: token.id,
            name: token.name.clone(),
            prefix: token.prefix.clone(),
            scope: token.scope.as_str().to_string(),
            created_at: token.created_at.to_rfc3339(),
            last_used_at: token.last_used_at.map(|t| t.to_rfc3339()),
            expires_at: token.expires_at.map(|t| t.to_rfc3339()),
        }
    }
}

/// token to create
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateApiTokenRequest {
    /// label to recognise the token by, e.g. "claude code"
    pub name: String,
    /// `read` (GET requests and read-only tools) or `full`; default `full`
    pub scope: Option<String>,
    /// days until the token stops working; omit for no expiry
    pub expires_in_days: Option<i64>,
}

/// newly created token; `token` is shown only this once
#[derive(Debug, Serialize, ToSchema)]
pub struct CreatedApiTokenResponse {
    pub token: String,
    pub api_token: ApiTokenResponse,
}

/// list the caller's api tokens
#[utoipa::path(
    get,
    path = "/api/tokens",
    tag = "tokens",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "api tokens", body = Vec<ApiTokenResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn list_api_tokens(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ApiTokenResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let user = require_authenticated_user(&state, &headers).await?;
    let tokens = state
        .db
        .list_api_tokens_by_user(user.id)
        .map_err(internal_error)?;
    Ok(Json(tokens.iter().map(ApiTokenResponse::from).collect()))
}

/// create an api token
#[utoipa::path(
    post,
    path = "/api/tokens",
    tag = "tokens",
    security(("bearer" = [])),
    request_body = CreateApiTokenRequest,
    responses(
        (status = 201, description = "token created", body = CreatedApiTokenResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "api tokens cannot create tokens", body = ErrorResponse)
    )
)]
pub async fn create_api_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    scope: Option<axum::Extension<RequestScope>>,
    Json(req): Json<CreateApiTokenRequest>,
) -> Result<
    (StatusCode, Json<CreatedApiTokenResponse>),
    (StatusCode, Json<ErrorResponse>),
> {
    // a leaked token must not be able to mint fresh ones
    if scope.is_some_and(|scope| scope.via_api_token) {
        return Err(error(
            StatusCode::FORBIDDEN,
            "sign in to create api tokens",
        ));
    }
    let user = require_authenticated_user(&state, &headers).await?;

    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(error(StatusCode::BAD_REQUEST, "name is required"));
    }
    if name.chars().count() > 64 {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "name must be at most 64 characters",
        ));
    }
    let token_scope = match req.scope.as_deref() {
        None => ApiTokenScope::Full,
        Some(value) => ApiTokenScope::parse(value).ok_or_else(|| {
            error(StatusCode::BAD_REQUEST, "scope must be read or full")
        })?,
    };
    let expires_at = match req.expires_in_days {
        None => None,
        Some(days) if (1..=MAX_EXPIRY_DAYS).contains(&days) => {
            Some(Utc::now() + Duration::days(days))
        }
        Some(_) => {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "expires_in_days must be between 1 and 3650",
            ));
        }
    };

    let secret = generate_token();
    let token = ApiToken {
        id: Uuid::new_v4(),
        user_id: user.id,
        name,
        token_hash: hash_token(&secret),
        prefix: secret.chars().take(DISPLAY_PREFIX_LEN).collect(),
        scope: token_scope,
        created_at: Utc::now(),
        last_used_at: None,
        expires_at,
    };
    state.db.save_api_token(&token).map_err(internal_error)?;

    Ok((
        StatusCode::CREATED,
        Json(CreatedApiTokenResponse {
            token: secret,
            api_token: ApiTokenResponse::from(&token),
        }),
    ))
}

/// revoke an api token
#[utoipa::path(
    delete,
    path = "/api/tokens/{id}",
    tag = "tokens",
    params(("id" = Uuid, Path, description = "token id")),
    security(("bearer" = [])),
    responses(
        (status = 204, description = "token revoked"),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "token not found", body = ErrorResponse)
    )
)]
pub async fn delete_api_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let user = require_authenticated_user(&state, &headers).await?;
    let deleted = state
        .db
        .delete_api_token(user.id, id)
        .map_err(internal_error)?;
    if !deleted {
        return Err(error(StatusCode::NOT_FOUND, "token not found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// swaps a `ctr_` api token for a short-lived session jwt and records the
/// caller's scope. read-only tokens are limited to safe methods, except on
/// the mcp endpoint, which checks the scope per tool.
pub async fn api_token_auth(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Response {
    let bearer = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(extract_bearer_token)
        .map(str::to_string);

    let Some(bearer) = bearer else {
        return next.run(req).await;
    };
    if !bearer.starts_with(TOKEN_PREFIX) {
        // a scope set further up (an mcp tool call) wins over the default
        if req.extensions().get::<RequestScope>().is_none() {
            req.extensions_mut().insert(RequestScope {
                scope: ApiTokenScope::Full,
                via_api_token: false,
            });
        }
        return next.run(req).await;
    }

    let (session, scope) = match exchange_token(&state, &bearer).await {
        Ok(result) => result,
        Err(response) => return *response,
    };

    let safe_method =
        matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if scope == ApiTokenScope::Read
        && !safe_method
        && req.uri().path() != crate::mcp::MCP_PATH
    {
        return error(StatusCode::FORBIDDEN, "this api token is read-only")
            .into_response();
    }

    let Ok(value) = HeaderValue::from_str(&format!("Bearer {}", session))
    else {
        return internal_error("session token is not a valid header")
            .into_response();
    };
    req.headers_mut().insert(header::AUTHORIZATION, value);
    req.extensions_mut().insert(RequestScope {
        scope,
        via_api_token: true,
    });
    next.run(req).await
}

async fn exchange_token(
    state: &AppState,
    secret: &str,
) -> Result<(String, ApiTokenScope), Box<Response>> {
    let unauthorized = || {
        let mut response =
            error(StatusCode::UNAUTHORIZED, "invalid or expired api token")
                .into_response();
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Bearer"),
        );
        Box::new(response)
    };

    let token = state
        .db
        .get_api_token_by_hash(&hash_token(secret))
        .map_err(|e| Box::new(internal_error(e).into_response()))?
        .ok_or_else(unauthorized)?;
    let now = Utc::now();
    if token.is_expired(now) {
        return Err(unauthorized());
    }
    let user = state
        .db
        .get_user(token.user_id)
        .map_err(|e| Box::new(internal_error(e).into_response()))?
        .ok_or_else(unauthorized)?;

    let stale = token
        .last_used_at
        .is_none_or(|used| (now - used).num_seconds() >= TOUCH_INTERVAL_SECS);
    if stale {
        if let Err(e) = state.db.touch_api_token(token.id, now) {
            tracing::warn!(error = %e, "failed to record api token use");
        }
    }

    let jwt_secret = state.config.read().await.auth.jwt_secret.clone();
    let session = create_token(user.id, &user.email, &jwt_secret, 1)
        .map_err(|e| Box::new(internal_error(e).into_response()))?;
    Ok((session, token.scope))
}

/// sha-256 of a token secret, hex encoded
pub fn hash_token(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    format!(
        "{}{}",
        TOKEN_PREFIX,
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    )
}

fn error(
    status: StatusCode,
    message: &str,
) -> (StatusCode, Json<ErrorResponse>) {
    (
        status,
        Json(ErrorResponse {
            error: message.to_string(),
        }),
    )
}

fn internal_error<E: std::fmt::Display>(
    e: E,
) -> (StatusCode, Json<ErrorResponse>) {
    tracing::error!("internal error: {}", e);
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_tokens_are_prefixed_and_unique() {
        let a = generate_token();
        let b = generate_token();
        assert!(a.starts_with(TOKEN_PREFIX));
        assert_eq!(a.len(), TOKEN_PREFIX.len() + 43);
        assert_ne!(a, b);
    }

    #[test]
    fn hashes_are_stable_and_hide_the_secret() {
        let token = "ctr_example";
        assert_eq!(hash_token(token), hash_token(token));
        assert_eq!(hash_token(token).len(), 64);
        assert!(!hash_token(token).contains("example"));
    }
}
