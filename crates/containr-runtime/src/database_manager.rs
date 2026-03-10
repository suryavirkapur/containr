//! managed database container orchestration
//!
//! handles starting, stopping, and managing database containers
//! with bind mount storage for data persistence using bollard.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;

use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use bollard::models::{
    ContainerCreateBody, EndpointSettings, HealthConfig, HealthStatusEnum,
    HostConfig, Mount, MountTypeEnum, NetworkCreateRequest, NetworkingConfig,
    PortBinding, RestartPolicy, RestartPolicyNameEnum,
};
use bollard::query_parameters::{
    CreateContainerOptions, InspectContainerOptions, InspectNetworkOptions,
    LogsOptions, RemoveContainerOptions, StartContainerOptions,
    StopContainerOptions,
};
use bollard::Docker;
use chrono::{DateTime, Utc};
use futures::StreamExt;
use tracing::{error, info, warn};

use crate::error::{ClientError, Result};
use crate::ImageManager;
use containr_common::managed_services::{
    DatabaseType, ManagedDatabase, ServiceStatus, POSTGRES_PROXY_PORT,
};

const PGDOG_IMAGE: &str = "ghcr.io/pgdogdev/pgdog:v0.1.6";
const PGDOG_BINARY_PATH: &str = "/usr/local/bin/pgdog";
const PGDOG_CONFIG_DIR: &str = "/etc/pgdog";
const PGDOG_CONFIG_PATH: &str = "/etc/pgdog/pgdog.toml";
const PGDOG_USERS_PATH: &str = "/etc/pgdog/users.toml";
const POSTGRES_PITR_MOUNT_PATH: &str = "/var/lib/postgresql/containr-pitr";
const POSTGRES_PITR_WAL_PATH: &str = "/var/lib/postgresql/containr-pitr/wal";
const POSTGRES_PITR_BACKUPS_PATH: &str =
    "/var/lib/postgresql/containr-pitr/basebackups";
