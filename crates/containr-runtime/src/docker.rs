//! docker-based container management
//!
//! async container operations using bollard docker api.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;

use bollard::exec::{
    CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults,
};
use bollard::models::{
    ContainerCreateBody, ContainerStateStatusEnum, ContainerSummaryStateEnum,
    EndpointSettings, HealthStatusEnum, HostConfig, Mount, MountTypeEnum,
    NetworkConnectRequest, NetworkCreateRequest, NetworkingConfig,
    RestartPolicy, RestartPolicyNameEnum,
};
use bollard::query_parameters::{
    CreateContainerOptions, InspectContainerOptions, ListContainersOptions,
    LogsOptions, RemoveContainerOptions, StartContainerOptions, StatsOptions,
    StopContainerOptions,
};
use bollard::Docker;
use futures::{Stream, StreamExt};
use serde::Deserialize;
use tokio::io::AsyncWrite;
use tracing::{error, info, warn};

use crate::error::{ClientError, Result};

pub const INTERNAL_NETWORK_NAME: &str = "containr-internal";

/// network attachment for container creation
#[derive(Debug, Clone, Default)]
pub struct DockerNetworkAttachment {
    pub name: String,
    pub aliases: Vec<String>,
}

/// bind mount configuration for a container
#[derive(Debug, Clone)]
pub struct DockerBindMount {
    pub source: String,
    pub target: String,
    pub read_only: bool,
}

/// health check command configuration for docker
#[derive(Debug, Clone)]
pub struct HealthCheckCommand {
    /// command to run (e.g. ["curl", "-f", "http://localhost:8080/health"])
    pub cmd: Vec<String>,
    /// interval between checks in seconds
    pub interval_secs: u32,
    /// timeout for each check in seconds
    pub timeout_secs: u32,
    /// number of retries before marking unhealthy
    pub retries: u32,
}

/// container configuration for docker
#[derive(Debug, Clone)]
pub struct DockerContainerConfig {
    pub id: String,
    pub image: String,
    pub env_vars: HashMap<String, String>,
    pub port: u16,
    pub additional_ports: Vec<u16>,
    pub command: Option<Vec<String>>,
    pub entrypoint: Option<Vec<String>>,
    pub working_dir: Option<String>,
    pub memory_limit: Option<u64>,
    pub cpu_limit: Option<f64>,
    /// primary docker network to attach to during container creation
    pub network: Option<DockerNetworkAttachment>,
    /// bind mounts attached when the container starts
    pub mounts: Vec<DockerBindMount>,
    /// additional docker networks to attach after container start
    pub additional_networks: Vec<DockerNetworkAttachment>,
    /// health check configuration
    pub health_check: Option<HealthCheckCommand>,
    /// restart policy ("no", "always", "on-failure", "unless-stopped")
    pub restart_policy: String,
}

/// docker container status
#[derive(Debug, Clone)]
pub struct DockerContainerStatus {
    pub running: bool,
    pub container_id: Option<String>,
}

/// docker container stats
#[derive(Debug, Clone)]
pub struct DockerContainerStats {
    pub cpu_percent: f64,
    pub mem_usage_bytes: u64,
    pub mem_limit_bytes: u64,
}

/// docker container runtime state
#[derive(Debug, Clone)]
pub struct DockerContainerState {
    pub status: String,
    pub health_status: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub restart_count: u64,
}

/// docker mount info
#[derive(Debug, Clone, Deserialize)]
pub struct DockerMountInfo {
    #[serde(rename = "Type")]
    pub mount_type: String,
    #[serde(rename = "Source")]
    pub source: String,
    #[serde(rename = "Destination")]
    pub destination: String,
    #[serde(rename = "Name")]
    pub name: Option<String>,
    #[serde(rename = "RW")]
    pub rw: Option<bool>,
}

/// docker container info
#[derive(Debug, Clone)]
pub struct DockerContainerInfo {
    pub id: String,
    pub image: String,
    pub status: DockerContainerStatus,
}

