//! managed database container orchestration
//!
//! handles starting, stopping, and managing database containers
//! with bind mount storage for data persistence using bollard.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use bollard::query_parameters::{
    CreateContainerOptions, InspectContainerOptions, LogsOptions,
    RemoveContainerOptions, StopContainerOptions, InspectNetworkOptions, StartContainerOptions,
};
use bollard::models::{
    ContainerCreateBody, HostConfig, Mount, MountTypeEnum, RestartPolicy, RestartPolicyNameEnum,
    NetworkCreateRequest, HealthConfig,
};
use bollard::Docker;
use futures::StreamExt;
use tracing::{error, info, warn};

use crate::error::{ClientError, Result};
use znskr_common::managed_services::{DatabaseType, ManagedDatabase, ServiceStatus};

/// manages database container lifecycle
pub struct DatabaseManager {
    docker: Arc<Docker>,
}

impl DatabaseManager {
    /// creates a new database manager
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

    /// starts a managed database container
    /// creates the data directory and runs the container with bind mount
    pub async fn start_database(&self, db: &mut ManagedDatabase) -> Result<String> {
        info!(
            "starting database: {} ({})",
            db.name,
            db.db_type.docker_image(&db.version)
        );

        // create data directory
        let data_path = Path::new(&db.host_data_path);
        if !data_path.exists() {
            info!("creating data directory: {}", db.host_data_path);
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
        let container_name = format!("znskr-db-{}", db.id);

        // ensure network exists
        self.ensure_network("znskr-infra").await?;

        // build environment variables
        let env: Vec<String> = db
            .db_type
            .env_vars(&db.credentials)
            .into_iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect();

        // build labels
        let mut labels = HashMap::new();
        labels.insert("znskr.type".to_string(), "managed-database".to_string());
        labels.insert("znskr.db.id".to_string(), db.id.to_string());
        labels.insert(
            "znskr.db.type".to_string(),
            format!("{:?}", db.db_type).to_lowercase(),
        );

        // build port bindings if external access enabled
        let mut port_bindings = HashMap::new();
        if let Some(ext_port) = db.external_port {
            port_bindings.insert(
                format!("{}/tcp", db.port),
                Some(vec![bollard::models::PortBinding {
                    host_ip: Some("0.0.0.0".to_string()),
                    host_port: Some(ext_port.to_string()),
                }]),
            );
        }

        // build mount using db_type.volume_path()
        let mount = Mount {
            target: Some(db.db_type.volume_path().to_string()),
            source: Some(db.host_data_path.clone()),
            typ: Some(MountTypeEnum::BIND),
            ..Default::default()
        };

        // build health check
        let health_cmd = self.get_health_check_cmd(db);
        let healthcheck = if !health_cmd.is_empty() {
            Some(HealthConfig {
                test: Some(vec!["CMD-SHELL".to_string(), health_cmd]),
                interval: Some(10_000_000_000), // 10s
                timeout: Some(5_000_000_000),   // 5s
                retries: Some(3),
                start_period: None,
                start_interval: None,
            })
        } else {
            None
        };

        let host_config = HostConfig {
            mounts: Some(vec![mount]),
            memory: Some((db.memory_limit / (1024 * 1024)) as i64 * 1024 * 1024),
            nano_cpus: Some((db.cpu_limit * 1_000_000_000.0) as i64),
            restart_policy: Some(RestartPolicy {
                name: Some(RestartPolicyNameEnum::UNLESS_STOPPED),
                maximum_retry_count: None,
            }),
            network_mode: Some("znskr-infra".to_string()),
            port_bindings: if port_bindings.is_empty() {
                None
            } else {
                Some(port_bindings)
            },
            ..Default::default()
        };

        let container_config = ContainerCreateBody {
            image: Some(db.docker_image()),
            env: Some(env),
            labels: Some(labels),
            hostname: Some(format!("db-{}", db.id)),
            host_config: Some(host_config),
            healthcheck,
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

        // update database record
        db.container_id = Some(container_id.clone());
        db.status = ServiceStatus::Running;
        db.updated_at = chrono::Utc::now();

        info!("database started: {} -> {}", db.name, container_id);
        Ok(container_id)
    }

    /// ensures the infrastructure network exists
    async fn ensure_network(&self, name: &str) -> Result<()> {
        // check if network exists
        if self.docker.inspect_network(name, None::<InspectNetworkOptions>).await.is_ok() {
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

    /// returns health check command for database type
    fn get_health_check_cmd(&self, db: &ManagedDatabase) -> String {
        match db.db_type {
            DatabaseType::Postgresql => format!(
                "pg_isready -U {} -d {}",
                db.credentials.username, db.credentials.database_name
            ),
            DatabaseType::Mariadb => format!(
                "mariadb-admin ping -u{} -p{}",
                db.credentials.username, db.credentials.password
            ),
            DatabaseType::Valkey => format!("valkey-cli -a {} ping", db.credentials.password),
            DatabaseType::Qdrant => "curl -f http://localhost:6333/health || exit 1".to_string(),
        }
    }

    /// stops a managed database container
    pub async fn stop_database(&self, db: &mut ManagedDatabase) -> Result<()> {
        if let Some(ref container_id) = db.container_id {
            info!("stopping database: {} ({})", db.name, container_id);

            let stop_options = StopContainerOptions { t: Some(10), ..Default::default() };
            let _ = self.docker.stop_container(container_id, Some(stop_options)).await;

            let rm_options = RemoveContainerOptions {
                force: true,
                ..Default::default()
            };
            let _ = self.docker.remove_container(container_id, Some(rm_options)).await;

            db.container_id = None;
            db.status = ServiceStatus::Stopped;
            db.updated_at = chrono::Utc::now();
        }

        Ok(())
    }

    /// exports database data to a backup file
    pub async fn export_database(
        &self,
        db: &ManagedDatabase,
        output_path: &Path,
    ) -> Result<String> {
        let container_name = format!("znskr-db-{}", db.id);
        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let backup_file = output_path.join(format!("{}_{}.sql", db.name, timestamp));

        info!("exporting database {} to {:?}", db.name, backup_file);

        let cmd = match db.db_type {
            DatabaseType::Postgresql => vec![
                "pg_dump".to_string(),
                "-U".to_string(),
                db.credentials.username.clone(),
                "-d".to_string(),
                db.credentials.database_name.clone(),
            ],
            DatabaseType::Mariadb => vec![
                "mariadb-dump".to_string(),
                format!("-u{}", db.credentials.username),
                format!("-p{}", db.credentials.password),
                db.credentials.database_name.clone(),
            ],
            DatabaseType::Valkey => vec![
                "valkey-cli".to_string(),
                "-a".to_string(),
                db.credentials.password.clone(),
                "BGSAVE".to_string(),
            ],
            DatabaseType::Qdrant => {
                return Err(ClientError::Operation(
                    "qdrant export requires api call".to_string(),
                ));
            }
        };

        let exec_options = CreateExecOptions {
            cmd: Some(cmd),
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            ..Default::default()
        };

        let exec = self
            .docker
            .create_exec(&container_name, exec_options)
            .await
            .map_err(|e| ClientError::Operation(format!("create exec failed: {}", e)))?;

        let start_options = StartExecOptions {
            detach: false,
            ..Default::default()
        };

        let mut output_data = Vec::new();

        match self.docker.start_exec(&exec.id, Some(start_options)).await {
            Ok(StartExecResults::Attached { mut output, .. }) => {
                while let Some(Ok(msg)) = output.next().await {
                    output_data.extend_from_slice(&msg.into_bytes());
                }
            }
            Ok(StartExecResults::Detached) => {}
            Err(e) => {
                return Err(ClientError::Operation(format!("exec failed: {}", e)));
            }
        }

        // write output to file
        std::fs::write(&backup_file, &output_data)
            .map_err(|e| ClientError::Operation(format!("write backup failed: {}", e)))?;

        Ok(backup_file.to_string_lossy().to_string())
    }

    /// gets logs from a database container
    pub async fn get_logs(&self, db: &ManagedDatabase, _tail: usize) -> Result<String> {
        if let Some(ref container_id) = db.container_id {
            let options = LogsOptions {
                follow: true,
                stdout: true,
                stderr: true,
                tail: "100".to_string(),
                ..Default::default()
            };
            let mut stream = self.docker.logs(container_id, Some(options));
            let mut logs = String::new();

            while let Some(result) = stream.next().await {
                match result {
                    Ok(output) => logs.push_str(&output.to_string()),
                    Err(e) => {
                        error!(container_id = %container_id, error = %e, "error reading logs");
                        break;
                    }
                }
            }

            Ok(logs)
        } else {
            Ok("container not running".to_string())
        }
    }

    /// checks if database container is running
    pub async fn is_running(&self, db: &ManagedDatabase) -> bool {
        if let Some(ref container_id) = db.container_id {
            match self
                .docker
                .inspect_container(container_id, None::<InspectContainerOptions>)
                .await
            {
                Ok(inspect) => inspect
                    .state
                    .and_then(|s| s.running)
                    .unwrap_or(false),
                Err(_) => false,
            }
        } else {
            false
        }
    }
}

impl Default for DatabaseManager {
    fn default() -> Self {
        Self::new()
    }
}
