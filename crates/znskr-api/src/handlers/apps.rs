//! app management handlers

use std::net::IpAddr;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use tracing::warn;
use trust_dns_resolver::config::{ResolverConfig, ResolverOpts};
use trust_dns_resolver::proto::rr::RecordType;
use trust_dns_resolver::TokioAsyncResolver;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use znskr_common::models::{App, ContainerService, EnvVar, HealthCheck, RestartPolicy};
use znskr_runtime::DockerContainerManager;

/// create app request
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateAppRequest {
    /// app name
    pub name: String,
    /// github repository url
    pub github_url: String,
    /// branch to deploy (defaults to main)
    pub branch: Option<String>,
    /// custom domain
    pub domain: Option<String>,
    /// port for the app (deprecated, use services)
    pub port: Option<u16>,
    /// environment variables (shared across all services)
    pub env_vars: Option<Vec<EnvVarRequest>>,
    /// container services for multi-container apps
    pub services: Option<Vec<ServiceRequest>>,
}

/// env var in request
#[derive(Debug, Deserialize, ToSchema)]
pub struct EnvVarRequest {
    /// variable key
    pub key: String,
    /// variable value
    pub value: String,
    /// mark as secret (hides value)
    pub secret: Option<bool>,
}

/// env var in response (hides secret values)
#[derive(Debug, Serialize, ToSchema)]
pub struct EnvVarResponse {
    /// variable key
    pub key: String,
    /// variable value (masked if secret)
    pub value: String,
    /// whether value is secret
    pub secret: bool,
}

/// health check configuration request
#[derive(Debug, Deserialize, ToSchema)]
pub struct HealthCheckRequest {
    /// http path to check
    pub path: String,
    /// interval in seconds
    pub interval_secs: Option<u32>,
    /// timeout in seconds
    pub timeout_secs: Option<u32>,
    /// retries before unhealthy
    pub retries: Option<u32>,
}

/// service request for multi-container apps
#[derive(Debug, Deserialize, ToSchema)]
pub struct ServiceRequest {
    /// service name (e.g. "web", "api", "db")
    pub name: String,
    /// docker image (empty = use built image)
    pub image: Option<String>,
    /// container port
    pub port: u16,
    /// number of replicas
    pub replicas: Option<u32>,
    /// memory limit in mb
    pub memory_limit_mb: Option<u64>,
    /// cpu limit (1.0 = 1 core)
    pub cpu_limit: Option<f64>,
    /// service names this depends on
    pub depends_on: Option<Vec<String>>,
    /// health check config
    pub health_check: Option<HealthCheckRequest>,
    /// restart policy
    pub restart_policy: Option<String>,
}

/// service response for multi-container apps
#[derive(Debug, Serialize, ToSchema)]
pub struct ServiceResponse {
    /// service id
    pub id: String,
    /// service name
    pub name: String,
    /// docker image
    pub image: String,
    /// container port
    pub port: u16,
    /// number of replicas
    pub replicas: u32,
    /// memory limit in mb
    pub memory_limit_mb: Option<u64>,
    /// cpu limit
    pub cpu_limit: Option<f64>,
    /// dependencies
    pub depends_on: Vec<String>,
    /// restart policy
    pub restart_policy: String,
}

/// app container metrics response
#[derive(Debug, Serialize, ToSchema)]
pub struct AppMetricsResponse {
    pub container: String,
    pub cpu_percent: f64,
    pub mem_usage_bytes: u64,
    pub mem_limit_bytes: u64,
}

/// update app request
#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateAppRequest {
    /// new app name
    pub name: Option<String>,
    /// new github url
    pub github_url: Option<String>,
    /// new branch
    pub branch: Option<String>,
    /// new domain
    pub domain: Option<String>,
    /// new port (deprecated, use services)
    pub port: Option<u16>,
    /// updated env vars
    pub env_vars: Option<Vec<EnvVarRequest>>,
    /// updated services
    pub services: Option<Vec<ServiceRequest>>,
}

/// app response
#[derive(Debug, Serialize, ToSchema)]
pub struct AppResponse {
    /// unique app id
    pub id: Uuid,
    /// app name
    pub name: String,
    /// github repository url
    pub github_url: String,
    /// branch being deployed
    pub branch: String,
    /// custom domain
    pub domain: Option<String>,
    /// app port (deprecated)
    pub port: u16,
    /// environment variables
    pub env_vars: Vec<EnvVarResponse>,
    /// container services
    pub services: Vec<ServiceResponse>,
    /// creation timestamp
    pub created_at: String,
}

