//! deployment handlers

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::github::{get_repo_installation_token, DeploymentJob};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use znskr_common::models::{Deployment, DeploymentStatus, RolloutStrategy};

/// deployment response
#[derive(Debug, Serialize, ToSchema)]
pub struct DeploymentResponse {
    pub id: Uuid,
    pub app_id: Uuid,
    pub commit_sha: String,
    pub commit_message: Option<String>,
    #[schema(value_type = String)]
    pub status: DeploymentStatus,
    pub container_id: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

/// deployment trigger request (optional)
#[derive(Debug, Deserialize, ToSchema)]
pub struct DeploymentTriggerRequest {
    /// branch to deploy
    pub branch: Option<String>,
    /// commit sha to record
    pub commit_sha: Option<String>,
    /// commit message to record
    pub commit_message: Option<String>,
    /// rollout strategy override (stop_first or start_first)
    pub rollout_strategy: Option<String>,
}

/// rollback request
#[derive(Debug, Deserialize, ToSchema)]
pub struct RollbackRequest {
    /// rollout strategy override (stop_first or start_first)
    pub rollout_strategy: Option<String>,
}

impl From<&Deployment> for DeploymentResponse {
    fn from(d: &Deployment) -> Self {
        Self {
            id: d.id,
            app_id: d.app_id,
            commit_sha: d.commit_sha.clone(),
            commit_message: d.commit_message.clone(),
            status: d.status,
            container_id: d.container_id.clone(),
            created_at: d.created_at.to_rfc3339(),
            started_at: d.started_at.map(|t| t.to_rfc3339()),
            finished_at: d.finished_at.map(|t| t.to_rfc3339()),
        }
    }
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

/// list deployments for an app
#[utoipa::path(
    get,
    path = "/api/apps/{id}/deployments",
    tag = "deployments",
    params(("id" = Uuid, Path, description = "app id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "list of deployments", body = Vec<DeploymentResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "app not found", body = ErrorResponse)
    )
)]
pub async fn list_deployments(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(app_id): Path<Uuid>,
) -> Result<Json<Vec<DeploymentResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    // verify app ownership
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

    let deployments = state
        .db
        .list_deployments_by_app(app_id)
        .map_err(internal_error)?;

    let responses: Vec<DeploymentResponse> =
        deployments.iter().map(DeploymentResponse::from).collect();
    Ok(Json(responses))
}

/// get a single deployment
#[utoipa::path(
    get,
    path = "/api/apps/{app_id}/deployments/{id}",
    tag = "deployments",
    params(
        ("app_id" = Uuid, Path, description = "app id"),
        ("id" = Uuid, Path, description = "deployment id")
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "deployment details", body = DeploymentResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn get_deployment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((app_id, deployment_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<DeploymentResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    // verify app ownership
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

    let deployment = state
        .db
        .get_deployment(deployment_id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "deployment not found".to_string(),
                }),
            )
        })?;

    if deployment.app_id != app_id {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "deployment not found".to_string(),
            }),
        ));
    }

    Ok(Json(DeploymentResponse::from(&deployment)))
}

