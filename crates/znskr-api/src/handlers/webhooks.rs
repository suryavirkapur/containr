//! github webhook handlers

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Serialize;

use crate::github::{extract_branch, verify_webhook_signature, DeploymentJob, PushEvent};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use znskr_common::models::Deployment;

/// webhook response
#[derive(Debug, Serialize)]
pub struct WebhookResponse {
    pub message: String,
    pub deployment_id: Option<String>,
}

/// handles github push webhooks
pub async fn github_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<WebhookResponse>, (StatusCode, Json<ErrorResponse>)> {
    // get signature header
    let signature = headers
        .get("x-hub-signature-256")
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "missing signature".to_string(),
                }),
            )
        })?;

    // verify signature
    let config = state.config.read().await;
    let valid = verify_webhook_signature(&body, signature, &config.github.webhook_secret)
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: e.to_string(),
                }),
            )
        })?;

    if !valid {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "invalid signature".to_string(),
            }),
        ));
    }

    // get event type
    let event_type = headers
        .get("x-github-event")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");

    if event_type != "push" {
        return Ok(Json(WebhookResponse {
            message: format!("ignored event: {}", event_type),
            deployment_id: None,
        }));
    }

    // parse push event
    let push_event: PushEvent = serde_json::from_slice(&body).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!("invalid payload: {}", e),
            }),
        )
    })?;

    // extract branch
    let branch = extract_branch(&push_event.ref_).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "invalid ref".to_string(),
            }),
        )
    })?;

    // find app by github url
    let repo_url = &push_event.repository.html_url;
    let app = find_app_by_repo(&state, repo_url, branch).await?;

    match app {
        Some(app) => {
            // create deployment
            let mut deployment = Deployment::new(app.id, push_event.after.clone());
            deployment.commit_message = push_event.head_commit.map(|c| c.message);
            state
                .db
                .save_deployment(&deployment)
                .map_err(internal_error)?;

            // queue deployment job
            let job = DeploymentJob {
                app_id: app.id,
                commit_sha: push_event.after,
                commit_message: deployment.commit_message.clone(),
                github_url: app.github_url,
                branch: app.branch,
            };

            state
                .deployment_tx
                .send(job)
                .await
                .map_err(|e| internal_error(format!("failed to queue deployment: {}", e)))?;

            tracing::info!(
                app_id = %app.id,
                deployment_id = %deployment.id,
                "deployment triggered via webhook"
            );

            Ok(Json(WebhookResponse {
                message: "deployment triggered".to_string(),
                deployment_id: Some(deployment.id.to_string()),
            }))
        }
        None => Ok(Json(WebhookResponse {
            message: "no matching app found".to_string(),
            deployment_id: None,
        })),
    }
}

/// finds an app by repository url and branch
async fn find_app_by_repo(
    state: &AppState,
    repo_url: &str,
    branch: &str,
) -> Result<Option<znskr_common::models::App>, (StatusCode, Json<ErrorResponse>)> {
    // use the database method to find the app
    state
        .db
        .get_app_by_github_url(repo_url, branch)
        .map_err(internal_error)
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
