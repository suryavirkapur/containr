//! deployment source resolution helpers

use std::path::Path;

use axum::{http::StatusCode, Json};
use uuid::Uuid;

use crate::github::get_repo_installation_token;
use crate::handlers::auth::ErrorResponse;
use crate::security::decrypt_value;
use crate::state::AppState;
use containr_common::models::{App, DeploymentSource};

pub async fn resolve_app_deployment_source(
    state: &AppState,
    owner_id: Uuid,
    app: &App,
) -> Result<DeploymentSource, (StatusCode, Json<ErrorResponse>)> {
    if !app.requires_source_checkout() {
        return Ok(DeploymentSource::None);
    }

    if app.github_url.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "github_url is required when a service needs source checkout"
                    .to_string(),
            }),
        ));
    }

    resolve_source_deployment_source(state, owner_id, &app.github_url).await
}

pub async fn resolve_source_deployment_source(
    state: &AppState,
    owner_id: Uuid,
    source_url: &str,
) -> Result<DeploymentSource, (StatusCode, Json<ErrorResponse>)> {
    if is_local_source_path(source_url) {
        return Ok(DeploymentSource::LocalPath {
            path: source_url.to_string(),
        });
    }

    resolve_remote_source_deployment(state, owner_id, source_url).await
}

pub async fn resolve_remote_deployment_source(
    state: &AppState,
    owner_id: Uuid,
    app: &App,
) -> Result<DeploymentSource, (StatusCode, Json<ErrorResponse>)> {
    resolve_remote_source_deployment(state, owner_id, &app.github_url).await
}

pub async fn resolve_remote_source_deployment(
    state: &AppState,
    owner_id: Uuid,
    source_url: &str,
) -> Result<DeploymentSource, (StatusCode, Json<ErrorResponse>)> {
    let token = resolve_remote_git_token(state, owner_id, source_url).await?;
    Ok(DeploymentSource::RemoteGit {
        url: source_url.to_string(),
        token,
    })
}

pub async fn resolve_remote_git_token(
    state: &AppState,
    owner_id: Uuid,
    repo_url: &str,
) -> Result<Option<String>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;

    if let Some(app_config) =
        state.db.get_github_app(owner_id).map_err(internal_error)?
    {
        let private_key_pem = decrypt_value(
            &config,
            &app_config.private_key,
            Some(&config.auth.jwt_secret),
        )
        .map_err(internal_error)?;

        let token = get_repo_installation_token(
            &app_config,
            &private_key_pem,
            repo_url,
        )
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                Json(ErrorResponse {
                    error: format!("github api error: {}", e),
                }),
            )
        })?;

        if token.is_some() {
            return Ok(token);
        }
    }

    let user = state.db.get_user(owner_id).map_err(internal_error)?;
    if let Some(user) = user {
        if let Some(access_token) = user.github_access_token {
            let decrypted_token = decrypt_value(
                &config,
                &access_token,
                Some(&config.auth.jwt_secret),
            )
            .map_err(internal_error)?;
            return Ok(Some(decrypted_token));
        }
    }

    Ok(None)
}

fn is_local_source_path(source: &str) -> bool {
    if source.trim().is_empty() {
        return false;
    }

    if source.contains("://") {
        return false;
    }

    let path = Path::new(source);
    path.is_absolute() || path.exists()
}

fn internal_error<E: std::fmt::Display>(
    error: E,
) -> (StatusCode, Json<ErrorResponse>) {
    tracing::error!("internal error: {}", error);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: "internal server error".to_string(),
        }),
    )
}