const PGDOG_POOL_SIZE: usize = 20;
const PGDOG_MIN_POOL_SIZE: usize = 1;
const DATABASE_PROXY_MEMORY_LIMIT_BYTES: i64 = 256 * 1024 * 1024;
const DATABASE_PROXY_NANO_CPUS: i64 = 500_000_000;
const RECOVERY_MANAGED_KEYS: [&str; 4] = [
    "restore_command",
    "recovery_target_action",
    "recovery_target_name",
    "recovery_target_time",
];

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
    pub async fn start_database(
        &self,
        db: &mut ManagedDatabase,
    ) -> Result<String> {
        if db.proxy_enabled && db.db_type != DatabaseType::Postgresql {
            return Err(ClientError::Operation(
                "pgdog proxy is only supported for postgresql".to_string(),
            ));
        }

        if self.is_running(db).await {
            return Err(ClientError::Operation(
                "database is already running".to_string(),
            ));
        }

        info!(
            "starting database: {} ({})",
            db.name,
            db.db_type.docker_image(&db.version)
        );
        self.ensure_image(&db.docker_image()).await?;

        let container_name = Self::database_container_name(db);
        let proxy_container_name = Self::proxy_container_name(db);
        self.remove_container_if_exists(&container_name).await?;
        self.remove_container_if_exists(&proxy_container_name)
            .await?;

        Self::ensure_host_dir(Path::new(&db.host_data_path))?;
        db.internal_host = db.normalized_internal_host();

        let network_name = db.network_name();
        self.ensure_network(&network_name).await?;

        let env: Vec<String> = db
            .db_type
            .env_vars(&db.credentials)
            .into_iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect();

        let mut mounts = vec![Mount {
            target: Some(db.db_type.volume_path().to_string()),
            source: Some(db.host_data_path.clone()),
            typ: Some(MountTypeEnum::BIND),
            ..Default::default()
        }];

        let mut cmd = Self::build_start_command(db);
        if matches!(db.db_type, DatabaseType::Postgresql) && db.pitr_enabled {
            self.prepare_postgres_pitr_dirs(db)?;
            mounts.push(Mount {
                target: Some(POSTGRES_PITR_MOUNT_PATH.to_string()),
                source: Some(db.pitr_root_path().to_string_lossy().to_string()),
                typ: Some(MountTypeEnum::BIND),
                ..Default::default()
            });
            cmd = Some(Self::build_postgres_pitr_command());
        }

        let mut labels = HashMap::new();
        labels.insert(
            "containr.type".to_string(),
            "managed-database".to_string(),
        );
        labels.insert("containr.db.id".to_string(), db.id.to_string());
        labels.insert(
            "containr.db.type".to_string(),
            format!("{:?}", db.db_type).to_lowercase(),
        );

        let host_config = HostConfig {
            mounts: Some(mounts),
            memory: Some(Self::u64_to_i64(
                db.memory_limit,
                "database memory_limit",
            )?),
            nano_cpus: Some((db.cpu_limit * 1_000_000_000.0) as i64),
            restart_policy: Some(RestartPolicy {
                name: Some(RestartPolicyNameEnum::UNLESS_STOPPED),
                maximum_retry_count: None,
            }),
            network_mode: Some(network_name.clone()),
            port_bindings: Self::build_port_bindings(db.port, db.external_port),
            ..Default::default()
        };

        let networking_config = Some(NetworkingConfig {
            endpoints_config: Some(HashMap::from([(
                network_name.clone(),
                EndpointSettings {
                    aliases: Some(db.network_aliases()),
                    ..Default::default()
                },
            )])),
        });

        let health_cmd = self.get_health_check_cmd(db);
        let healthcheck = if !health_cmd.is_empty() {
            Some(HealthConfig {
                test: Some(vec!["CMD-SHELL".to_string(), health_cmd]),
                interval: Some(10_000_000_000),
                timeout: Some(5_000_000_000),
                retries: Some(3),
                start_period: None,
                start_interval: None,
            })
        } else {
            None
        };

        let container_config = ContainerCreateBody {
            image: Some(db.docker_image()),
            env: Some(env),
            labels: Some(labels),
            hostname: Some(db.normalized_internal_host()),
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
        let response = self
            .docker
            .create_container(Some(options), container_config)
            .await
            .map_err(|e| {
                ClientError::Operation(format!("docker create failed: {}", e))
            })?;

        let container_id = response.id.clone();

        self.docker
            .start_container(&container_id, None::<StartContainerOptions>)
            .await
            .map_err(|e| {
                ClientError::Operation(format!("docker start failed: {}", e))
            })?;

        if !self.wait_for_ready(&container_id, 90).await? {
            let _ = self.remove_container_if_exists(&container_name).await;
            return Err(ClientError::Operation(
                "database container did not become ready".to_string(),
            ));
        }

        db.container_id = Some(container_id.clone());
        db.status = ServiceStatus::Running;
        db.updated_at = Utc::now();

        if db.proxy_enabled {
            if let Err(error) = self.start_proxy_frontend(db).await {
                let _ = self.stop_database(db).await;
                return Err(error);
            }
        }

        info!("database started: {} -> {}", db.name, container_id);
        Ok(container_id)
    }

    /// stops a managed database container
    pub async fn stop_database(&self, db: &mut ManagedDatabase) -> Result<()> {
        self.stop_proxy_frontend(db).await?;

        if let Some(ref container_id) = db.container_id {
            info!("stopping database: {} ({})", db.name, container_id);

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
        }

        db.container_id = None;
        db.status = ServiceStatus::Stopped;
        db.updated_at = Utc::now();

        if db.group_id.is_none() {
            self.remove_network_if_exists(&db.network_name()).await?;
        }

        Ok(())
    }

    /// exports database data to a backup file
    pub async fn export_database(
        &self,
        db: &ManagedDatabase,
        output_path: &Path,
    ) -> Result<String> {
        let container_name = Self::database_container_name(db);
        let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
        let backup_file =
            output_path.join(format!("{}_{}.sql", db.name, timestamp));

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

        let output_data =
            self.exec_command_output(&container_name, cmd, None).await?;
        fs::write(&backup_file, &output_data).map_err(|e| {
            ClientError::Operation(format!("write backup failed: {}", e))
        })?;

        Ok(backup_file.to_string_lossy().to_string())
    }

    /// creates a local postgres base backup for pitr
    pub async fn create_postgres_base_backup(
        &self,
        db: &mut ManagedDatabase,
        requested_label: Option<&str>,
    ) -> Result<(String, String)> {
        self.ensure_postgres_pitr_supported(db)?;

        if !self.is_running(db).await {
            return Err(ClientError::Operation(
                "database must be running to create a base backup".to_string(),
            ));
        }

        self.prepare_postgres_pitr_dirs(db)?;

        let label = requested_label
            .map(|value| Self::sanitize_name(value, "base"))
            .unwrap_or_else(|| {
                format!("base-{}", Utc::now().format("%Y%m%d%H%M%S"))
            });
        let backup_dir = db.pitr_backups_path().join(&label);

        if backup_dir.exists() {
            fs::remove_dir_all(&backup_dir).map_err(|e| {
                ClientError::Operation(format!(
                    "remove backup dir failed: {}",
                    e
                ))
            })?;
        }

        let cmd = vec![
            "pg_basebackup".to_string(),
            "-h".to_string(),
            "127.0.0.1".to_string(),
            "-p".to_string(),
            db.port.to_string(),
            "-U".to_string(),
            db.credentials.username.clone(),
            "-D".to_string(),
            format!("{}/{}", POSTGRES_PITR_BACKUPS_PATH, label),
            "-Fp".to_string(),
            "-Xs".to_string(),
            "-P".to_string(),
            "-l".to_string(),
            label.clone(),
        ];

        self.exec_command_output(
            &Self::database_container_name(db),
            cmd,
            Some(vec![format!("PGPASSWORD={}", db.credentials.password)]),
        )
        .await?;
        self.normalize_postgres_backup_permissions(db, &label)
            .await?;

        db.pitr_last_base_backup_at = Some(Utc::now());
        db.pitr_last_base_backup_label = Some(label.clone());
        db.updated_at = Utc::now();

        Ok((label, backup_dir.to_string_lossy().to_string()))
    }

    /// creates a named postgres restore point
    pub async fn create_postgres_restore_point(
        &self,
        db: &ManagedDatabase,
        requested_name: Option<&str>,
    ) -> Result<(String, String)> {
        self.ensure_postgres_pitr_supported(db)?;

        if !self.is_running(db).await {
            return Err(ClientError::Operation(
                "database must be running to create a restore point"
                    .to_string(),
            ));
        }

        let restore_point = requested_name
            .map(|value| Self::sanitize_name(value, "restore"))
            .unwrap_or_else(|| {
                format!("restore-{}", Utc::now().format("%Y%m%d%H%M%S"))
            });

        let lsn = self
            .exec_postgres_query(
                db,
                &format!(
                    "select pg_create_restore_point('{}');",
                    restore_point
                ),
            )
            .await?;
        self.switch_postgres_wal(db).await?;
        self.sync_postgres_wal_archive(db).await?;

        Ok((restore_point, lsn))
    }

    /// restores a postgres database to a restore point or timestamp
    pub async fn recover_postgres_to_target(
        &self,
        db: &mut ManagedDatabase,
        restore_point: Option<&str>,
        target_time: Option<DateTime<Utc>>,
    ) -> Result<()> {
        self.ensure_postgres_pitr_supported(db)?;

        if restore_point.is_some() == target_time.is_some() {
            return Err(ClientError::Operation(
                "provide exactly one recovery target".to_string(),
            ));
        }

        let backup_label =
            db.pitr_last_base_backup_label.clone().ok_or_else(|| {
                ClientError::Operation("no base backup available".to_string())
            })?;
        let backup_dir = db.pitr_backups_path().join(&backup_label);
        if !backup_dir.exists() {
            return Err(ClientError::Operation(
                "latest base backup directory is missing".to_string(),
            ));
        }

        if self.is_running(db).await {
            self.switch_postgres_wal(db).await?;
            self.sync_postgres_wal_archive(db).await?;
        }

        self.stop_database(db).await?;

        let data_dir = Path::new(&db.host_data_path);
        if data_dir.exists() {
            let archived_data_dir = db.root_path().join(format!(
                "data-pre-recovery-{}",
                Utc::now().format("%Y%m%d_%H%M%S")
            ));
            fs::rename(data_dir, &archived_data_dir).map_err(|e| {
                ClientError::Operation(format!(
                    "archive current data directory failed: {}",
                    e
                ))
            })?;
        }

        Self::copy_dir_recursive(&backup_dir, data_dir)?;
        Self::write_recovery_config(data_dir, restore_point, target_time)?;

        self.start_database(db).await?;
        Ok(())
    }

    /// gets logs from a database container
    pub async fn get_logs(
        &self,
        db: &ManagedDatabase,
        tail: usize,
    ) -> Result<String> {
        if let Some(ref container_id) = db.container_id {
            let options = LogsOptions {
                follow: false,
                stdout: true,
                stderr: true,
                tail: tail.to_string(),
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
                .inspect_container(
                    container_id,
                    None::<InspectContainerOptions>,
                )
                .await
            {
                Ok(inspect) => {
                    inspect.state.and_then(|s| s.running).unwrap_or(false)
                }
                Err(_) => false,
            }
        } else {
            false
        }
    }

    async fn start_proxy_frontend(&self, db: &ManagedDatabase) -> Result<()> {
        if !db.proxy_enabled {
            return Ok(());
        }
        if db.db_type != DatabaseType::Postgresql {
            return Err(ClientError::Operation(
                "pgdog proxy is only supported for postgresql".to_string(),
            ));
        }

        let proxy_host = db.proxy_internal_host().ok_or_else(|| {
            ClientError::Operation("proxy host is not available".to_string())
        })?;

        let network_name = db.network_name();
        self.ensure_image(PGDOG_IMAGE).await?;
        self.ensure_network(&network_name).await?;

        let config_dir = db.proxy_config_path();
        Self::ensure_host_dir(&config_dir)?;
        fs::write(config_dir.join("pgdog.toml"), Self::render_pgdog_config(db))
            .map_err(|e| {
                ClientError::Operation(format!(
                    "failed to write pgdog config: {}",
                    e
                ))
            })?;
        fs::write(config_dir.join("users.toml"), Self::render_pgdog_users(db))
            .map_err(|e| {
                ClientError::Operation(format!(
                    "failed to write pgdog users config: {}",
                    e
                ))
            })?;

        let mut labels = HashMap::new();
        labels.insert(
            "containr.type".to_string(),
            "managed-database-frontend".to_string(),
        );
        labels.insert("containr.db.id".to_string(), db.id.to_string());
        labels.insert("containr.db.type".to_string(), "postgresql".to_string());

        let host_config = HostConfig {
            mounts: Some(vec![Mount {
                target: Some(PGDOG_CONFIG_DIR.to_string()),
                source: Some(config_dir.to_string_lossy().to_string()),
                typ: Some(MountTypeEnum::BIND),
                ..Default::default()
            }]),
            memory: Some(DATABASE_PROXY_MEMORY_LIMIT_BYTES),
            nano_cpus: Some(DATABASE_PROXY_NANO_CPUS),
            restart_policy: Some(RestartPolicy {
                name: Some(RestartPolicyNameEnum::UNLESS_STOPPED),
                maximum_retry_count: None,
            }),
            network_mode: Some(network_name.clone()),
            port_bindings: Self::build_port_bindings(
                POSTGRES_PROXY_PORT,
                db.proxy_external_port,
            ),
            ..Default::default()
        };

        let networking_config = Some(NetworkingConfig {
            endpoints_config: Some(HashMap::from([(
                network_name,
                EndpointSettings {
                    aliases: Some(vec![proxy_host.clone()]),
                    ..Default::default()
                },
            )])),
        });

        let container_config = ContainerCreateBody {
            image: Some(PGDOG_IMAGE.to_string()),
            labels: Some(labels),
            hostname: Some(proxy_host),
            host_config: Some(host_config),
            networking_config,
            entrypoint: Some(Self::build_pgdog_entrypoint()),
            cmd: Some(Self::build_pgdog_command()),
            ..Default::default()
        };

        let options = CreateContainerOptions {
            name: Some(Self::proxy_container_name(db)),
            ..Default::default()
        };

        let response = self
            .docker
            .create_container(Some(options), container_config)
            .await
            .map_err(|e| {
                ClientError::Operation(format!("pgdog create failed: {}", e))
            })?;

        self.docker
            .start_container(&response.id, None::<StartContainerOptions>)
            .await
            .map_err(|e| {
                ClientError::Operation(format!("pgdog start failed: {}", e))
            })?;

        if !self.wait_for_ready(&response.id, 30).await? {
            let _ = self
                .remove_container_if_exists(&Self::proxy_container_name(db))
                .await;
            return Err(ClientError::Operation(
                "pgdog frontend did not become ready".to_string(),
            ));
        }

        Ok(())
    }

    async fn stop_proxy_frontend(&self, db: &ManagedDatabase) -> Result<()> {
        self.remove_container_if_exists(&Self::proxy_container_name(db))
            .await
    }

    async fn wait_for_ready(
        &self,
        container_id: &str,
        timeout_secs: u64,
    ) -> Result<bool> {
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_secs(timeout_secs);

        while std::time::Instant::now() < deadline {
            let inspect = self
                .docker
                .inspect_container(
                    container_id,
                    None::<InspectContainerOptions>,
                )
                .await
                .map_err(|e| {
                    ClientError::Operation(format!(
                        "docker inspect failed: {}",
                        e
                    ))
                })?;

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

    async fn remove_network_if_exists(&self, name: &str) -> Result<()> {
        if self
            .docker
            .inspect_network(name, None::<InspectNetworkOptions>)
            .await
            .is_err()
        {
            return Ok(());
        }

        self.docker.remove_network(name).await.map_err(|e| {
            ClientError::Operation(format!(
                "docker network remove failed: {}",
                e
            ))
        })?;
        Ok(())
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
            DatabaseType::Valkey => {
                format!("valkey-cli -a {} ping", db.credentials.password)
            }
            DatabaseType::Qdrant => String::new(),
        }
    }

    fn build_start_command(db: &ManagedDatabase) -> Option<Vec<String>> {
        match db.db_type {
            DatabaseType::Valkey => Some(vec![
                "valkey-server".to_string(),
                "--requirepass".to_string(),
                db.credentials.password.clone(),
            ]),
            _ => None,
        }
    }

    fn ensure_postgres_pitr_supported(
        &self,
        db: &ManagedDatabase,
    ) -> Result<()> {
        if db.db_type != DatabaseType::Postgresql {
            return Err(ClientError::Operation(
                "point in time recovery is only supported for postgresql"
                    .to_string(),
            ));
        }
        if !db.pitr_enabled {
            return Err(ClientError::Operation(
                "point in time recovery is not enabled for this database"
                    .to_string(),
            ));
        }
        Ok(())
    }

    fn prepare_postgres_pitr_dirs(&self, db: &ManagedDatabase) -> Result<()> {
        Self::ensure_host_dir(&db.pitr_root_path())?;
        Self::ensure_host_dir(&db.pitr_archive_path())?;
        Self::ensure_host_dir(&db.pitr_backups_path())?;
        Ok(())
    }

    fn database_container_name(db: &ManagedDatabase) -> String {
        format!("containr-db-{}", db.id)
    }

    fn proxy_container_name(db: &ManagedDatabase) -> String {
        format!("containr-db-proxy-{}", db.id)
    }

    fn build_port_bindings(
        container_port: u16,
        host_port: Option<u16>,
    ) -> Option<HashMap<String, Option<Vec<PortBinding>>>> {
        host_port.map(|value| {
            HashMap::from([(
                format!("{}/tcp", container_port),
                Some(vec![PortBinding {
                    host_ip: Some("0.0.0.0".to_string()),
                    host_port: Some(value.to_string()),
                }]),
            )])
        })
    }

    fn build_postgres_pitr_command() -> Vec<String> {
        vec![
            "postgres".to_string(),
            "-c".to_string(),
            "wal_level=replica".to_string(),
            "-c".to_string(),
            "archive_mode=on".to_string(),
            "-c".to_string(),
            "archive_timeout=60".to_string(),
            "-c".to_string(),
            format!(
                "archive_command=test ! -f {0}/%f && cp %p {0}/%f",
                POSTGRES_PITR_WAL_PATH
            ),
        ]
    }

    fn build_pgdog_entrypoint() -> Vec<String> {
        vec![PGDOG_BINARY_PATH.to_string()]
    }

    fn build_pgdog_command() -> Vec<String> {
        vec![
            "--config".to_string(),
            PGDOG_CONFIG_PATH.to_string(),
            "--users".to_string(),
            PGDOG_USERS_PATH.to_string(),
        ]
    }

    async fn remove_container_if_exists(
        &self,
        container_name: &str,
    ) -> Result<()> {
        let rm_options = RemoveContainerOptions {
            force: true,
            ..Default::default()
        };

        match self
            .docker
            .remove_container(container_name, Some(rm_options))
            .await
        {
            Ok(_) => Ok(()),
            Err(e) => {
                let error = e.to_string();
                if error.contains("No such container") || error.contains("404")
                {
                    Ok(())
                } else {
                    Err(ClientError::Operation(format!(
                        "failed to remove container {}: {}",
                        container_name, error
                    )))
                }
            }
        }
    }

    async fn exec_command_output(
        &self,
        container_name: &str,
        cmd: Vec<String>,
        env: Option<Vec<String>>,
    ) -> Result<Vec<u8>> {
        let exec_options = CreateExecOptions {
            cmd: Some(cmd),
            env,
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            ..Default::default()
        };

        let exec = self
            .docker
            .create_exec(container_name, exec_options)
            .await
            .map_err(|e| {
                ClientError::Operation(format!("create exec failed: {}", e))
            })?;

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
                return Err(ClientError::Operation(format!(
                    "exec failed: {}",
                    e
                )));
            }
        }

        let inspect =
            self.docker.inspect_exec(&exec.id).await.map_err(|e| {
                ClientError::Operation(format!("inspect exec failed: {}", e))
            })?;

        match inspect.exit_code {
            Some(0) => Ok(output_data),
            Some(code) => Err(ClientError::Operation(format!(
                "command failed with exit code {}: {}",
                code,
                Self::trim_exec_output(&output_data)
            ))),
            None => Err(ClientError::Operation(
                "command exit status was not available".to_string(),
            )),
        }
    }

    async fn exec_postgres_query(
        &self,
        db: &ManagedDatabase,
        sql: &str,
    ) -> Result<String> {
        let output = self
            .exec_command_output(
                &Self::database_container_name(db),
                vec![
                    "psql".to_string(),
                    "-v".to_string(),
                    "ON_ERROR_STOP=1".to_string(),
                    "-U".to_string(),
                    db.credentials.username.clone(),
                    "-d".to_string(),
                    db.credentials.database_name.clone(),
                    "-tAc".to_string(),
                    sql.to_string(),
                ],
                Some(vec![format!("PGPASSWORD={}", db.credentials.password)]),
            )
            .await?;

        Ok(String::from_utf8_lossy(&output).trim().to_string())
    }

    async fn switch_postgres_wal(&self, db: &ManagedDatabase) -> Result<()> {
        self.exec_postgres_query(db, "select pg_switch_wal();")
            .await
            .map(|_| ())
    }

    async fn sync_postgres_wal_archive(
        &self,
        db: &ManagedDatabase,
    ) -> Result<()> {
        self.prepare_postgres_pitr_dirs(db)?;
        self.exec_command_output(
            &Self::database_container_name(db),
            vec![
                "sh".to_string(),
                "-lc".to_string(),
                format!(
                    "cp -f /var/lib/postgresql/data/pg_wal/000000* {0}/ \
                     2>/dev/null || true; \
                     cp -f /var/lib/postgresql/data/pg_wal/*.history {0}/ \
                     2>/dev/null || true; \
                     chmod -R a+rX {0}",
                    POSTGRES_PITR_WAL_PATH
                ),
            ],
            None,
        )
        .await
        .map(|_| ())
    }

    async fn normalize_postgres_backup_permissions(
        &self,
        db: &ManagedDatabase,
        label: &str,
    ) -> Result<()> {
        self.exec_command_output(
            &Self::database_container_name(db),
            vec![
                "sh".to_string(),
                "-lc".to_string(),
                format!(
                    "chmod -R a+rX '{}/{}'",
                    POSTGRES_PITR_BACKUPS_PATH, label
                ),
            ],
            None,
        )
        .await
        .map(|_| ())
    }

    fn trim_exec_output(output: &[u8]) -> String {
        let text = String::from_utf8_lossy(output).trim().to_string();
        if text.is_empty() {
            "no command output".to_string()
        } else {
            text
        }
    }

    fn write_recovery_config(
        data_dir: &Path,
        restore_point: Option<&str>,
        target_time: Option<DateTime<Utc>>,
    ) -> Result<()> {
        let recovery_signal = data_dir.join("recovery.signal");
        fs::write(&recovery_signal, "").map_err(|e| {
            ClientError::Operation(format!(
                "write recovery.signal failed: {}",
                e
            ))
        })?;

        let auto_conf_path = data_dir.join("postgresql.auto.conf");
        let existing = if auto_conf_path.exists() {
            fs::read_to_string(&auto_conf_path).map_err(|e| {
                ClientError::Operation(format!(
                    "read postgresql.auto.conf failed: {}",
                    e
                ))
            })?
        } else {
            String::new()
        };

        let mut managed = Vec::new();
        for line in existing.lines() {
            let trimmed = line.trim_start();
            if RECOVERY_MANAGED_KEYS
                .iter()
                .any(|key| trimmed.starts_with(key))
            {
                continue;
            }
            managed.push(line.to_string());
        }

        managed.push(format!(
            "restore_command = 'cp {}/%f %p'",
            POSTGRES_PITR_WAL_PATH
        ));
        managed.push("recovery_target_action = 'promote'".to_string());
        if let Some(value) = restore_point {
            managed.push(format!("recovery_target_name = '{}'", value));
        }
        if let Some(value) = target_time {
            managed.push(format!(
                "recovery_target_time = '{}'",
                value.to_rfc3339()
            ));
        }

        let mut contents = managed.join("\n");
        contents.push('\n');

        fs::write(&auto_conf_path, contents).map_err(|e| {
            ClientError::Operation(format!(
                "write postgresql.auto.conf failed: {}",
                e
            ))
        })?;

        let standby_signal = data_dir.join("standby.signal");
        if standby_signal.exists() {
            let _ = fs::remove_file(standby_signal);
        }

        Ok(())
    }

    fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<()> {
        let metadata = fs::metadata(source).map_err(|e| {
            ClientError::Operation(format!(
                "stat backup directory failed: {}",
                e
            ))
        })?;
        if !metadata.is_dir() {
            return Err(ClientError::Operation(
                "base backup directory is not a directory".to_string(),
            ));
        }

        fs::create_dir_all(destination).map_err(|e| {
            ClientError::Operation(format!(
                "create data directory failed: {}",
                e
            ))
        })?;

        for entry in fs::read_dir(source).map_err(|e| {
            ClientError::Operation(format!(
                "read backup directory failed: {}",
                e
            ))
        })? {
            let entry = entry.map_err(|e| {
                ClientError::Operation(format!("read entry failed: {}", e))
            })?;
            let source_path = entry.path();
            let destination_path = destination.join(entry.file_name());
            let file_type = entry.file_type().map_err(|e| {
                ClientError::Operation(format!("stat entry failed: {}", e))
            })?;

            if file_type.is_dir() {
                Self::copy_dir_recursive(&source_path, &destination_path)?;
            } else if file_type.is_file() {
                fs::copy(&source_path, &destination_path).map_err(|e| {
                    ClientError::Operation(format!(
                        "copy backup file {} failed: {}",
                        source_path.display(),
                        e
                    ))
                })?;
            } else {
                return Err(ClientError::Operation(
                    "unsupported special file found in base backup".to_string(),
                ));
            }
        }

        Ok(())
    }

    fn ensure_host_dir(path: &Path) -> Result<()> {
        if !path.exists() {
            fs::create_dir_all(path).map_err(|e| {
                ClientError::Operation(format!(
                    "create directory failed: {}",
                    e
                ))
            })?;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = fs::Permissions::from_mode(0o755);
            let _ = fs::set_permissions(path, perms);
        }

        Ok(())
    }

    fn render_pgdog_config(db: &ManagedDatabase) -> String {
        let database_name =
            Self::escape_toml_string(&db.credentials.database_name);
        let database_host =
            Self::escape_toml_string(&db.normalized_internal_host());
        let server_user = Self::escape_toml_string(&db.credentials.username);
        let server_password =
            Self::escape_toml_string(&db.credentials.password);

        format!(
            "[general]\n\
             host = \"0.0.0.0\"\n\
             port = {proxy_port}\n\
             default_pool_size = {pool_size}\n\
             min_pool_size = {min_pool_size}\n\
             pooler_mode = \"session\"\n\n\
             [[databases]]\n\
             name = \"{database_name}\"\n\
             host = \"{database_host}\"\n\
             port = {database_port}\n\
             role = \"primary\"\n\
             database_name = \"{database_name}\"\n\
             user = \"{server_user}\"\n\
             password = \"{server_password}\"\n",
            proxy_port = POSTGRES_PROXY_PORT,
            pool_size = PGDOG_POOL_SIZE,
            min_pool_size = PGDOG_MIN_POOL_SIZE,
            database_name = database_name,
            database_host = database_host,
            database_port = db.port,
            server_user = server_user,
            server_password = server_password,
        )
    }

    fn render_pgdog_users(db: &ManagedDatabase) -> String {
        let database_name =
            Self::escape_toml_string(&db.credentials.database_name);
        let username = Self::escape_toml_string(&db.credentials.username);
        let password = Self::escape_toml_string(&db.credentials.password);

        format!(
            "[[users]]\n\
             name = \"{username}\"\n\
             database = \"{database_name}\"\n\
             password = \"{password}\"\n\
             pool_size = {pool_size}\n\
             pooler_mode = \"session\"\n\
             server_user = \"{username}\"\n\
             server_password = \"{password}\"\n",
            username = username,
            database_name = database_name,
            password = password,
            pool_size = PGDOG_POOL_SIZE,
        )
    }

    fn sanitize_name(input: &str, prefix: &str) -> String {
        let mut sanitized = String::new();
        for ch in input.chars() {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                sanitized.push(ch.to_ascii_lowercase());
            } else if !sanitized.ends_with('-') {
                sanitized.push('-');
            }
        }

        let sanitized =
            sanitized.trim_matches('-').trim_matches('_').to_string();
        if sanitized.is_empty() {
            format!("{}-{}", prefix, Utc::now().format("%Y%m%d%H%M%S"))
        } else {
            sanitized
        }
    }

    fn escape_toml_string(value: &str) -> String {
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
    }

    fn u64_to_i64(value: u64, field: &str) -> Result<i64> {
        i64::try_from(value).map_err(|_| {
            ClientError::Operation(format!(
                "invalid {} value: {}",
                field, value
            ))
        })
    }
}

