//! dynamic route management
//!
//! manages the mapping between domains and upstream containers.

use argon2::password_hash::{PasswordHash, PasswordVerifier};
use argon2::Argon2;
use base64::Engine;
use dashmap::DashMap;
use parking_lot::Mutex;
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tracing::info;
use uuid::Uuid;

use containr_common::config::LoadBalanceAlgorithm;
use containr_common::models::{BasicAuth, LoginGateScope};

/// max cached successful credentials per route
const MAX_AUTH_CACHE_ENTRIES: usize = 64;

/// route information
#[derive(Debug, Clone)]
pub struct Route {
    pub domain: String,
    pub app_id: Option<Uuid>,
    pub service_id: Option<Uuid>,
    pub upstreams: Vec<Upstream>,
    pub ssl_enabled: bool,
    pub algorithm: LoadBalanceAlgorithm,
    /// http basic auth required for this route
    pub basic_auth: Option<BasicAuth>,
    /// containr login required for this route
    pub login_gate: Option<RouteLoginGate>,
}

/// who may pass a route's containr login gate
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouteLoginGate {
    /// owner of the service behind the route
    pub owner_id: Uuid,
    pub scope: LoginGateScope,
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
    app_id: Option<Uuid>,
    service_id: Option<Uuid>,
    upstreams: Vec<UpstreamState>,
    ssl_enabled: bool,
    algorithm: LoadBalanceAlgorithm,
    rr_cursor: AtomicUsize,
    basic_auth: Option<BasicAuth>,
    login_gate: Option<RouteLoginGate>,
    /// authorization header values that verified successfully. the cache
    /// lives on the route state, so it is dropped whenever routes refresh.
    auth_cache: Mutex<HashSet<String>>,
}

impl RouteState {
    fn to_route(&self) -> Route {
        Route {
            domain: self.domain.clone(),
            app_id: self.app_id,
            service_id: self.service_id,
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
            basic_auth: self.basic_auth.clone(),
            login_gate: self.login_gate,
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
        let normalized_domain = normalize_domain(&route.domain);
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
            domain = %normalized_domain,
            app_id = ?route.app_id,
            service_id = ?route.service_id,
            upstreams = %upstream_summary,
            ssl = %route.ssl_enabled,
            algorithm = ?route.algorithm,
            "adding route"
        );

        let state = Arc::new(RouteState {
            domain: normalized_domain.clone(),
            app_id: route.app_id,
            service_id: route.service_id,
            upstreams,
            ssl_enabled: route.ssl_enabled,
            algorithm: route.algorithm,
            rr_cursor: AtomicUsize::new(0),
            basic_auth: route.basic_auth.clone(),
            login_gate: route.login_gate,
            auth_cache: Mutex::new(HashSet::new()),
        });

        self.routes.insert(normalized_domain, state);
    }

    // removes a route
    pub fn remove_route(&self, domain: &str) {
        let normalized_domain = normalize_domain(domain);
        info!(domain = %normalized_domain, "removing route");
        self.routes.remove(&normalized_domain);
    }

    // gets a route by domain
    pub fn get_route(&self, domain: &str) -> Option<Route> {
        self.routes
            .get(&normalize_domain(domain))
            .map(|route| route.value().to_route())
    }

