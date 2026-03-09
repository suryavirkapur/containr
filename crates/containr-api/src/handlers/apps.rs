//! app management handlers

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::net::IpAddr;
use std::path::{Component, Path as FsPath, PathBuf};

use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tracing::warn;
use trust_dns_resolver::config::{ResolverConfig, ResolverOpts};
use trust_dns_resolver::proto::rr::RecordType;
use trust_dns_resolver::TokioAsyncResolver;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::ErrorResponse;
use crate::handlers::deployments::create_and_queue_deployment;
use crate::security::encrypt_value;
use crate::state::AppState;
use containr_common::models::{
    App, BuildArg, ContainerService, EnvVar, HealthCheck, RestartPolicy, RolloutStrategy,
    ServiceMount, ServiceRegistryAuth,
};
use containr_common::Config;
use containr_runtime::DockerContainerManager;

/// create app request
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateAppRequest {
    /// app name
    pub name: String,
    /// repository url
    pub github_url: String,
    /// branch to deploy (defaults to main)
    pub branch: Option<String>,
    /// custom domains
    pub domains: Option<Vec<String>>,
    /// custom domain
    pub domain: Option<String>,
    /// port for the app (deprecated, use services)
    pub port: Option<u16>,
    /// environment variables (shared across all services)
    pub env_vars: Option<Vec<EnvVarRequest>>,
    /// container services for multi-container apps
    pub services: Option<Vec<ServiceRequest>>,
    /// rollout strategy (stop_first or start_first)
    pub rollout_strategy: Option<String>,
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

/// persistent mount configuration request
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct ServiceMountRequest {
    /// unique mount name within the service
    pub name: String,
    /// absolute container path where the mount is attached
    pub target: String,
    /// whether the mount is read-only
    pub read_only: Option<bool>,
}

/// private registry credentials request
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ServiceRegistryAuthRequest {
    /// optional registry server override
    pub server: Option<String>,
    /// registry username
    pub username: Option<String>,
    /// registry password
    pub password: Option<String>,
}

/// health check configuration response
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct HealthCheckResponse {
    /// http path to check
    pub path: String,
    /// interval in seconds
    pub interval_secs: u32,
    /// timeout in seconds
    pub timeout_secs: u32,
    /// retries before unhealthy
    pub retries: u32,
}

/// persistent mount configuration response
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ServiceMountResponse {
    /// unique mount name within the service
    pub name: String,
    /// absolute container path where the mount is attached
    pub target: String,
    /// whether the mount is read-only
    pub read_only: bool,
}

/// private registry credentials response
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ServiceRegistryAuthResponse {
    /// optional registry server override
    pub server: Option<String>,
    /// registry username
    pub username: String,
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
    /// whether this service receives public http traffic
    pub expose_http: Option<bool>,
    /// additional container ports
    pub additional_ports: Option<Vec<u16>>,
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
    /// private registry credentials for pulling the service image
    pub registry_auth: Option<ServiceRegistryAuthRequest>,
    /// service-specific environment variables
    pub env_vars: Option<Vec<EnvVarRequest>>,
    /// relative repo path used as the docker build context
    pub build_context: Option<String>,
    /// relative path to the dockerfile within the repo
    pub dockerfile_path: Option<String>,
    /// docker build target stage
    pub build_target: Option<String>,
    /// docker build arguments
    pub build_args: Option<Vec<EnvVarRequest>>,
    /// command arguments override
    pub command: Option<Vec<String>>,
    /// entrypoint override
    pub entrypoint: Option<Vec<String>>,
    /// working directory override
    pub working_dir: Option<String>,
    /// persistent mounts attached to the service
    pub mounts: Option<Vec<ServiceMountRequest>>,
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
    /// whether this service receives public http traffic
    pub expose_http: bool,
    /// additional container ports
    pub additional_ports: Vec<u16>,
    /// number of replicas
    pub replicas: u32,
    /// memory limit in mb
    pub memory_limit_mb: Option<u64>,
    /// cpu limit
    pub cpu_limit: Option<f64>,
    /// dependencies
    pub depends_on: Vec<String>,
    /// health check config
    pub health_check: Option<HealthCheckResponse>,
    /// restart policy
    pub restart_policy: String,
    /// private registry credentials metadata
    pub registry_auth: Option<ServiceRegistryAuthResponse>,
    /// service-specific environment variables
    pub env_vars: Vec<EnvVarResponse>,
    /// relative repo path used as the docker build context
    pub build_context: Option<String>,
    /// relative path to the dockerfile within the repo
    pub dockerfile_path: Option<String>,
    /// docker build target stage
    pub build_target: Option<String>,
    /// docker build arguments
    pub build_args: Vec<EnvVarResponse>,
    /// command arguments override
    pub command: Vec<String>,
    /// entrypoint override
    pub entrypoint: Vec<String>,
    /// working directory override
    pub working_dir: Option<String>,
    /// persistent mounts
    pub mounts: Vec<ServiceMountResponse>,
}

/// service mount restore response
#[derive(Debug, Serialize, ToSchema)]
pub struct ServiceMountRestoreResponse {
    /// service name
    pub service: String,
    /// restored mount names
    pub mounts: Vec<String>,
    /// restore timestamp
    pub restored_at: String,
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
    /// new repository url
    pub github_url: Option<String>,
    /// new branch
    pub branch: Option<String>,
    /// new domains
    pub domains: Option<Vec<String>>,
    /// new domain
    pub domain: Option<String>,
    /// new port (deprecated, use services)
    pub port: Option<u16>,
    /// updated env vars
    pub env_vars: Option<Vec<EnvVarRequest>>,
    /// updated services
    pub services: Option<Vec<ServiceRequest>>,
    /// rollout strategy (stop_first or start_first)
    pub rollout_strategy: Option<String>,
}

/// app response
#[derive(Debug, Serialize, ToSchema)]
pub struct AppResponse {
    /// unique app id
    pub id: Uuid,
    /// app name
    pub name: String,
    /// repository url
    pub github_url: String,
    /// branch being deployed
    pub branch: String,
    /// custom domain
    pub domain: Option<String>,
    /// custom domains
    pub domains: Vec<String>,
    /// app port (deprecated)
    pub port: u16,
    /// environment variables
    pub env_vars: Vec<EnvVarResponse>,
    /// container services
    pub services: Vec<ServiceResponse>,
    /// rollout strategy
    pub rollout_strategy: String,
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
            domains: app.custom_domains(),
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
                    expose_http: s.expose_http,
                    additional_ports: s.additional_ports.clone(),
                    replicas: s.replicas,
                    memory_limit_mb: s.memory_limit.map(|m| m / (1024 * 1024)),
                    cpu_limit: s.cpu_limit,
                    depends_on: s.depends_on.clone(),
                    health_check: s
                        .health_check
                        .as_ref()
                        .map(|health_check| HealthCheckResponse {
                            path: health_check.path.clone(),
                            interval_secs: health_check.interval_secs,
                            timeout_secs: health_check.timeout_secs,
                            retries: health_check.retries,
                        }),
                    restart_policy: format!("{:?}", s.restart_policy).to_lowercase(),
                    registry_auth: s.registry_auth.as_ref().map(|registry_auth| {
                        ServiceRegistryAuthResponse {
                            server: registry_auth.server.clone(),
                            username: registry_auth.username.clone(),
                        }
                    }),
                    env_vars: s
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
                    build_context: s.build_context.clone(),
                    dockerfile_path: s.dockerfile_path.clone(),
                    build_target: s.build_target.clone(),
                    build_args: s
                        .build_args
                        .iter()
                        .map(|arg| EnvVarResponse {
                            key: arg.key.clone(),
                            value: if arg.secret {
                                "********".to_string()
                            } else {
                                arg.value.clone()
                            },
                            secret: arg.secret,
                        })
                        .collect(),
                    command: s.command.clone().unwrap_or_default(),
                    entrypoint: s.entrypoint.clone().unwrap_or_default(),
                    working_dir: s.working_dir.clone(),
                    mounts: s
                        .mounts
                        .iter()
                        .map(|mount| ServiceMountResponse {
                            name: mount.name.clone(),
                            target: mount.target.clone(),
                            read_only: mount.read_only,
                        })
                        .collect(),
                })
                .collect(),
            rollout_strategy: match app.rollout_strategy {
                RolloutStrategy::StopFirst => "stop_first".to_string(),
                RolloutStrategy::StartFirst => "start_first".to_string(),
            },
            created_at: app.created_at.to_rfc3339(),
        }
    }
}

