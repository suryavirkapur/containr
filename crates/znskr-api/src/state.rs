//! shared application state

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use znskr_common::{Config, Database};

use crate::github::DeploymentJob;

/// shared state across all api handlers
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<RwLock<Config>>,
    pub config_path: PathBuf,
    pub db: Database,
    pub deployment_tx: mpsc::Sender<DeploymentJob>,
}

impl AppState {
    /// creates a new app state
    pub fn new(
        config: Config,
        config_path: PathBuf,
        db: Database,
        deployment_tx: mpsc::Sender<DeploymentJob>,
    ) -> Self {
        Self {
            config: Arc::new(RwLock::new(config)),
            config_path,
            db,
            deployment_tx,
        }
    }
}

