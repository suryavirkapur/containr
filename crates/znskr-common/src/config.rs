//! configuration for all znskr services

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// main configuration for the znskr paas
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
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
            port: 3000,
        }
    }
}

/// sled database configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseConfig {
    pub path: String,
}

impl Default for DatabaseConfig {
    fn default() -> Self {
        Self {
            path: "./data/znskr.db".to_string(),
        }
    }
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
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
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
    /// rustfs endpoint for object storage
    pub rustfs_endpoint: String,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from("/data/znskr"),
            max_volume_size_gb: 10,
            backup_enabled: false,
            rustfs_endpoint: "http://localhost:9000".to_string(),
        }
    }
}

impl StorageConfig {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toml_missing_optional_sections_use_defaults() {
        let config: Config = toml::from_str(
            r#"
[server]
host = "0.0.0.0"
port = 3000

[database]
path = "./data/znskr.db"

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
        assert!(config.security.cors_allowed_origins.contains(&"http://localhost:3001".to_string()));
        assert_eq!(config.proxy.public_ip, None);
        assert_eq!(config.proxy.load_balance, LoadBalanceAlgorithm::RoundRobin);
        assert_eq!(config.storage.data_dir, PathBuf::from("/data/znskr"));
        assert_eq!(config.storage.backup_enabled, false);
    }

    #[test]
    fn storage_paths_are_scoped() {
        let storage = StorageConfig::default();

        assert_eq!(
            storage.database_data_path("db1"),
            PathBuf::from("/data/znskr/databases/db1/data")
        );
        assert_eq!(
            storage.database_backup_path("db1"),
            PathBuf::from("/data/znskr/databases/db1/backups")
        );
        assert_eq!(
            storage.queue_data_path("queue1"),
            PathBuf::from("/data/znskr/queues/queue1/data")
        );
    }
}
