//! events for proxy route updates

use containr_common::models::App;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub enum ProxyRouteUpdate {
    RefreshApp { app_id: Uuid },
    RemoveApp { app: App },
}
