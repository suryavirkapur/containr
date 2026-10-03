//! projects (apps) that group services onto one network

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::handlers::auth::{require_authenticated_user, ErrorResponse};
use crate::state::AppState;
use containr_common::models::App;
use containr_runtime::ProxyRouteUpdate;

/// project summary
#[derive(Debug, Serialize, ToSchema)]
pub struct ProjectResponse {
    pub id: Uuid,
    pub name: String,
    pub network_name: String,
    /// number of app services in the project
    pub service_count: usize,
    /// managed databases and queues attached to the project
    pub managed_count: usize,
    pub created_at: String,
    pub updated_at: String,
}

/// project rename request
#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateProjectRequest {
    /// new name (1-64 characters)
    pub name: String,
}

fn project_response(
    state: &AppState,
    app: &App,
) -> Result<ProjectResponse, (StatusCode, Json<ErrorResponse>)> {
    let databases = state
        .db
        .list_managed_databases_by_owner(app.owner_id)
        .map_err(internal_error)?
        .into_iter()
        .filter(|database| database.group_id == Some(app.id))
        .count();
    let queues = state
        .db
        .list_managed_queues_by_owner(app.owner_id)
        .map_err(internal_error)?
        .into_iter()
        .filter(|queue| queue.group_id == Some(app.id))
        .count();

    Ok(ProjectResponse {
        id: app.id,
        name: app.name.clone(),
        network_name: app.network_name(),
        service_count: app.services.len(),
        managed_count: databases + queues,
        created_at: app.created_at.to_rfc3339(),
        updated_at: app.updated_at.to_rfc3339(),
    })
}

/// list the caller's projects
#[utoipa::path(
    get,
    path = "/api/projects",
    tag = "projects",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "projects", body = Vec<ProjectResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn list_projects(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ProjectResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let user = require_authenticated_user(&state, &headers).await?;
    let apps = state
        .db
        .list_apps_by_owner(user.id)
        .map_err(internal_error)?;
    let mut projects = Vec::with_capacity(apps.len());
    for app in &apps {
        projects.push(project_response(&state, app)?);
    }
    Ok(Json(projects))
}

/// rename a project
#[utoipa::path(
    patch,
    path = "/api/projects/{id}",
    tag = "projects",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "project id")),
    request_body = UpdateProjectRequest,
    responses(
        (status = 200, description = "project updated", body = ProjectResponse),
        (status = 400, description = "invalid name", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "project not found", body = ErrorResponse)
    )
)]
pub async fn update_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateProjectRequest>,
) -> Result<Json<ProjectResponse>, (StatusCode, Json<ErrorResponse>)> {
    let user = require_authenticated_user(&state, &headers).await?;
    let name = req.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 64 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "name must be 1-64 characters".to_string(),
            }),
        ));
    }

    let mut app = state
        .db
        .get_app(id)
        .map_err(internal_error)?
        .filter(|app| app.owner_id == user.id)
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "project not found".to_string(),
                }),
            )
        })?;

    app.name = name;
    app.updated_at = Utc::now();
    state.db.save_app(&app).map_err(internal_error)?;

    if let Some(sender) = &state.proxy_update_tx {
        let _ = sender
            .send(ProxyRouteUpdate::RefreshApp { app_id: app.id })
            .await;
    }

    Ok(Json(project_response(&state, &app)?))
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
