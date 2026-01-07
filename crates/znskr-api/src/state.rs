//! shared application state

use std::sync::Arc;
use tokio::sync::mpsc;
use znskr_common::{Config, Database};

use crate::github::DeploymentJob;

/// shared state across all api handlers
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: Database,
    pub deployment_tx: mpsc::Sender<DeploymentJob>,
}

impl AppState {
    // creates a new app state
    pub fn new(config: Config, db: Database, deployment_tx: mpsc::Sender<DeploymentJob>) -> Self {
        Self {
            config: Arc::new(config),
            db,
            deployment_tx,
        }
    }
}