/// interactive exec session for a running container
pub struct DockerExecSession {
    pub exec_id: String,
    pub output: Pin<Box<dyn Stream<Item = Result<Vec<u8>>> + Send>>,
    pub input: Pin<Box<dyn AsyncWrite + Send>>,
}

/// manages container lifecycle using bollard docker api
#[derive(Clone)]
pub struct DockerContainerManager {
    docker: Option<Arc<Docker>>,
    stub_mode: bool,
}

impl DockerContainerManager {
    /// creates a new docker container manager
    /// panics if unable to connect to docker socket
    pub fn new() -> Self {
        match Docker::connect_with_socket_defaults() {
            Ok(docker) => {
                info!("connected to docker socket");
                Self {
                    docker: Some(Arc::new(docker)),
                    stub_mode: false,
                }
            }
            Err(e) => {
                panic!("failed to connect to docker socket: {}", e);
            }
        }
    }

    /// creates a new manager in stub mode
    pub fn new_stub() -> Self {
        warn!("docker container manager running in stub mode");
        Self {
            docker: None,
            stub_mode: true,
        }
    }

    /// returns true if running in stub mode
    pub fn is_stub(&self) -> bool {
        self.stub_mode
    }

    /// gets the docker client (panics if in stub mode)
    fn client(&self) -> &Docker {
        self.docker
            .as_ref()
            .expect("docker client not available in stub mode")
    }

    /// starts an interactive exec session inside a running container
    pub async fn start_exec_session(
        &self,
        id: &str,
        command: Vec<String>,
        cols: u16,
        rows: u16,
    ) -> Result<DockerExecSession> {
        info!(id = %id, command = ?command, "starting exec session");

        if self.stub_mode {
            return Err(ClientError::Operation(
                "container exec is not available in stub mode".to_string(),
            ));
        }

        let exec_options = CreateExecOptions {
            attach_stdin: Some(true),
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            tty: Some(true),
            cmd: Some(command),
            ..Default::default()
        };

        let exec =
            self.client()
                .create_exec(id, exec_options)
                .await
                .map_err(|e| {
                    ClientError::Operation(format!("create exec failed: {}", e))
                })?;

        let start_options = StartExecOptions {
            detach: false,
            tty: true,
            output_capacity: Some(32 * 1024),
        };

        match self
            .client()
            .start_exec(&exec.id, Some(start_options))
            .await
        {
            Ok(StartExecResults::Attached { output, input }) => {
                self.resize_exec(&exec.id, cols, rows).await?;

                let output = output.map(|result| match result {
                    Ok(message) => Ok(message.into_bytes().to_vec()),
                    Err(error) => Err(ClientError::Operation(format!(
                        "exec stream failed: {}",
                        error
                    ))),
                });

                Ok(DockerExecSession {
                    exec_id: exec.id,
                    output: Box::pin(output),
                    input,
                })
            }
            Ok(StartExecResults::Detached) => Err(ClientError::Operation(
                "exec session detached unexpectedly".to_string(),
            )),
            Err(e) => {
                Err(ClientError::Operation(format!("start exec failed: {}", e)))
            }
        }
    }

    /// resizes an interactive exec session
    pub async fn resize_exec(
        &self,
        exec_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        if self.stub_mode {
            return Ok(());
        }

        self.client()
            .resize_exec(
                exec_id,
                ResizeExecOptions {
                    width: cols,
                    height: rows,
                },
            )
            .await
            .map_err(|e| {
                ClientError::Operation(format!("resize exec failed: {}", e))
            })?;

        Ok(())
    }