fn parse_restart_policy(value: Option<&str>) -> RestartPolicy {
    match value.unwrap_or("always").to_lowercase().as_str() {
        "never" | "no" => RestartPolicy::Never,
        "onfailure" | "on-failure" => RestartPolicy::OnFailure,
        _ => RestartPolicy::Always,
    }
}

fn validate_mount_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn build_service_mounts(
    mounts: Option<Vec<ServiceMountRequest>>,
) -> Result<Vec<ServiceMount>, (StatusCode, Json<ErrorResponse>)> {
    let mut seen_names = HashSet::new();
    let mut seen_targets = HashSet::new();
    let mut parsed = Vec::new();

    for mount in mounts.unwrap_or_default() {
        let name = mount.name.trim().to_string();
        let target = mount.target.trim().to_string();

        if !validate_mount_name(&name) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "invalid mount name. use letters, numbers, hyphens, or underscores"
                        .to_string(),
                }),
            ));
        }

        if !target.starts_with('/') {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "mount target must be an absolute container path".to_string(),
                }),
            ));
        }

        if !seen_names.insert(name.clone()) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("duplicate mount name: {}", name),
                }),
            ));
        }

        if !seen_targets.insert(target.clone()) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("duplicate mount target: {}", target),
                }),
            ));
        }

        parsed.push(ServiceMount {
            name,
            target,
            read_only: mount.read_only.unwrap_or(false),
        });
    }

    Ok(parsed)
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_optional_args(
    value: Option<Vec<String>>,
    existing: Option<&[String]>,
) -> Option<Vec<String>> {
    match value {
        Some(value) => {
            let normalized = value
                .into_iter()
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect::<Vec<_>>();
            if normalized.is_empty() {
                None
            } else {
                Some(normalized)
            }
        }
        None => existing.map(|existing| existing.to_vec()),
    }
}

