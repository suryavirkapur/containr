//! managed services models for databases and storage

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::models::{ContainerService, ServiceType};

pub const POSTGRES_PROXY_PORT: u16 = 6432;

fn normalize_internal_host(host: &str) -> String {
    host.trim().trim_end_matches(".internal").to_string()
}

/// supported database types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseType {
    Postgresql,
    Mariadb,
    Valkey,
    Qdrant,
}

impl DatabaseType {
    /// returns the public api name for this database type
    pub fn api_name(&self) -> &'static str {
        match self {
            DatabaseType::Postgresql => "postgres",
            DatabaseType::Mariadb => "mariadb",
            DatabaseType::Valkey => "redis",
            DatabaseType::Qdrant => "qdrant",
        }
    }

    /// returns the normalized service type for this database
    pub fn service_type(&self) -> ServiceType {
        match self {
            DatabaseType::Postgresql => ServiceType::Postgres,
            DatabaseType::Mariadb => ServiceType::Mariadb,
            DatabaseType::Valkey => ServiceType::Redis,
            DatabaseType::Qdrant => ServiceType::Qdrant,
        }
    }

    /// returns the docker image for this database type
    pub fn docker_image(&self, version: &str) -> String {
        match self {
            DatabaseType::Postgresql => format!("postgres:{}", version),
            DatabaseType::Mariadb => format!("mariadb:{}", version),
            DatabaseType::Valkey => format!("valkey/valkey:{}", version),
            DatabaseType::Qdrant => format!("qdrant/qdrant:{}", version),
        }
    }

    /// returns the default port for this database type
    pub fn default_port(&self) -> u16 {
        match self {
            DatabaseType::Postgresql => 5432,
            DatabaseType::Mariadb => 3306,
            DatabaseType::Valkey => 6379,
            DatabaseType::Qdrant => 6333,
        }
    }

    /// returns the data volume path inside the container
    pub fn volume_path(&self) -> &'static str {
        match self {
            DatabaseType::Postgresql => "/var/lib/postgresql/data",
            DatabaseType::Mariadb => "/var/lib/mysql",
            DatabaseType::Valkey => "/data",
            DatabaseType::Qdrant => "/qdrant/storage",
        }
    }

    /// returns default memory limit in bytes
    pub fn default_memory_limit(&self) -> u64 {
        match self {
            DatabaseType::Postgresql => 512 * 1024 * 1024, // 512mb
            DatabaseType::Mariadb => 512 * 1024 * 1024,    // 512mb
            DatabaseType::Valkey => 256 * 1024 * 1024,     // 256mb
            DatabaseType::Qdrant => 1024 * 1024 * 1024,    // 1gb
        }
    }

    /// returns default cpu limit
    pub fn default_cpu_limit(&self) -> f64 {
        match self {
            DatabaseType::Postgresql => 1.0,
            DatabaseType::Mariadb => 1.0,
            DatabaseType::Valkey => 0.5,
            DatabaseType::Qdrant => 1.0,
        }
    }

    /// returns the default version
    pub fn default_version(&self) -> &'static str {
        match self {
            DatabaseType::Postgresql => "16",
            DatabaseType::Mariadb => "11",
            DatabaseType::Valkey => "8",
            DatabaseType::Qdrant => "latest",
        }
    }

    /// returns environment variables for container startup
    pub fn env_vars(
        &self,
        creds: &DatabaseCredentials,
    ) -> Vec<(String, String)> {
        match self {
            DatabaseType::Postgresql => vec![
                ("POSTGRES_USER".into(), creds.username.clone()),
                ("POSTGRES_PASSWORD".into(), creds.password.clone()),
                ("POSTGRES_DB".into(), creds.database_name.clone()),
            ],
            DatabaseType::Mariadb => vec![
                ("MARIADB_USER".into(), creds.username.clone()),
                ("MARIADB_PASSWORD".into(), creds.password.clone()),
                ("MARIADB_DATABASE".into(), creds.database_name.clone()),
                ("MARIADB_ROOT_PASSWORD".into(), creds.password.clone()),
            ],
            DatabaseType::Valkey => {
                vec![("VALKEY_PASSWORD".into(), creds.password.clone())]
            }
            DatabaseType::Qdrant => {
                vec![(
                    "QDRANT__SERVICE__API_KEY".into(),
                    creds.password.clone(),
                )]
            }
        }
    }
}

