//! github app integration handlers (coolify-style)

use std::collections::HashMap;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Redirect,
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::github::{
    convert_manifest_code, generate_app_jwt, get_installation_repos,
    get_installation_token, list_app_installations, GithubRepo,
};
use crate::handlers::auth::ErrorResponse;
use crate::security::{decrypt_value, encrypt_value};
use crate::state::AppState;
use containr_common::models::{GithubAppConfig, GithubInstallation};

/// github app status response
#[derive(Debug, Serialize, ToSchema)]
pub struct GithubAppStatusResponse {
    /// whether a github app is configured
    pub configured: bool,
    /// app details if configured
    pub app: Option<AppDetails>,
    /// list of installations
    pub installations: Vec<InstallationDetails>,
}

/// app details
#[derive(Debug, Serialize, ToSchema)]
pub struct AppDetails {
    pub app_id: i64,
    pub app_name: String,
    pub html_url: String,
}

/// installation details
#[derive(Debug, Serialize, ToSchema)]
pub struct InstallationDetails {
    pub id: i64,
    pub account_login: String,
    pub account_type: String,
    pub repository_count: Option<i32>,
}

/// repos response
#[derive(Debug, Serialize, ToSchema)]
pub struct AppReposResponse {
    pub repos: Vec<RepoInfo>,
}

/// repo info
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

/// callback query params
#[derive(Debug, Deserialize)]
pub struct ManifestCallbackQuery {
    pub code: String,
}

/// installation callback query
#[derive(Debug, Deserialize)]
pub struct InstallationCallbackQuery {
    pub installation_id: Option<i64>,
    pub setup_action: Option<String>,
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

/// get github app status and installations
#[utoipa::path(
    get,
    path = "/api/github/app",
    tag = "github-app",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "github app status", body = GithubAppStatusResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn get_github_app(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<GithubAppStatusResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let app_config =
        state.db.get_github_app(user_id).map_err(internal_error)?;

    match app_config {
        Some(app) => {
            let app = sync_installations(&state, &config, app).await;
            let installations = app.installations.clone();

            Ok(Json(GithubAppStatusResponse {
                configured: true,
                app: Some(AppDetails {
                    app_id: app.app_id,
                    app_name: app.app_name,
                    html_url: app.html_url,
                }),
                installations: installations
                    .into_iter()
                    .map(|i| InstallationDetails {
                        id: i.id,
                        account_login: i.account_login,
                        account_type: i.account_type,
                        repository_count: i.repository_count,
                    })
                    .collect(),
            }))
        }
        None => Ok(Json(GithubAppStatusResponse {
            configured: false,
            app: None,
            installations: vec![],
        })),
    }
}

/// generates the github app manifest and returns the creation url
#[utoipa::path(
    get,
    path = "/api/github/app/manifest",
    tag = "github-app",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "app manifest payload", body = serde_json::Value),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn get_app_manifest(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let _user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let base_domain = config.proxy.base_domain.trim_end_matches('/');
    let base_url = if base_domain.starts_with("http://")
        || base_domain.starts_with("https://")
    {
        base_domain.to_string()
    } else {
        format!("https://{}", base_domain)
    };
    let redirect_url = format!("{}/github/callback", base_url);

    let manifest = serde_json::json!({
        "name": "containr",
        "url": base_url,
        "hook_attributes": {
            "url": format!("{}/webhooks/github", base_url)
        },
        "redirect_url": redirect_url,
        "callback_urls": [
            format!("{}/github/callback", base_url)
        ],
        "setup_url": format!("{}/github/install/callback", base_url),
        "public": false,
        "default_permissions": {
            "contents": "read",
            "metadata": "read",
            "pull_requests": "read"
        },
        "default_events": ["push", "pull_request"]
    });

    Ok(Json(manifest))
}

/// handles the github app manifest callback
#[utoipa::path(
    get,
    path = "/api/github/app/callback",
    tag = "github-app",
    params(
        ("code" = String, Query, description = "manifest conversion code")
    ),
    responses(
        (status = 302, description = "redirect to settings"),
        (status = 400, description = "conversion failed", body = ErrorResponse)
    )
)]
pub async fn github_app_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ManifestCallbackQuery>,
) -> Result<Redirect, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;

    // try to get user from cookie/session or use a default flow
    // for now we'll require auth header
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    // convert manifest code to app credentials
    let app_response =
        convert_manifest_code(&query.code).await.map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("failed to create github app: {}", e),
                }),
            )
        })?;

    // encrypt sensitive data
    let encrypted_secret = encrypt_value(&config, &app_response.client_secret)
        .map_err(internal_error)?;

    let encrypted_pem =
        encrypt_value(&config, &app_response.pem).map_err(internal_error)?;

    let encrypted_webhook =
        encrypt_value(&config, &app_response.webhook_secret)
            .map_err(internal_error)?;

    // create app config using builder pattern
    let app_config =
        GithubAppConfig::builder(app_response.id, app_response.slug, user_id)
            .client_id(app_response.client_id)
            .client_secret(encrypted_secret)
            .private_key(encrypted_pem)
            .webhook_secret(encrypted_webhook)
            .html_url(app_response.html_url)
            .build();

    // save to database
    state
        .db
        .save_github_app(&app_config)
        .map_err(internal_error)?;

    // redirect to settings with success
    Ok(Redirect::to("/settings?github=created"))
}