    /// creates and starts a new container
    pub async fn create_container(
        &self,
        config: DockerContainerConfig,
    ) -> Result<DockerContainerInfo> {
        info!(id = %config.id, image = %config.image, "creating docker container");

        if self.stub_mode {
            return Ok(DockerContainerInfo {
                id: config.id,
                image: config.image,
                status: DockerContainerStatus {
                    running: true,
                    container_id: Some("stub-container-id".to_string()),
                },
            });
        }

        // build environment variables
        let env: Vec<String> = config
            .env_vars
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect();

        // build restart policy
        let restart_policy = match config.restart_policy.as_str() {
            "no" => Some(RestartPolicy {
                name: Some(RestartPolicyNameEnum::NO),
                maximum_retry_count: None,
            }),
            "always" => Some(RestartPolicy {
                name: Some(RestartPolicyNameEnum::ALWAYS),
                maximum_retry_count: None,
            }),
            "on-failure" => Some(RestartPolicy {
                name: Some(RestartPolicyNameEnum::ON_FAILURE),
                maximum_retry_count: None,
            }),
            "unless-stopped" => Some(RestartPolicy {
                name: Some(RestartPolicyNameEnum::UNLESS_STOPPED),
                maximum_retry_count: None,
            }),
            _ => Some(RestartPolicy {
                name: Some(RestartPolicyNameEnum::UNLESS_STOPPED),
                maximum_retry_count: None,
            }),
        };

        // build host config
        let host_config = HostConfig {
            memory: config.memory_limit.map(|m| m as i64),
            nano_cpus: config.cpu_limit.map(|c| (c * 1_000_000_000.0) as i64),
            restart_policy,
            network_mode: config
                .network
                .as_ref()
                .map(|network| network.name.clone()),
            mounts: Some(
                config
                    .mounts
                    .iter()
                    .map(|mount| Mount {
                        target: Some(mount.target.clone()),
                        source: Some(mount.source.clone()),
                        read_only: Some(mount.read_only),
                        typ: Some(MountTypeEnum::BIND),
                        ..Default::default()
                    })
                    .collect(),
            ),
            ..Default::default()
        };

        let networking_config =
            config.network.as_ref().map(build_networking_config);

        // add health check if configured
        let healthcheck = config.health_check.as_ref().map(|hc| {
            bollard::models::HealthConfig {
                test: Some(vec!["CMD-SHELL".to_string(), hc.cmd.join(" ")]),
                interval: Some((hc.interval_secs as i64) * 1_000_000_000),
                timeout: Some((hc.timeout_secs as i64) * 1_000_000_000),
                retries: Some(hc.retries as i64),
                start_period: None,
                start_interval: None,
            }
        });

        let exposed_ports =
            build_exposed_ports(config.port, &config.additional_ports);

        let container_config = ContainerCreateBody {
            image: Some(config.image.clone()),
            hostname: Some(build_container_hostname(&config.id)),
            env: Some(env),
            exposed_ports: if exposed_ports.is_empty() {
                None
            } else {
                Some(exposed_ports)
            },
            cmd: config.command,
            working_dir: config.working_dir,
            entrypoint: config.entrypoint,
            labels: Some(HashMap::from([(
                "containr".to_string(),
                "true".to_string(),
            )])),
            host_config: Some(host_config),
            networking_config,
            healthcheck,
            ..Default::default()
        };

        let options = CreateContainerOptions {
            name: Some(config.id.to_string()),
            ..Default::default()
        };

        // create container
        let response = self
            .client()
            .create_container(Some(options), container_config)
            .await
            .map_err(|e| {
                ClientError::Operation(format!("docker create failed: {}", e))
            })?;

        let container_id = response.id.clone();

        // attach extra networks before start to avoid restart-time races for short-lived containers
        for network in &config.additional_networks {
            self.client()
                .connect_network(
                    &network.name,
                    NetworkConnectRequest {
                        container: container_id.clone(),
                        endpoint_config: Some(build_endpoint_settings(
                            &network.aliases,
                        )),
                    },
                )
                .await
                .map_err(|e| {
                    ClientError::Operation(format!(
                        "docker network connect failed for {}: {}",
                        network.name, e
                    ))
                })?;
        }

        // start container
        self.client()
            .start_container(&container_id, None::<StartContainerOptions>)
            .await
            .map_err(|e| {
                ClientError::Operation(format!("docker start failed: {}", e))
            })?;

        info!(id = %config.id, container_id = %container_id, "docker container started");

        Ok(DockerContainerInfo {
            id: config.id,
            image: config.image,
            status: DockerContainerStatus {
                running: true,
                container_id: Some(container_id),
            },
        })
    }

