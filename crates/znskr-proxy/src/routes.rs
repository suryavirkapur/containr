//! dynamic route management
//!
//! manages the mapping between domains and upstream containers.

use dashmap::DashMap;
use std::sync::Arc;
use tracing::info;

/// route information
#[derive(Debug, Clone)]
pub struct Route {
    pub domain: String,
    pub upstream_host: String,
    pub upstream_port: u16,
    pub ssl_enabled: bool,
}

/// manages routes with thread-safe updates
#[derive(Clone)]
pub struct RouteManager {
    routes: Arc<DashMap<String, Route>>,
}

impl RouteManager {
    // creates a new route manager
    pub fn new() -> Self {
        Self {
            routes: Arc::new(DashMap::new()),
        }
    }

    // adds or updates a route
    pub fn add_route(&self, route: Route) {
        info!(
            domain = %route.domain,
            upstream = %format!("{}:{}", route.upstream_host, route.upstream_port),
            ssl = %route.ssl_enabled,
            "adding route"
        );
        self.routes.insert(route.domain.clone(), route);
    }

    // removes a route
    pub fn remove_route(&self, domain: &str) {
        info!(domain = %domain, "removing route");
        self.routes.remove(domain);
    }

    // gets a route by domain
    pub fn get_route(&self, domain: &str) -> Option<Route> {
        self.routes.get(domain).map(|r| r.clone())
    }

    // lists all routes
    pub fn list_routes(&self) -> Vec<Route> {
        self.routes.iter().map(|r| r.clone()).collect()
    }

    // checks if a route exists
    pub fn has_route(&self, domain: &str) -> bool {
        self.routes.contains_key(domain)
    }
}

impl Default for RouteManager {
    fn default() -> Self {
        Self::new()
    }
}