/// service status for managed services
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default,
)]
#[serde(rename_all = "lowercase")]
pub enum ServiceStatus {
    #[default]
    Pending,
    Starting,
    Running,
    Stopped,
    Failed,
}

/// supported queue types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueueType {
    Rabbitmq,
    Nats,
}

impl QueueType {
    /// returns the public api name for this queue type
    pub fn api_name(&self) -> &'static str {
        match self {
            QueueType::Rabbitmq => "rabbitmq",
            QueueType::Nats => "nats",
        }
    }

    /// returns the normalized service type for this queue
    pub fn service_type(&self) -> ServiceType {
        match self {
            QueueType::Rabbitmq => ServiceType::RabbitMq,
            QueueType::Nats => ServiceType::PrivateService,
        }
    }

    /// returns the docker image for this queue type
    pub fn docker_image(&self, version: &str) -> String {
        match self {
            QueueType::Rabbitmq => format!("rabbitmq:{}", version),
            QueueType::Nats => format!("nats:{}", version),
        }
    }

    /// returns the default port for this queue type
    pub fn default_port(&self) -> u16 {
        match self {
            QueueType::Rabbitmq => 5672,
            QueueType::Nats => 4222,
        }
    }

    /// returns the data volume path inside the container
    pub fn volume_path(&self) -> &'static str {
        match self {
            QueueType::Rabbitmq => "/var/lib/rabbitmq",
            QueueType::Nats => "/data",
        }
    }

    /// returns default memory limit in bytes
    pub fn default_memory_limit(&self) -> u64 {
        match self {
            QueueType::Rabbitmq => 512 * 1024 * 1024,
            QueueType::Nats => 256 * 1024 * 1024,
        }
    }

    /// returns default cpu limit
    pub fn default_cpu_limit(&self) -> f64 {
        match self {
            QueueType::Rabbitmq => 1.0,
            QueueType::Nats => 0.5,
        }
    }

    /// returns the default version
    pub fn default_version(&self) -> &'static str {
        match self {
            QueueType::Rabbitmq => "3-management",
            QueueType::Nats => "2",
        }
    }
}

/// queue credentials
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueCredentials {
    pub username: String,
    /// plaintext password (encrypt before storing)
    pub password: String,
}

impl QueueCredentials {
    /// generates new credentials with random password
    pub fn generate(queue_type: QueueType) -> Self {
        let password = generate_random_password(24);
        let username = match queue_type {
            QueueType::Rabbitmq => "rabbitmq".to_string(),
            QueueType::Nats => "nats".to_string(),
        };
        Self { username, password }
    }
}

/// database credentials (password stored encrypted)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseCredentials {
    pub username: String,
    /// plaintext password (encrypt before storing)
    pub password: String,
    pub database_name: String,
}

impl DatabaseCredentials {
    /// generates new credentials with random password
    pub fn generate(db_type: DatabaseType) -> Self {
        let password = generate_random_password(24);
        let username = match db_type {
            DatabaseType::Postgresql => "postgres".to_string(),
            DatabaseType::Mariadb => "mariadb".to_string(),
            DatabaseType::Valkey => "default".to_string(),
            DatabaseType::Qdrant => "qdrant".to_string(),
        };
        Self {
            username,
            password,
            database_name: "main".to_string(),
        }
    }
}