    /// stops a running container
    pub async fn stop_container(&self, id: &str) -> Result<()> {
        info!(id = %id, "stopping docker container");

        if self.stub_mode {
            return Ok(());
        }

        let options = StopContainerOptions {
            t: Some(10),
            ..Default::default()
        };

        if let Err(e) = self.client().stop_container(id, Some(options)).await {
            warn!(id = %id, error = %e, "docker stop failed (container may not exist)");
        }

        Ok(())
    }

    /// removes a container
    pub async fn remove_container(&self, id: &str) -> Result<()> {
        info!(id = %id, "removing docker container");

        if self.stub_mode {
            return Ok(());
        }

        // stop first
        let _ = self.stop_container(id).await;

        let options = RemoveContainerOptions {
            force: true,
            ..Default::default()
        };

        if let Err(e) = self.client().remove_container(id, Some(options)).await
        {
            warn!(id = %id, error = %e, "docker rm failed (container may not exist)");
        }

        Ok(())
    }

    /// gets logs from a container
    pub async fn get_logs(&self, id: &str, tail: usize) -> Result<String> {
        if self.stub_mode {
            return Ok(format!(
                "[stub] container {} logs would appear here",
                id
            ));
        }

        let options = LogsOptions {
            follow: false,
            stdout: true,
            stderr: true,
            tail: tail.to_string(),
            ..Default::default()
        };

        let mut stream = self.client().logs(id, Some(options));
        let mut logs = String::new();

        while let Some(result) = stream.next().await {
            match result {
                Ok(output) => logs.push_str(&output.to_string()),
                Err(e) => {
                    error!(id = %id, error = %e, "error reading logs");
                    break;
                }
            }
        }

        Ok(logs)
    }

    /// gets basic stats for a container
    pub async fn get_stats(&self, id: &str) -> Result<DockerContainerStats> {
        if self.stub_mode {
            return Ok(DockerContainerStats {
                cpu_percent: 0.0,
                mem_usage_bytes: 0,
                mem_limit_bytes: 0,
            });
        }

        let options = StatsOptions {
            stream: false,
            one_shot: true,
        };

        let mut stream = self.client().stats(id, Some(options));

        if let Some(result) = stream.next().await {
            match result {
                Ok(stats) => {
                    // calculate cpu percent - need to unwrap the option types
                    let cpu_stats = match stats.cpu_stats {
                        Some(cs) => cs,
                        None => {
                            return Ok(DockerContainerStats {
                                cpu_percent: 0.0,
                                mem_usage_bytes: 0,
                                mem_limit_bytes: 0,
                            });
                        }
                    };

                    let precpu_stats = stats.precpu_stats.unwrap_or_default();

                    let cpu_usage = cpu_stats
                        .cpu_usage
                        .as_ref()
                        .and_then(|u| u.total_usage)
                        .unwrap_or(0);
                    let precpu_usage = precpu_stats
                        .cpu_usage
                        .as_ref()
                        .and_then(|u| u.total_usage)
                        .unwrap_or(0);
                    let cpu_delta = cpu_usage.saturating_sub(precpu_usage);

                    let system_delta =
                        cpu_stats.system_cpu_usage.unwrap_or(0).saturating_sub(
                            precpu_stats.system_cpu_usage.unwrap_or(0),
                        );

                    let cpu_percent = if system_delta > 0 && cpu_delta > 0 {
                        let num_cpus =
                            cpu_stats.online_cpus.unwrap_or(1) as f64;
                        (cpu_delta as f64 / system_delta as f64)
                            * num_cpus
                            * 100.0
                    } else {
                        0.0
                    };

                    let memory_stats = stats.memory_stats.unwrap_or_default();
                    let mem_usage = memory_stats.usage.unwrap_or(0);
                    let mem_limit = memory_stats.limit.unwrap_or(0);

                    return Ok(DockerContainerStats {
                        cpu_percent,
                        mem_usage_bytes: mem_usage,
                        mem_limit_bytes: mem_limit,
                    });
                }
                Err(e) => {
                    return Err(ClientError::Operation(format!(
                        "docker stats failed: {}",
                        e
                    )));
                }
            }
        }

        Err(ClientError::Operation("no stats returned".to_string()))
    }

