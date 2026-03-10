use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

const SETTINGS_DIR_NAME: &str = ".containr";
const CONFIG_FILE_NAME: &str = "config.toml";
const DEFAULT_INSTANCE_NAME: &str = "default";
const DEFAULT_INSTANCE_ID: &str = "local";
const DEFAULT_INSTANCE_URL: &str = "http://127.0.0.1:2077";
const DEFAULT_TIMEOUT_SECS: u64 = 180;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClientConfig {
    #[serde(default = "default_active_instance")]
    pub active_instance: String,
    #[serde(default = "default_instances")]
    pub instances: BTreeMap<String, ClientInstanceConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClientInstanceConfig {
    #[serde(default = "default_instance_id")]
    pub instance_id: String,
    #[serde(default = "default_instance_url")]
    pub url: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
    #[serde(default = "default_tls_verify")]
    pub tls_verify: bool,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            active_instance: default_active_instance(),
            instances: default_instances(),
        }
    }
}

impl Default for ClientInstanceConfig {
    fn default() -> Self {
        Self {
            instance_id: default_instance_id(),
            url: default_instance_url(),
            token: None,
            api_key: None,
            timeout_secs: default_timeout_secs(),
            tls_verify: default_tls_verify(),
        }
    }
}

impl ClientConfig {
    pub fn settings_dir() -> Result<PathBuf> {
        let home =
            env::var_os("HOME").ok_or_else(|| anyhow!("$HOME is not set"))?;
        Ok(PathBuf::from(home).join(SETTINGS_DIR_NAME))
    }

    pub fn default_path() -> Result<PathBuf> {
        Ok(Self::settings_dir()?.join(CONFIG_FILE_NAME))
    }

    pub fn load(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        toml::from_str(&content)
            .with_context(|| format!("failed to parse {}", path.display()))
    }

    pub fn load_or_create(path: Option<&Path>) -> Result<(Self, PathBuf)> {
        let resolved_path = match path {
            Some(path) => path.to_path_buf(),
            None => Self::default_path()?,
        };

        if resolved_path.exists() {
            let config = Self::load(&resolved_path)?;
            return Ok((config, resolved_path));
        }

        let config = Self::default();
        config.save(&resolved_path)?;
        Ok((config, resolved_path))
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let parent = path.parent().ok_or_else(|| {
            anyhow!("failed to resolve parent directory for {}", path.display())
        })?;
        std::fs::create_dir_all(parent).with_context(|| {
            format!("failed to create {}", parent.display())
        })?;

        let content = toml::to_string_pretty(self)
            .context("failed to serialize client config")?;
        std::fs::write(path, content)
            .with_context(|| format!("failed to write {}", path.display()))
    }

    pub fn active_instance(&self) -> Result<&ClientInstanceConfig> {
        self.instance(&self.active_instance)
    }

    pub fn active_instance_mut(&mut self) -> Result<&mut ClientInstanceConfig> {
        let active_instance = self.active_instance.clone();
        self.instance_mut(&active_instance)
    }

    pub fn instance(&self, name: &str) -> Result<&ClientInstanceConfig> {
        self.instances
            .get(name)
            .ok_or_else(|| anyhow!("instance '{}' is not configured", name))
    }

    pub fn instance_mut(
        &mut self,
        name: &str,
    ) -> Result<&mut ClientInstanceConfig> {
        self.instances
            .get_mut(name)
            .ok_or_else(|| anyhow!("instance '{}' is not configured", name))
    }

    pub fn ensure_instance(&mut self, name: &str) -> &mut ClientInstanceConfig {
        self.instances
            .entry(name.to_string())
            .or_insert_with(ClientInstanceConfig::default)
    }

    pub fn masked(&self) -> Self {
        let mut masked = self.clone();
        for instance in masked.instances.values_mut() {
            instance.token = mask_secret(instance.token.as_deref());
            instance.api_key = mask_secret(instance.api_key.as_deref());
        }
        masked
    }
}

fn mask_secret(value: Option<&str>) -> Option<String> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(|_| "<redacted>".to_string())
}

fn default_active_instance() -> String {
    DEFAULT_INSTANCE_NAME.to_string()
}

fn default_instances() -> BTreeMap<String, ClientInstanceConfig> {
    let mut instances = BTreeMap::new();
    instances.insert(
        DEFAULT_INSTANCE_NAME.to_string(),
        ClientInstanceConfig::default(),
    );
    instances
}

fn default_instance_id() -> String {
    DEFAULT_INSTANCE_ID.to_string()
}

fn default_instance_url() -> String {
    DEFAULT_INSTANCE_URL.to_string()
}

fn default_timeout_secs() -> u64 {
    DEFAULT_TIMEOUT_SECS
}

fn default_tls_verify() -> bool {
    true
}

#[cfg(test)]
#[path = "client_config_test.rs"]
mod client_config_test;
