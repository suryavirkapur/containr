//! github webhook handlers

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Serialize;

use crate::deployment_source::resolve_remote_deployment_source;
use crate::github::{extract_branch, verify_webhook_signature, DeploymentJob, PushEvent};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use containr_common::models::Deployment;

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
    let valid =
        verify_webhook_signature(&body, signature, &config.github.webhook_secret).map_err(|e| {
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
            let source = resolve_remote_deployment_source(&state, app.owner_id, &app).await?;

            // create deployment
            let mut deployment = Deployment::new(app.id, push_event.after.clone());
            deployment.commit_message = push_event.head_commit.map(|c| c.message);
            state
                .db
                .save_deployment(&deployment)
                .map_err(internal_error)?;

            // queue deployment job
            let job = DeploymentJob {
                deployment_id: deployment.id,
                app_id: app.id,
                commit_sha: push_event.after,
                commit_message: deployment.commit_message.clone(),
                branch: app.branch.clone(),
                source,
                rollout_strategy: app.rollout_strategy,
                rollback_from_deployment_id: None,
            };

            state.deployment_tx.send(job).await.map_err(|e| {
                let _ = state.db.delete_deployment(deployment.id);
                internal_error(format!("failed to queue deployment: {}", e))
            })?;

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
) -> Result<Option<containr_common::models::App>, (StatusCode, Json<ErrorResponse>)> {
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

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use anyhow::{Context, Result};
    use axum::{
        body::Bytes,
        extract::State,
        http::{HeaderMap, HeaderValue, StatusCode},
    };
    use hmac::{Hmac, Mac};
    use serde_json::json;
    use sha2::Sha256;
    use tokio::sync::{mpsc, RwLock};
    use uuid::Uuid;

    use super::github_webhook;
    use crate::security::encrypt_value;
    use crate::state::AppState;
    use containr_common::models::{App, User};
    use containr_common::{Config, Database, DatabaseBackendKind, DatabaseConfig};

    #[tokio::test]
    async fn source_resolution_failure_does_not_persist_deployment() -> Result<()> {
        let fixture = test_fixture(TestTokenMode::InvalidEncrypted, false)?;
        let body = push_event_body(&fixture.app.github_url, &fixture.app.branch)?;
        let headers = signed_headers(&body, &fixture.config.github.webhook_secret)?;

        let result = github_webhook(State(fixture.state.clone()), headers, body).await;
        let (status, _) = result.err().context("expected webhook failure")?;

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(fixture
            .state
            .db
            .list_deployments_by_app(fixture.app.id)?
            .is_empty());

        Ok(())
    }

    #[tokio::test]
    async fn queue_failure_rolls_back_persisted_deployment() -> Result<()> {
        let fixture = test_fixture(TestTokenMode::ValidEncrypted, true)?;
        let body = push_event_body(&fixture.app.github_url, &fixture.app.branch)?;
        let headers = signed_headers(&body, &fixture.config.github.webhook_secret)?;

        let result = github_webhook(State(fixture.state.clone()), headers, body).await;
        let (status, _) = result.err().context("expected webhook failure")?;

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(fixture
            .state
            .db
            .list_deployments_by_app(fixture.app.id)?
            .is_empty());

        Ok(())
    }

    struct TestFixture {
        state: AppState,
        config: Config,
        app: App,
    }

    enum TestTokenMode {
        InvalidEncrypted,
        ValidEncrypted,
    }

    fn test_fixture(token_mode: TestTokenMode, close_queue: bool) -> Result<TestFixture> {
        let root = std::env::temp_dir().join(format!("containr-webhook-test-{}", Uuid::new_v4()));
        let db = Database::open(&DatabaseConfig {
            backend: DatabaseBackendKind::Sled,
            path: root.join("state").to_string_lossy().to_string(),
        })?;

        let mut config = Config::default();
        config.github.webhook_secret = "test-webhook-secret".to_string();
        config.auth.jwt_secret = "test-jwt-secret".to_string();
        config.security.encryption_key = "test-encryption-secret".to_string();

        let (deployment_tx, deployment_rx) = mpsc::channel(1);
        if close_queue {
            drop(deployment_rx);
        }

        let mut user =
            User::new_with_password("owner@example.com".to_string(), "password-hash".to_string());
        user.github_access_token = Some(match token_mode {
            TestTokenMode::InvalidEncrypted => "enc:not-valid".to_string(),
            TestTokenMode::ValidEncrypted => {
                encrypt_value(&config, "github-oauth-token").map_err(anyhow::Error::msg)?
            }
        });
        db.save_user(&user)?;

        let mut app = App::new(
            "demo".to_string(),
            "https://github.com/acme/demo.git".to_string(),
            user.id,
        );
        app.branch = "main".to_string();
        db.save_app(&app)?;

        let state = AppState::new(
            Arc::new(RwLock::new(config.clone())),
            PathBuf::from("containr.toml"),
            PathBuf::from("data"),
            db,
            deployment_tx,
            None,
            None,
        );

        Ok(TestFixture { state, config, app })
    }

    fn push_event_body(repo_url: &str, branch: &str) -> Result<Bytes> {
        let html_url = repo_url.trim_end_matches(".git");
        let clone_url = format!("{}.git", html_url);
        let payload = json!({
            "ref": format!("refs/heads/{}", branch),
            "after": "abc123",
            "repository": {
                "full_name": "acme/demo",
                "clone_url": clone_url,
                "html_url": html_url,
            },
            "head_commit": {
                "message": "test commit",
                "id": "abc123",
            }
        });

        Ok(Bytes::from(serde_json::to_vec(&payload)?))
    }

    fn signed_headers(body: &[u8], secret: &str) -> Result<HeaderMap> {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())?;
        mac.update(body);
        let signature = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));

        let mut headers = HeaderMap::new();
        headers.insert("x-github-event", HeaderValue::from_static("push"));
        headers.insert("x-hub-signature-256", HeaderValue::from_str(&signature)?);

        Ok(headers)
    }
}