    /// checks if a container is running
    pub async fn is_running(&self, id: &str) -> Result<bool> {
        if self.stub_mode {
            return Ok(true);
        }

        match self
            .client()
            .inspect_container(id, None::<InspectContainerOptions>)
            .await
        {
            Ok(inspect) => {
                let running =
                    inspect.state.and_then(|s| s.running).unwrap_or(false);
                Ok(running)
            }
            Err(_) => Ok(false),
        }
    }

    /// lists all containr containers
    pub async fn list_containers(&self) -> Result<Vec<DockerContainerInfo>> {
        if self.stub_mode {
            return Ok(vec![]);
        }

        let mut filters = HashMap::new();
        filters.insert("name", vec!["containr-"]);

        let options = ListContainersOptions {
            all: true,
            filters: Some(
                filters
                    .into_iter()
                    .map(|(k, v)| {
                        (
                            k.to_string(),
                            v.into_iter().map(|s| s.to_string()).collect(),
                        )
                    })
                    .collect(),
            ),
            ..Default::default()
        };

        let containers =
            self.client().list_containers(Some(options)).await.map_err(
                |e| ClientError::Operation(format!("docker ps failed: {}", e)),
            )?;

        let infos: Vec<DockerContainerInfo> = containers
            .into_iter()
            .map(|c| {
                let id = c
                    .names
                    .as_ref()
                    .and_then(|names| names.first())
                    .map(|n| n.trim_start_matches('/').to_string())
                    .unwrap_or_default();
                let image = c.image.unwrap_or_default();
                let running =
                    matches!(c.state, Some(ContainerSummaryStateEnum::RUNNING));
                let container_id = c.id.clone();

                DockerContainerInfo {
                    id,
                    image,
                    status: DockerContainerStatus {
                        running,
                        container_id,
                    },
                }
            })
            .collect();

        Ok(infos)
    }

    /// gets container state info
    pub async fn get_state(&self, id: &str) -> Result<DockerContainerState> {
        if self.stub_mode {
            return Ok(DockerContainerState {
                status: "running".to_string(),
                health_status: Some("healthy".to_string()),
                started_at: None,
                finished_at: None,
                restart_count: 0,
            });
        }

        let inspect = self
            .client()
            .inspect_container(id, None::<InspectContainerOptions>)
            .await
            .map_err(|e| {
                ClientError::Operation(format!("docker inspect failed: {}", e))
            })?;

        let state = inspect.state.unwrap_or_default();

        let status = state
            .status
            .map(|s| match s {
                ContainerStateStatusEnum::CREATED => "created",
                ContainerStateStatusEnum::RUNNING => "running",
                ContainerStateStatusEnum::PAUSED => "paused",
                ContainerStateStatusEnum::RESTARTING => "restarting",
                ContainerStateStatusEnum::REMOVING => "removing",
                ContainerStateStatusEnum::EXITED => "exited",
                ContainerStateStatusEnum::DEAD => "dead",
                ContainerStateStatusEnum::EMPTY => "empty",
            })
            .unwrap_or("unknown")
            .to_string();

        let health_status = state.health.and_then(|h| {
            h.status.map(|s| match s {
                HealthStatusEnum::NONE => "none".to_string(),
                HealthStatusEnum::STARTING => "starting".to_string(),
                HealthStatusEnum::HEALTHY => "healthy".to_string(),
                HealthStatusEnum::UNHEALTHY => "unhealthy".to_string(),
                HealthStatusEnum::EMPTY => "".to_string(),
            })
        });

        let restart_count = inspect.restart_count.unwrap_or(0) as u64;

        Ok(DockerContainerState {
            status,
            health_status,
            started_at: state.started_at,
            finished_at: state.finished_at,
            restart_count,
        })
    }

