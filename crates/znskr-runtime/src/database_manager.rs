//! managed database container orchestration
//!
//! handles starting, stopping, and managing database containers
//! with bind mount storage for data persistence.

use std::path::Path;
use std::process::Command;
use tracing::{info, warn, error};

use crate::client::{ClientError, Result};
use znskr_common::managed_services::{ManagedDatabase, ServiceStatus};

/// manages database container lifecycle
pub struct DatabaseManager;

impl DatabaseManager {
    /// creates a new database manager
    pub fn new() -> Self {
        Self
    }

    /// starts a managed database container
    /// creates the data directory and runs the container with bind mount
    pub fn start_database(&self, db: &mut ManagedDatabase) -> Result<String> {
        info!("starting database: {} ({})", db.name, db.db_type.docker_image(&db.version));

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
        self.ensure_network("znskr-infra")?;

        // build docker run command
        let mut args = vec![
            "run".to_string(),
            "-d".to_string(),
            "--name".to_string(),
            container_name.clone(),
            "-v".to_string(),
            db.bind_mount_arg(),
            "-p".to_string(),
            format!("{}:{}", db.port, db.port),
            "--restart".to_string(),
            "unless-stopped".to_string(),
            "--memory".to_string(),
            format!("{}m", db.memory_limit / (1024 * 1024)),
            "--cpus".to_string(),
            format!("{:.1}", db.cpu_limit),
            "--network".to_string(),
            "znskr-infra".to_string(),
            "--hostname".to_string(),
            format!("db-{}", db.id),
            "--network-alias".to_string(),
            format!("db-{}", db.id),
        ];

        // add labels
        args.push("--label".to_string());
        args.push("znskr.type=managed-database".to_string());
        args.push("--label".to_string());
        args.push(format!("znskr.db.id={}", db.id));
        args.push("--label".to_string());
        args.push(format!("znskr.db.type={:?}", db.db_type).to_lowercase());

        // add environment variables
        for (key, value) in db.db_type.env_vars(&db.credentials) {
            args.push("-e".to_string());
            args.push(format!("{}={}", key, value));
        }

        // add health check
        let health_cmd = self.get_health_check_cmd(db);
        if !health_cmd.is_empty() {
            args.push("--health-cmd".to_string());
            args.push(health_cmd);
            args.push("--health-interval".to_string());
            args.push("10s".to_string());
            args.push("--health-timeout".to_string());
            args.push("5s".to_string());
            args.push("--health-retries".to_string());
            args.push("3".to_string());
        }

        // add image
        args.push(db.docker_image());

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

        // update database record
        db.container_id = Some(container_id.clone());
        db.status = ServiceStatus::Running;
        db.updated_at = chrono::Utc::now();

        info!("database started: {} -> {}", db.name, container_id);
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

    /// returns health check command for database type
    fn get_health_check_cmd(&self, db: &ManagedDatabase) -> String {
        use znskr_common::managed_services::DatabaseType;

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
    pub fn stop_database(&self, db: &mut ManagedDatabase) -> Result<()> {
        if let Some(ref container_id) = db.container_id {
            info!("stopping database: {} ({})", db.name, container_id);

            let _ = Command::new("docker")
                .args(["stop", container_id])
                .output();

            let _ = Command::new("docker")
                .args(["rm", container_id])
                .output();

            db.container_id = None;
            db.status = ServiceStatus::Stopped;
            db.updated_at = chrono::Utc::now();
        }

        Ok(())
    }

    /// exports database data to a backup file
    pub fn export_database(&self, db: &ManagedDatabase, output_path: &Path) -> Result<String> {
        use znskr_common::managed_services::DatabaseType;

        let container_name = format!("znskr-db-{}", db.id);
        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let backup_file = output_path.join(format!("{}_{}.sql", db.name, timestamp));

        info!("exporting database {} to {:?}", db.name, backup_file);

        let dump_cmd = match db.db_type {
            DatabaseType::Postgresql => format!(
                "docker exec {} pg_dump -U {} -d {} > {:?}",
                container_name, db.credentials.username, db.credentials.database_name, backup_file
            ),
            DatabaseType::Mariadb => format!(
                "docker exec {} mariadb-dump -u{} -p{} {} > {:?}",
                container_name, db.credentials.username, db.credentials.password,
                db.credentials.database_name, backup_file
            ),
            DatabaseType::Valkey => format!(
                "docker exec {} valkey-cli -a {} --rdb {:?}",
                container_name, db.credentials.password, backup_file
            ),
            DatabaseType::Qdrant => {
                return Err(ClientError::Operation(
                    "qdrant export requires api call".to_string(),
                ));
            }
        };

        let output = Command::new("sh")
            .args(["-c", &dump_cmd])
            .output()
            .map_err(|e| ClientError::Operation(e.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ClientError::Operation(format!("backup failed: {}", stderr)));
        }

        Ok(backup_file.to_string_lossy().to_string())
    }

    /// gets logs from a database container
    pub fn get_logs(&self, db: &ManagedDatabase, tail: usize) -> Result<String> {
        if let Some(ref container_id) = db.container_id {
            let output = Command::new("docker")
                .args(["logs", "--tail", &tail.to_string(), container_id])
                .output()
                .map_err(|e| ClientError::Operation(e.to_string()))?;

            let logs = String::from_utf8_lossy(&output.stdout).to_string()
                + &String::from_utf8_lossy(&output.stderr);
            Ok(logs)
        } else {
            Ok("container not running".to_string())
        }
    }

    /// checks if database container is running
    pub fn is_running(&self, db: &ManagedDatabase) -> bool {
        if let Some(ref container_id) = db.container_id {
            let output = Command::new("docker")
                .args(["inspect", "-f", "{{.State.Running}}", container_id])
                .output();

            match output {
                Ok(o) => String::from_utf8_lossy(&o.stdout).trim() == "true",
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
