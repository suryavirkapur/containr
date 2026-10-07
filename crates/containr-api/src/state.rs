//! shared application state

use containr_common::{Config, Database};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, RwLock};

use crate::github::DeploymentJob;
use containr_runtime::ProxyRouteUpdate;
use dashmap::DashMap;
use uuid::Uuid;

/// what a github oauth round trip is for
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthPurpose {
    /// sign in (or create the first account) with github
    Login,
    /// attach a github account to this signed-in containr user
    Link(Uuid),
}

pub struct OAuthState {
    expires_at: i64,
    created_at: Instant,
    purpose: OAuthPurpose,
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

    pub fn insert_oauth_state(
        &self,
        state: &str,
        expires_at: i64,
        purpose: OAuthPurpose,
    ) {
        self.oauth_states.insert(
            state.to_string(),
            OAuthState {
                expires_at,
                created_at: Instant::now(),
                purpose,
            },
        );
    }

    /// removes the state (states are single use) and returns its expiry
    /// and purpose
    pub fn take_oauth_state(&self, state: &str) -> Option<(i64, OAuthPurpose)> {
        self.oauth_states
            .remove(state)
            .map(|(_, v)| (v.expires_at, v.purpose))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_states_are_single_use_and_keep_their_purpose() {
        let states: DashMap<String, OAuthState> = DashMap::new();
        let user = Uuid::new_v4();
        states.insert(
            "abc".to_string(),
            OAuthState {
                expires_at: 10,
                created_at: Instant::now(),
                purpose: OAuthPurpose::Link(user),
            },
        );
        let taken =
            states.remove("abc").map(|(_, v)| (v.expires_at, v.purpose));
        assert_eq!(taken, Some((10, OAuthPurpose::Link(user))));
        assert!(states.remove("abc").is_none());
    }
}
