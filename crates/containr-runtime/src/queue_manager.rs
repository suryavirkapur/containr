//! managed queue container orchestration
//!
//! handles starting, stopping, and managing queue containers
//! with bind mount storage for data persistence using bollard.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use bollard::models::{
    ContainerCreateBody, EndpointSettings, HealthStatusEnum, HostConfig, Mount, MountTypeEnum,
    NetworkCreateRequest, NetworkingConfig, RestartPolicy, RestartPolicyNameEnum,
};
use bollard::query_parameters::{
    CreateContainerOptions, InspectContainerOptions, InspectNetworkOptions, RemoveContainerOptions,
    StartContainerOptions, StopContainerOptions,
};
use bollard::Docker;
use tracing::{info, warn};

use crate::docker::INTERNAL_NETWORK_NAME;
use crate::error::{ClientError, Result};
use crate::ImageManager;
use containr_common::managed_services::{ManagedQueue, QueueType, ServiceStatus};

/// manages queue container lifecycle
pub struct QueueManager {
    docker: Arc<Docker>,
}

impl QueueManager {
    /// creates a new queue manager
    /// panics if unable to connect to docker socket
    pub fn new() -> Self {
        match Docker::connect_with_socket_defaults() {
            Ok(docker) => Self {
                docker: Arc::new(docker),
            },
            Err(e) => {
                panic!("failed to connect to docker socket: {}", e);
            }
        }
    }

    /// starts a managed queue container
    /// creates the data directory and runs the container with bind mount
    pub async fn start_queue(&self, queue: &mut ManagedQueue) -> Result<String> {
        info!(
            "starting queue: {} ({})",
            queue.name,
            queue.queue_type.docker_image(&queue.version)
        );
        self.ensure_image(&queue.docker_image()).await?;

        // create data directory
        let data_path = Path::new(&queue.host_data_path);
        if !data_path.exists() {
            info!("creating data directory: {}", queue.host_data_path);
            std::fs::create_dir_all(data_path).map_err(|e| {
                ClientError::Operation(format!("failed to create data directory: {}", e))
            })?;

            // set permissions (755)
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let perms = std::fs::Permissions::from_mode(0o755);
                std::fs::set_permissions(data_path, perms).ok();
            }
        }

        // container name
        let container_name = format!("containr-queue-{}", queue.id);
        queue.internal_host = queue.normalized_internal_host();

        // ensure network exists
        self.ensure_network(INTERNAL_NETWORK_NAME).await?;

        // build environment variables
        let mut env = Vec::new();
        match queue.queue_type {
            QueueType::Rabbitmq => {
                env.push(format!(
                    "RABBITMQ_DEFAULT_USER={}",
                    queue.credentials.username
                ));
                env.push(format!(
                    "RABBITMQ_DEFAULT_PASS={}",
                    queue.credentials.password
                ));
            }
            QueueType::Nats => {}
        }

        // build labels
        let mut labels = HashMap::new();
        labels.insert("containr.type".to_string(), "managed-queue".to_string());
        labels.insert("containr.queue.id".to_string(), queue.id.to_string());
        labels.insert(
            "containr.queue.type".to_string(),
            format!("{:?}", queue.queue_type).to_lowercase(),
        );

        // build mount using queue_type.volume_path()
        let mount = Mount {
            target: Some(queue.queue_type.volume_path().to_string()),
            source: Some(queue.host_data_path.clone()),
            typ: Some(MountTypeEnum::BIND),
            ..Default::default()
        };

        // build health check for rabbitmq
        let healthcheck = match queue.queue_type {
            QueueType::Rabbitmq => Some(bollard::models::HealthConfig {
                test: Some(vec![
                    "CMD-SHELL".to_string(),
                    "rabbitmq-diagnostics -q ping".to_string(),
                ]),
                interval: Some(10_000_000_000), // 10s
                timeout: Some(5_000_000_000),   // 5s
                retries: Some(3),
                start_period: None,
                start_interval: None,
            }),
            QueueType::Nats => None,
        };

        let host_config = HostConfig {
            mounts: Some(vec![mount]),
            memory: Some((queue.memory_limit / (1024 * 1024)) as i64 * 1024 * 1024),
            nano_cpus: Some((queue.cpu_limit * 1_000_000_000.0) as i64),
            restart_policy: Some(RestartPolicy {
                name: Some(RestartPolicyNameEnum::UNLESS_STOPPED),
                maximum_retry_count: None,
            }),
            network_mode: Some(INTERNAL_NETWORK_NAME.to_string()),
            port_bindings: queue.external_port.map(|external_port| {
                HashMap::from([(
                    format!("{}/tcp", queue.port),
                    Some(vec![bollard::models::PortBinding {
                        host_ip: Some("0.0.0.0".to_string()),
                        host_port: Some(external_port.to_string()),
                    }]),
                )])
            }),
            ..Default::default()
        };