    pub fn select_upstream(&self, domain: &str) -> Option<SelectedUpstream> {
        let route = self
            .routes
            .get(&normalize_domain(domain))
            .map(|route| route.value().clone())?;

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
                let mut lowest =
                    route.upstreams[0].inflight.load(Ordering::Relaxed);
                for (idx, upstream) in
                    route.upstreams.iter().enumerate().skip(1)
                {
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

    /// checks http basic auth for a domain. verification of uncached
    /// credentials is deferred so callers can run it off the async path.
    pub fn check_basic_auth(
        &self,
        domain: &str,
        authorization: Option<&str>,
    ) -> BasicAuthCheck {
        let Some(route) = self
            .routes
            .get(&normalize_domain(domain))
            .map(|route| route.value().clone())
        else {
            return BasicAuthCheck::NotRequired;
        };
        if route.basic_auth.is_none() {
            return BasicAuthCheck::NotRequired;
        }

        let Some(header) = authorization.map(str::trim) else {
            return BasicAuthCheck::Denied;
        };
        if route.auth_cache.lock().contains(header) {
            return BasicAuthCheck::Allowed;
        }
        let Some((username, password)) = parse_basic_authorization(header)
        else {
            return BasicAuthCheck::Denied;
        };

        BasicAuthCheck::Verify(PendingBasicAuth {
            route,
            header: header.to_string(),
            username,
            password,
        })
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
        self.routes.contains_key(&normalize_domain(domain))
    }
}

impl Default for RouteManager {
    fn default() -> Self {
        Self::new()
    }
}

/// outcome of a basic auth check
pub enum BasicAuthCheck {
    /// the route has no basic auth
    NotRequired,
    /// credentials matched a cached successful login
    Allowed,
    /// credentials are missing or malformed
    Denied,
    /// credentials must be verified against the stored hash
    Verify(PendingBasicAuth),
}

/// credentials awaiting (cpu heavy) hash verification
pub struct PendingBasicAuth {
    route: Arc<RouteState>,
    header: String,
    username: String,
    password: String,
}

impl PendingBasicAuth {
    /// verifies the credentials, caching a success on the route
    pub fn verify(self) -> bool {
        let Some(expected) = self.route.basic_auth.as_ref() else {
            return true;
        };
        if !verify_basic_credentials(&self.username, &self.password, expected) {
            return false;
        }

        let mut cache = self.route.auth_cache.lock();
        if cache.len() >= MAX_AUTH_CACHE_ENTRIES {
            cache.clear();
        }
        cache.insert(self.header);
        true
    }
}

/// parses an `Authorization: Basic ...` header into username and password
pub fn parse_basic_authorization(header: &str) -> Option<(String, String)> {
    let header = header.trim();
    let (scheme, encoded) = header.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    let (username, password) = decoded.split_once(':')?;
    Some((username.to_string(), password.to_string()))
}

/// verifies a username/password pair against stored basic auth
pub fn verify_basic_credentials(
    username: &str,
    password: &str,
    expected: &BasicAuth,
) -> bool {
    if username != expected.username {
        return false;
    }
    let Ok(hash) = PasswordHash::new(&expected.password_hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &hash)
        .is_ok()
}

fn normalize_domain(domain: &str) -> String {
    domain.trim().trim_end_matches('.').to_lowercase()
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

    pub fn app_id(&self) -> Option<Uuid> {
        self.route.app_id
    }

    pub fn service_id(&self) -> Option<Uuid> {
        self.route.service_id
    }

    pub fn domain(&self) -> &str {
        &self.route.domain
    }

    pub fn complete(&self) {
        let upstream = &self.route.upstreams[self.index];
        let _ = upstream.inflight.fetch_update(
            Ordering::Relaxed,
            Ordering::Relaxed,
            |value| value.checked_sub(1),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use argon2::password_hash::{PasswordHasher, SaltString};

    fn hash(password: &str) -> String {
        let salt = SaltString::encode_b64(b"containr-test-salt")
            .expect("salt should encode");
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .expect("hash should succeed")
            .to_string()
    }

    fn header(credentials: &str) -> String {
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(credentials)
        )
    }

    fn manager_with_auth() -> RouteManager {
        let manager = RouteManager::new();
        manager.add_route(Route {
            domain: "app.example.com".to_string(),
            app_id: None,
            service_id: None,
            upstreams: Vec::new(),
            ssl_enabled: false,
            algorithm: LoadBalanceAlgorithm::RoundRobin,
            basic_auth: Some(BasicAuth {
                username: "admin".to_string(),
                password_hash: hash("s3cret"),
            }),
            login_gate: None,
        });
        manager
    }

    #[test]
    fn parses_basic_authorization_header() {
        assert_eq!(
            parse_basic_authorization(&header("admin:pa:ss")),
            Some(("admin".to_string(), "pa:ss".to_string()))
        );
        assert!(parse_basic_authorization("Bearer abc").is_none());
        assert!(parse_basic_authorization("Basic !!!").is_none());
        assert!(parse_basic_authorization(&header("nocolon")).is_none());
    }

    #[test]
    fn basic_auth_check_verifies_and_caches() {
        let manager = manager_with_auth();
        assert!(matches!(
            manager.check_basic_auth("other.example.com", None),
            BasicAuthCheck::NotRequired
        ));
        assert!(matches!(
            manager.check_basic_auth("app.example.com", None),
            BasicAuthCheck::Denied
        ));

        let wrong = header("admin:nope");
        match manager.check_basic_auth("app.example.com", Some(&wrong)) {
            BasicAuthCheck::Verify(pending) => assert!(!pending.verify()),
            _ => panic!("expected verification"),
        }
        let wrong_user = header("root:s3cret");
        match manager.check_basic_auth("app.example.com", Some(&wrong_user)) {
            BasicAuthCheck::Verify(pending) => assert!(!pending.verify()),
            _ => panic!("expected verification"),
        }

        let good = header("admin:s3cret");
        match manager.check_basic_auth("app.example.com", Some(&good)) {
            BasicAuthCheck::Verify(pending) => assert!(pending.verify()),
            _ => panic!("expected verification"),
        }
        assert!(matches!(
            manager.check_basic_auth("APP.example.com", Some(&good)),
            BasicAuthCheck::Allowed
        ));

        // refreshing the route drops the cache
        let route = manager.get_route("app.example.com").expect("route");
        manager.add_route(route);
        assert!(matches!(
            manager.check_basic_auth("app.example.com", Some(&good)),
            BasicAuthCheck::Verify(_)
        ));
    }
}
