//! Docker-based container management
//!
//! Simple container operations using Docker CLI as a fallback
//! when containerd task creation is not yet fully implemented.

use std::collections::HashMap;
use std::process::Command;
use tracing::{info, warn};

use crate::client::{ClientError, Result};

/// Container configuration for Docker
#[derive(Debug, Clone)]
pub struct DockerContainerConfig {
    pub id: String,
    pub image: String,
    pub env_vars: HashMap<String, String>,
    pub port: u16,
    pub memory_limit: Option<u64>,
    pub cpu_limit: Option<f64>,
}

/// Docker container status
#[derive(Debug, Clone)]
pub struct DockerContainerStatus {
    pub running: bool,
    pub container_id: Option<String>,
}

/// Docker container info
#[derive(Debug, Clone)]
pub struct DockerContainerInfo {
    pub id: String,
    pub image: String,
    pub status: DockerContainerStatus,
}

/// manages container lifecycle using Docker CLI
#[derive(Clone)]
pub struct DockerContainerManager {
    stub_mode: bool,
}

impl DockerContainerManager {
    /// creates a new Docker container manager
    pub fn new() -> Self {
        if which::which("docker").is_err() {
            warn!("docker not found - running in stub mode");
            return Self { stub_mode: true };
        }
        Self { stub_mode: false }
    }

    /// creates a new manager in stub mode
    pub fn new_stub() -> Self {
        warn!("docker container manager running in stub mode");
        Self { stub_mode: true }
    }

    /// returns true if running in stub mode
    pub fn is_stub(&self) -> bool {
        self.stub_mode
    }

    /// creates and starts a new container
    pub async fn create_container(&self, config: DockerContainerConfig) -> Result<DockerContainerInfo> {
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

        // Build docker run command
        let mut args = vec![
            "run".to_string(),
            "-d".to_string(),
            "--name".to_string(),
            config.id.clone(),
            "--restart".to_string(),
            "unless-stopped".to_string(),
        ];

        // Add port mapping - use 0 for host port to let Docker pick an available port
        // The container port stays fixed, proxy will route to the container via Docker network
        args.push("-p".to_string());
        args.push(format!("0:{}", config.port));

        // Add environment variables
        for (key, value) in &config.env_vars {
            args.push("-e".to_string());
            args.push(format!("{}={}", key, value));
        }

        // Add memory limit
        if let Some(mem) = config.memory_limit {
            args.push("-m".to_string());
            args.push(format!("{}b", mem));
        }

        // Add CPU limit
        if let Some(cpu) = config.cpu_limit {
            args.push("--cpus".to_string());
            args.push(format!("{:.2}", cpu));
        }

        // Add image
        args.push(config.image.clone());

        let output = Command::new("docker")
            .args(&args)
            .output()
            .map_err(|e| ClientError::Operation(format!("docker run failed: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ClientError::Operation(format!("docker run failed: {}", stderr)));
        }

        let container_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
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

        let output = Command::new("docker")
            .args(["stop", id])
            .output()
            .map_err(|e| ClientError::Operation(format!("docker stop failed: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!(id = %id, error = %stderr, "docker stop failed (container may not exist)");
        }

        Ok(())
    }

    /// removes a container
    pub async fn remove_container(&self, id: &str) -> Result<()> {
        info!(id = %id, "removing docker container");

        if self.stub_mode {
            return Ok(());
        }

        // Stop first
        let _ = self.stop_container(id).await;

        let output = Command::new("docker")
            .args(["rm", "-f", id])
            .output()
            .map_err(|e| ClientError::Operation(format!("docker rm failed: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!(id = %id, error = %stderr, "docker rm failed (container may not exist)");
        }

        Ok(())
    }

    /// gets logs from a container
    pub async fn get_logs(&self, id: &str, tail: usize) -> Result<String> {
        if self.stub_mode {
            return Ok(format!("[stub] container {} logs would appear here", id));
        }

        let output = Command::new("docker")
            .args(["logs", "--tail", &tail.to_string(), id])
            .output()
            .map_err(|e| ClientError::Operation(format!("docker logs failed: {}", e)))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        
        Ok(format!("{}{}", stdout, stderr))
    }

    /// checks if a container is running
    pub async fn is_running(&self, id: &str) -> Result<bool> {
        if self.stub_mode {
            return Ok(true);
        }

        let output = Command::new("docker")
            .args(["inspect", "-f", "{{.State.Running}}", id])
            .output()
            .map_err(|e| ClientError::Operation(format!("docker inspect failed: {}", e)))?;

        if !output.status.success() {
            return Ok(false);
        }

        let running = String::from_utf8_lossy(&output.stdout).trim() == "true";
        Ok(running)
    }

    /// lists all znskr containers
    pub async fn list_containers(&self) -> Result<Vec<DockerContainerInfo>> {
        if self.stub_mode {
            return Ok(vec![]);
        }

        let output = Command::new("docker")
            .args(["ps", "-a", "--filter", "name=znskr-", "--format", "{{.Names}}|{{.Image}}|{{.Status}}"])
            .output()
            .map_err(|e| ClientError::Operation(format!("docker ps failed: {}", e)))?;

        if !output.status.success() {
            return Ok(vec![]);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let containers: Vec<DockerContainerInfo> = stdout
            .lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.split('|').collect();
                if parts.len() >= 3 {
                    Some(DockerContainerInfo {
                        id: parts[0].to_string(),
                        image: parts[1].to_string(),
                        status: DockerContainerStatus {
                            running: parts[2].starts_with("Up"),
                            container_id: Some(parts[0].to_string()),
                        },
                    })
                } else {
                    None
                }
            })
            .collect();

        Ok(containers)
    }
}

impl Default for DockerContainerManager {
    fn default() -> Self {
        Self::new()
    }
}