impl From<&App> for AppResponse {
    fn from(app: &App) -> Self {
        Self {
            id: app.id,
            name: app.name.clone(),
            github_url: app.github_url.clone(),
            branch: app.branch.clone(),
            domain: app.domain.clone(),
            port: app.port,
            env_vars: app
                .env_vars
                .iter()
                .map(|e| EnvVarResponse {
                    key: e.key.clone(),
                    value: if e.secret {
                        "********".to_string()
                    } else {
                        e.value.clone()
                    },
                    secret: e.secret,
                })
                .collect(),
            services: app
                .services
                .iter()
                .map(|s| ServiceResponse {
                    id: s.id.to_string(),
                    name: s.name.clone(),
                    image: s.image.clone(),
                    port: s.port,
                    replicas: s.replicas,
                    memory_limit_mb: s.memory_limit.map(|m| m / (1024 * 1024)),
                    cpu_limit: s.cpu_limit,
                    depends_on: s.depends_on.clone(),
                    restart_policy: format!("{:?}", s.restart_policy).to_lowercase(),
                })
                .collect(),
            created_at: app.created_at.to_rfc3339(),
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

/// list all apps for the authenticated user
#[utoipa::path(
    get,
    path = "/api/apps",
    tag = "apps",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "list of apps", body = Vec<AppResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn list_apps(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AppResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let apps = state
        .db
        .list_apps_by_owner(user_id)
        .map_err(internal_error)?;

    let responses: Vec<AppResponse> = apps.iter().map(AppResponse::from).collect();
    Ok(Json(responses))
}

/// create a new app
#[utoipa::path(
    post,
    path = "/api/apps",
    tag = "apps",
    security(("bearer" = [])),
    request_body = CreateAppRequest,
    responses(
        (status = 201, description = "app created", body = AppResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 409, description = "domain conflict", body = ErrorResponse)
    )
)]
pub async fn create_app(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateAppRequest>,
) -> Result<(StatusCode, Json<AppResponse>), (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    // validate name
    if req.name.is_empty() || req.name.len() > 64 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "name must be 1-64 characters".to_string(),
            }),
        ));
    }

    // check domain uniqueness
    if let Some(ref domain) = req.domain {
        if state
            .db
            .get_app_by_domain(domain)
            .map_err(internal_error)?
            .is_some()
        {
            return Err((
                StatusCode::CONFLICT,
                Json(ErrorResponse {
                    error: "domain already in use".to_string(),
                }),
            ));
        }
    }

    if let Some(ref domain) = req.domain {
        validate_domain(domain, &config.proxy.base_domain, config.proxy.public_ip.as_deref())
            .await
            .map_err(|e| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse { error: e }),
                )
            })?;
    }

    // create app
    let mut app = App::new(req.name, req.github_url, user_id);
    if let Some(branch) = req.branch {
        app.branch = branch;
    }
    app.domain = req.domain;
    if let Some(port) = req.port {
        app.port = port;
    }
    if let Some(env_vars) = req.env_vars {
        app.env_vars = env_vars
            .into_iter()
            .map(|e| EnvVar {
                key: e.key,
                value: e.value,
                secret: e.secret.unwrap_or(false),
            })
            .collect();
    }

    // process services for multi-container apps
    if let Some(services) = req.services {
        app.services = services
            .into_iter()
            .map(|s| {
                let mut service = ContainerService::new(
                    app.id,
                    s.name,
                    s.image.unwrap_or_default(),
                    s.port,
                );
                service.replicas = s.replicas.unwrap_or(1);
                service.memory_limit = s.memory_limit_mb.map(|m| m * 1024 * 1024);
                service.cpu_limit = s.cpu_limit;
                service.depends_on = s.depends_on.unwrap_or_default();
                if let Some(hc) = s.health_check {
                    service.health_check = Some(HealthCheck {
                        path: hc.path,
                        interval_secs: hc.interval_secs.unwrap_or(30),
                        timeout_secs: hc.timeout_secs.unwrap_or(5),
                        retries: hc.retries.unwrap_or(3),
                    });
                }
                if let Some(rp) = s.restart_policy {
                    service.restart_policy = match rp.to_lowercase().as_str() {
                        "never" | "no" => RestartPolicy::Never,
                        "onfailure" | "on-failure" => RestartPolicy::OnFailure,
                        _ => RestartPolicy::Always,
                    };
                }
                service
            })
            .collect();
    }

    state.db.save_app(&app).map_err(internal_error)?;

    if let Some(domain) = app.domain.clone() {
        if let Some(tx) = &state.cert_request_tx {
            let _ = tx.try_send(domain);
        } else {
            warn!("certificate issuance not available for new app domain");
        }
    }

    Ok((StatusCode::CREATED, Json(AppResponse::from(&app))))
}

/// get a single app by id
#[utoipa::path(
    get,
    path = "/api/apps/{id}",
    tag = "apps",
    params(("id" = Uuid, Path, description = "app id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "app details", body = AppResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn get_app(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<AppResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let app = state
        .db
        .get_app(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "app not found".to_string(),
                }),
            )
        })?;

    // check ownership
    if app.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    Ok(Json(AppResponse::from(&app)))
}