    /// lists mounts for a container
    pub async fn list_mounts(&self, id: &str) -> Result<Vec<DockerMountInfo>> {
        if self.stub_mode {
            return Ok(vec![]);
        }

        let inspect = self
            .client()
            .inspect_container(id, None::<InspectContainerOptions>)
            .await
            .map_err(|e| {
                ClientError::Operation(format!("docker inspect failed: {}", e))
            })?;

        let mounts: Vec<DockerMountInfo> = inspect
            .mounts
            .unwrap_or_default()
            .into_iter()
            .map(|m| DockerMountInfo {
                mount_type: m
                    .typ
                    .map(|t| format!("{:?}", t))
                    .unwrap_or_default(),
                source: m.source.unwrap_or_default(),
                destination: m.destination.unwrap_or_default(),
                name: m.name,
                rw: m.rw,
            })
            .collect();

        Ok(mounts)
    }

    /// creates a docker network for an app
    pub async fn create_network(&self, name: &str) -> Result<()> {
        info!(network = %name, "creating docker network");

        if self.stub_mode {
            return Ok(());
        }

        let options = NetworkCreateRequest {
            name: name.to_string(),
            driver: Some("bridge".to_string()),
            ..Default::default()
        };

        match self.client().create_network(options).await {
            Ok(_) => Ok(()),
            Err(e) => {
                let err_str = e.to_string();
                // ignore "already exists" errors
                if err_str.contains("already exists") {
                    Ok(())
                } else {
                    Err(ClientError::Operation(format!(
                        "docker network create failed: {}",
                        e
                    )))
                }
            }
        }
    }

    /// removes a docker network
    pub async fn remove_network(&self, name: &str) -> Result<()> {
        info!(network = %name, "removing docker network");

        if self.stub_mode {
            return Ok(());
        }

        if let Err(e) = self.client().remove_network(name).await {
            warn!(network = %name, error = %e, "docker network rm failed");
        }

        Ok(())
    }

    /// checks if a container is healthy (returns true if no health check or healthy)
    pub async fn is_healthy(&self, id: &str) -> Result<bool> {
        if self.stub_mode {
            return Ok(true);
        }

        match self
            .client()
            .inspect_container(id, None::<InspectContainerOptions>)
            .await
        {
            Ok(inspect) => {
                let health_status =
                    inspect.state.and_then(|s| s.health).and_then(|h| h.status);

                match health_status {
                    Some(HealthStatusEnum::HEALTHY) => Ok(true),
                    Some(HealthStatusEnum::NONE) => Ok(true),
                    None => Ok(true), // no health check configured
                    _ => Ok(false),
                }
            }
            Err(_) => Ok(true), // container might not exist
        }
    }

