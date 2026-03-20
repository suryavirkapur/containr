//! shared application state

use containr_common::{Config, Database};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, RwLock};

use crate::github::DeploymentJob;
use containr_runtime::ProxyRouteUpdate;
use dashmap::DashMap;

pub struct OAuthState {
    expires_at: i64,
    created_at: Instant,
}

/// shared state across all api handlers
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<RwLock<Config>>,
    pub config_path: PathBuf,
    pub data_dir: PathBuf,
    pub db: Database,
    pub deployment_tx: mpsc::Sender<DeploymentJob>,
    pub proxy_update_tx: Option<mpsc::Sender<ProxyRouteUpdate>>,
    pub oauth_states: Arc<DashMap<String, OAuthState>>,
    pub cert_request_tx: Option<mpsc::Sender<String>>,
}

impl AppState {
    /// creates a new app state
    pub fn new(
        config: Arc<RwLock<Config>>,
        config_path: PathBuf,
        data_dir: PathBuf,
        db: Database,
        deployment_tx: mpsc::Sender<DeploymentJob>,
        proxy_update_tx: Option<mpsc::Sender<ProxyRouteUpdate>>,
        cert_request_tx: Option<mpsc::Sender<String>>,
    ) -> containr_common::Result<Self> {
        Ok(Self {
            config,
            config_path,
            data_dir,
            db,
            deployment_tx,
            proxy_update_tx,
            oauth_states: Arc::new(DashMap::new()),
            cert_request_tx,
        })
    }

    pub fn insert_oauth_state(&self, state: &str, expires_at: i64) {
        self.oauth_states.insert(
            state.to_string(),
            OAuthState {
                expires_at,
                created_at: Instant::now(),
            },
        );
    }

    pub fn take_oauth_state(&self, state: &str) -> Option<i64> {
        self.oauth_states.remove(state).map(|(_, v)| v.expires_at)
    }

    pub fn cleanup_expired_oauth_states(&self, now: i64) {
        let now_instant = Instant::now();
        let expired: Vec<String> = self
            .oauth_states
            .iter()
            .filter(|entry| {
                let duration = Duration::from_secs(
                    (entry.value().expires_at - now) as u64,
                );
                entry.value().created_at + duration < now_instant
            })
            .map(|entry| entry.key().clone())
            .collect();
        for key in expired {
            self.oauth_states.remove(&key);
        }
    }
}
