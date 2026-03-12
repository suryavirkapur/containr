//! github webhook handlers

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use globset::{Glob, GlobSetBuilder};
use serde::{Deserialize, Serialize};

use crate::deployment_source::resolve_remote_deployment_source;
use crate::github::{extract_branch, verify_webhook_signature, PushEvent};
use crate::handlers::auth::ErrorResponse;
use crate::handlers::deployments::{
    create_and_queue_deployment, DeploymentTriggerRequest,
};
use crate::state::AppState;
use containr_common::models::RolloutStrategy;

/// webhook response
#[derive(Debug, Serialize)]
pub struct WebhookResponse {
    pub message: String,
    pub deployment_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DeployWebhookQuery {
    pub token: String,
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
    let valid = verify_webhook_signature(
        &body,
        signature,
        &config.github.webhook_secret,
    )
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
            if !app.auto_deploy_enabled {
                return Ok(Json(WebhookResponse {
                    message: "auto-deploy is disabled".to_string(),
                    deployment_id: None,
                }));
            }

            if !should_trigger_for_watch_paths(
                &push_event,
                &app.auto_deploy_watch_paths,
            )
            .map_err(internal_error)?
            {
                return Ok(Json(WebhookResponse {
                    message: "ignored push: no watched paths changed"
                        .to_string(),
                    deployment_id: None,
                }));
            }

            let source =
                resolve_remote_deployment_source(&state, app.owner_id, &app)
                    .await?;
            let deployment = create_and_queue_deployment(
                &state,
                app.owner_id,
                &app,
                push_event.after.clone(),
                push_event
                    .head_commit
                    .as_ref()
                    .map(|commit| commit.message.clone()),
                app.branch.clone(),
                app.rollout_strategy,
                None,
                Some(source),
                app.auto_deploy_cleanup_stale_deployments,
            )
            .await?;

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

/// handles deploy webhooks for CI systems
pub async fn deploy_webhook(
    State(state): State<AppState>,
    Path(service_id): Path<uuid::Uuid>,
    Query(query): Query<DeployWebhookQuery>,
    body: Option<Json<DeploymentTriggerRequest>>,
) -> Result<Json<WebhookResponse>, (StatusCode, Json<ErrorResponse>)> {
    let service = state
        .db
        .get_service(service_id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "service not found".to_string(),
                }),
            )
        })?;
    let mut app = state
        .db
        .get_app(service.app_id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "service group not found".to_string(),
                }),
            )
        })?;

    let token_missing = app
        .deploy_webhook_token
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .is_empty();
    let expected_token = app.ensure_deploy_webhook_token().to_string();
    if token_missing {
        state.db.save_app(&app).map_err(internal_error)?;
    }

    if query.token != expected_token {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "invalid deploy webhook token".to_string(),
            }),
        ));
    }

    let trigger = body.map(|value| value.0);
    let deployment = create_and_queue_deployment(
        &state,
        app.owner_id,
        &app,
        trigger
            .as_ref()
            .and_then(|value| value.commit_sha.clone())
            .unwrap_or_else(|| "webhook".to_string()),
        trigger
            .as_ref()
            .and_then(|value| value.commit_message.clone())
            .or_else(|| Some("deploy webhook".to_string())),
        trigger
            .as_ref()
            .and_then(|value| value.branch.clone())
            .unwrap_or_else(|| app.branch.clone()),
        resolve_rollout_strategy_override(
            trigger
                .as_ref()
                .and_then(|value| value.rollout_strategy.as_deref()),
            app.rollout_strategy,
        )?,
        None,
        None,
        app.auto_deploy_cleanup_stale_deployments,
    )
    .await?;

    Ok(Json(WebhookResponse {
        message: "deployment triggered".to_string(),
        deployment_id: Some(deployment.id.to_string()),
    }))
}

/// finds an app by repository url and branch
async fn find_app_by_repo(
    state: &AppState,
    repo_url: &str,
    branch: &str,
) -> Result<
    Option<containr_common::models::App>,
    (StatusCode, Json<ErrorResponse>),
> {
    // use the database method to find the app
    state
        .db
        .get_app_by_github_url(repo_url, branch)
        .map_err(internal_error)
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

fn should_trigger_for_watch_paths(
    push_event: &PushEvent,
    watch_paths: &[String],
) -> anyhow::Result<bool> {
    if watch_paths.is_empty() {
        return Ok(true);
    }

    let changed_paths = push_event.changed_paths();
    if changed_paths.is_empty() {
        return Ok(true);
    }

    let mut builder = GlobSetBuilder::new();
    for watch_path in watch_paths {
        builder.add(Glob::new(watch_path.trim())?);
    }
    let matcher = builder.build()?;

    Ok(changed_paths
        .iter()
        .any(|path| matcher.is_match(path.as_str())))
}

fn resolve_rollout_strategy_override(
    value: Option<&str>,
    default_value: RolloutStrategy,
) -> Result<RolloutStrategy, (StatusCode, Json<ErrorResponse>)> {
    match value {
        None => Ok(default_value),
        Some(value) => match value.trim().to_ascii_lowercase().as_str() {
            "stop_first" | "stop-first" | "stopfirst" => {
                Ok(RolloutStrategy::StopFirst)
            }
            "start_first" | "start-first" | "startfirst" => {
                Ok(RolloutStrategy::StartFirst)
            }
            _ => Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error:
                        "invalid rollout strategy. use stop_first or start_first"
                            .to_string(),
                }),
            )),
        },
    }
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
    use containr_common::{Config, Database, DatabaseConfig};

    #[tokio::test]
    async fn source_resolution_failure_does_not_persist_deployment(
    ) -> Result<()> {
        let fixture = test_fixture(TestTokenMode::InvalidEncrypted, false)?;
        let body =
            push_event_body(&fixture.app.github_url, &fixture.app.branch)?;
        let headers =
            signed_headers(&body, &fixture.config.github.webhook_secret)?;

        let result =
            github_webhook(State(fixture.state.clone()), headers, body).await;
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
        let body =
            push_event_body(&fixture.app.github_url, &fixture.app.branch)?;
        let headers =
            signed_headers(&body, &fixture.config.github.webhook_secret)?;

        let result =
            github_webhook(State(fixture.state.clone()), headers, body).await;
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

    fn test_fixture(
        token_mode: TestTokenMode,
        close_queue: bool,
    ) -> Result<TestFixture> {
        let root = std::env::temp_dir()
            .join(format!("containr-webhook-test-{}", Uuid::new_v4()));
        let db = Database::open(&DatabaseConfig {
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

        let mut user = User::new_with_password(
            "owner@example.com".to_string(),
            "password-hash".to_string(),
        );
        user.github_access_token = Some(match token_mode {
            TestTokenMode::InvalidEncrypted => "enc:not-valid".to_string(),
            TestTokenMode::ValidEncrypted => {
                encrypt_value(&config, "github-oauth-token")
                    .map_err(anyhow::Error::msg)?
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
            root.join("cache"),
            deployment_tx,
            None,
            None,
        )?;

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
        let signature =
            format!("sha256={}", hex::encode(mac.finalize().into_bytes()));

        let mut headers = HeaderMap::new();
        headers.insert("x-github-event", HeaderValue::from_static("push"));
        headers
            .insert("x-hub-signature-256", HeaderValue::from_str(&signature)?);

        Ok(headers)
    }
}
