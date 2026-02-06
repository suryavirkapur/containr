//! git push handlers (smart http)

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use axum::{
    body::Bytes,
    extract::{Path as AxumPath, RawQuery, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::engine::general_purpose::STANDARD as base64_engine;
use base64::Engine;
use serde::Serialize;
use tokio::task::spawn_blocking;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::ErrorResponse;
use crate::security::{decrypt_value, encrypt_value};
use crate::state::AppState;

const GIT_USERNAME: &str = "znskr";

/// git info response
#[derive(Debug, Serialize, ToSchema)]
pub struct GitInfoResponse {
    /// whether git push is enabled
    pub enabled: bool,
    /// repo name (e.g. <uuid>.git)
    pub repo: String,
    /// http path for git push
    pub path: String,
    /// http url for git push (if base domain configured)
    pub http_url: Option<String>,
    /// http basic username
    pub username: String,
}

/// git enable response
#[derive(Debug, Serialize, ToSchema)]
pub struct GitEnableResponse {
    pub enabled: bool,
    pub repo: String,
    pub path: String,
    pub http_url: Option<String>,
    pub username: String,
    /// deploy token (only returned on enable/rotate)
    pub token: String,
}

/// get git push info for an app
#[utoipa::path(
    get,
    path = "/api/apps/{id}/git",
    tag = "git",
    params(("id" = Uuid, Path, description = "app id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "git info", body = GitInfoResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn get_git_info(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(app_id): AxumPath<Uuid>,
) -> Result<Json<GitInfoResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let app = state
        .db
        .get_app(app_id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "app not found".to_string(),
                }),
            )
        })?;

    if app.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    let repo = repo_name(app_id);
    let path = format!("/git/{}", repo);
    let http_url = build_http_url(&config.proxy.base_domain, &path);

    Ok(Json(GitInfoResponse {
        enabled: app.git_deploy_token.is_some(),
        repo,
        path,
        http_url,
        username: GIT_USERNAME.to_string(),
    }))
}

/// enable git push for an app
#[utoipa::path(
    post,
    path = "/api/apps/{id}/git",
    tag = "git",
    params(("id" = Uuid, Path, description = "app id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "git enabled", body = GitEnableResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse),
        (status = 409, description = "already enabled", body = ErrorResponse)
    )
)]
pub async fn enable_git(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(app_id): AxumPath<Uuid>,
) -> Result<Json<GitEnableResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let mut app = state
        .db
        .get_app(app_id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "app not found".to_string(),
                }),
            )
        })?;

    if app.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    if app.git_deploy_token.is_some() {
        return Err((
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: "git push already enabled".to_string(),
            }),
        ));
    }

    let token = generate_token();
    let encrypted = encrypt_value(&config, &token).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e }),
        )
    })?;

    let repo_root = git_root(&config.storage.data_dir);
    let repo_path = repo_root.join(repo_name(app_id));
    init_bare_repo(&repo_path).map_err(internal_error)?;
    write_post_receive_hook(&repo_path, app_id, config.server.port, &token)
        .map_err(internal_error)?;

    app.git_deploy_token = Some(encrypted);
    app.updated_at = chrono::Utc::now();
    state.db.save_app(&app).map_err(internal_error)?;

    let path = format!("/git/{}", repo_name(app_id));
    let http_url = build_http_url(&config.proxy.base_domain, &path);

    Ok(Json(GitEnableResponse {
        enabled: true,
        repo: repo_name(app_id),
        path,
        http_url,
        username: GIT_USERNAME.to_string(),
        token,
    }))
}

/// rotate git deploy token
#[utoipa::path(
    post,
    path = "/api/apps/{id}/git/rotate",
    tag = "git",
    params(("id" = Uuid, Path, description = "app id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "git token rotated", body = GitEnableResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn rotate_git_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(app_id): AxumPath<Uuid>,
) -> Result<Json<GitEnableResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let mut app = state
        .db
        .get_app(app_id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "app not found".to_string(),
                }),
            )
        })?;

    if app.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    if app.git_deploy_token.is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "git push not enabled".to_string(),
            }),
        ));
    }

    let token = generate_token();
    let encrypted = encrypt_value(&config, &token).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e }),
        )
    })?;

    let repo_root = git_root(&config.storage.data_dir);
    let repo_path = repo_root.join(repo_name(app_id));
    write_post_receive_hook(&repo_path, app_id, config.server.port, &token)
        .map_err(internal_error)?;

    app.git_deploy_token = Some(encrypted);
    app.updated_at = chrono::Utc::now();
    state.db.save_app(&app).map_err(internal_error)?;

    let path = format!("/git/{}", repo_name(app_id));
    let http_url = build_http_url(&config.proxy.base_domain, &path);

    Ok(Json(GitEnableResponse {
        enabled: true,
        repo: repo_name(app_id),
        path,
        http_url,
        username: GIT_USERNAME.to_string(),
        token,
    }))
}