/// generates a random alphanumeric password
fn generate_random_password(len: usize) -> String {
    use rand::Rng;
    const CHARSET: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::rng();
    (0..len)
        .map(|_| {
            let idx = rng.random_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect()
}

/// managed database instance
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedDatabase {
    pub id: Uuid,
    pub owner_id: Uuid,
    #[serde(default)]
    pub group_id: Option<Uuid>,
    pub name: String,
    pub db_type: DatabaseType,
    pub version: String,
    pub container_id: Option<String>,
    /// deprecated: use host_data_path for bind mounts instead
    pub volume_name: String,
    /// host directory for bind mount storage
    pub host_data_path: String,
    pub internal_host: String,
    pub port: u16,
    /// external port for host exposure (if enabled)
    pub external_port: Option<u16>,
    #[serde(default)]
    pub pitr_enabled: bool,
    #[serde(default)]
    pub pitr_last_base_backup_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub pitr_last_base_backup_label: Option<String>,
    #[serde(default)]
    pub proxy_enabled: bool,
    #[serde(default)]
    pub proxy_external_port: Option<u16>,
    pub credentials: DatabaseCredentials,
    pub memory_limit: u64,
    pub cpu_limit: f64,
    pub status: ServiceStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl ManagedDatabase {
    /// creates a new managed database with defaults
    pub fn new(owner_id: Uuid, name: String, db_type: DatabaseType) -> Self {
        let id = Uuid::new_v4();
        let now = Utc::now();
        Self {
            id,
            owner_id,
            group_id: None,
            name: name.clone(),
            db_type,
            version: db_type.default_version().to_string(),
            container_id: None,
            volume_name: format!("containr-db-{}", id),
            host_data_path: format!("/data/containr/databases/{}/data", id),
            internal_host: format!("db-{}", id),
            port: db_type.default_port(),
            external_port: None,
            pitr_enabled: false,
            pitr_last_base_backup_at: None,
            pitr_last_base_backup_label: None,
            proxy_enabled: false,
            proxy_external_port: None,
            credentials: DatabaseCredentials::generate(db_type),
            memory_limit: db_type.default_memory_limit(),
            cpu_limit: db_type.default_cpu_limit(),
            status: ServiceStatus::Pending,
            created_at: now,
            updated_at: now,
        }
    }

    /// creates a new managed database with custom data path from config
    pub fn new_with_path(
        owner_id: Uuid,
        name: String,
        db_type: DatabaseType,
        data_dir: &std::path::Path,
    ) -> Self {
        let mut db = Self::new(owner_id, name, db_type);
        db.host_data_path = data_dir
            .join("databases")
            .join(db.id.to_string())
            .join("data")
            .to_string_lossy()
            .to_string();
        db
    }

    /// returns the bind mount argument for docker (host:container)
    pub fn bind_mount_arg(&self) -> String {
        format!("{}:{}", self.host_data_path, self.container_mount_target())
    }

    /// returns the bind mount target inside the container
    pub fn container_mount_target(&self) -> &'static str {
        if self.uses_versioned_postgres_layout() {
            "/var/lib/postgresql"
        } else {
            self.db_type.volume_path()
        }
    }

    /// returns the effective data directory inside the container
    pub fn container_data_dir(&self) -> String {
        if self.db_type != DatabaseType::Postgresql {
            return self.db_type.volume_path().to_string();
        }

        match self.postgres_major_version() {
            Some(major) if major >= 18 => {
                format!("/var/lib/postgresql/{major}/docker")
            }
            _ => self.db_type.volume_path().to_string(),
        }
    }

    /// returns the effective data directory on the host
    pub fn host_runtime_data_path(&self) -> PathBuf {
        if self.db_type != DatabaseType::Postgresql {
            return PathBuf::from(&self.host_data_path);
        }

        match self.postgres_major_version() {
            Some(major) if major >= 18 => Path::new(&self.host_data_path)
                .join(major.to_string())
                .join("docker"),
            _ => PathBuf::from(&self.host_data_path),
        }
    }

    /// returns env vars for container startup including version-specific data dir
    pub fn container_env_vars(&self) -> Vec<(String, String)> {
        let mut env_vars = self.db_type.env_vars(&self.credentials);
        if self.uses_versioned_postgres_layout() {
            env_vars.push(("PGDATA".into(), self.container_data_dir()));
        }
        env_vars
    }

    /// returns the parsed postgres major version when available
    pub fn postgres_major_version(&self) -> Option<u16> {
        if self.db_type != DatabaseType::Postgresql {
            return None;
        }

        let leading = self
            .version
            .trim()
            .split(['.', '-'])
            .next()
            .unwrap_or_default();
        leading.parse::<u16>().ok()
    }

    fn uses_versioned_postgres_layout(&self) -> bool {
        matches!(self.postgres_major_version(), Some(major) if major >= 18)
    }

    /// returns the docker network name used by this service
    pub fn network_name(&self) -> String {
        match self.group_id {
            Some(group_id) => format!("containr-{}", group_id),
            None => format!("containr-svc-{}", self.id),
        }
    }

    /// returns the normalized hostname exposed on the shared internal network
    pub fn normalized_internal_host(&self) -> String {
        normalize_internal_host(&self.internal_host)
    }

    /// returns the docker aliases used for the shared internal network
    pub fn network_aliases(&self) -> Vec<String> {
        let normalized = self.normalized_internal_host();
        let legacy = self.internal_host.trim().to_string();
        let mut aliases = vec![normalized.clone()];
        if !legacy.is_empty() && legacy != normalized {
            aliases.push(legacy);
        }
        aliases
    }

    /// returns the connection string for this database
    pub fn connection_string(&self) -> String {
        let host = self.normalized_internal_host();
        match self.db_type {
            DatabaseType::Postgresql => format!(
                "postgresql://{}:{}@{}:{}/{}",
                self.credentials.username,
                self.credentials.password,
                host,
                self.port,
                self.credentials.database_name
            ),
            DatabaseType::Mariadb => format!(
                "mysql://{}:{}@{}:{}/{}",
                self.credentials.username,
                self.credentials.password,
                host,
                self.port,
                self.credentials.database_name
            ),
            DatabaseType::Valkey => format!(
                "redis://:{}@{}:{}",
                self.credentials.password, host, self.port
            ),
            DatabaseType::Qdrant => format!("http://{}:{}", host, self.port),
        }
    }

    /// returns docker image for this database
    pub fn docker_image(&self) -> String {
        self.db_type.docker_image(&self.version)
    }

    /// returns the normalized service type name
    pub fn service_type_name(&self) -> &'static str {
        ContainerService::service_type_name(self.db_type.service_type())
    }

    /// returns the database root directory on the host
    pub fn root_path(&self) -> PathBuf {
        Path::new(&self.host_data_path)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(&self.host_data_path))
    }

    /// returns the host directory used for postgres pitr data
    pub fn pitr_root_path(&self) -> PathBuf {
        self.root_path().join("pitr")
    }

    /// returns the host directory used for archived wal segments
    pub fn pitr_archive_path(&self) -> PathBuf {
        self.pitr_root_path().join("wal")
    }

    /// returns the host directory used for local base backups
    pub fn pitr_backups_path(&self) -> PathBuf {
        self.pitr_root_path().join("basebackups")
    }

    /// returns the host directory used for pgdog config files
    pub fn proxy_config_path(&self) -> PathBuf {
        self.root_path().join("pgdog")
    }

    /// returns the internal hostname exposed by the proxy frontend
    pub fn proxy_internal_host(&self) -> Option<String> {
        match self.db_type {
            DatabaseType::Postgresql if self.proxy_enabled => {
                Some(format!("{}-proxy", self.normalized_internal_host()))
            }
            _ => None,
        }
    }

    /// returns the internal proxy port for postgres frontends
    pub fn proxy_port(&self) -> Option<u16> {
        match self.db_type {
            DatabaseType::Postgresql if self.proxy_enabled => {
                Some(POSTGRES_PROXY_PORT)
            }
            _ => None,
        }
    }

    /// returns the internal pgdog connection string when enabled
    pub fn proxy_connection_string(&self) -> Option<String> {
        let host = self.proxy_internal_host()?;
        let port = self.proxy_port()?;
        Some(format!(
            "postgresql://{}:{}@{}:{}/{}",
            self.credentials.username,
            self.credentials.password,
            host,
            port,
            self.credentials.database_name
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_postgres_database(version: &str) -> ManagedDatabase {
        let mut db = ManagedDatabase::new(
            Uuid::new_v4(),
            "primary".to_string(),
            DatabaseType::Postgresql,
        );
        db.version = version.to_string();
        db
    }

    #[test]
    fn postgres_16_uses_legacy_data_layout() {
        let db = sample_postgres_database("16");

        assert_eq!(db.container_mount_target(), "/var/lib/postgresql/data");
        assert_eq!(db.container_data_dir(), "/var/lib/postgresql/data");
        assert_eq!(
            db.host_runtime_data_path(),
            PathBuf::from(&db.host_data_path)
        );
        assert!(!db
            .container_env_vars()
            .iter()
            .any(|(key, _)| key == "PGDATA"));
    }

    #[test]
    fn postgres_18_uses_versioned_data_layout() {
        let db = sample_postgres_database("18.1");

        assert_eq!(db.container_mount_target(), "/var/lib/postgresql");
        assert_eq!(db.container_data_dir(), "/var/lib/postgresql/18/docker");
        assert_eq!(
            db.host_runtime_data_path(),
            Path::new(&db.host_data_path).join("18").join("docker")
        );
        assert!(db.container_env_vars().iter().any(|(key, value)| {
            key == "PGDATA" && value == "/var/lib/postgresql/18/docker"
        }));
    }
}

/// managed queue instance
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedQueue {
    pub id: Uuid,
    pub owner_id: Uuid,
    #[serde(default)]
    pub group_id: Option<Uuid>,
    pub name: String,
    pub queue_type: QueueType,
    pub version: String,
    pub container_id: Option<String>,
    /// deprecated: use host_data_path for bind mounts instead
    pub volume_name: String,
    /// host directory for bind mount storage
    pub host_data_path: String,
    pub internal_host: String,
    pub port: u16,
    #[serde(default)]
    pub external_port: Option<u16>,
    pub credentials: QueueCredentials,
    pub memory_limit: u64,
    pub cpu_limit: f64,
    pub status: ServiceStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl ManagedQueue {
    /// creates a new managed queue with defaults
    pub fn new(owner_id: Uuid, name: String, queue_type: QueueType) -> Self {
        let id = Uuid::new_v4();
        let now = Utc::now();
        Self {
            id,
            owner_id,
            group_id: None,
            name,
            queue_type,
            version: queue_type.default_version().to_string(),
            container_id: None,
            volume_name: format!("containr-queue-{}", id),
            host_data_path: format!("/data/containr/queues/{}/data", id),
            internal_host: format!("queue-{}", id),
            port: queue_type.default_port(),
            external_port: None,
            credentials: QueueCredentials::generate(queue_type),
            memory_limit: queue_type.default_memory_limit(),
            cpu_limit: queue_type.default_cpu_limit(),
            status: ServiceStatus::Pending,
            created_at: now,
            updated_at: now,
        }
    }

    /// creates a new managed queue with custom data path from config
    pub fn new_with_path(
        owner_id: Uuid,
        name: String,
        queue_type: QueueType,
        data_dir: &std::path::Path,
    ) -> Self {
        let mut queue = Self::new(owner_id, name, queue_type);
        queue.host_data_path = data_dir
            .join("queues")
            .join(queue.id.to_string())
            .join("data")
            .to_string_lossy()
            .to_string();
        queue
    }

    /// returns the bind mount argument for docker (host:container)
    pub fn bind_mount_arg(&self) -> String {
        format!("{}:{}", self.host_data_path, self.queue_type.volume_path())
    }

    /// returns the docker network name used by this service
    pub fn network_name(&self) -> String {
        match self.group_id {
            Some(group_id) => format!("containr-{}", group_id),
            None => format!("containr-svc-{}", self.id),
        }
    }

    /// returns the normalized hostname exposed on the shared internal network
    pub fn normalized_internal_host(&self) -> String {
        normalize_internal_host(&self.internal_host)
    }

    /// returns the docker aliases used for the shared internal network
    pub fn network_aliases(&self) -> Vec<String> {
        let normalized = self.normalized_internal_host();
        let legacy = self.internal_host.trim().to_string();
        let mut aliases = vec![normalized.clone()];
        if !legacy.is_empty() && legacy != normalized {
            aliases.push(legacy);
        }
        aliases
    }

    /// returns the connection string for this queue
    pub fn connection_string(&self) -> String {
        let host = self.normalized_internal_host();
        match self.queue_type {
            QueueType::Rabbitmq => format!(
                "amqp://{}:{}@{}:{}",
                self.credentials.username,
                self.credentials.password,
                host,
                self.port
            ),
            QueueType::Nats => format!(
                "nats://{}:{}@{}:{}",
                self.credentials.username,
                self.credentials.password,
                host,
                self.port
            ),
        }
    }

    /// returns docker image for this queue
    pub fn docker_image(&self) -> String {
        self.queue_type.docker_image(&self.version)
    }

    /// returns the normalized service type name
    pub fn service_type_name(&self) -> &'static str {
        ContainerService::service_type_name(self.queue_type.service_type())
    }

    /// returns the queue root directory on the host
    pub fn root_path(&self) -> PathBuf {
        Path::new(&self.host_data_path)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(&self.host_data_path))
    }
}

/// storage bucket (s3-compatible via rustfs)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageBucket {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub name: String,
    /// reserved for future per-bucket access management
    pub access_key: String,
    /// reserved for future per-bucket access management
    pub secret_key: String,
    pub size_bytes: u64,
    pub endpoint: String,
    pub created_at: DateTime<Utc>,
}

impl StorageBucket {
    /// creates a new storage bucket
    pub fn new(owner_id: Uuid, name: String, endpoint: String) -> Self {
        Self {
            id: Uuid::new_v4(),
            owner_id,
            name,
            access_key: String::new(),
            secret_key: String::new(),
            size_bytes: 0,
            endpoint,
            created_at: Utc::now(),
        }
    }
}
