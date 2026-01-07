//! container management
//!
//! high-level api for container lifecycle operations using containerd.

use std::collections::HashMap;
use tracing::{error, info, warn};

use crate::client::{ClientError, ContainerdClient, Result};

/// container configuration for creation
#[derive(Debug, Clone)]
pub struct ContainerConfig {
    pub id: String,
    pub image: String,
    pub env_vars: HashMap<String, String>,
    pub port: u16,
    pub memory_limit: Option<u64>,
    pub cpu_limit: Option<f64>,
}

/// container status information
#[derive(Debug, Clone)]
pub struct ContainerStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
}

/// container information
#[derive(Debug, Clone)]
pub struct ContainerInfo {
    pub id: String,
    pub image: String,
    pub status: ContainerStatus,
    pub labels: HashMap<String, String>,
}

/// manages container lifecycle operations
#[derive(Clone)]
pub struct ContainerManager {
    client: Option<ContainerdClient>,
    stub_mode: bool,
}

impl ContainerManager {
    /// creates a new container manager with a containerd client
    pub fn new(client: ContainerdClient) -> Self {
        Self {
            client: Some(client),
            stub_mode: false,
        }
    }

    /// creates a new container manager in stub mode (for development)
    pub fn new_stub() -> Self {
        warn!("container manager running in stub mode");
        Self {
            client: None,
            stub_mode: true,
        }
    }

    /// returns true if running in stub mode
    pub fn is_stub(&self) -> bool {
        self.stub_mode
    }

    /// creates a new container
    pub async fn create_container(&self, config: ContainerConfig) -> Result<ContainerInfo> {
        info!(id = %config.id, image = %config.image, "creating container");

        if self.stub_mode {
            // stub implementation
            return Ok(ContainerInfo {
                id: config.id,
                image: config.image,
                status: ContainerStatus {
                    running: true,
                    pid: Some(12345),
                    exit_code: None,
                },
                labels: HashMap::new(),
            });
        }

        let client = self.client.as_ref().ok_or_else(|| {
            ClientError::Operation("no containerd client".to_string())
        })?;

        // prepare labels
        let mut labels = HashMap::new();
        labels.insert("znskr.port".to_string(), config.port.to_string());
        for (k, v) in &config.env_vars {
            labels.insert(format!("znskr.env.{}", k), v.clone());
        }
        if let Some(mem) = config.memory_limit {
            labels.insert("znskr.memory".to_string(), mem.to_string());
        }
        if let Some(cpu) = config.cpu_limit {
            labels.insert("znskr.cpu".to_string(), cpu.to_string());
        }

        // create container
        let container = client
            .create_container(&config.id, &config.image, labels.clone())
            .await?;

        // create and start task
        let pid = client.create_task(&config.id).await?;
        client.start_task(&config.id).await?;

        info!(id = %config.id, pid = %pid, "container started");

        Ok(ContainerInfo {
            id: container.id,
            image: container.image,
            status: ContainerStatus {
                running: true,
                pid: Some(pid),
                exit_code: None,
            },
            labels,
        })
    }

    /// stops a running container
    pub async fn stop_container(&self, id: &str) -> Result<()> {
        info!(id = %id, "stopping container");

        if self.stub_mode {
            return Ok(());
        }

        let client = self.client.as_ref().ok_or_else(|| {
            ClientError::Operation("no containerd client".to_string())
        })?;

        // kill the task with sigterm (15)
        match client.kill_task(id, 15).await {
            Ok(_) => {
                // wait a bit then delete
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                let _ = client.delete_task(id).await;
            }
            Err(e) => {
                warn!(id = %id, error = %e, "failed to kill task, trying force delete");
                let _ = client.delete_task(id).await;
            }
        }

        Ok(())
    }

    /// removes a container
    pub async fn remove_container(&self, id: &str) -> Result<()> {
        info!(id = %id, "removing container");

        if self.stub_mode {
            return Ok(());
        }

        let client = self.client.as_ref().ok_or_else(|| {
            ClientError::Operation("no containerd client".to_string())
        })?;

        // stop task first if running
        let _ = self.stop_container(id).await;

        // delete container
        client.delete_container(id).await?;

        Ok(())
    }

    /// gets the status of a container
    pub async fn get_status(&self, id: &str) -> Result<ContainerStatus> {
        if self.stub_mode {
            return Ok(ContainerStatus {
                running: true,
                pid: Some(12345),
                exit_code: None,
            });
        }

        let client = self.client.as_ref().ok_or_else(|| {
            ClientError::Operation("no containerd client".to_string())
        })?;

        // check if container exists
        let _container = client.get_container(id).await?;

        // for now, if container exists, assume running
        // full implementation would check task status
        Ok(ContainerStatus {
            running: true,
            pid: None,
            exit_code: None,
        })
    }

    /// lists all containers
    pub async fn list_containers(&self) -> Result<Vec<ContainerInfo>> {
        if self.stub_mode {
            return Ok(vec![]);
        }

        let client = self.client.as_ref().ok_or_else(|| {
            ClientError::Operation("no containerd client".to_string())
        })?;

        let containers = client.list_containers().await?;

        Ok(containers
            .into_iter()
            .map(|c| ContainerInfo {
                id: c.id,
                image: c.image,
                status: ContainerStatus {
                    running: true,
                    pid: None,
                    exit_code: None,
                },
                labels: c.labels,
            })
            .collect())
    }

    /// gets logs from a container (stub - containerd doesn't store logs)
    pub async fn get_logs(&self, id: &str, _tail: usize) -> Result<String> {
        if self.stub_mode {
            return Ok(format!("[stub] container {} logs would appear here", id));
        }

        // containerd doesn't store logs - need to collect from task stdio
        // for production, integrate with a log aggregator
        Ok(format!("logs for container {} - use external log collection", id))
    }
}