/// trigger a new deployment
#[utoipa::path(
    post,
    path = "/api/apps/{id}/deployments",
    tag = "deployments",
    params(("id" = Uuid, Path, description = "app id")),
    security(("bearer" = [])),
    request_body = DeploymentTriggerRequest,
    responses(
        (status = 201, description = "deployment triggered", body = DeploymentResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "app not found", body = ErrorResponse)
    )
)]
pub async fn trigger_deployment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(app_id): Path<Uuid>,
    body: Option<Json<DeploymentTriggerRequest>>,
) -> Result<(StatusCode, Json<DeploymentResponse>), (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let git_token = headers
        .get("x-git-token")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());

    // get app
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

    let mut using_git_token = false;
    let mut user_id: Option<Uuid> = None;

    if let Some(token) = git_token {
        if let Some(stored) = app.git_deploy_token.clone() {
            let decrypted =
                crate::security::decrypt_value(&config, &stored, Some(&config.auth.jwt_secret))
                    .map_err(internal_error)?;
            if decrypted == token {
                using_git_token = true;
            }
        }
    }

    if !using_git_token {
        let owner_id = get_user_id(&headers, &config.auth.jwt_secret)?;
        if app.owner_id != owner_id {
            return Err((
                StatusCode::FORBIDDEN,
                Json(ErrorResponse {
                    error: "access denied".to_string(),
                }),
            ));
        }
        user_id = Some(owner_id);
    }

    let trigger = body.map(|value| value.0);
    let commit_sha = trigger
        .as_ref()
        .and_then(|t| t.commit_sha.clone())
        .unwrap_or_else(|| {
            if using_git_token {
                "git-push".to_string()
            } else {
                "manual".to_string()
            }
        });
    let commit_message = trigger
        .as_ref()
        .and_then(|t| t.commit_message.clone())
        .or_else(|| {
            if using_git_token {
                Some("git push".to_string())
            } else {
                Some("manual deployment".to_string())
            }
        });
    let rollout_strategy = resolve_rollout_strategy(
        trigger.as_ref().and_then(|t| t.rollout_strategy.as_deref()),
        app.rollout_strategy,
    )?;

    // create deployment record
    let mut deployment = Deployment::new(app_id, commit_sha.clone());
    deployment.commit_message = commit_message.clone();
    state
        .db
        .save_deployment(&deployment)
        .map_err(internal_error)?;

    // queue deployment job
    let github_token = if let Some(user_id) = user_id {
        get_github_token_for_app(&state, user_id, &app).await?
    } else {
        None
    };
    let branch = trigger
        .as_ref()
        .and_then(|t| t.branch.clone())
        .unwrap_or_else(|| app.branch.clone());
    let job = DeploymentJob {
        deployment_id: deployment.id,
        app_id,
        commit_sha: commit_sha.clone(),
        commit_message: commit_message.clone(),
        github_url: app.github_url,
        branch,
        github_token,
        repo_path: if using_git_token {
            Some(
                config
                    .storage
                    .data_dir
                    .join("git")
                    .join(format!("{}.git", app_id))
                    .to_string_lossy()
                    .to_string(),
            )
        } else {
            None
        },
        rollout_strategy,
        rollback_from_deployment_id: None,
    };

    state
        .deployment_tx
        .send(job)
        .await
        .map_err(|e| internal_error(format!("failed to queue deployment: {}", e)))?;

    Ok((
        StatusCode::CREATED,
        Json(DeploymentResponse::from(&deployment)),
    ))
}

/// rollback to a previous deployment
#[utoipa::path(
    post,
    path = "/api/apps/{app_id}/deployments/{id}/rollback",
    tag = "deployments",
    params(
        ("app_id" = Uuid, Path, description = "app id"),
        ("id" = Uuid, Path, description = "deployment id to rollback to")
    ),
    security(("bearer" = [])),
    request_body = RollbackRequest,
    responses(
        (status = 201, description = "rollback deployment queued", body = DeploymentResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn rollback_deployment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((app_id, target_deployment_id)): Path<(Uuid, Uuid)>,
    body: Option<Json<RollbackRequest>>,
) -> Result<(StatusCode, Json<DeploymentResponse>), (StatusCode, Json<ErrorResponse>)> {
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

    let target = state
        .db
        .get_deployment(target_deployment_id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "deployment not found".to_string(),
                }),
            )
        })?;

    if target.app_id != app_id {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "deployment not found".to_string(),
            }),
        ));
    }

    if target.image_id.is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "target deployment cannot be rolled back (missing image artifact)"
                    .to_string(),
            }),
        ));
    }

    let req = body.map(|value| value.0);
    let rollout_strategy = resolve_rollout_strategy(
        req.as_ref().and_then(|r| r.rollout_strategy.as_deref()),
        app.rollout_strategy,
    )?;

    let mut deployment = Deployment::new(app_id, target.commit_sha.clone());
    deployment.commit_message = Some(format!("rollback to deployment {}", target_deployment_id));
    state
        .db
        .save_deployment(&deployment)
        .map_err(internal_error)?;

    let job = DeploymentJob {
        deployment_id: deployment.id,
        app_id,
        commit_sha: target.commit_sha.clone(),
        commit_message: deployment.commit_message.clone(),
        github_url: app.github_url.clone(),
        branch: app.branch.clone(),
        github_token: None,
        repo_path: None,
        rollout_strategy,
        rollback_from_deployment_id: Some(target_deployment_id),
    };

    state
        .deployment_tx
        .send(job)
        .await
        .map_err(|e| internal_error(format!("failed to queue rollback: {}", e)))?;

    Ok((
        StatusCode::CREATED,
        Json(DeploymentResponse::from(&deployment)),
    ))
}

