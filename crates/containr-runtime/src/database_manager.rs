//! managed database container orchestration
//!
//! handles starting, stopping, and managing database containers
//! with bind mount storage for data persistence using bollard.

mod pitr;

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
use chrono::Utc;
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
            .container_env_vars()
            .into_iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect();

        let mut mounts = vec![Mount {
            target: Some(db.container_mount_target().to_string()),
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
                    let error = e.to_string();
                    if error.contains("No such container")
                        || error.contains("404")
                    {
                        ClientError::Operation(
                            "container disappeared while starting".to_string(),
                        )
                    } else {
                        ClientError::Operation(format!(
                            "docker inspect failed: {}",
                            error
                        ))
                    }
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

    fn trim_exec_output(output: &[u8]) -> String {
        let text = String::from_utf8_lossy(output).trim().to_string();
        if text.is_empty() {
            "no command output".to_string()
        } else {
            text
        }
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

    #[test]
    fn postgres_18_uses_versioned_mount_target() {
        let owner_id = Uuid::new_v4();
        let mut db = ManagedDatabase::new(
            owner_id,
            "primary".to_string(),
            DatabaseType::Postgresql,
        );
        db.version = "18".to_string();

        assert_eq!(db.container_mount_target(), "/var/lib/postgresql");
        assert_eq!(db.container_data_dir(), "/var/lib/postgresql/18/docker");
    }
}