fn normalize_additional_ports(
    value: Option<Vec<u16>>,
    existing: &[u16],
    primary_port: u16,
) -> Result<Vec<u16>, (StatusCode, Json<ErrorResponse>)> {
    let ports = value.unwrap_or_else(|| existing.to_vec());
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for port in ports {
        if port == 0 {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "additional service ports must be between 1 and 65535".to_string(),
                }),
            ));
        }
        if port == primary_port {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("additional port {} duplicates the primary port", port),
                }),
            ));
        }
        if !seen.insert(port) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("duplicate additional port: {}", port),
                }),
            ));
        }
        normalized.push(port);
    }

    Ok(normalized)
}

fn normalize_working_dir(
    value: Option<String>,
    existing: Option<&str>,
) -> Result<Option<String>, (StatusCode, Json<ErrorResponse>)> {
    match value {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            if !trimmed.starts_with('/') {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: "working directory must be an absolute container path".to_string(),
                    }),
                ));
            }
            Ok(Some(trimmed.to_string()))
        }
        None => Ok(existing.map(|existing| existing.to_string())),
    }
}

fn normalize_repo_relative_path(
    field: &str,
    value: Option<String>,
    existing: Option<&str>,
) -> Result<Option<String>, (StatusCode, Json<ErrorResponse>)> {
    match value {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }

            let path = FsPath::new(trimmed);
            if path.is_absolute() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: format!("{field} must be relative to the repository root"),
                    }),
                ));
            }

            for component in path.components() {
                match component {
                    Component::Normal(_) | Component::CurDir => {}
                    _ => {
                        return Err((
                            StatusCode::BAD_REQUEST,
                            Json(ErrorResponse {
                                error: format!(
                                    "{field} cannot contain parent traversal or absolute components"
                                ),
                            }),
                        ))
                    }
                }
            }

            Ok(Some(trimmed.to_string()))
        }
        None => Ok(existing.map(|existing| existing.to_string())),
    }
}

fn build_service_env_vars(
    requests: Option<Vec<EnvVarRequest>>,
    existing: &[EnvVar],
) -> Result<Vec<EnvVar>, (StatusCode, Json<ErrorResponse>)> {
    let Some(requests) = requests else {
        return Ok(existing.to_vec());
    };

    let existing_by_key = existing
        .iter()
        .map(|env_var| (env_var.key.clone(), env_var.clone()))
        .collect::<HashMap<_, _>>();
    let mut seen_keys = HashSet::new();
    let mut env_vars = Vec::new();

    for request in requests {
        let key = request.key.trim().to_string();
        if key.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "service env var key cannot be empty".to_string(),
                }),
            ));
        }

        if !seen_keys.insert(key.clone()) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("duplicate service env var key: {}", key),
                }),
            ));
        }

        let existing_value = existing_by_key.get(&key);
        let secret = request
            .secret
            .unwrap_or_else(|| existing_value.map(|item| item.secret).unwrap_or(false));
        let value = if secret && request.value == "********" {
            existing_value
                .map(|item| item.value.clone())
                .ok_or_else(|| {
                    (
                        StatusCode::BAD_REQUEST,
                        Json(ErrorResponse {
                            error: format!(
                                "missing original value for masked service env var {}",
                                key
                            ),
                        }),
                    )
                })?
        } else {
            request.value
        };

        env_vars.push(EnvVar { key, value, secret });
    }

    Ok(env_vars)
}

fn build_service_build_args(
    requests: Option<Vec<EnvVarRequest>>,
    existing: &[BuildArg],
) -> Result<Vec<BuildArg>, (StatusCode, Json<ErrorResponse>)> {
    let Some(requests) = requests else {
        return Ok(existing.to_vec());
    };

    let existing_by_key = existing
        .iter()
        .map(|build_arg| (build_arg.key.clone(), build_arg.clone()))
        .collect::<HashMap<_, _>>();
    let mut seen_keys = HashSet::new();
    let mut build_args = Vec::new();

    for request in requests {
        let key = request.key.trim().to_string();
        if key.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "service build arg key cannot be empty".to_string(),
                }),
            ));
        }

        if !seen_keys.insert(key.clone()) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("duplicate service build arg key: {}", key),
                }),
            ));
        }

        let existing_value = existing_by_key.get(&key);
        let secret = request
            .secret
            .unwrap_or_else(|| existing_value.map(|item| item.secret).unwrap_or(false));
        let value = if secret && request.value == "********" {
            existing_value
                .map(|item| item.value.clone())
                .ok_or_else(|| {
                    (
                        StatusCode::BAD_REQUEST,
                        Json(ErrorResponse {
                            error: format!(
                                "missing original value for masked service build arg {}",
                                key
                            ),
                        }),
                    )
                })?
        } else {
            request.value
        };

        build_args.push(BuildArg { key, value, secret });
    }

    Ok(build_args)
}

fn build_service_registry_auth(
    config: &Config,
    existing_auth: Option<&ServiceRegistryAuth>,
    registry_auth: Option<ServiceRegistryAuthRequest>,
) -> Result<Option<ServiceRegistryAuth>, (StatusCode, Json<ErrorResponse>)> {
    let Some(registry_auth) = registry_auth else {
        return Ok(existing_auth.cloned());
    };

    let server = normalize_optional_string(registry_auth.server);
    let username = normalize_optional_string(registry_auth.username);
    let password = normalize_optional_string(registry_auth.password);

    if server.is_none() && username.is_none() && password.is_none() {
        return Ok(None);
    }

    let username = username.ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "registry username is required when registry auth is set".to_string(),
            }),
        )
    })?;

    let password = match password.as_deref() {
        Some("********") | None => existing_auth
            .map(|existing| existing.password.clone())
            .ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: "registry password is required for new registry auth".to_string(),
                    }),
                )
            })?,
        Some(password) => encrypt_value(config, password).map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error }),
            )
        })?,
    };

    Ok(Some(ServiceRegistryAuth {
        server,
        username,
        password,
    }))
}