/// get app container metrics
#[utoipa::path(
    get,
    path = "/api/apps/{id}/metrics",
    tag = "apps",
    params(("id" = Uuid, Path, description = "app id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "container metrics", body = Vec<AppMetricsResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn get_app_metrics(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<AppMetricsResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let app = state
        .db
        .get_app(id)
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

    let manager = DockerContainerManager::new();
    let containers = manager.list_containers().await.map_err(internal_error)?;
    
    let mut metrics = Vec::new();
    let prefix = format!("znskr-{}", app.id);

    for container in containers.iter().filter(|c| c.id.starts_with(&prefix)) {
        if let Ok(stats) = manager.get_stats(&container.id).await {
            metrics.push(AppMetricsResponse {
                container: container.id.clone(),
                cpu_percent: stats.cpu_percent,
                mem_usage_bytes: stats.mem_usage_bytes,
                mem_limit_bytes: stats.mem_limit_bytes,
            });
        }
    }

    Ok(Json(metrics))
}

/// update an app
#[utoipa::path(
    put,
    path = "/api/apps/{id}",
    tag = "apps",
    params(("id" = Uuid, Path, description = "app id")),
    security(("bearer" = [])),
    request_body = UpdateAppRequest,
    responses(
        (status = 200, description = "app updated", body = AppResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse),
        (status = 409, description = "domain conflict", body = ErrorResponse)
    )
)]
pub async fn update_app(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateAppRequest>,
) -> Result<Json<AppResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let mut app = state
        .db
        .get_app(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "app not found".to_string(),
                }),
            )
        })?;

    // check ownership
    if app.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    let mut requested_domain: Option<String> = None;

    // update fields
    if let Some(name) = req.name {
        app.name = name;
    }
    if let Some(branch) = req.branch {
        app.branch = branch;
    }
    if let Some(domain) = req.domain {
        validate_domain(&domain, &config.proxy.base_domain, config.proxy.public_ip.as_deref())
            .await
            .map_err(|e| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse { error: e }),
                )
            })?;
        // check domain uniqueness
        if let Some(existing) = state
            .db
            .get_app_by_domain(&domain)
            .map_err(internal_error)?
        {
            if existing.id != app.id {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ErrorResponse {
                        error: "domain already in use".to_string(),
                    }),
                ));
            }
        }
        app.domain = Some(domain);
        requested_domain = app.domain.clone();
    }
    if let Some(port) = req.port {
        app.port = port;
    }
    if let Some(env_vars) = req.env_vars {
        // Create a map of existing env vars for lookups
        let existing_vars: std::collections::HashMap<String, String> = app
            .env_vars
            .iter()
            .map(|e| (e.key.clone(), e.value.clone()))
            .collect();

        app.env_vars = env_vars
            .into_iter()
            .map(|e| {
                let value = if e.secret.unwrap_or(false) && e.value == "********" {
                    // unexpected: user sent back the mask, try to find existing value
                    existing_vars.get(&e.key).cloned().unwrap_or(e.value)
                } else {
                    e.value
                };

                EnvVar {
                    key: e.key,
                    value,
                    secret: e.secret.unwrap_or(false),
                }
            })
            .collect();
    }

    app.updated_at = chrono::Utc::now();
    state.db.save_app(&app).map_err(internal_error)?;

    if let Some(domain) = requested_domain {
        if let Some(tx) = &state.cert_request_tx {
            let _ = tx.try_send(domain);
        } else {
            warn!("certificate issuance not available for updated app domain");
        }
    }

    Ok(Json(AppResponse::from(&app)))
}

/// delete an app
#[utoipa::path(
    delete,
    path = "/api/apps/{id}",
    tag = "apps",
    params(("id" = Uuid, Path, description = "app id")),
    security(("bearer" = [])),
    responses(
        (status = 204, description = "app deleted"),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn delete_app(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let app = state
        .db
        .get_app(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "app not found".to_string(),
                }),
            )
        })?;

    // check ownership
    if app.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    state.db.delete_app(id).map_err(internal_error)?;

    Ok(StatusCode::NO_CONTENT)
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

async fn validate_domain(
    domain: &str,
    base_domain: &str,
    public_ip: Option<&str>,
) -> Result<(), String> {
    if domain == base_domain {
        return Err("domain is reserved for the dashboard".to_string());
    }

    if domain.starts_with("www.") {
        return Err("www subdomains are not supported".to_string());
    }

    let public_ip = public_ip
        .ok_or_else(|| "public_ip must be configured for domain validation".to_string())?;
    let public_ip: IpAddr = public_ip
        .parse()
        .map_err(|_| "public_ip is not a valid IP address".to_string())?;

    let resolver = TokioAsyncResolver::tokio(ResolverConfig::default(), ResolverOpts::default());

    if let Ok(lookup) = resolver.lookup_ip(domain).await {
        if lookup.iter().any(|ip| ip == public_ip) {
            return Ok(());
        }
    }

    let cname_lookup = resolver
        .lookup(domain, RecordType::CNAME)
        .await
        .map_err(|_| "domain does not resolve to required records".to_string())?;

    let suffix = format!(".{}", base_domain.trim_end_matches('.'));
    for record in cname_lookup.iter() {
        if let trust_dns_resolver::proto::rr::RData::CNAME(cname) = record {
            let target = cname.to_utf8();
            if target.trim_end_matches('.').ends_with(&suffix) {
                return Ok(());
            }
        }
    }

    Err("domain must have an A record pointing to the public IP or CNAME to the base domain".to_string())
}