    /// waits for a container to become healthy with timeout
    pub async fn wait_for_healthy(
        &self,
        id: &str,
        timeout_secs: u32,
    ) -> Result<bool> {
        if self.stub_mode {
            return Ok(true);
        }

        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(timeout_secs as u64);

        while start.elapsed() < timeout {
            if self.is_healthy(id).await? {
                return Ok(true);
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }

        Ok(false)
    }

    /// stops and removes multiple containers
    pub async fn stop_service_group(
        &self,
        container_ids: Vec<String>,
    ) -> Result<()> {
        for id in container_ids {
            let _ = self.stop_container(&id).await;
            let _ = self.remove_container(&id).await;
        }
        Ok(())
    }

    /// inspects a container and returns its ip address on a given network
    pub async fn get_container_ip(
        &self,
        container_name: &str,
        network_name: &str,
    ) -> Option<String> {
        if self.stub_mode {
            return None;
        }

        match self
            .client()
            .inspect_container(container_name, None::<InspectContainerOptions>)
            .await
        {
            Ok(inspect) => {
                let networks =
                    inspect.network_settings.and_then(|ns| ns.networks)?;

                // try specific network first
                if let Some(network) = networks.get(network_name) {
                    if let Some(ip) = &network.ip_address {
                        if !ip.is_empty() {
                            return Some(ip.clone());
                        }
                    }
                }

                // fallback: return first available ip
                for (_, network) in networks {
                    if let Some(ip) = network.ip_address {
                        if !ip.is_empty() {
                            return Some(ip);
                        }
                    }
                }

                None
            }
            Err(_) => None,
        }
    }
}

fn build_networking_config(
    network: &DockerNetworkAttachment,
) -> NetworkingConfig {
    NetworkingConfig {
        endpoints_config: Some(HashMap::from([(
            network.name.clone(),
            build_endpoint_settings(&network.aliases),
        )])),
    }
}

fn build_exposed_ports(
    primary_port: u16,
    additional_ports: &[u16],
) -> Vec<String> {
    let mut ports = Vec::with_capacity(
        additional_ports.len() + usize::from(primary_port > 0),
    );
    if primary_port > 0 {
        ports.push(format!("{}/tcp", primary_port));
    }
    ports.extend(additional_ports.iter().map(|port| format!("{}/tcp", port)));
    ports
}

fn build_endpoint_settings(aliases: &[String]) -> EndpointSettings {
    let aliases = aliases
        .iter()
        .map(|alias| alias.trim())
        .filter(|alias| !alias.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    EndpointSettings {
        aliases: if aliases.is_empty() {
            None
        } else {
            Some(aliases)
        },
        ..Default::default()
    }
}

fn build_container_hostname(id: &str) -> String {
    let mut hostname = String::with_capacity(id.len().min(63));

    for ch in id.chars() {
        let normalized = if ch.is_ascii_alphanumeric() {
            ch.to_ascii_lowercase()
        } else {
            '-'
        };

        if normalized == '-' && hostname.ends_with('-') {
            continue;
        }

        hostname.push(normalized);

        if hostname.len() >= 63 {
            break;
        }
    }

    while hostname.ends_with('-') {
        hostname.pop();
    }

    let hostname = hostname.trim_start_matches('-').to_string();
    if hostname.is_empty() {
        "containr".to_string()
    } else {
        hostname
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stub_mode_returns_safe_defaults() {
        let manager = DockerContainerManager::new_stub();
        assert!(manager.is_stub());

        let stats = manager.get_stats("stub").await.unwrap();
        assert_eq!(stats.cpu_percent, 0.0);
        assert_eq!(stats.mem_usage_bytes, 0);
        assert_eq!(stats.mem_limit_bytes, 0);

        assert!(manager.list_containers().await.unwrap().is_empty());
        assert!(manager.is_running("stub").await.unwrap());
        assert!(manager.is_healthy("stub").await.unwrap());
        assert!(manager.wait_for_healthy("stub", 1).await.unwrap());

        let state = manager.get_state("stub").await.unwrap();
        assert_eq!(state.status, "running");
        assert_eq!(state.health_status, Some("healthy".to_string()));
    }

    #[test]
    fn build_container_hostname_sanitizes_and_truncates() {
        let hostname = build_container_hostname(
            "containr-12345678-service_WITH spaces-and-a-name-that-is-far-too-long-for-linux-hostnames",
        );

        assert!(hostname.starts_with("containr-12345678-service-with-spaces"));
        assert!(hostname.len() <= 63);
        assert!(!hostname.contains('_'));
    }
}

impl Default for DockerContainerManager {
    fn default() -> Self {
        Self::new()
    }
}