/// smart http git backend
pub async fn git_http(
    State(state): State<AppState>,
    headers: HeaderMap,
    method: Method,
    AxumPath(path): AxumPath<String>,
    RawQuery(query): RawQuery,
    body: Bytes,
) -> Response {
    let repo = match repo_from_path(&path) {
        Some(repo) => repo,
        None => return StatusCode::NOT_FOUND.into_response(),
    };

    let app_id = match Uuid::parse_str(repo.trim_end_matches(".git")) {
        Ok(id) => id,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };

    let app = match state.db.get_app(app_id) {
        Ok(Some(app)) => app,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };

    let token = match extract_basic_token(&headers) {
        Some(token) => token,
        None => return unauthorized_response(),
    };

    let config = state.config.read().await;
    let stored = match app.git_deploy_token {
        Some(value) => value,
        None => return unauthorized_response(),
    };
    let decrypted = match decrypt_value(&config, &stored, Some(&config.auth.jwt_secret)) {
        Ok(value) => value,
        Err(_) => return unauthorized_response(),
    };

    if decrypted != token {
        return unauthorized_response();
    }

    let repo_root = git_root(&config.storage.data_dir);
    let path_info = format!("/{}", path.trim_start_matches('/'));
    let query = query.unwrap_or_default();
    let content_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_string();

    let envs = vec![
        ("GIT_PROJECT_ROOT", repo_root.to_string_lossy().to_string()),
        ("GIT_HTTP_EXPORT_ALL", "1".to_string()),
        ("PATH_INFO", path_info),
        ("REQUEST_METHOD", method.to_string()),
        ("QUERY_STRING", query),
        ("CONTENT_TYPE", content_type),
        ("CONTENT_LENGTH", body.len().to_string()),
    ];

    let output = match spawn_blocking(move || run_git_backend(envs, body.to_vec())).await {
        Ok(Ok(output)) => output,
        _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    build_git_response(output)
}

fn repo_name(app_id: Uuid) -> String {
    format!("{}.git", app_id)
}

fn repo_from_path(path: &str) -> Option<String> {
    let trimmed = path.trim_start_matches('/');
    let mut parts = trimmed.splitn(2, '/');
    let repo = parts.next()?;
    if repo.ends_with(".git") {
        Some(repo.to_string())
    } else {
        None
    }
}

fn git_root(data_dir: &Path) -> PathBuf {
    data_dir.join("git")
}

fn build_http_url(base_domain: &str, path: &str) -> Option<String> {
    let trimmed = base_domain.trim();
    if trimmed.is_empty() {
        None
    } else if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        Some(format!("{}{}", trimmed.trim_end_matches('/'), path))
    } else {
        Some(format!("https://{}{}", trimmed, path))
    }
}

fn init_bare_repo(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    git2::Repository::init_bare(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn write_post_receive_hook(
    repo_path: &Path,
    app_id: Uuid,
    api_port: u16,
    token: &str,
) -> Result<(), String> {
    let hooks_dir = repo_path.join("hooks");
    std::fs::create_dir_all(&hooks_dir).map_err(|e| e.to_string())?;
    let hook_path = hooks_dir.join("post-receive");
    let script = format!(
        r#"#!/bin/sh
set -e
while read oldrev newrev refname; do
  branch=$(printf "%s" "$refname" | sed "s#refs/heads/##")
  payload=$(printf '{{"branch":"%s","commit_sha":"%s"}}' "$branch" "$newrev")
  curl -s -X POST "http://127.0.0.1:{api_port}/api/apps/{app_id}/deployments" \
    -H "x-git-token: {token}" \
    -H "content-type: application/json" \
    -d "$payload" >/dev/null 2>&1 || true
done
"#
    );
    std::fs::write(&hook_path, script).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&hook_path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&hook_path, perms).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn generate_token() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

fn extract_basic_token(headers: &HeaderMap) -> Option<String> {
    let auth_header = headers.get(axum::http::header::AUTHORIZATION)?;
    let auth_str = auth_header.to_str().ok()?;
    let encoded = auth_str.strip_prefix("Basic ")?;
    let decoded = base64_engine.decode(encoded).ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    let mut parts = decoded.splitn(2, ':');
    let _user = parts.next()?;
    let token = parts.next()?;
    Some(token.to_string())
}

fn unauthorized_response() -> Response {
    let mut response = Response::new(axum::body::Body::empty());
    *response.status_mut() = StatusCode::UNAUTHORIZED;
    response.headers_mut().insert(
        axum::http::header::WWW_AUTHENTICATE,
        axum::http::HeaderValue::from_static("Basic realm=\"znskr\""),
    );
    response
}

fn run_git_backend(envs: Vec<(&'static str, String)>, input: Vec<u8>) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    command.arg("http-backend");
    for (key, value) in envs {
        command.env(key, value);
    }
    command.stdin(Stdio::piped()).stdout(Stdio::piped());
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(&input).map_err(|e| e.to_string())?;
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(output.stdout)
}

fn build_git_response(output: Vec<u8>) -> Response {
    let split = output
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|idx| (idx, 4))
        .or_else(|| {
            output
                .windows(2)
                .position(|w| w == b"\n\n")
                .map(|idx| (idx, 2))
        });

    let (header_bytes, body) = match split {
        Some((idx, sep_len)) => (&output[..idx], output[idx + sep_len..].to_vec()),
        None => (output.as_slice(), Vec::new()),
    };

    let header_text = String::from_utf8_lossy(header_bytes);
    let mut status = StatusCode::OK;
    let mut response = Response::new(axum::body::Body::from(body));

    for line in header_text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("Status:") {
            let code = value.trim().split_whitespace().next().unwrap_or("200");
            if let Ok(parsed) = code.parse::<u16>() {
                if let Ok(parsed) = StatusCode::from_u16(parsed) {
                    status = parsed;
                }
            }
            continue;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            if let Ok(header_name) = axum::http::HeaderName::from_bytes(key.trim().as_bytes()) {
                if let Ok(header_value) = axum::http::HeaderValue::from_str(value.trim()) {
                    response.headers_mut().append(header_name, header_value);
                }
            }
        }
    }

    *response.status_mut() = status;
    response
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

fn internal_error<E: std::fmt::Display>(e: E) -> (StatusCode, Json<ErrorResponse>) {
    tracing::error!("internal error: {}", e);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: "internal server error".to_string(),
        }),
    )
}