async fn get_github_token_for_app(
    state: &AppState,
    user_id: Uuid,
    app: &znskr_common::models::App,
) -> Result<Option<String>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;

    if let Ok(Some(app_config)) = state.db.get_github_app(user_id) {
        let token = get_repo_installation_token(
            &app_config,
            config.security.encryption_key.as_bytes(),
            &app.github_url,
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

    let user = state.db.get_user(user_id).map_err(internal_error)?;
    if let Some(user) = user {
        if let Some(access_token) = user.github_access_token {
            let decrypted_token = znskr_common::encryption::decrypt(
                &access_token,
                config.security.encryption_key.as_bytes(),
            )
            .map_err(internal_error)?;
            return Ok(Some(decrypted_token));
        }
    }

    Ok(None)
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct LogsQuery {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

/// get deployment logs
#[utoipa::path(
    get,
    path = "/api/apps/{app_id}/deployments/{id}/logs",
    tag = "deployments",
    params(
        ("app_id" = Uuid, Path, description = "app id"),
        ("id" = Uuid, Path, description = "deployment id"),
        ("limit" = Option<usize>, Query, description = "lines limit"),
        ("offset" = Option<usize>, Query, description = "lines offset")
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "deployment logs", body = Vec<String>),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn get_deployment_logs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((app_id, deployment_id)): Path<(Uuid, Uuid)>,
    Query(query): Query<LogsQuery>,
) -> Result<Json<Vec<String>>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    // verify app ownership
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

    let deployment = state
        .db
        .get_deployment(deployment_id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "deployment not found".to_string(),
                }),
            )
        })?;

    if deployment.app_id != app_id {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "deployment not found".to_string(),
            }),
        ));
    }

    // get logs from new storage
    let limit = query.limit.unwrap_or(100);
    let offset = query.offset.unwrap_or(0);
    let mut logs = state
        .db
        .get_deployment_logs(deployment_id, limit, offset)
        .map_err(internal_error)?;

    // if new storage empty and offset is 0, fallback to old storage for backward compatibility
    if logs.is_empty() && offset == 0 && !deployment.logs.is_empty() {
        logs = deployment.logs;
    }

    Ok(Json(logs))
}

fn resolve_rollout_strategy(
    override_value: Option<&str>,
    default_value: RolloutStrategy,
) -> Result<RolloutStrategy, (StatusCode, Json<ErrorResponse>)> {
    match override_value {
        None => Ok(default_value),
        Some(value) => parse_rollout_strategy(value).ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "invalid rollout strategy. use stop_first or start_first".to_string(),
                }),
            )
        }),
    }
}

fn parse_rollout_strategy(value: &str) -> Option<RolloutStrategy> {
    match value.trim().to_ascii_lowercase().as_str() {
        "stop_first" | "stop-first" | "stopfirst" => Some(RolloutStrategy::StopFirst),
        "start_first" | "start-first" | "startfirst" => Some(RolloutStrategy::StartFirst),
        _ => None,
    }
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
