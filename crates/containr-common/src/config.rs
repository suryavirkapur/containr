//! configuration for all containr services

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// main configuration for the containr paas
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    #[serde(default)]
    pub cache: CacheConfig,
    #[serde(default)]
    pub logging: LoggingConfig,
    pub proxy: ProxyConfig,
    pub github: GithubConfig,
    pub auth: AuthConfig,
    #[serde(default)]
    pub security: SecurityConfig,
    pub acme: AcmeConfig,
    #[serde(default)]
    pub storage: StorageConfig,
}

/// api server configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: "0.0.0.0".to_string(),
            port: 2077,
        }
    }
}

/// metadata database configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseConfig {
    pub path: String,
}

impl Default for DatabaseConfig {
    fn default() -> Self {
        Self {
            path: "./data/containr.sqlite3".to_string(),
        }
    }
}

impl DatabaseConfig {
    /// returns the effective sqlite file path
    pub fn sqlite_path(&self) -> PathBuf {
        let path = PathBuf::from(self.path.trim());
        if path.is_dir() {
            return path.join("containr.sqlite3");
        }
        path
    }
}

/// ephemeral cache configuration backed by sled
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheConfig {
    pub path: String,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            path: "./data/cache".to_string(),
        }
    }
}

/// append-only file logging configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoggingConfig {
    pub dir: String,
    #[serde(default = "default_log_retention_days")]
    pub retention_days: u32,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            dir: "./data/logs".to_string(),
            retention_days: default_log_retention_days(),
        }
    }
}

fn default_log_retention_days() -> u32 {
    14
}

/// reverse proxy configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub http_port: u16,
    pub https_port: u16,
    pub base_domain: String,
    #[serde(default)]
    pub public_ip: Option<String>,
    #[serde(default)]
    pub load_balance: LoadBalanceAlgorithm,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            http_port: 80,
            https_port: 443,
            base_domain: "svk77.com".to_string(),
            public_ip: None,
            load_balance: LoadBalanceAlgorithm::default(),
        }
    }
}

/// load balancing algorithm for proxy upstream selection
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum LoadBalanceAlgorithm {
    #[default]
    RoundRobin,
    LeastConnections,
}

/// github integration configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GithubConfig {
    pub client_id: String,
    pub client_secret: String,
    pub webhook_secret: String,
}

/// authentication configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthConfig {
    pub jwt_secret: String,
    pub jwt_expiry_hours: u64,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            jwt_secret: "change-me-in-production".to_string(),
            jwt_expiry_hours: 24,
        }
    }
}

/// encryption configuration for sensitive data at rest
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityConfig {
    pub encryption_key: String,
    #[serde(default = "default_cors_allowed_origins")]
    pub cors_allowed_origins: Vec<String>,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            encryption_key: String::new(),
            cors_allowed_origins: default_cors_allowed_origins(),
        }
    }
}

fn default_cors_allowed_origins() -> Vec<String> {
    vec![
        "http://localhost:3001".to_string(),
        "http://127.0.0.1:3001".to_string(),
        "http://localhost:5173".to_string(),
        "http://127.0.0.1:5173".to_string(),
    ]
}

/// acme / let's encrypt configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcmeConfig {
    pub email: String,
    pub certs_dir: String,
    pub staging: bool,
}

impl Default for AcmeConfig {
    fn default() -> Self {
        Self {
            email: String::new(),
            certs_dir: "./data/certs".to_string(),
            staging: true,
        }
    }
}

/// managed services storage configuration (bind mounts)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageConfig {
    /// base directory for all managed service data
    /// structure: {data_dir}/{service_type}/{id}/data
    pub data_dir: PathBuf,
    /// maximum volume size in gb per database (0 = unlimited)
    pub max_volume_size_gb: u32,
    /// whether backup functionality is enabled
    pub backup_enabled: bool,
    /// rustfs endpoint used by containr for management calls
    #[serde(
        default = "default_rustfs_management_endpoint",
        alias = "rustfs_endpoint"
    )]
    pub rustfs_management_endpoint: String,
    /// rustfs hostname exposed to containers on the shared docker network
    #[serde(default = "default_rustfs_internal_host")]
    pub rustfs_internal_host: String,
    /// rustfs service port
    #[serde(default = "default_rustfs_port")]
    pub rustfs_port: u16,
    /// optional public s3 hostname routed through the containr proxy
    #[serde(default)]
    pub rustfs_public_hostname: Option<String>,
    /// rustfs access key used for bucket and backup management
    #[serde(default)]
    pub rustfs_access_key: String,
    /// rustfs secret key used for bucket and backup management
    #[serde(default)]
    pub rustfs_secret_key: String,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from("/data/containr"),
            max_volume_size_gb: 10,
            backup_enabled: false,
            rustfs_management_endpoint: default_rustfs_management_endpoint(),
            rustfs_internal_host: default_rustfs_internal_host(),
            rustfs_port: default_rustfs_port(),
            rustfs_public_hostname: None,
            rustfs_access_key: String::new(),
            rustfs_secret_key: String::new(),
        }
    }
}

impl StorageConfig {
    /// returns the rustfs endpoint used by containr for management calls
    pub fn management_endpoint(&self) -> &str {
        &self.rustfs_management_endpoint
    }

    /// returns the internal s3 endpoint exposed on the shared docker network
    pub fn internal_endpoint(&self) -> String {
        format!(
            "http://{}:{}",
            self.rustfs_internal_host.trim(),
            self.rustfs_port
        )
    }

    /// returns the externally exposed s3 endpoint if configured
    pub fn public_endpoint(&self) -> Option<String> {
        self.rustfs_public_hostname
            .as_deref()
            .map(str::trim)
            .filter(|hostname| !hostname.is_empty())
            .map(normalize_public_endpoint)
    }

