//! deployment handlers

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Serialize;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::github::{get_repo_installation_token, DeploymentJob};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use znskr_common::models::{Deployment, DeploymentStatus};

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
) -> Result<(StatusCode, Json<DeploymentResponse>), (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

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

    if app.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    // create deployment record
    let deployment = Deployment::new(app_id, "manual".to_string());
    state
        .db
        .save_deployment(&deployment)
        .map_err(internal_error)?;

    // queue deployment job
    let github_token = get_github_token_for_app(&state, user_id, &app).await?;
    let job = DeploymentJob {
        app_id,
        commit_sha: "HEAD".to_string(),
        commit_message: Some("manual deployment".to_string()),
        github_url: app.github_url,
        branch: app.branch,
        github_token,
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

/// get deployment logs
#[utoipa::path(
    get,
    path = "/api/apps/{app_id}/deployments/{id}/logs",
    tag = "deployments",
    params(
        ("app_id" = Uuid, Path, description = "app id"),
        ("id" = Uuid, Path, description = "deployment id")
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

    Ok(Json(deployment.logs))
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
