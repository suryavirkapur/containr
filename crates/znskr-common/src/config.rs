//! configuration for all znskr services

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// main configuration for the znskr paas
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub proxy: ProxyConfig,
    pub github: GithubConfig,
    pub auth: AuthConfig,
    pub acme: AcmeConfig,
    #[serde(default)]
    pub storage: StorageConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server: ServerConfig::default(),
            database: DatabaseConfig::default(),
            proxy: ProxyConfig::default(),
            github: GithubConfig::default(),
            auth: AuthConfig::default(),
            acme: AcmeConfig::default(),
            storage: StorageConfig::default(),
        }
    }
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
    pub load_balance: LoadBalanceAlgorithm,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            http_port: 80,
            https_port: 443,
            base_domain: "svk77.com".to_string(),
            load_balance: LoadBalanceAlgorithm::default(),
        }
    }
}

/// load balancing algorithm for proxy upstream selection
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoadBalanceAlgorithm {
    RoundRobin,
    LeastConnections,
}

impl Default for LoadBalanceAlgorithm {
    fn default() -> Self {
        Self::RoundRobin
    }
}

/// github integration configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubConfig {
    pub client_id: String,
    pub client_secret: String,
    pub webhook_secret: String,
}

impl Default for GithubConfig {
    fn default() -> Self {
        Self {
            client_id: String::new(),
            client_secret: String::new(),
            webhook_secret: String::new(),
        }
    }
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
    /// structure: {data_dir}/{db_id}/data
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
}