        let networking_config = Some(NetworkingConfig {
            endpoints_config: Some(HashMap::from([(
                INTERNAL_NETWORK_NAME.to_string(),
                EndpointSettings {
                    aliases: Some(queue.network_aliases()),
                    ..Default::default()
                },
            )])),
        });

        // build command args for nats
        let cmd = match queue.queue_type {
            QueueType::Nats => Some(vec![
                "-m".to_string(),
                "8222".to_string(),
                "-js".to_string(),
                "-sd".to_string(),
                "/data".to_string(),
                "--user".to_string(),
                queue.credentials.username.clone(),
                "--pass".to_string(),
                queue.credentials.password.clone(),
            ]),
            QueueType::Rabbitmq => None,
        };

        let container_config = ContainerCreateBody {
            image: Some(queue.docker_image()),
            env: Some(env),
            labels: Some(labels),
            hostname: Some(queue.normalized_internal_host()),
            host_config: Some(host_config),
            networking_config,
            healthcheck,
            cmd,
            ..Default::default()
        };

        let options = CreateContainerOptions {
            name: Some(container_name.clone()),
            ..Default::default()
        };

        info!("creating container: {}", container_name);

        // create container
        let response = self
            .docker
            .create_container(Some(options), container_config)
            .await
            .map_err(|e| ClientError::Operation(format!("docker create failed: {}", e)))?;

        let container_id = response.id.clone();

        // start container
        self.docker
            .start_container(&container_id, None::<StartContainerOptions>)
            .await
            .map_err(|e| ClientError::Operation(format!("docker start failed: {}", e)))?;

        if !self.wait_for_ready(&container_id, 90).await? {
            return Err(ClientError::Operation(
                "queue container did not become ready".to_string(),
            ));
        }

        // update queue record
        queue.container_id = Some(container_id.clone());
        queue.status = ServiceStatus::Running;
        queue.updated_at = chrono::Utc::now();

        info!("queue started: {} -> {}", queue.name, container_id);
        Ok(container_id)
    }

    async fn wait_for_ready(&self, container_id: &str, timeout_secs: u64) -> Result<bool> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);

        while std::time::Instant::now() < deadline {
            let inspect = match self
                .docker
                .inspect_container(container_id, None::<InspectContainerOptions>)
                .await
            {
                Ok(inspect) => inspect,
                Err(e) => {
                    return Err(ClientError::Operation(format!(
                        "docker inspect failed: {}",
                        e
                    )));
                }
            };

            let state = inspect.state.unwrap_or_default();
            let running = state.running.unwrap_or(false);
            let health_status = state.health.and_then(|health| health.status);

            let ready = match health_status {
                Some(HealthStatusEnum::HEALTHY) => true,
                Some(HealthStatusEnum::NONE) | None => running,
                _ => false,
            };

            if ready {
                return Ok(true);
            }

            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }

        Ok(false)
    }

    async fn ensure_image(&self, image: &str) -> Result<()> {
        let image_manager = ImageManager::new();
        if image_manager.image_exists(image).await? {
            return Ok(());
        }

        image_manager.pull_image(image).await?;
        Ok(())
    }

    /// ensures the infrastructure network exists
    async fn ensure_network(&self, name: &str) -> Result<()> {
        // check if network exists
        if self
            .docker
            .inspect_network(name, None::<InspectNetworkOptions>)
            .await
            .is_ok()
        {
            return Ok(());
        }

        info!("creating docker network: {}", name);

        let options = NetworkCreateRequest {
            name: name.to_string(),
            driver: Some("bridge".to_string()),
            ..Default::default()
        };

        match self.docker.create_network(options).await {
            Ok(_) => Ok(()),
            Err(e) => {
                let err_str = e.to_string();
                if err_str.contains("already exists") {
                    Ok(())
                } else {
                    warn!("failed to create network: {}", err_str);
                    Ok(())
                }
            }
        }
    }

    /// stops a managed queue container
    pub async fn stop_queue(&self, queue: &mut ManagedQueue) -> Result<()> {
        if let Some(ref container_id) = queue.container_id {
            info!("stopping queue: {} ({})", queue.name, container_id);

            let stop_options = StopContainerOptions {
                t: Some(10),
                ..Default::default()
            };
            let _ = self
                .docker
                .stop_container(container_id, Some(stop_options))
                .await;

            let rm_options = RemoveContainerOptions {
                force: true,
                ..Default::default()
            };
            let _ = self
                .docker
                .remove_container(container_id, Some(rm_options))
                .await;

            queue.container_id = None;
            queue.status = ServiceStatus::Stopped;
            queue.updated_at = chrono::Utc::now();
        }

        Ok(())
    }
}

impl Default for QueueManager {
    fn default() -> Self {
        Self::new()
    }
}
