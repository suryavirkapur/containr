//! dynamic route management
//!
//! manages the mapping between domains and upstream containers.

use dashmap::DashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tracing::info;

use znskr_common::config::LoadBalanceAlgorithm;

/// route information
#[derive(Debug, Clone)]
pub struct Route {
    pub domain: String,
    pub upstreams: Vec<Upstream>,
    pub ssl_enabled: bool,
    pub algorithm: LoadBalanceAlgorithm,
}

/// upstream target
#[derive(Debug, Clone)]
pub struct Upstream {
    pub host: String,
    pub port: u16,
}

#[derive(Debug)]
struct UpstreamState {
    host: String,
    port: u16,
    inflight: AtomicUsize,
}

#[derive(Debug)]
struct RouteState {
    domain: String,
    upstreams: Vec<UpstreamState>,
    ssl_enabled: bool,
    algorithm: LoadBalanceAlgorithm,
    rr_cursor: AtomicUsize,
}

impl RouteState {
    fn to_route(&self) -> Route {
        Route {
            domain: self.domain.clone(),
            upstreams: self
                .upstreams
                .iter()
                .map(|upstream| Upstream {
                    host: upstream.host.clone(),
                    port: upstream.port,
                })
                .collect(),
            ssl_enabled: self.ssl_enabled,
            algorithm: self.algorithm,
        }
    }
}

/// manages routes with thread-safe updates
#[derive(Clone)]
pub struct RouteManager {
    routes: Arc<DashMap<String, Arc<RouteState>>>,
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
        let upstreams: Vec<UpstreamState> = route
            .upstreams
            .iter()
            .map(|upstream| UpstreamState {
                host: upstream.host.clone(),
                port: upstream.port,
                inflight: AtomicUsize::new(0),
            })
            .collect();

        let upstream_summary = route
            .upstreams
            .iter()
            .map(|upstream| format!("{}:{}", upstream.host, upstream.port))
            .collect::<Vec<_>>()
            .join(", ");

        info!(
            domain = %route.domain,
            upstreams = %upstream_summary,
            ssl = %route.ssl_enabled,
            algorithm = ?route.algorithm,
            "adding route"
        );

        let state = Arc::new(RouteState {
            domain: route.domain.clone(),
            upstreams,
            ssl_enabled: route.ssl_enabled,
            algorithm: route.algorithm,
            rr_cursor: AtomicUsize::new(0),
        });

        self.routes.insert(route.domain.clone(), state);
    }

    // removes a route
    pub fn remove_route(&self, domain: &str) {
        info!(domain = %domain, "removing route");
        self.routes.remove(domain);
    }

    // gets a route by domain
    pub fn get_route(&self, domain: &str) -> Option<Route> {
        self.routes
            .get(domain)
            .map(|route| route.value().to_route())
    }

    pub fn select_upstream(&self, domain: &str) -> Option<SelectedUpstream> {
        let route = self.routes.get(domain).map(|route| route.value().clone())?;

        if route.upstreams.is_empty() {
            return None;
        }

        let index = match route.algorithm {
            LoadBalanceAlgorithm::RoundRobin => {
                let cursor = route.rr_cursor.fetch_add(1, Ordering::Relaxed);
                cursor % route.upstreams.len()
            }
            LoadBalanceAlgorithm::LeastConnections => {
                let mut selected = 0usize;
                let mut lowest = route.upstreams[0].inflight.load(Ordering::Relaxed);
                for (idx, upstream) in route.upstreams.iter().enumerate().skip(1) {
                    let inflight = upstream.inflight.load(Ordering::Relaxed);
                    if inflight < lowest {
                        lowest = inflight;
                        selected = idx;
                    }
                }
                selected
            }
        };

        let upstream = &route.upstreams[index];
        upstream.inflight.fetch_add(1, Ordering::Relaxed);

        Some(SelectedUpstream { route, index })
    }

    // lists all routes
    pub fn list_routes(&self) -> Vec<Route> {
        self.routes
            .iter()
            .map(|route| route.value().to_route())
            .collect()
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

pub struct SelectedUpstream {
    route: Arc<RouteState>,
    index: usize,
}

impl SelectedUpstream {
    pub fn address(&self) -> String {
        let upstream = &self.route.upstreams[self.index];
        format!("{}:{}", upstream.host, upstream.port)
    }

    pub fn complete(&self) {
        let upstream = &self.route.upstreams[self.index];
        let _ = upstream
            .inflight
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_sub(1)
            });
    }
}