fn build_services(
    config: &Config,
    app_id: Uuid,
    existing_services: &[ContainerService],
    requests: Vec<ServiceRequest>,
) -> Result<Vec<ContainerService>, (StatusCode, Json<ErrorResponse>)> {
    if requests.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "apps must define at least one service".to_string(),
            }),
        ));
    }

    let existing_by_name = existing_services
        .iter()
        .map(|service| (service.name.clone(), service.clone()))
        .collect::<HashMap<_, _>>();
    let mut seen_names = HashSet::new();
    let mut services = Vec::new();

    for request in requests {
        let service_name = request.name.trim().to_string();
        if service_name.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "service name cannot be empty".to_string(),
                }),
            ));
        }
        if !seen_names.insert(service_name.clone()) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("duplicate service name: {}", service_name),
                }),
            ));
        }

        let mut service = existing_by_name
            .get(&service_name)
            .cloned()
            .unwrap_or_else(|| {
                ContainerService::new(
                    app_id,
                    service_name.clone(),
                    request.image.clone().unwrap_or_default(),
                    request.port,
                )
            });

        service.app_id = app_id;
        service.name = service_name;
        service.image = request.image.unwrap_or_default();
        service.port = request.port;
        service.expose_http = request.expose_http.unwrap_or(service.expose_http);
        service.additional_ports = normalize_additional_ports(
            request.additional_ports,
            &service.additional_ports,
            service.port,
        )?;
        service.replicas = request.replicas.unwrap_or(1);
        service.memory_limit = request.memory_limit_mb.map(|m| m * 1024 * 1024);
        service.cpu_limit = request.cpu_limit;
        service.depends_on = request.depends_on.unwrap_or_default();
        service.registry_auth = build_service_registry_auth(
            config,
            service.registry_auth.as_ref(),
            request.registry_auth,
        )?;
        service.env_vars = build_service_env_vars(request.env_vars, &service.env_vars)?;
        service.build_context = normalize_repo_relative_path(
            "service build context",
            request.build_context,
            service.build_context.as_deref(),
        )?;
        service.dockerfile_path = normalize_repo_relative_path(
            "service dockerfile path",
            request.dockerfile_path,
            service.dockerfile_path.as_deref(),
        )?;
        service.build_target = match request.build_target {
            Some(build_target) => normalize_optional_string(Some(build_target)),
            None => service.build_target.clone(),
        };
        service.build_args = build_service_build_args(request.build_args, &service.build_args)?;
        service.command = normalize_optional_args(request.command, service.command.as_deref());
        service.entrypoint =
            normalize_optional_args(request.entrypoint, service.entrypoint.as_deref());
        service.working_dir =
            normalize_working_dir(request.working_dir, service.working_dir.as_deref())?;
        service.mounts = build_service_mounts(request.mounts)?;
        service.health_check = request.health_check.map(|health_check| HealthCheck {
            path: health_check.path,
            interval_secs: health_check.interval_secs.unwrap_or(30),
            timeout_secs: health_check.timeout_secs.unwrap_or(5),
            retries: health_check.retries.unwrap_or(3),
        });
        service.restart_policy = parse_restart_policy(request.restart_policy.as_deref());
        service.updated_at = chrono::Utc::now();
        services.push(service);
    }

    let exposed_service_count = services
        .iter()
        .filter(|service| service.expose_http)
        .count();
    if exposed_service_count > 1 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "only one service can receive public http traffic".to_string(),
            }),
        ));
    }

    Ok(services)
}

fn get_owned_app_record(
    state: &AppState,
    user_id: Uuid,
    app_id: Uuid,
) -> Result<App, (StatusCode, Json<ErrorResponse>)> {
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

    Ok(app)
}

fn get_owned_service_record(
    state: &AppState,
    user_id: Uuid,
    app_id: Uuid,
    service_name: &str,
) -> Result<(App, ContainerService), (StatusCode, Json<ErrorResponse>)> {
    let app = get_owned_app_record(state, user_id, app_id)?;
    let service = app
        .services
        .iter()
        .find(|service| service.name == service_name)
        .cloned()
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "service not found".to_string(),
                }),
            )
        })?;

    if service.mounts.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "service has no persistent mounts".to_string(),
            }),
        ));
    }

    Ok((app, service))
}

fn service_mount_root(data_dir: &FsPath, app_id: Uuid, service_id: Uuid) -> PathBuf {
    data_dir
        .join("builds")
        .join("app-mounts")
        .join(app_id.to_string())
        .join(service_id.to_string())
}

fn sanitize_archive_entry_path(
    path: &FsPath,
    allowed_mounts: &HashSet<String>,
) -> anyhow::Result<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(anyhow::anyhow!("archive entry path cannot be empty"));
    }

    let mut clean = PathBuf::new();
    let mut components = path.components();
    let first = match components.next() {
        Some(Component::Normal(name)) => name.to_string_lossy().to_string(),
        _ => {
            return Err(anyhow::anyhow!(
                "archive entry must start with a mount name"
            ))
        }
    };

    if !allowed_mounts.contains(&first) {
        return Err(anyhow::anyhow!("archive entry references an unknown mount"));
    }

    clean.push(first);

    for component in components {
        match component {
            Component::CurDir => {}
            Component::Normal(name) => clean.push(name),
            _ => return Err(anyhow::anyhow!("archive entry path is invalid")),
        }
    }

    Ok(clean)
}