    /// returns the preferred s3 endpoint for clients
    pub fn preferred_endpoint(&self) -> String {
        self.public_endpoint()
            .unwrap_or_else(|| self.internal_endpoint())
    }

    /// returns the data directory path for a specific database
    pub fn database_data_path(&self, db_id: &str) -> PathBuf {
        self.data_dir.join("databases").join(db_id).join("data")
    }

    /// returns the backup directory path for a specific database
    pub fn database_backup_path(&self, db_id: &str) -> PathBuf {
        self.data_dir.join("databases").join(db_id).join("backups")
    }

    /// returns the data directory path for a specific queue
    pub fn queue_data_path(&self, queue_id: &str) -> PathBuf {
        self.data_dir.join("queues").join(queue_id).join("data")
    }
}

fn default_rustfs_management_endpoint() -> String {
    "http://127.0.0.1:9000".to_string()
}

fn default_rustfs_internal_host() -> String {
    "containr-storage".to_string()
}

fn default_rustfs_port() -> u16 {
    9000
}

fn normalize_public_endpoint(hostname: &str) -> String {
    if hostname.starts_with("http://") || hostname.starts_with("https://") {
        hostname.trim_end_matches('/').to_string()
    } else {
        format!("https://{}", hostname.trim_end_matches('/'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toml_missing_optional_sections_use_defaults() {
        let config: Config = toml::from_str(
            r#"
[server]
host = "0.0.0.0"
port = 2077

[database]
path = "./data/containr.sqlite3"

[proxy]
http_port = 80
https_port = 443
base_domain = "example.com"

[github]
client_id = "id"
client_secret = "secret"
webhook_secret = "webhook"

[auth]
jwt_secret = "secret"
jwt_expiry_hours = 24

[acme]
email = "ops@example.com"
certs_dir = "./data/certs"
staging = true
"#,
        )
        .unwrap();

        assert!(config.security.encryption_key.is_empty());
        assert_eq!(config.database.path, "./data/containr.sqlite3");
        assert_eq!(config.cache.path, "./data/cache");
        assert_eq!(config.logging.dir, "./data/logs");
        assert_eq!(config.logging.retention_days, 14);
        assert!(config
            .security
            .cors_allowed_origins
            .contains(&"http://localhost:3001".to_string()));
        assert_eq!(config.proxy.public_ip, None);
        assert_eq!(config.proxy.load_balance, LoadBalanceAlgorithm::RoundRobin);
        assert_eq!(config.storage.data_dir, PathBuf::from("/data/containr"));
        assert_eq!(config.storage.backup_enabled, false);
        assert_eq!(
            config.storage.rustfs_management_endpoint,
            "http://127.0.0.1:9000"
        );
        assert_eq!(config.storage.rustfs_internal_host, "containr-storage");
        assert_eq!(config.storage.rustfs_port, 9000);
        assert_eq!(config.storage.rustfs_public_hostname, None);
        assert!(config.storage.rustfs_access_key.is_empty());
        assert!(config.storage.rustfs_secret_key.is_empty());
    }

    #[test]
    fn storage_paths_are_scoped() {
        let storage = StorageConfig::default();

        assert_eq!(
            storage.database_data_path("db1"),
            PathBuf::from("/data/containr/databases/db1/data")
        );
        assert_eq!(
            storage.database_backup_path("db1"),
            PathBuf::from("/data/containr/databases/db1/backups")
        );
        assert_eq!(
            storage.queue_data_path("queue1"),
            PathBuf::from("/data/containr/queues/queue1/data")
        );
        assert_eq!(storage.internal_endpoint(), "http://containr-storage:9000");
        assert_eq!(storage.public_endpoint(), None);
        assert_eq!(
            storage.preferred_endpoint(),
            "http://containr-storage:9000"
        );
    }

    #[test]
    fn public_endpoint_normalization_accepts_host_or_url() {
        let mut storage = StorageConfig {
            rustfs_public_hostname: Some("s3.example.com".to_string()),
            ..StorageConfig::default()
        };
        assert_eq!(
            storage.public_endpoint(),
            Some("https://s3.example.com".to_string())
        );

        storage.rustfs_public_hostname =
            Some("https://s3.example.com/".to_string());
        assert_eq!(
            storage.public_endpoint(),
            Some("https://s3.example.com".to_string())
        );
    }

    #[test]
    fn sqlite_backend_toml_is_supported() {
        let config: Config = toml::from_str(
            r#"
[server]
host = "0.0.0.0"
port = 2077

[database]
path = "./data/containr.sqlite3"

[proxy]
http_port = 80
https_port = 443
base_domain = "example.com"

[github]
client_id = "id"
client_secret = "secret"
webhook_secret = "webhook"

[auth]
jwt_secret = "secret"
jwt_expiry_hours = 24

[acme]
email = "ops@example.com"
certs_dir = "./data/certs"
staging = true
"#,
        )
        .unwrap();

        assert_eq!(config.database.path, "./data/containr.sqlite3");
    }

    #[test]
    fn directory_database_path_resolves_to_sqlite_file() {
        let config = DatabaseConfig {
            path: "/var/lib/containr/containr.sqlite3".to_string(),
        };
        let root = std::env::temp_dir().join("containr-config-dir-test");
        let _ = std::fs::create_dir_all(&root);

        let directory_config = DatabaseConfig {
            path: root.to_string_lossy().to_string(),
        };

        assert_eq!(
            config.sqlite_path(),
            PathBuf::from("/var/lib/containr/containr.sqlite3")
        );
        assert_eq!(
            directory_config.sqlite_path(),
            root.join("containr.sqlite3")
        );
    }
}