impl Default for DatabaseManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn sample_database() -> ManagedDatabase {
        let owner_id = Uuid::new_v4();
        let mut db = ManagedDatabase::new(
            owner_id,
            "primary".to_string(),
            DatabaseType::Postgresql,
        );
        db.proxy_enabled = true;
        db.pitr_enabled = true;
        db
    }

    #[test]
    fn pgdog_config_uses_internal_database_host() {
        let db = sample_database();
        let config = DatabaseManager::render_pgdog_config(&db);
        assert!(config.contains("[general]"));
        assert!(config.contains("pooler_mode = \"session\""));
        assert!(config.contains(&format!(
            "host = \"{}\"",
            db.normalized_internal_host()
        )));
        assert!(config.contains(&format!("port = {}", POSTGRES_PROXY_PORT)));
    }

    #[test]
    fn pgdog_users_config_maps_client_and_server_credentials() {
        let db = sample_database();
        let config = DatabaseManager::render_pgdog_users(&db);
        assert!(config.contains("[[users]]"));
        assert!(
            config.contains(&format!("name = \"{}\"", db.credentials.username))
        );
        assert!(config.contains(&format!(
            "server_user = \"{}\"",
            db.credentials.username
        )));
    }

    #[test]
    fn postgres_pitr_command_enables_wal_archiving() {
        let command = DatabaseManager::build_postgres_pitr_command();
        let joined = command.join(" ");
        assert!(joined.contains("wal_level=replica"));
        assert!(joined.contains("archive_mode=on"));
        assert!(joined.contains(POSTGRES_PITR_WAL_PATH));
    }

    #[test]
    fn pgdog_container_uses_explicit_binary_and_config_args() {
        assert_eq!(
            DatabaseManager::build_pgdog_entrypoint(),
            vec![PGDOG_BINARY_PATH.to_string()]
        );
        assert_eq!(
            DatabaseManager::build_pgdog_command(),
            vec![
                "--config".to_string(),
                PGDOG_CONFIG_PATH.to_string(),
                "--users".to_string(),
                PGDOG_USERS_PATH.to_string(),
            ]
        );
    }

    #[test]
    fn valkey_start_command_enforces_password() {
        let owner_id = Uuid::new_v4();
        let db = ManagedDatabase::new(
            owner_id,
            "cache".to_string(),
            DatabaseType::Valkey,
        );

        assert_eq!(
            DatabaseManager::build_start_command(&db),
            Some(vec![
                "valkey-server".to_string(),
                "--requirepass".to_string(),
                db.credentials.password.clone(),
            ])
        );
    }
}
