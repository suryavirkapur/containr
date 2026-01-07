//! configuration for all znskr services

use serde::{Deserialize, Serialize};

/// main configuration for the znskr paas
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub proxy: ProxyConfig,
    pub github: GithubConfig,
    pub auth: AuthConfig,
    pub acme: AcmeConfig,
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
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            http_port: 80,
            https_port: 443,
            base_domain: "svk77.com".to_string(),
        }
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
