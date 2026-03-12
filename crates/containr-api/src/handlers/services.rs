use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::domain::services::{
    CreateServiceRequest, HttpRequestLogResponse, HttpRequestLogsQuery,
    InventoryServiceResponse, ListServicesQuery, ServiceAction,
    ServiceLogsQuery, ServiceLogsResponse, ServiceSettingsResponse, ServiceSvc,
    UpdateServiceRequest,
};
use crate::handlers::auth::ErrorResponse;
use crate::handlers::deployments::{
    DeploymentResponse, DeploymentTriggerRequest, LogsQuery, RollbackRequest,
};
use crate::state::AppState;

fn bad_request(
    message: impl Into<String>,
) -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ErrorResponse {
            error: message.into(),
        }),
    )
}

async fn get_user_id(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Uuid, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let auth_header = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
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

    let claims =
        validate_token(token, &config.auth.jwt_secret).map_err(|error| {
            (
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: error.to_string(),
                }),
            )
        })?;

    Ok(claims.sub)
}

#[utoipa::path(
    post,
    path = "/api/services",
    tag = "services",
    security(("bearer" = [])),
    request_body = CreateServiceRequest,
    responses(
        (status = 201, description = "service created", body = InventoryServiceResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 409, description = "conflict", body = ErrorResponse)
    )
)]
pub async fn create_service(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateServiceRequest>,
) -> Result<
    (StatusCode, Json<InventoryServiceResponse>),
    (StatusCode, Json<ErrorResponse>),
> {
    let user_id = get_user_id(&state, &headers).await?;
    let response = ServiceSvc::new(state).create_service(user_id, req).await?;
    Ok((StatusCode::CREATED, Json(response)))
}

#[utoipa::path(
    get,
    path = "/api/services",
    tag = "services",
    params(ListServicesQuery),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "list of services", body = Vec<InventoryServiceResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn list_services(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListServicesQuery>,
) -> Result<
    Json<Vec<InventoryServiceResponse>>,
    (StatusCode, Json<ErrorResponse>),
> {
    let user_id = get_user_id(&state, &headers).await?;
    let services = ServiceSvc::new(state).list_services(user_id, query).await?;
    Ok(Json(services))
}

#[utoipa::path(
    get,
    path = "/api/services/{id}",
    tag = "services",
    params(("id" = Uuid, Path, description = "service id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "service details", body = InventoryServiceResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse)
    )
)]
pub async fn get_service(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<InventoryServiceResponse>, (StatusCode, Json<ErrorResponse>)> {
    let user_id = get_user_id(&state, &headers).await?;
    let service = ServiceSvc::new(state).get_service(user_id, id).await?;
    Ok(Json(service))
}

#[utoipa::path(
    get,
    path = "/api/services/{id}/settings",
    tag = "services",
    params(("id" = Uuid, Path, description = "service id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "service settings", body = ServiceSettingsResponse),
        (status = 400, description = "settings not supported for this service", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse)
    )
)]
pub async fn get_service_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<ServiceSettingsResponse>, (StatusCode, Json<ErrorResponse>)> {
    let user_id = get_user_id(&state, &headers).await?;
    let settings = ServiceSvc::new(state)
        .get_service_settings(user_id, id)
        .await?;
    Ok(Json(settings))
}

#[utoipa::path(
    patch,
    path = "/api/services/{id}",
    tag = "services",
    params(("id" = Uuid, Path, description = "service id")),
    security(("bearer" = [])),
    request_body = UpdateServiceRequest,
    responses(
        (status = 200, description = "service updated", body = InventoryServiceResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse)
    )
)]
pub async fn update_service(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateServiceRequest>,
) -> Result<Json<InventoryServiceResponse>, (StatusCode, Json<ErrorResponse>)> {
    let user_id = get_user_id(&state, &headers).await?;
    let service = ServiceSvc::new(state)
        .update_service(user_id, id, req)
        .await?;
    Ok(Json(service))
}

#[utoipa::path(
    get,
    path = "/api/services/{id}/logs",
    tag = "services",
    params(
        ("id" = Uuid, Path, description = "service id"),
        ServiceLogsQuery
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "service logs", body = ServiceLogsResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse)
    )
)]
pub async fn get_service_logs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(query): Query<ServiceLogsQuery>,
) -> Result<Json<ServiceLogsResponse>, (StatusCode, Json<ErrorResponse>)> {
    let user_id = get_user_id(&state, &headers).await?;
    let logs = ServiceSvc::new(state)
        .get_service_logs(user_id, id, query.tail)
        .await?;
    Ok(Json(logs))
}

#[utoipa::path(
    get,
    path = "/api/services/{id}/http-logs",
    tag = "services",
    params(
        ("id" = Uuid, Path, description = "service id"),
        HttpRequestLogsQuery
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "http request logs", body = Vec<HttpRequestLogResponse>),
        (status = 400, description = "http request logs not supported for this service", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse)
    )
)]
pub async fn list_service_http_logs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(query): Query<HttpRequestLogsQuery>,
) -> Result<Json<Vec<HttpRequestLogResponse>>, (StatusCode, Json<ErrorResponse>)>
{
    let user_id = get_user_id(&state, &headers).await?;
    let logs = ServiceSvc::new(state).list_http_request_logs(
        user_id,
        id,
        query.limit,
        query.offset,
    )?;
    Ok(Json(logs))
}

