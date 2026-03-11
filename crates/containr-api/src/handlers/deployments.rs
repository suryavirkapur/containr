//! deployment types and helpers shared by service handlers

use axum::{http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::deployment_source::resolve_app_deployment_source;
use crate::github::DeploymentJob;
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use containr_common::models::{
    App, Deployment, DeploymentSource, DeploymentStatus, RolloutStrategy,
};

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

#[derive(Debug, Deserialize, ToSchema)]
pub struct LogsQuery {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
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

fn deployment_source_url(source: &DeploymentSource) -> String {
    match source {
        DeploymentSource::RemoteGit { url, .. } => url.clone(),
        DeploymentSource::LocalPath { path } => path.clone(),
        DeploymentSource::None => String::new(),
    }
}

pub(crate) async fn create_and_queue_deployment(
    state: &AppState,
    owner_id: Uuid,
    app: &App,
    commit_sha: String,
    commit_message: Option<String>,
    branch: String,
    rollout_strategy: RolloutStrategy,
    rollback_from_deployment_id: Option<Uuid>,
) -> Result<Deployment, (StatusCode, Json<ErrorResponse>)> {
    let source = resolve_app_deployment_source(state, owner_id, app).await?;

    let mut deployment = Deployment::new(app.id, commit_sha.clone());
    deployment.commit_message = commit_message.clone();
    deployment.branch = branch.clone();
    let source_url = deployment_source_url(&source);
    deployment.source_url = if source_url.is_empty() {
        None
    } else {
        Some(source_url)
    };
    deployment.rollout_strategy = rollout_strategy;
    deployment.rollback_from_deployment_id = rollback_from_deployment_id;
    deployment.app_snapshot = Some(app.clone());
    state
        .db
        .save_deployment(&deployment)
        .map_err(internal_error)?;

    let job = DeploymentJob {
        deployment_id: deployment.id,
        app_id: app.id,
        commit_sha,
        commit_message,
        branch,
        source,
        rollout_strategy,
        rollback_from_deployment_id,
    };

    state.deployment_tx.send(job).await.map_err(|error| {
        let _ = state.db.delete_deployment(deployment.id);
        internal_error(format!("failed to queue deployment: {}", error))
    })?;

    Ok(deployment)
}

pub(crate) fn can_rollback_to_deployment(
    app: &App,
    target: &Deployment,
) -> bool {
    if target.image_id.is_some() {
        return true;
    }

    let service_images = target
        .service_deployments
        .iter()
        .filter_map(|deployment| {
            deployment
                .image_id
                .as_ref()
                .map(|image_id| (deployment.service_id, image_id))
        })
        .collect::<std::collections::HashMap<_, _>>();

    app.services.iter().all(|service| {
        service_images.contains_key(&service.id) || !service.image.is_empty()
    })
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

#[cfg(test)]
#[path = "deployments_test.rs"]
mod deployments_test;