/// handles the installation callback
#[utoipa::path(
    get,
    path = "/api/github/app/install/callback",
    tag = "github-app",
    params(
        ("installation_id" = Option<i64>, Query, description = "installation id"),
        ("setup_action" = Option<String>, Query, description = "setup action")
    ),
    responses(
        (status = 302, description = "redirect to settings")
    )
)]
pub async fn github_install_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<InstallationCallbackQuery>,
) -> Result<Redirect, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    if let Some(installation_id) = query.installation_id {
        // get app config
        if let Some(mut app_config) =
            state.db.get_github_app(user_id).map_err(internal_error)?
        {
            // decrypt private key
            let pem = decrypt_value(
                &config,
                &app_config.private_key,
                Some(&config.auth.jwt_secret),
            )
            .map_err(internal_error)?;

            // generate jwt and get installation info
            let jwt =
                generate_app_jwt(app_config.app_id, &pem).map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ErrorResponse {
                            error: format!("failed to generate jwt: {}", e),
                        }),
                    )
                })?;

            // get installations from github
            if let Ok(installations) = list_app_installations(&jwt).await {
                // find the new installation
                if let Some(install) =
                    installations.iter().find(|i| i.id == installation_id)
                {
                    let new_install = GithubInstallation::new(
                        install.id,
                        install.account.login.clone(),
                        install.account.account_type.clone(),
                    );

                    // add if not already present
                    if !app_config
                        .installations
                        .iter()
                        .any(|i| i.id == installation_id)
                    {
                        app_config.installations.push(new_install);
                        app_config.updated_at = chrono::Utc::now();
                        state
                            .db
                            .save_github_app(&app_config)
                            .map_err(internal_error)?;
                    }
                }
            }
        }
    }

    Ok(Redirect::to("/settings?github=installed"))
}

/// get repos from github app installations
#[utoipa::path(
    get,
    path = "/api/github/app/repos",
    tag = "github-app",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "list of repositories", body = AppReposResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 400, description = "no github app configured", body = ErrorResponse)
    )
)]
pub async fn get_app_repos(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AppReposResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let app_config = state
        .db
        .get_github_app(user_id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "no github app configured".to_string(),
                }),
            )
        })?;
    let app_config = sync_installations(&state, &config, app_config).await;

    // decrypt private key
    let pem = decrypt_value(
        &config,
        &app_config.private_key,
        Some(&config.auth.jwt_secret),
    )
    .map_err(internal_error)?;

    // generate jwt
    let jwt = generate_app_jwt(app_config.app_id, &pem).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("failed to generate jwt: {}", e),
            }),
        )
    })?;

    let installation_ids = match list_app_installations(&jwt).await {
        Ok(installations) => {
            let ids: Vec<i64> = installations
                .into_iter()
                .map(|installation| installation.id)
                .collect();
            if ids.is_empty() {
                app_config
                    .installations
                    .iter()
                    .map(|installation| installation.id)
                    .collect()
            } else {
                ids
            }
        }
        Err(error) => {
            tracing::warn!(error = %error, "failed to refresh github installations");
            app_config
                .installations
                .iter()
                .map(|installation| installation.id)
                .collect()
        }
    };

    let mut all_repos = HashMap::new();

    // get repos from each installation
    for installation_id in installation_ids {
        let token_response = get_installation_token(&jwt, installation_id)
            .await
            .map_err(|e| {
                (
                    StatusCode::BAD_GATEWAY,
                    Json(ErrorResponse {
                        error: format!(
                            "failed to get installation token: {}",
                            e
                        ),
                    }),
                )
            })?;

        let repos = get_installation_repos(&token_response.token)
            .await
            .map_err(|e| {
                (
                    StatusCode::BAD_GATEWAY,
                    Json(ErrorResponse {
                        error: format!("failed to get repos: {}", e),
                    }),
                )
            })?;

        for repo in repos {
            all_repos.entry(repo.id).or_insert(repo);
        }
    }

    let mut repos: Vec<RepoInfo> =
        all_repos.into_values().map(RepoInfo::from).collect();
    repos.sort_by(|left, right| left.full_name.cmp(&right.full_name));

    Ok(Json(AppReposResponse { repos }))
}

/// delete github app configuration
#[utoipa::path(
    delete,
    path = "/api/github/app",
    tag = "github-app",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "github app deleted"),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn delete_github_app(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    state
        .db
        .delete_github_app(user_id)
        .map_err(internal_error)?;

    Ok(StatusCode::OK)
}

async fn sync_installations(
    state: &AppState,
    config: &containr_common::Config,
    mut app_config: GithubAppConfig,
) -> GithubAppConfig {
    let pem = match decrypt_value(
        config,
        &app_config.private_key,
        Some(&config.auth.jwt_secret),
    ) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(error = %error, "failed to decrypt github app private key");
            return app_config;
        }
    };

    let jwt = match generate_app_jwt(app_config.app_id, &pem) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(error = %error, "failed to generate github app jwt");
            return app_config;
        }
    };

    let refreshed_installations = match list_app_installations(&jwt).await {
        Ok(installations) => installations
            .into_iter()
            .map(|installation| {
                GithubInstallation::new(
                    installation.id,
                    installation.account.login,
                    installation.account.account_type,
                )
            })
            .collect::<Vec<_>>(),
        Err(error) => {
            tracing::warn!(error = %error, "failed to refresh github installations");
            return app_config;
        }
    };

    if same_installations(&app_config.installations, &refreshed_installations) {
        return app_config;
    }

    app_config.installations = refreshed_installations;
    app_config.updated_at = chrono::Utc::now();
    if let Err(error) = state.db.save_github_app(&app_config) {
        tracing::warn!(error = %error, "failed to persist github installation refresh");
    }

    app_config
}

fn same_installations(
    left: &[GithubInstallation],
    right: &[GithubInstallation],
) -> bool {
    if left.len() != right.len() {
        return false;
    }

    left.iter().zip(right.iter()).all(|(left, right)| {
        left.id == right.id
            && left.account_login == right.account_login
            && left.account_type == right.account_type
            && left.repository_count == right.repository_count
    })
}

/// helper for internal errors
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