#[utoipa::path(
    post,
    path = "/api/services/{id}/actions/{action}",
    tag = "services",
    params(
        ("id" = Uuid, Path, description = "service id"),
        ("action" = String, Path, description = "service action: start | stop | restart")
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "service action completed", body = InventoryServiceResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse)
    )
)]
pub async fn run_service_action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, action)): Path<(Uuid, String)>,
) -> Result<Json<InventoryServiceResponse>, (StatusCode, Json<ErrorResponse>)> {
    let user_id = get_user_id(&state, &headers).await?;
    let action = ServiceAction::parse(&action).ok_or_else(|| {
        bad_request("invalid service action. supported: start, stop, restart")
    })?;
    let service = ServiceSvc::new(state)
        .run_action(user_id, id, action)
        .await?;
    Ok(Json(service))
}

#[utoipa::path(
    get,
    path = "/api/services/{id}/deployments",
    tag = "services",
    params(("id" = Uuid, Path, description = "service id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "list of service deployments", body = Vec<DeploymentResponse>),
        (status = 400, description = "deployments not supported for this service", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse)
    )
)]
pub async fn list_service_deployments(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<DeploymentResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let user_id = get_user_id(&state, &headers).await?;
    let deployments =
        ServiceSvc::new(state).list_service_deployments(user_id, id)?;
    Ok(Json(deployments))
}

#[utoipa::path(
    get,
    path = "/api/services/{id}/deployments/{deployment_id}",
    tag = "services",
    params(
        ("id" = Uuid, Path, description = "service id"),
        ("deployment_id" = Uuid, Path, description = "deployment id")
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "service deployment details", body = DeploymentResponse),
        (status = 400, description = "deployments not supported for this service", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "deployment not found", body = ErrorResponse)
    )
)]
pub async fn get_service_deployment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, deployment_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<DeploymentResponse>, (StatusCode, Json<ErrorResponse>)> {
    let user_id = get_user_id(&state, &headers).await?;
    let deployment = ServiceSvc::new(state).get_service_deployment(
        user_id,
        id,
        deployment_id,
    )?;
    Ok(Json(deployment))
}

#[utoipa::path(
    post,
    path = "/api/services/{id}/deployments",
    tag = "services",
    params(("id" = Uuid, Path, description = "service id")),
    security(("bearer" = [])),
    request_body = DeploymentTriggerRequest,
    responses(
        (status = 201, description = "deployment triggered", body = DeploymentResponse),
        (status = 400, description = "deployments not supported for this service", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse)
    )
)]
pub async fn trigger_service_deployment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    body: Option<Json<DeploymentTriggerRequest>>,
) -> Result<
    (StatusCode, Json<DeploymentResponse>),
    (StatusCode, Json<ErrorResponse>),
> {
    let user_id = get_user_id(&state, &headers).await?;
    let deployment = ServiceSvc::new(state)
        .trigger_service_deployment(user_id, id, body.map(|value| value.0))
        .await?;
    Ok((StatusCode::CREATED, Json(deployment)))
}

#[utoipa::path(
    post,
    path = "/api/services/{id}/deployments/{deployment_id}/rollback",
    tag = "services",
    params(
        ("id" = Uuid, Path, description = "service id"),
        ("deployment_id" = Uuid, Path, description = "deployment id to rollback to")
    ),
    security(("bearer" = [])),
    request_body = RollbackRequest,
    responses(
        (status = 201, description = "rollback deployment queued", body = DeploymentResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "deployment not found", body = ErrorResponse)
    )
)]
pub async fn rollback_service_deployment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, deployment_id)): Path<(Uuid, Uuid)>,
    body: Option<Json<RollbackRequest>>,
) -> Result<
    (StatusCode, Json<DeploymentResponse>),
    (StatusCode, Json<ErrorResponse>),
> {
    let user_id = get_user_id(&state, &headers).await?;
    let deployment = ServiceSvc::new(state)
        .rollback_service_deployment(
            user_id,
            id,
            deployment_id,
            body.map(|value| value.0),
        )
        .await?;
    Ok((StatusCode::CREATED, Json(deployment)))
}

#[utoipa::path(
    get,
    path = "/api/services/{id}/deployments/{deployment_id}/logs",
    tag = "services",
    params(
        ("id" = Uuid, Path, description = "service id"),
        ("deployment_id" = Uuid, Path, description = "deployment id"),
        ("limit" = Option<usize>, Query, description = "lines limit"),
        ("offset" = Option<usize>, Query, description = "lines offset")
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "deployment logs", body = Vec<String>),
        (status = 400, description = "deployments not supported for this service", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "deployment not found", body = ErrorResponse)
    )
)]
pub async fn get_service_deployment_logs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, deployment_id)): Path<(Uuid, Uuid)>,
    Query(query): Query<LogsQuery>,
) -> Result<Json<Vec<String>>, (StatusCode, Json<ErrorResponse>)> {
    let user_id = get_user_id(&state, &headers).await?;
    let logs = ServiceSvc::new(state).get_service_deployment_logs(
        user_id,
        id,
        deployment_id,
        query,
    )?;
    Ok(Json(logs))
}

#[utoipa::path(
    delete,
    path = "/api/services/{id}",
    tag = "services",
    params(("id" = Uuid, Path, description = "service id")),
    security(("bearer" = [])),
    responses(
        (status = 204, description = "service deleted"),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 404, description = "service not found", body = ErrorResponse)
    )
)]
pub async fn delete_service(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let user_id = get_user_id(&state, &headers).await?;
    ServiceSvc::new(state).delete_service(user_id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}
