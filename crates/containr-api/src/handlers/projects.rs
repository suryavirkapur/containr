//! project management handlers

use axum::{
    extract::{Multipart, Path, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use uuid::Uuid;

use crate::handlers::{apps, auth::ErrorResponse, certificates, deployments};
use crate::state::AppState;

/// list all projects for the authenticated user
#[utoipa::path(
    get,
    operation_id = "project_list_projects",
    path = "/api/projects",
    tag = "projects",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "list of projects", body = Vec<apps::AppResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn list_projects(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<apps::AppResponse>>, (StatusCode, Json<ErrorResponse>)> {
    apps::list_apps(State(state), headers).await
}

/// create a new project
#[utoipa::path(
    post,
    operation_id = "project_create_project",
    path = "/api/projects",
    tag = "projects",
    security(("bearer" = [])),
    request_body = apps::CreateAppRequest,
    responses(
        (status = 201, description = "project created", body = apps::AppResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 409, description = "domain conflict", body = ErrorResponse)
    )
)]
pub async fn create_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<apps::CreateAppRequest>,
) -> Result<
    (StatusCode, Json<apps::AppResponse>),
    (StatusCode, Json<ErrorResponse>),
> {
    apps::create_app(State(state), headers, Json(req)).await
}

/// get a single project by id
#[utoipa::path(
    get,
    operation_id = "project_get_project",
    path = "/api/projects/{id}",
    tag = "projects",
    params(("id" = Uuid, Path, description = "project id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "project details", body = apps::AppResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn get_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<apps::AppResponse>, (StatusCode, Json<ErrorResponse>)> {
    apps::get_app(State(state), headers, Path(id)).await
}

/// get project container metrics
#[utoipa::path(
    get,
    operation_id = "project_get_project_metrics",
    path = "/api/projects/{id}/metrics",
    tag = "projects",
    params(("id" = Uuid, Path, description = "project id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "container metrics", body = Vec<apps::AppMetricsResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn get_project_metrics(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<
    Json<Vec<apps::AppMetricsResponse>>,
    (StatusCode, Json<ErrorResponse>),
> {
    apps::get_app_metrics(State(state), headers, Path(id)).await
}

/// download a tar archive of all persistent mounts for a service
#[utoipa::path(
    get,
    operation_id = "project_backup_service_mounts",
    path = "/api/projects/{id}/services/{service_name}/mounts/backup",
    tag = "projects",
    params(
        ("id" = Uuid, Path, description = "project id"),
        ("service_name" = String, Path, description = "service name")
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "service mount backup archive"),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn backup_service_mounts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, service_name)): Path<(Uuid, String)>,
) -> Result<Response, (StatusCode, Json<ErrorResponse>)> {
    apps::backup_service_mounts(State(state), headers, Path((id, service_name)))
        .await
}

/// restore all persistent mounts for a service from a tar archive
#[utoipa::path(
    post,
    operation_id = "project_restore_service_mounts",
    path = "/api/projects/{id}/services/{service_name}/mounts/restore",
    tag = "projects",
    params(
        ("id" = Uuid, Path, description = "project id"),
        ("service_name" = String, Path, description = "service name")
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "service mount archive restored", body = apps::ServiceMountRestoreResponse),
        (status = 400, description = "invalid archive", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn restore_service_mounts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, service_name)): Path<(Uuid, String)>,
    multipart: Multipart,
) -> Result<
    Json<apps::ServiceMountRestoreResponse>,
    (StatusCode, Json<ErrorResponse>),
> {
    apps::restore_service_mounts(
        State(state),
        headers,
        Path((id, service_name)),
        multipart,
    )
    .await
}

/// update a project
#[utoipa::path(
    put,
    operation_id = "project_update_project",
    path = "/api/projects/{id}",
    tag = "projects",
    params(("id" = Uuid, Path, description = "project id")),
    security(("bearer" = [])),
    request_body = apps::UpdateAppRequest,
    responses(
        (status = 200, description = "project updated", body = apps::AppResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse),
        (status = 409, description = "domain conflict", body = ErrorResponse)
    )
)]
pub async fn update_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<apps::UpdateAppRequest>,
) -> Result<Json<apps::AppResponse>, (StatusCode, Json<ErrorResponse>)> {
    apps::update_app(State(state), headers, Path(id), Json(req)).await
}

/// delete a project
#[utoipa::path(
    delete,
    operation_id = "project_delete_project",
    path = "/api/projects/{id}",
    tag = "projects",
    params(("id" = Uuid, Path, description = "project id")),
    security(("bearer" = [])),
    responses(
        (status = 204, description = "project deleted"),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn delete_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    apps::delete_app(State(state), headers, Path(id)).await
}