fn build_service_mount_archive(
    archive_path: &FsPath,
    mount_root: &FsPath,
    mounts: &[ServiceMount],
) -> anyhow::Result<()> {
    let file = File::create(archive_path)?;
    let mut builder = tar::Builder::new(file);

    for mount in mounts {
        let source = mount_root.join(&mount.name);
        std::fs::create_dir_all(&source)?;
        builder.append_dir_all(&mount.name, &source)?;
    }

    builder.finish()?;
    Ok(())
}

fn validate_service_mount_archive(
    archive_path: &FsPath,
    mounts: &[ServiceMount],
) -> anyhow::Result<()> {
    let allowed_mounts = mounts
        .iter()
        .map(|mount| mount.name.clone())
        .collect::<HashSet<_>>();
    let file = File::open(archive_path)?;
    let mut archive = tar::Archive::new(file);

    for entry in archive.entries()? {
        let entry = entry?;
        let entry_type = entry.header().entry_type();
        if !entry_type.is_dir() && !entry_type.is_file() {
            return Err(anyhow::anyhow!("archive contains unsupported entry types"));
        }

        let path = entry.path()?;
        let _ = sanitize_archive_entry_path(path.as_ref(), &allowed_mounts)?;
    }

    Ok(())
}

fn extract_service_mount_archive(
    archive_path: &FsPath,
    mount_root: &FsPath,
    mounts: &[ServiceMount],
) -> anyhow::Result<()> {
    validate_service_mount_archive(archive_path, mounts)?;

    for mount in mounts {
        let target = mount_root.join(&mount.name);
        if target.exists() {
            std::fs::remove_dir_all(&target)?;
        }
        std::fs::create_dir_all(&target)?;
    }

    let allowed_mounts = mounts
        .iter()
        .map(|mount| mount.name.clone())
        .collect::<HashSet<_>>();
    let file = File::open(archive_path)?;
    let mut archive = tar::Archive::new(file);

    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?;
        let rel_path = sanitize_archive_entry_path(path.as_ref(), &allowed_mounts)?;
        let target = mount_root.join(rel_path);

        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }

        entry.unpack(&target)?;
    }

    Ok(())
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

    let requested_domains = merge_domains(req.domain.clone(), req.domains.clone());

    if !requested_domains.is_empty() {
        // check domain uniqueness
        for domain in &requested_domains {
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

        validate_domains(
            &requested_domains,
            &config.proxy.base_domain,
            config.proxy.public_ip.as_deref(),
        )
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: e })))?;
    }

    // create app
    let mut app = App::new(req.name, req.github_url, user_id);
    if let Some(branch) = req.branch {
        app.branch = branch;
    }
    if !requested_domains.is_empty() {
        app.set_domains(requested_domains);
    }
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
    if let Some(strategy) = req.rollout_strategy.as_deref() {
        app.rollout_strategy = parse_rollout_strategy(strategy).ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "invalid rollout strategy. use stop_first or start_first".to_string(),
                }),
            )
        })?;
    }

    // process services for multi-container apps
    if let Some(services) = req.services {
        app.services = build_services(&config, app.id, &[], services)?;
    }
    app.ensure_service_model();

    state.db.save_app(&app).map_err(internal_error)?;

    if let Err(error) = create_and_queue_deployment(
        &state,
        user_id,
        &app,
        "initial".to_string(),
        Some("initial deployment".to_string()),
        app.branch.clone(),
        app.rollout_strategy,
        None,
    )
    .await
    {
        let _ = state.db.delete_app(app.id);
        return Err(error);
    }

    let domains = app.custom_domains();
    if !domains.is_empty() {
        if let Some(tx) = &state.cert_request_tx {
            for domain in domains {
                let _ = tx.try_send(domain);
            }
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
    let prefix = format!("containr-{}", app.id);

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

/// download a tar archive of all persistent mounts for a service
#[utoipa::path(
    get,
    path = "/api/apps/{id}/services/{service_name}/mounts/backup",
    tag = "apps",
    params(
        ("id" = Uuid, Path, description = "app id"),
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
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    drop(config);

    let (_app, service) = get_owned_service_record(&state, user_id, id, &service_name)?;
    let mount_root = service_mount_root(&state.data_dir, id, service.id);
    let temp_dir = state.data_dir.join("tmp");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(internal_error)?;
    let archive_path = temp_dir.join(format!("{}-{}.tar", service.id, Uuid::new_v4()));
    let mounts = service.mounts.clone();
    let archive_path_for_build = archive_path.clone();
    let mount_root_for_build = mount_root.clone();

    tokio::task::spawn_blocking(move || {
        build_service_mount_archive(&archive_path_for_build, &mount_root_for_build, &mounts)
    })
    .await
    .map_err(internal_error)?
    .map_err(internal_error)?;

    let archive_bytes = tokio::fs::read(&archive_path)
        .await
        .map_err(internal_error)?;
    let _ = tokio::fs::remove_file(&archive_path).await;
    let filename = format!("{}-mounts.tar", service.name);

    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-tar")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename),
        )
        .body(Body::from(archive_bytes))
        .map_err(internal_error)
}

/// restore all persistent mounts for a service from a tar archive
#[utoipa::path(
    post,
    path = "/api/apps/{id}/services/{service_name}/mounts/restore",
    tag = "apps",
    params(
        ("id" = Uuid, Path, description = "app id"),
        ("service_name" = String, Path, description = "service name")
    ),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "service mount archive restored", body = ServiceMountRestoreResponse),
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
    mut multipart: Multipart,
) -> Result<Json<ServiceMountRestoreResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;
    drop(config);

    let (_app, service) = get_owned_service_record(&state, user_id, id, &service_name)?;
    let temp_dir = state.data_dir.join("tmp");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(internal_error)?;
    let archive_path = temp_dir.join(format!("{}-{}.tar", service.id, Uuid::new_v4()));
    let mut archive_file = tokio::fs::File::create(&archive_path)
        .await
        .map_err(internal_error)?;
    let mut archive_found = false;

    while let Some(mut field) = multipart.next_field().await.map_err(internal_error)? {
        if field.name() != Some("archive") {
            continue;
        }

        archive_found = true;
        while let Some(chunk) = field.chunk().await.map_err(internal_error)? {
            archive_file
                .write_all(&chunk)
                .await
                .map_err(internal_error)?;
        }
        break;
    }

    archive_file.flush().await.map_err(internal_error)?;
    drop(archive_file);

    if !archive_found {
        let _ = tokio::fs::remove_file(&archive_path).await;
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "missing archive file".to_string(),
            }),
        ));
    }

    let mounts = service.mounts.clone();
    let archive_path_for_validation = archive_path.clone();
    let validation = tokio::task::spawn_blocking(move || {
        validate_service_mount_archive(&archive_path_for_validation, &mounts)
    })
    .await
    .map_err(internal_error)?;
    if let Err(error) = validation {
        let _ = tokio::fs::remove_file(&archive_path).await;
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: error.to_string(),
            }),
        ));
    }

    let mount_root = service_mount_root(&state.data_dir, id, service.id);
    let mounts = service.mounts.clone();
    let archive_path_for_restore = archive_path.clone();
    tokio::task::spawn_blocking(move || {
        extract_service_mount_archive(&archive_path_for_restore, &mount_root, &mounts)
    })
    .await
    .map_err(internal_error)?
    .map_err(internal_error)?;

    let _ = tokio::fs::remove_file(&archive_path).await;

    Ok(Json(ServiceMountRestoreResponse {
        service: service.name,
        mounts: service
            .mounts
            .iter()
            .map(|mount| mount.name.clone())
            .collect(),
        restored_at: chrono::Utc::now().to_rfc3339(),
    }))
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

    let mut requested_domains: Option<Vec<String>> = None;

    // update fields
    if let Some(name) = req.name {
        app.name = name;
    }
    if let Some(branch) = req.branch {
        app.branch = branch;
    }
    if req.domain.is_some() || req.domains.is_some() {
        let domains = merge_domains(req.domain, req.domains);
        if !domains.is_empty() {
            validate_domains(
                &domains,
                &config.proxy.base_domain,
                config.proxy.public_ip.as_deref(),
            )
            .await
            .map_err(|e| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: e })))?;

            // check domain uniqueness
            for domain in &domains {
                if let Some(existing) =
                    state.db.get_app_by_domain(domain).map_err(internal_error)?
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
            }
        }
        requested_domains = Some(domains);
    }
    if let Some(domains) = requested_domains.clone() {
        app.set_domains(domains);
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
    if let Some(strategy) = req.rollout_strategy.as_deref() {
        app.rollout_strategy = parse_rollout_strategy(strategy).ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "invalid rollout strategy. use stop_first or start_first".to_string(),
                }),
            )
        })?;
    }
    if let Some(services) = req.services {
        app.services = build_services(&config, app.id, &app.services, services)?;
    }

    app.ensure_service_model();
    app.updated_at = chrono::Utc::now();
    state.db.save_app(&app).map_err(internal_error)?;

    if requested_domains.is_some() {
        if let Some(tx) = &state.cert_request_tx {
            for domain in app.custom_domains() {
                let _ = tx.try_send(domain);
            }
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

fn normalize_domain(input: &str) -> Option<String> {
    let trimmed = input.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_lowercase())
}

fn parse_rollout_strategy(value: &str) -> Option<RolloutStrategy> {
    match value.trim().to_ascii_lowercase().as_str() {
        "stop_first" | "stop-first" | "stopfirst" => Some(RolloutStrategy::StopFirst),
        "start_first" | "start-first" | "startfirst" => Some(RolloutStrategy::StartFirst),
        _ => None,
    }
}

fn normalize_domains(domains: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for domain in domains {
        if let Some(value) = normalize_domain(&domain) {
            if !normalized.iter().any(|d| d == &value) {
                normalized.push(value);
            }
        }
    }
    normalized
}

fn merge_domains(domain: Option<String>, domains: Option<Vec<String>>) -> Vec<String> {
    let mut combined = Vec::new();
    if let Some(list) = domains {
        combined.extend(list);
    }
    if let Some(single) = domain {
        combined.push(single);
    }
    normalize_domains(combined)
}

async fn validate_domains(
    domains: &[String],
    base_domain: &str,
    public_ip: Option<&str>,
) -> Result<(), String> {
    for domain in domains {
        validate_domain(domain, base_domain, public_ip).await?;
    }
    Ok(())
}

async fn validate_domain(
    domain: &str,
    base_domain: &str,
    public_ip: Option<&str>,
) -> Result<(), String> {
    let base_domain = base_domain.trim().to_lowercase();

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

    Err(
        "domain must have an A record pointing to the public IP or CNAME to the base domain"
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        build_service_mounts, build_services, normalize_additional_ports, normalize_optional_args,
        normalize_working_dir, sanitize_archive_entry_path, HealthCheckRequest,
        ServiceMountRequest, ServiceRequest,
    };
    use axum::http::StatusCode;
    use containr_common::models::{ContainerService, RestartPolicy, ServiceRegistryAuth};
    use containr_common::Config;
    use std::collections::HashSet;
    use std::path::Path;
    use uuid::Uuid;

    #[test]
    fn rejects_duplicate_mount_targets() {
        let result = build_service_mounts(Some(vec![
            ServiceMountRequest {
                name: "data".to_string(),
                target: "/data".to_string(),
                read_only: Some(false),
            },
            ServiceMountRequest {
                name: "cache".to_string(),
                target: "/data".to_string(),
                read_only: Some(true),
            },
        ]));

        match result {
            Ok(_) => panic!("expected duplicate mount target validation to fail"),
            Err((status, body)) => {
                assert_eq!(status, StatusCode::BAD_REQUEST);
                assert_eq!(body.0.error, "duplicate mount target: /data");
            }
        }
    }

    #[test]
    fn updates_existing_service_by_name_and_keeps_mounts() {
        let app_id = Uuid::new_v4();
        let mut config = Config::default();
        config.security.encryption_key = "test-secret".to_string();

        let mut existing = ContainerService::new(
            app_id,
            "web".to_string(),
            "ghcr.io/example/web:1".to_string(),
            8080,
        );
        let existing_id = existing.id;
        existing.restart_policy = RestartPolicy::OnFailure;
        existing.registry_auth = Some(ServiceRegistryAuth {
            server: Some("ghcr.io".to_string()),
            username: "demo-user".to_string(),
            password: "enc:existing-password".to_string(),
        });

        let result = build_services(
            &config,
            app_id,
            &[existing],
            vec![ServiceRequest {
                name: "web".to_string(),
                image: Some("ghcr.io/example/web:2".to_string()),
                port: 9090,
                expose_http: Some(true),
                additional_ports: Some(vec![9091, 9092]),
                replicas: Some(3),
                memory_limit_mb: Some(256),
                cpu_limit: Some(1.5),
                depends_on: Some(vec!["redis".to_string()]),
                health_check: Some(HealthCheckRequest {
                    path: "/health".to_string(),
                    interval_secs: Some(15),
                    timeout_secs: Some(4),
                    retries: Some(2),
                }),
                restart_policy: Some("always".to_string()),
                registry_auth: None,
                env_vars: None,
                build_context: None,
                dockerfile_path: None,
                build_target: None,
                build_args: None,
                command: Some(vec![
                    "npm".to_string(),
                    "run".to_string(),
                    "start".to_string(),
                ]),
                entrypoint: Some(vec!["/usr/bin/env".to_string()]),
                working_dir: Some("/workspace".to_string()),
                mounts: Some(vec![ServiceMountRequest {
                    name: "data".to_string(),
                    target: "/var/lib/app".to_string(),
                    read_only: Some(false),
                }]),
            }],
        );

        match result {
            Ok(services) => {
                assert_eq!(services.len(), 1);
                let service = &services[0];
                assert_eq!(service.id, existing_id);
                assert_eq!(service.name, "web");
                assert_eq!(service.image, "ghcr.io/example/web:2");
                assert_eq!(service.port, 9090);
                assert!(service.expose_http);
                assert_eq!(service.additional_ports, vec![9091, 9092]);
                assert_eq!(service.replicas, 3);
                assert_eq!(service.depends_on, vec!["redis".to_string()]);
                assert!(service.registry_auth.is_some());
                assert_eq!(
                    service
                        .registry_auth
                        .as_ref()
                        .map(|registry_auth| registry_auth.username.clone()),
                    Some("demo-user".to_string())
                );
                assert_eq!(service.mounts.len(), 1);
                assert_eq!(service.mounts[0].name, "data");
                assert_eq!(service.mounts[0].target, "/var/lib/app");
                assert!(!service.mounts[0].read_only);
                assert_eq!(
                    service.command,
                    Some(vec![
                        "npm".to_string(),
                        "run".to_string(),
                        "start".to_string()
                    ])
                );
                assert_eq!(service.entrypoint, Some(vec!["/usr/bin/env".to_string()]));
                assert_eq!(service.working_dir, Some("/workspace".to_string()));
                assert_eq!(service.restart_policy, RestartPolicy::Always);
                assert!(service.health_check.is_some());
            }
            Err(_) => panic!("expected service update to succeed"),
        }
    }

    #[test]
    fn omitted_command_fields_preserve_existing_values() {
        let existing_command = vec!["npm".to_string(), "run".to_string(), "serve".to_string()];
        let existing_entrypoint = vec!["/usr/bin/env".to_string()];

        assert_eq!(
            normalize_optional_args(None, Some(existing_command.as_slice())),
            Some(existing_command)
        );
        assert_eq!(
            normalize_optional_args(None, Some(existing_entrypoint.as_slice())),
            Some(existing_entrypoint)
        );

        match normalize_working_dir(None, Some("/workspace")) {
            Ok(value) => assert_eq!(value, Some("/workspace".to_string())),
            Err(_) => panic!("expected working directory preservation to succeed"),
        }
    }

    #[test]
    fn empty_command_fields_clear_existing_values() {
        assert_eq!(
            normalize_optional_args(Some(vec![" ".to_string()]), Some(&["x".to_string()])),
            None
        );
        assert_eq!(normalize_optional_args(Some(Vec::new()), None), None);

        match normalize_working_dir(Some("   ".to_string()), Some("/workspace")) {
            Ok(value) => assert_eq!(value, None),
            Err(_) => panic!("expected blank working directory to clear the value"),
        }
    }

    #[test]
    fn additional_ports_preserve_and_validate() {
        match normalize_additional_ports(None, &[9000, 9001], 8080) {
            Ok(value) => assert_eq!(value, vec![9000, 9001]),
            Err(_) => panic!("expected existing additional ports to be preserved"),
        }

        match normalize_additional_ports(Some(vec![8080]), &[], 8080) {
            Ok(_) => panic!("expected duplicate primary port to be rejected"),
            Err((status, body)) => {
                assert_eq!(status, StatusCode::BAD_REQUEST);
                assert_eq!(
                    body.0.error,
                    "additional port 8080 duplicates the primary port"
                );
            }
        }
    }

    #[test]
    fn rejects_multiple_public_http_services() {
        let app_id = Uuid::new_v4();
        let config = Config::default();

        let result = build_services(
            &config,
            app_id,
            &[],
            vec![
                ServiceRequest {
                    name: "api".to_string(),
                    image: Some("ghcr.io/example/api:1".to_string()),
                    port: 8080,
                    expose_http: Some(true),
                    additional_ports: None,
                    replicas: None,
                    memory_limit_mb: None,
                    cpu_limit: None,
                    depends_on: None,
                    health_check: None,
                    restart_policy: None,
                    registry_auth: None,
                    env_vars: None,
                    build_context: None,
                    dockerfile_path: None,
                    build_target: None,
                    build_args: None,
                    command: None,
                    entrypoint: None,
                    working_dir: None,
                    mounts: None,
                },
                ServiceRequest {
                    name: "worker".to_string(),
                    image: Some("ghcr.io/example/worker:1".to_string()),
                    port: 9000,
                    expose_http: Some(true),
                    additional_ports: None,
                    replicas: None,
                    memory_limit_mb: None,
                    cpu_limit: None,
                    depends_on: None,
                    health_check: None,
                    restart_policy: None,
                    registry_auth: None,
                    env_vars: None,
                    build_context: None,
                    dockerfile_path: None,
                    build_target: None,
                    build_args: None,
                    command: None,
                    entrypoint: None,
                    working_dir: None,
                    mounts: None,
                },
            ],
        );

        match result {
            Ok(_) => panic!("expected multiple public services to be rejected"),
            Err((status, body)) => {
                assert_eq!(status, StatusCode::BAD_REQUEST);
                assert_eq!(
                    body.0.error,
                    "only one service can receive public http traffic"
                );
            }
        }
    }

    #[test]
    fn rejects_empty_services_list() {
        let config = Config::default();

        let result = build_services(&config, Uuid::new_v4(), &[], Vec::new());

        match result {
            Ok(_) => panic!("expected empty service list to be rejected"),
            Err((status, body)) => {
                assert_eq!(status, StatusCode::BAD_REQUEST);
                assert_eq!(body.0.error, "apps must define at least one service");
            }
        }
    }

    #[test]
    fn rejects_relative_working_directory() {
        match normalize_working_dir(Some("workspace".to_string()), None) {
            Ok(_) => panic!("expected relative working directory to be rejected"),
            Err((status, body)) => {
                assert_eq!(status, StatusCode::BAD_REQUEST);
                assert_eq!(
                    body.0.error,
                    "working directory must be an absolute container path"
                );
            }
        }
    }

    #[test]
    fn archive_path_validation_accepts_known_mounts() {
        let allowed = HashSet::from(["data".to_string(), "cache".to_string()]);
        match sanitize_archive_entry_path(Path::new("data/nested/file.txt"), &allowed) {
            Ok(path) => assert_eq!(path, Path::new("data/nested/file.txt")),
            Err(_) => panic!("expected archive path to be accepted"),
        }
    }

    #[test]
    fn archive_path_validation_rejects_unknown_mounts() {
        let allowed = HashSet::from(["data".to_string()]);
        match sanitize_archive_entry_path(Path::new("cache/file.txt"), &allowed) {
            Ok(_) => panic!("expected archive path to be rejected"),
            Err(error) => assert_eq!(
                error.to_string(),
                "archive entry references an unknown mount"
            ),
        }
    }

    #[test]
    fn archive_path_validation_rejects_parent_traversal() {
        let allowed = HashSet::from(["data".to_string()]);
        match sanitize_archive_entry_path(Path::new("data/../secret"), &allowed) {
            Ok(_) => panic!("expected archive path traversal to be rejected"),
            Err(error) => assert_eq!(error.to_string(), "archive entry path is invalid"),
        }
    }
}
