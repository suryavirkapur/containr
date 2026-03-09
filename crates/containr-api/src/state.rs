//! shared application state

use containr_common::{Config, Database};
use dashmap::DashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};

use crate::github::DeploymentJob;
use containr_runtime::ProxyRouteUpdate;

/// shared state across all api handlers
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<RwLock<Config>>,
    pub config_path: PathBuf,
    pub data_dir: PathBuf,
    pub db: Database,
    pub deployment_tx: mpsc::Sender<DeploymentJob>,
    pub proxy_update_tx: Option<mpsc::Sender<ProxyRouteUpdate>>,
    pub oauth_states: Arc<DashMap<String, i64>>,
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
    ) -> Self {
        Self {
            config,
            config_path,
            data_dir,
            db,
            deployment_tx,
            proxy_update_tx,
            oauth_states: Arc::new(DashMap::new()),
            cert_request_tx,
        }
    }
}
