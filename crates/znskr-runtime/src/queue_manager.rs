//! managed queue container orchestration
//!
//! handles starting, stopping, and managing queue containers
//! with bind mount storage for data persistence.

use std::path::Path;
use std::process::Command;
use tracing::{error, info, warn};

use crate::error::{ClientError, Result};
use znskr_common::managed_services::{ManagedQueue, QueueType, ServiceStatus};

/// manages queue container lifecycle
pub struct QueueManager;

impl QueueManager {
    /// creates a new queue manager
    pub fn new() -> Self {
        Self
    }

    /// starts a managed queue container
    /// creates the data directory and runs the container with bind mount
    pub fn start_queue(&self, queue: &mut ManagedQueue) -> Result<String> {
        info!(
            "starting queue: {} ({})",
            queue.name,
            queue.queue_type.docker_image(&queue.version)
        );

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
        let container_name = format!("znskr-queue-{}", queue.id);

        // ensure network exists
        self.ensure_network("znskr-infra")?;

        // build docker run command
        let mut args = vec![
            "run".to_string(),
            "-d".to_string(),
            "--name".to_string(),
            container_name.clone(),
            "-v".to_string(),
            queue.bind_mount_arg(),
            "-p".to_string(),
            format!("{}:{}", queue.port, queue.port),
            "--restart".to_string(),
            "unless-stopped".to_string(),
            "--memory".to_string(),
            format!("{}m", queue.memory_limit / (1024 * 1024)),
            "--cpus".to_string(),
            format!("{:.1}", queue.cpu_limit),
            "--network".to_string(),
            "znskr-infra".to_string(),
            "--hostname".to_string(),
            format!("queue-{}", queue.id),
            "--network-alias".to_string(),
            format!("queue-{}", queue.id),
        ];

        // add labels
        args.push("--label".to_string());
        args.push("znskr.type=managed-queue".to_string());
        args.push("--label".to_string());
        args.push(format!("znskr.queue.id={}", queue.id));
        args.push("--label".to_string());
        args.push(format!("znskr.queue.type={:?}", queue.queue_type).to_lowercase());

        // add environment variables or command flags
        match queue.queue_type {
            QueueType::Rabbitmq => {
                args.push("-e".to_string());
                args.push(format!(
                    "RABBITMQ_DEFAULT_USER={}",
                    queue.credentials.username
                ));
                args.push("-e".to_string());
                args.push(format!(
                    "RABBITMQ_DEFAULT_PASS={}",
                    queue.credentials.password
                ));

                // add health check
                args.push("--health-cmd".to_string());
                args.push("rabbitmq-diagnostics -q ping".to_string());
                args.push("--health-interval".to_string());
                args.push("10s".to_string());
                args.push("--health-timeout".to_string());
                args.push("5s".to_string());
                args.push("--health-retries".to_string());
                args.push("3".to_string());
            }
            QueueType::Nats => {}
        }

        // add image
        args.push(queue.docker_image());

        // add command args for nats auth/monitoring
        if queue.queue_type == QueueType::Nats {
            args.push("-m".to_string());
            args.push("8222".to_string());
            args.push("-js".to_string());
            args.push("-sd".to_string());
            args.push("/data".to_string());
            args.push("--user".to_string());
            args.push(queue.credentials.username.clone());
            args.push("--pass".to_string());
            args.push(queue.credentials.password.clone());
        }

        info!("running: docker {}", args.join(" "));

        let output = Command::new("docker")
            .args(&args)
            .output()
            .map_err(|e| ClientError::Operation(e.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!("docker run failed: {}", stderr);
            return Err(ClientError::Operation(format!("docker run failed: {}", stderr)));
        }

        let container_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

        // update queue record
        queue.container_id = Some(container_id.clone());
        queue.status = ServiceStatus::Running;
        queue.updated_at = chrono::Utc::now();

        info!("queue started: {} -> {}", queue.name, container_id);
        Ok(container_id)
    }

    /// ensures the infrastructure network exists
    fn ensure_network(&self, name: &str) -> Result<()> {
        let output = Command::new("docker")
            .args(["network", "inspect", name])
            .output()
            .map_err(|e| ClientError::Operation(e.to_string()))?;

        if output.status.success() {
            return Ok(());
        }

        info!("creating docker network: {}", name);
        let output = Command::new("docker")
            .args(["network", "create", name])
            .output()
            .map_err(|e| ClientError::Operation(e.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stderr.contains("already exists") {
                warn!("failed to create network: {}", stderr);
            }
        }

        Ok(())
    }

    /// stops a managed queue container
    pub fn stop_queue(&self, queue: &mut ManagedQueue) -> Result<()> {
        if let Some(ref container_id) = queue.container_id {
            info!("stopping queue: {} ({})", queue.name, container_id);

            let _ = Command::new("docker")
                .args(["stop", container_id])
                .output();

            let _ = Command::new("docker")
                .args(["rm", container_id])
                .output();

            queue.container_id = None;
            queue.status = ServiceStatus::Stopped;
            queue.updated_at = chrono::Utc::now();
        }

        Ok(())
    }
}
