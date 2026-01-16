//! Docker-based container management
//!
//! Simple container operations using Docker CLI.

use std::collections::HashMap;
use std::process::Command;
use tracing::{info, warn};

use crate::error::{ClientError, Result};
use serde::Deserialize;

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
    pub memory_limit: Option<u64>,
    pub cpu_limit: Option<f64>,
    /// docker network to attach to
    pub network: Option<String>,
    /// health check configuration
    pub health_check: Option<HealthCheckCommand>,
    /// restart policy ("no", "always", "on-failure", "unless-stopped")
    pub restart_policy: String,
}

/// Docker container status
#[derive(Debug, Clone)]
pub struct DockerContainerStatus {
    pub running: bool,
    pub container_id: Option<String>,
}

/// Docker container stats
#[derive(Debug, Clone)]
pub struct DockerContainerStats {
    pub cpu_percent: f64,
    pub mem_usage_bytes: u64,
    pub mem_limit_bytes: u64,
}

/// Docker container runtime state
#[derive(Debug, Clone)]
pub struct DockerContainerState {
    pub status: String,
    pub health_status: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub restart_count: u64,
}

/// Docker mount info
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

        // Build docker run command
        let mut args = vec![
            "run".to_string(),
            "-d".to_string(),
            "--name".to_string(),
            config.id.clone(),
            "--restart".to_string(),
            config.restart_policy.clone(),
        ];

        // attach to network if specified
        if let Some(ref network) = config.network {
            args.push("--network".to_string());
            args.push(network.clone());
        }

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

        // add health check if configured
        if let Some(ref hc) = config.health_check {
            args.push("--health-cmd".to_string());
            args.push(hc.cmd.join(" "));
            args.push("--health-interval".to_string());
            args.push(format!("{}s", hc.interval_secs));
            args.push("--health-timeout".to_string());
            args.push(format!("{}s", hc.timeout_secs));
            args.push("--health-retries".to_string());
            args.push(hc.retries.to_string());
        }

        // Add image
        args.push(config.image.clone());

        let output = Command::new("docker")
            .args(&args)
            .output()
            .map_err(|e| ClientError::Operation(format!("docker run failed: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ClientError::Operation(format!(
                "docker run failed: {}",
                stderr
            )));
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

    /// gets basic stats for a container
    pub async fn get_stats(&self, id: &str) -> Result<DockerContainerStats> {
        if self.stub_mode {
            return Ok(DockerContainerStats {
                cpu_percent: 0.0,
                mem_usage_bytes: 0,
                mem_limit_bytes: 0,
            });
        }

        let output = Command::new("docker")
            .args([
                "stats",
                "--no-stream",
                "--format",
                "{{.CPUPerc}}|{{.MemUsage}}",
                id,
            ])
            .output()
            .map_err(|e| ClientError::Operation(format!("docker stats failed: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ClientError::Operation(format!(
                "docker stats failed: {}",
                stderr
            )));
        }

        let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 2 {
            return Err(ClientError::Operation("unexpected stats format".to_string()));
        }

        let cpu_percent = parts[0]
            .trim()
            .trim_end_matches('%')
            .parse::<f64>()
            .unwrap_or(0.0);

        let mem_parts: Vec<&str> = parts[1].split('/').collect();
        let mem_usage = mem_parts.get(0).map(|s| s.trim()).unwrap_or("0B");
        let mem_limit = mem_parts.get(1).map(|s| s.trim()).unwrap_or("0B");

        Ok(DockerContainerStats {
            cpu_percent,
            mem_usage_bytes: parse_bytes(mem_usage),
            mem_limit_bytes: parse_bytes(mem_limit),
        })
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
            .args([
                "ps",
                "-a",
                "--filter",
                "name=znskr-",
                "--format",
                "{{.Names}}|{{.Image}}|{{.Status}}",
            ])
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

        let output = Command::new("docker")
            .args([
                "inspect",
                "-f",
                "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.StartedAt}}|{{.State.FinishedAt}}|{{.RestartCount}}",
                id,
            ])
            .output()
            .map_err(|e| ClientError::Operation(format!("docker inspect failed: {}", e)))?;

        if !output.status.success() {
            return Err(ClientError::Operation("docker inspect failed".to_string()));
        }

        let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 5 {
            return Err(ClientError::Operation("unexpected inspect format".to_string()));
        }

        let health_raw = parts[1].trim();
        let health_status = if health_raw.is_empty() || health_raw == "<no value>" {
            None
        } else {
            Some(health_raw.to_string())
        };

        Ok(DockerContainerState {
            status: parts[0].trim().to_string(),
            health_status,
            started_at: {
                let v = parts[2].trim();
                if v.is_empty() || v == "<no value>" { None } else { Some(v.to_string()) }
            },
            finished_at: {
                let v = parts[3].trim();
                if v.is_empty() || v == "<no value>" { None } else { Some(v.to_string()) }
            },
            restart_count: parts[4].trim().parse::<u64>().unwrap_or(0),
        })
    }

    /// lists mounts for a container
    pub async fn list_mounts(&self, id: &str) -> Result<Vec<DockerMountInfo>> {
        if self.stub_mode {
            return Ok(vec![]);
        }

        let output = Command::new("docker")
            .args(["inspect", "-f", "{{json .Mounts}}", id])
            .output()
            .map_err(|e| ClientError::Operation(format!("docker inspect failed: {}", e)))?;

        if !output.status.success() {
            return Err(ClientError::Operation("docker inspect failed".to_string()));
        }

        let mounts_json = String::from_utf8_lossy(&output.stdout);
        let mounts: Vec<DockerMountInfo> = serde_json::from_str(mounts_json.trim())
            .map_err(|e| ClientError::Operation(format!("failed to parse mounts: {}", e)))?;

        Ok(mounts)
    }

    /// creates a docker network for an app
    pub async fn create_network(&self, name: &str) -> Result<()> {
        info!(network = %name, "creating docker network");

        if self.stub_mode {
            return Ok(());
        }

        let output = Command::new("docker")
            .args(["network", "create", "--driver", "bridge", name])
            .output()
            .map_err(|e| ClientError::Operation(format!("docker network create failed: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // ignore "already exists" errors
            if !stderr.contains("already exists") {
                return Err(ClientError::Operation(format!(
                    "docker network create failed: {}",
                    stderr
                )));
            }
        }

        Ok(())
    }

    /// removes a docker network
    pub async fn remove_network(&self, name: &str) -> Result<()> {
        info!(network = %name, "removing docker network");

        if self.stub_mode {
            return Ok(());
        }

        let output = Command::new("docker")
            .args(["network", "rm", name])
            .output()
            .map_err(|e| ClientError::Operation(format!("docker network rm failed: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!(network = %name, error = %stderr, "docker network rm failed");
        }

        Ok(())
    }

    /// checks if a container is healthy (returns true if no health check or healthy)
    pub async fn is_healthy(&self, id: &str) -> Result<bool> {
        if self.stub_mode {
            return Ok(true);
        }

        let output = Command::new("docker")
            .args(["inspect", "-f", "{{.State.Health.Status}}", id])
            .output()
            .map_err(|e| ClientError::Operation(format!("docker inspect failed: {}", e)))?;

        if !output.status.success() {
            // container might not exist or have no health check
            return Ok(true);
        }

        let status = String::from_utf8_lossy(&output.stdout).trim().to_lowercase();
        // "healthy", "none" (no healthcheck), or empty means healthy
        Ok(status == "healthy" || status == "none" || status.is_empty())
    }

    /// waits for a container to become healthy with timeout
    pub async fn wait_for_healthy(&self, id: &str, timeout_secs: u32) -> Result<bool> {
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
    pub async fn stop_service_group(&self, container_ids: Vec<String>) -> Result<()> {
        for id in container_ids {
            let _ = self.stop_container(&id).await;
            let _ = self.remove_container(&id).await;
        }
        Ok(())
    }
}

fn parse_bytes(value: &str) -> u64 {
    let value = value.trim();
    if value.is_empty() {
        return 0;
    }

    let mut number = String::new();
    let mut unit = String::new();
    for ch in value.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            number.push(ch);
        } else if !ch.is_whitespace() {
            unit.push(ch);
        }
    }

    let parsed = number.parse::<f64>().unwrap_or(0.0);
    let multiplier = match unit.as_str() {
        "B" => 1.0,
        "KB" => 1_000.0,
        "MB" => 1_000_000.0,
        "GB" => 1_000_000_000.0,
        "TB" => 1_000_000_000_000.0,
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        "TiB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };

    (parsed * multiplier) as u64
}

#[cfg(test)]
mod tests {
    use super::parse_bytes;

    #[test]
    fn parse_bytes_supports_binary_units() {
        assert_eq!(parse_bytes("1KiB"), 1024);
        assert_eq!(parse_bytes("2MiB"), 2 * 1024 * 1024);
    }

    #[test]
    fn parse_bytes_supports_decimal_units() {
        assert_eq!(parse_bytes("1KB"), 1000);
        assert_eq!(parse_bytes("1GB"), 1_000_000_000);
    }

    #[test]
    fn parse_bytes_handles_empty() {
        assert_eq!(parse_bytes(""), 0);
    }
}

impl Default for DockerContainerManager {
    fn default() -> Self {
        Self::new()
    }
}
