//! events for proxy route updates

use uuid::Uuid;

#[derive(Debug, Clone)]
pub enum ProxyRouteUpdate {
    RefreshApp { app_id: Uuid },
}