/// list deployments for a project
#[utoipa::path(
    get,
    operation_id = "project_list_deployments",
    path = "/api/projects/{id}/deployments",
    tag = "projects",
    params(("id" = Uuid, Path, description = "project id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "list of deployments", body = Vec<deployments::DeploymentResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "project not found", body = ErrorResponse)
    )
)]
pub async fn list_deployments(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<
    Json<Vec<deployments::DeploymentResponse>>,
    (StatusCode, Json<ErrorResponse>),
> {
    deployments::list_deployments(State(state), headers, Path(id)).await
}

/// get a single project deployment
#[utoipa::path(
    get,
    operation_id = "project_get_deployment",
    path = "/api/projects/{project_id}/deployments/{id}",
    tag = "projects",
    params(
        ("project_id" = Uuid, Path, description = "project id"),
        ("id" = Uuid, Path, description = "deployment id")
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "deployment details", body = deployments::DeploymentResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn get_deployment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, id)): Path<(Uuid, Uuid)>,
) -> Result<
    Json<deployments::DeploymentResponse>,
    (StatusCode, Json<ErrorResponse>),
> {
    deployments::get_deployment(State(state), headers, Path((project_id, id)))
        .await
}

/// trigger a new deployment for a project
#[utoipa::path(
    post,
    operation_id = "project_trigger_deployment",
    path = "/api/projects/{id}/deployments",
    tag = "projects",
    params(("id" = Uuid, Path, description = "project id")),
    security(("bearer" = [])),
    request_body = deployments::DeploymentTriggerRequest,
    responses(
        (status = 201, description = "deployment triggered", body = deployments::DeploymentResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "project not found", body = ErrorResponse)
    )
)]
pub async fn trigger_deployment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    body: Option<Json<deployments::DeploymentTriggerRequest>>,
) -> Result<
    (StatusCode, Json<deployments::DeploymentResponse>),
    (StatusCode, Json<ErrorResponse>),
> {
    deployments::trigger_deployment(State(state), headers, Path(id), body).await
}

/// roll back a project to a previous deployment
#[utoipa::path(
    post,
    operation_id = "project_rollback_deployment",
    path = "/api/projects/{project_id}/deployments/{id}/rollback",
    tag = "projects",
    params(
        ("project_id" = Uuid, Path, description = "project id"),
        ("id" = Uuid, Path, description = "deployment id")
    ),
    security(("bearer" = [])),
    request_body = deployments::RollbackRequest,
    responses(
        (status = 201, description = "rollback deployment queued", body = deployments::DeploymentResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn rollback_deployment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, id)): Path<(Uuid, Uuid)>,
    body: Option<Json<deployments::RollbackRequest>>,
) -> Result<
    (StatusCode, Json<deployments::DeploymentResponse>),
    (StatusCode, Json<ErrorResponse>),
> {
    deployments::rollback_deployment(
        State(state),
        headers,
        Path((project_id, id)),
        body,
    )
    .await
}

/// get logs for a project deployment
#[utoipa::path(
    get,
    operation_id = "project_get_deployment_logs",
    path = "/api/projects/{project_id}/deployments/{id}/logs",
    tag = "projects",
    params(
        ("project_id" = Uuid, Path, description = "project id"),
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
    Path((project_id, id)): Path<(Uuid, Uuid)>,
    query: axum::extract::Query<deployments::LogsQuery>,
) -> Result<Json<Vec<String>>, (StatusCode, Json<ErrorResponse>)> {
    deployments::get_deployment_logs(
        State(state),
        headers,
        Path((project_id, id)),
        query,
    )
    .await
}

/// get certificate status for a project
#[utoipa::path(
    get,
    operation_id = "project_get_certificate",
    path = "/api/projects/{id}/certificate",
    tag = "projects",
    params(("id" = Uuid, Path, description = "project id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "certificate status", body = Vec<certificates::CertificateResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "project not found", body = ErrorResponse)
    )
)]
pub async fn get_certificate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<
    Json<Vec<certificates::CertificateResponse>>,
    (StatusCode, Json<ErrorResponse>),
> {
    certificates::get_certificate(State(state), headers, Path(id)).await
}

/// trigger certificate reissue for a project
#[utoipa::path(
    post,
    operation_id = "project_reissue_certificate",
    path = "/api/projects/{id}/certificate/reissue",
    tag = "projects",
    params(("id" = Uuid, Path, description = "project id")),
    security(("bearer" = [])),
    request_body = certificates::ReissueRequest,
    responses(
        (status = 200, description = "certificate reissue initiated", body = certificates::ReissueResponse),
        (status = 400, description = "bad request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "project not found", body = ErrorResponse),
        (status = 503, description = "service unavailable", body = ErrorResponse)
    )
)]
pub async fn reissue_certificate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    body: Option<Json<certificates::ReissueRequest>>,
) -> Result<
    Json<certificates::ReissueResponse>,
    (StatusCode, Json<ErrorResponse>),
> {
    certificates::reissue_certificate(State(state), headers, Path(id), body)
        .await
}
