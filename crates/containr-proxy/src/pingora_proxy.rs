//! Pingora-based reverse proxy implementation
//!
//! High-performance reverse proxy using Cloudflare's Pingora framework.
//! Supports dynamic routing, ACME challenges, TLS termination,
//! WebSocket upgrades, gRPC (HTTP/2), and Server-Sent Events.

use std::net::ToSocketAddrs;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use containr_common::Config as AppConfig;
use containr_common::{Database, HttpRequestLog};
use dashmap::DashMap;
use pingora_core::listeners::tls::TlsSettings;
use pingora_core::listeners::{TlsAccept, TlsAcceptCallbacks};
use pingora_core::prelude::*;
use pingora_core::server::configuration::ServerConf;
use pingora_core::tls::{
    ext,
    pkey::{PKey, Private},
    ssl,
    x509::X509,
};
use pingora_http::{RequestHeader, ResponseHeader};
use pingora_proxy::{ProxyHttp, Session};
use tokio::sync::RwLock;
use tracing::{info, warn};
use uuid::Uuid;

use crate::acme::ChallengeStore;
use crate::routes::{BasicAuthCheck, RouteManager, SelectedUpstream};

/// Context for each request
pub struct ProxyCtx {
    /// The upstream address to forward to
    upstream_addr: Option<String>,
    upstream_tls: bool,
    upstream_selection: Option<SelectedUpstream>,
    /// Whether this is a WebSocket upgrade request
    is_websocket: bool,
    /// Whether this is a gRPC request
    is_grpc: bool,
    /// Whether this is an SSE request
    is_sse: bool,
    /// whether the client connected over tls, for X-Forwarded-Proto
    client_tls: bool,
    /// host the client asked for, for X-Forwarded-Host
    client_host: String,
    /// client ip, for X-Forwarded-For and X-Real-IP
    client_ip: Option<String>,
}

/// Pingora-based proxy server
pub struct ContainrProxy {
    routes: Arc<RouteManager>,
    challenges: Arc<ChallengeStore>,
    config: Arc<RwLock<AppConfig>>,
    api_upstream: String,
    db: Database,
}

impl ContainrProxy {
    /// Creates a new pingora proxy
    pub fn new(
        routes: RouteManager,
        challenges: ChallengeStore,
        config: Arc<RwLock<AppConfig>>,
        api_upstream: String,
        db: Database,
    ) -> Self {
        Self {
            routes: Arc::new(routes),
            challenges: Arc::new(challenges),
            config,
            api_upstream,
            db,
        }
    }

    /// enforces http basic auth for routes that require it
    async fn basic_auth_allowed(&self, session: &Session, host: &str) -> bool {
        let authorization = session
            .req_header()
            .headers
            .get("authorization")
            .and_then(|value| value.to_str().ok());
        match self.routes.check_basic_auth(host, authorization) {
            BasicAuthCheck::NotRequired | BasicAuthCheck::Allowed => true,
            BasicAuthCheck::Denied => false,
            BasicAuthCheck::Verify(pending) => {
                // argon2 is cpu heavy; keep it off the proxy event loop
                tokio::task::spawn_blocking(move || pending.verify())
                    .await
                    .unwrap_or(false)
            }
        }
    }

    fn has_certificate(&self, domain: &str) -> bool {
        self.db
            .get_certificate_by_domain(domain)
            .ok()
            .flatten()
            .map(|cert| cert.expires_at > Utc::now())
            .unwrap_or(false)
    }
}

pub struct DynamicCertResolver {
    db: Database,
    cache: Arc<DashMap<String, CachedCertificate>>,
}

#[derive(Clone)]
struct CachedCertificate {
    id: Uuid,
    expires_at: DateTime<Utc>,
    leaf: X509,
    chain: Vec<X509>,
    key: PKey<Private>,
}

impl DynamicCertResolver {
    pub fn new(db: Database) -> Self {
        Self {
            db,
            cache: Arc::new(DashMap::new()),
        }
    }

    async fn load_cert(
        &self,
        domain: &str,
    ) -> Option<(X509, Vec<X509>, PKey<Private>)> {
        let cert =
            match self.db.get_certificate_by_domain(domain).ok().flatten() {
                Some(cert) if cert.expires_at > Utc::now() => cert,
                _ => {
                    self.cache.remove(domain);
                    return None;
                }
            };

        if let Some(cached) = self.cache.get(domain) {
            if cached.id == cert.id && cached.expires_at == cert.expires_at {
                return Some((
                    cached.leaf.clone(),
                    cached.chain.clone(),
                    cached.key.clone(),
                ));
            }
        }

        // Support fullchain PEM files: first cert is leaf, remainder is the chain.
        let mut certs = X509::stack_from_pem(cert.cert_pem.as_bytes()).ok()?;
        if certs.is_empty() {
            return None;
        }
        let leaf = certs.remove(0);
        let chain = certs;

        let key = PKey::private_key_from_pem(cert.key_pem.as_bytes()).ok()?;

        let cached = CachedCertificate {
            id: cert.id,
            expires_at: cert.expires_at,
            leaf,
            chain,
            key,
        };

        self.cache.insert(domain.to_string(), cached.clone());

        Some((cached.leaf, cached.chain, cached.key))
    }
}

#[async_trait]
impl TlsAccept for DynamicCertResolver {
    async fn certificate_callback(
        &self,
        ssl: &mut pingora_core::protocols::tls::TlsRef,
    ) -> () {
        let domain = match ssl.servername(ssl::NameType::HOST_NAME) {
            Some(name) => name.to_string(),
            None => {
                warn!("tls handshake missing server name");
                return;
            }
        };

        match self.load_cert(&domain).await {
            Some((cert, chain, key)) => {
                if let Err(error) = ext::ssl_use_certificate(ssl, &cert) {
                    warn!(error = %error, domain = %domain, "failed to set tls certificate");
                    return;
                }

                // Attach intermediate chain certs so clients can validate the leaf.
                for c in chain {
                    if let Err(error) = ssl.add_chain_cert(c) {
                        warn!(error = %error, domain = %domain, "failed to add extra chain cert");
                        return;
                    }
                }

                if let Err(error) = ext::ssl_use_private_key(ssl, &key) {
                    warn!(error = %error, domain = %domain, "failed to set tls private key");
                    return;
                }
            }
            None => {
                warn!(domain = %domain, "no tls certificate found for domain");
            }
        }
    }
}

#[async_trait]
impl ProxyHttp for ContainrProxy {
    type CTX = ProxyCtx;

    fn new_ctx(&self) -> Self::CTX {
        ProxyCtx {
            upstream_addr: None,
            upstream_tls: false,
            upstream_selection: None,
            is_websocket: false,
            is_grpc: false,
            is_sse: false,
            client_tls: false,
            client_host: String::new(),
            client_ip: None,
        }
    }

    /// Called before connecting to upstream - handles routing, ACME, and protocol detection
    async fn request_filter(
        &self,
        session: &mut Session,
        ctx: &mut Self::CTX,
    ) -> Result<bool> {
        let req_header = session.req_header();
        let path = req_header.uri.path();
        let config = self.config.read().await;
        let base_domain = normalize_hostname(&config.proxy.base_domain);
        let storage_public_hostname = config
            .storage
            .rustfs_public_hostname
            .as_deref()
            .map(str::trim)
            .filter(|hostname| !hostname.is_empty())
            .map(normalize_hostname);
        let storage_upstream = parse_storage_management_upstream(
            config.storage.management_endpoint(),
        );
        drop(config);

        // try Host header first, then :authority pseudo-header (HTTP/2), then URI host
        let host = req_header
            .headers
            .get("host")
            .and_then(|h| h.to_str().ok())
            .or_else(|| req_header.uri.host())
            .or_else(|| req_header.uri.authority().map(|a| a.as_str()))
            .map(|h| h.split(':').next().unwrap_or(h))
            .map(normalize_hostname)
            .unwrap_or_default();

        // Detect WebSocket upgrade
        if let Some(upgrade) = req_header.headers.get("upgrade") {
            if upgrade
                .to_str()
                .unwrap_or("")
                .eq_ignore_ascii_case("websocket")
            {
                ctx.is_websocket = true;
                info!(host = %host, path = %path, "WebSocket upgrade request");
            }
        }

        // Detect gRPC (content-type: application/grpc)
        if let Some(content_type) = req_header.headers.get("content-type") {
            if content_type
                .to_str()
                .unwrap_or("")
                .starts_with("application/grpc")
            {
                ctx.is_grpc = true;
                info!(host = %host, path = %path, "gRPC request");
            }
        }

        // Detect Server-Sent Events (Accept: text/event-stream)
        if let Some(accept) = req_header.headers.get("accept") {
            if accept.to_str().unwrap_or("").contains("text/event-stream") {
                ctx.is_sse = true;
                info!(host = %host, path = %path, "SSE request");
            }
        }

        // Check for ACME challenge (always allow over HTTP)
        if path.starts_with("/.well-known/acme-challenge/") {
            let token = path.trim_start_matches("/.well-known/acme-challenge/");
            if let Some(key_auth) = self.challenges.get(token) {
                info!(token = %token, "serving ACME challenge via pingora");

                // Send challenge response
                let mut header = ResponseHeader::build(200, None)?;
                header.insert_header("Content-Type", "text/plain")?;
                header.insert_header(
                    "Content-Length",
                    key_auth.len().to_string(),
                )?;
                session
                    .write_response_header(Box::new(header), false)
                    .await?;
                session
                    .write_response_body(Some(key_auth.into()), true)
                    .await?;

                return Ok(true); // Request handled, don't forward
            }
        }

        // enforce https for managed domains
        let is_tls = session
            .digest()
            .map(|d| d.ssl_digest.is_some())
            .unwrap_or(false);
        ctx.client_tls = is_tls;
        ctx.client_host = host.clone();
        ctx.client_ip = session
            .client_addr()
            .and_then(|addr| addr.as_inet())
            .map(|addr| addr.ip().to_string());
        let https_required = if host.is_empty() {
            false
        } else if host == base_domain
            || storage_public_hostname
                .as_deref()
                .map(|storage_host| storage_host == host)
                .unwrap_or(false)
        {
            true
        } else if let Some(route) = self.routes.get_route(&host) {
            route.ssl_enabled
        } else {
            false
        };

        if !is_tls && https_required {
            if self.has_certificate(&host) {
                let uri = req_header
                    .uri
                    .path_and_query()
                    .map(|pq| pq.as_str())
                    .unwrap_or("/");
                let redirect_url = format!("https://{}{}", host, uri);
                info!(host = %host, "redirecting http to https");

                let mut header = ResponseHeader::build(301, None)?;
                header.insert_header("Location", &redirect_url)?;
                header.insert_header("Content-Length", "0")?;
                session
                    .write_response_header(Box::new(header), true)
                    .await?;
            } else {
                let body =
                    "https required; certificate provisioning in progress";
                let mut header = ResponseHeader::build(426, None)?;
                header.insert_header("Content-Type", "text/plain")?;
                header
                    .insert_header("Content-Length", body.len().to_string())?;
                session
                    .write_response_header(Box::new(header), false)
                    .await?;
                session.write_response_body(Some(body.into()), true).await?;
            }

            return Ok(true);
        }

        if host == base_domain {
            ctx.upstream_addr = Some(self.api_upstream.clone());
            ctx.upstream_tls = false;
            ctx.upstream_selection = None;
            return Ok(false);
        }

        if storage_public_hostname
            .as_deref()
            .map(|storage_host| storage_host == host)
            .unwrap_or(false)
        {
            let Some((address, tls)) = storage_upstream else {
                let body = "storage proxy is not configured";
                let mut header = ResponseHeader::build(503, None)?;
                header.insert_header("Content-Type", "text/plain")?;
                header
                    .insert_header("Content-Length", body.len().to_string())?;
                session
                    .write_response_header(Box::new(header), false)
                    .await?;
                session.write_response_body(Some(body.into()), true).await?;
                return Ok(true);
            };

            ctx.upstream_addr = Some(address);
            ctx.upstream_tls = tls;
            ctx.upstream_selection = None;
            return Ok(false);
        }

        // Find route for this host
        if let Some(route) = self.routes.get_route(&host) {
            let is_acme = path.starts_with("/.well-known/acme-challenge/");
            if !is_acme && !self.basic_auth_allowed(session, &host).await {
                let body = "authentication required";
                let mut header = ResponseHeader::build(401, None)?;
                header.insert_header(
                    "WWW-Authenticate",
                    "Basic realm=\"containr\"",
                )?;
                header.insert_header("Content-Type", "text/plain")?;
                header
                    .insert_header("Content-Length", body.len().to_string())?;
                session
                    .write_response_header(Box::new(header), false)
                    .await?;
                session.write_response_body(Some(body.into()), true).await?;
                return Ok(true);
            }

            match self.routes.select_upstream(&host) {
                Some(selection) => {
                    ctx.upstream_addr = Some(selection.address());
                    ctx.upstream_tls = false;
                    ctx.upstream_selection = Some(selection);
                    Ok(false)
                }
                None => {
                    warn!(host = %host, service_id = ?route.service_id, "route is mapped but has no live upstream");

                    let body = "service is mapped but has no live upstream";
                    let mut header = ResponseHeader::build(503, None)?;
                    header.insert_header("Content-Type", "text/plain")?;
                    header.insert_header(
                        "Content-Length",
                        body.len().to_string(),
                    )?;
                    session
                        .write_response_header(Box::new(header), false)
                        .await?;
                    session
                        .write_response_body(Some(body.into()), true)
                        .await?;

                    Ok(true)
                }
            }
        } else {
            warn!(host = %host, "no route found");

            // Send 404 response
            let body = "no route found";
            let mut header = ResponseHeader::build(404, None)?;
            header.insert_header("Content-Type", "text/plain")?;
            header.insert_header("Content-Length", body.len().to_string())?;
            session
                .write_response_header(Box::new(header), false)
                .await?;
            session.write_response_body(Some(body.into()), true).await?;

            Ok(true)
        }
    }

    /// Modify request before forwarding to upstream
    async fn upstream_request_filter(
        &self,
        _session: &mut Session,
        upstream_request: &mut RequestHeader,
        ctx: &mut Self::CTX,
    ) -> Result<()> {
        merge_cookie_headers(upstream_request)?;
        set_forwarded_headers(upstream_request, ctx)?;

        // For SSE, add appropriate headers for streaming
        if ctx.is_sse {
            upstream_request.insert_header("X-Accel-Buffering", "no")?;
        }

        Ok(())
    }

    /// Determines the upstream address
    async fn upstream_peer(
        &self,
        _session: &mut Session,
        ctx: &mut Self::CTX,
    ) -> Result<Box<HttpPeer>> {
        let addr = ctx.upstream_addr.as_ref().ok_or_else(|| {
            Error::explain(ErrorType::InternalError, "no upstream configured")
        })?;

        let mut resolved = addr.to_socket_addrs().map_err(|error| {
            Error::explain(
                ErrorType::InternalError,
                format!("failed to resolve upstream address: {}", error),
            )
        })?;

        let socket_addr = resolved.next().ok_or_else(|| {
            Error::explain(
                ErrorType::InternalError,
                "no upstream address resolved",
            )
        })?;

        // Create peer - Pingora handles HTTP/1.1 upgrade for WebSocket
        // and HTTP/2 for gRPC automatically based on negotiation
        let mut peer =
            HttpPeer::new(socket_addr, ctx.upstream_tls, String::new());

        // For gRPC, prefer HTTP/2
        if ctx.is_grpc {
            // HttpPeer will negotiate HTTP/2 if the upstream supports it
            peer.options.alpn = pingora_core::protocols::ALPN::H2H1;
        }

        Ok(Box::new(peer))
    }

    /// Modify response headers for SSE and streaming
    async fn response_filter(
        &self,
        _session: &mut Session,
        upstream_response: &mut ResponseHeader,
        ctx: &mut Self::CTX,
    ) -> Result<()> {
        // For SSE responses, ensure no buffering
        if ctx.is_sse {
            upstream_response.insert_header("X-Accel-Buffering", "no")?;
            upstream_response.insert_header("Cache-Control", "no-cache")?;
        }

        Ok(())
    }

    /// Log the request/response after completion
    async fn logging(
        &self,
        session: &mut Session,
        _e: Option<&Error>,
        ctx: &mut Self::CTX,
    ) {
        if let Some(selection) = ctx.upstream_selection.as_ref() {
            selection.complete();
        }

        let req = session.req_header();
        let status = session
            .response_written()
            .map(|r| r.status.as_u16())
            .unwrap_or(0);

        let upstream = ctx.upstream_addr.as_deref().unwrap_or("none");

        let protocol = if ctx.is_websocket {
            "websocket"
        } else if ctx.is_grpc {
            "grpc"
        } else if ctx.is_sse {
            "sse"
        } else {
            "http"
        };

        info!(
            method = %req.method,
            path = %req.uri.path(),
            status = %status,
            upstream = %upstream,
            protocol = %protocol,
            "request completed"
        );

        let Some(selection) = ctx.upstream_selection.as_ref() else {
            return;
        };
        let (Some(app_id), Some(service_id)) =
            (selection.app_id(), selection.service_id())
        else {
            return;
        };

        let host = req
            .headers
            .get("host")
            .and_then(|value| value.to_str().ok())
            .map(|value| value.split(':').next().unwrap_or(value))
            .unwrap_or(selection.domain())
            .to_string();
        let path = req
            .uri
            .path_and_query()
            .map(|value| value.as_str())
            .unwrap_or(req.uri.path())
            .to_string();
        let log = HttpRequestLog::new(
            service_id,
            app_id,
            host,
            req.method.as_str().to_string(),
            path,
            status,
            upstream.to_string(),
            protocol.to_string(),
        );
        if let Err(error) = self.db.append_http_request_log(&log) {
            warn!(
                service_id = %service_id,
                error = %error,
                "failed to persist http request log"
            );
        }
    }
}

/// Creates and runs the pingora proxy server
#[allow(clippy::too_many_arguments)]
pub fn create_proxy_server(
    routes: RouteManager,
    challenges: ChallengeStore,
    http_port: u16,
    https_port: u16,
    config: Arc<RwLock<AppConfig>>,
    api_upstream: String,
    db: Database,
) -> anyhow::Result<Server> {
    // pingora defaults to a 300s grace period; the systemd unit only allows
    // 15s (TimeoutStopSec) before it sends SIGKILL.
    let mut conf = ServerConf::new().ok_or_else(|| {
        anyhow::anyhow!("failed to build proxy server config")
    })?;
    conf.grace_period_seconds = Some(5);
    conf.graceful_shutdown_timeout_seconds = Some(5);
    let mut server = Server::new_with_opt_and_conf(None, conf);
    server.bootstrap();

    let proxy = ContainrProxy::new(
        routes,
        challenges,
        config,
        api_upstream,
        db.clone(),
    );

    let mut proxy_service =
        pingora_proxy::http_proxy_service(&server.configuration, proxy);

    proxy_service.add_tcp(&format!("0.0.0.0:{}", http_port));

    let resolver = DynamicCertResolver::new(db);
    let callbacks: TlsAcceptCallbacks = Box::new(resolver);
    let mut tls_settings = TlsSettings::with_callbacks(callbacks)?;
    tls_settings.enable_h2();
    proxy_service.add_tls_with_settings(
        &format!("0.0.0.0:{}", https_port),
        None,
        tls_settings,
    );

    server.add_service(proxy_service);

    Ok(server)
}

fn normalize_hostname(hostname: &str) -> String {
    hostname
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_lowercase()
}

fn parse_storage_management_upstream(endpoint: &str) -> Option<(String, bool)> {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return None;
    }

    let (authority, tls) = if let Some(rest) = trimmed.strip_prefix("https://")
    {
        (rest, true)
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        (rest, false)
    } else {
        (trimmed, false)
    };

    let authority = authority.split('/').next()?.trim();
    if authority.is_empty() {
        return None;
    }

    if authority.contains(':') {
        Some((authority.to_string(), tls))
    } else {
        Some((format!("{}:{}", authority, if tls { 443 } else { 80 }), tls))
    }
}

/// http/2 clients may send each cookie as its own `cookie` header. an
/// http/1.1 upstream expects one header joined with "; " (rfc 9113
/// 8.2.3); left alone, apps receive "a=1, b=2" and lose all but the first
/// cookie, which silently breaks session logins
fn merge_cookie_headers(request: &mut RequestHeader) -> Result<()> {
    let values: Vec<String> = request
        .headers
        .get_all("cookie")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    if values.len() < 2 {
        return Ok(());
    }
    request.remove_header("cookie");
    request.insert_header("cookie", values.join("; "))?;
    Ok(())
}

/// tells the app how the client reached the proxy, like nginx or caprover
/// do: apps use these to build absolute urls, mark cookies secure and log
/// the real client ip
fn set_forwarded_headers(
    request: &mut RequestHeader,
    ctx: &ProxyCtx,
) -> Result<()> {
    let proto = if ctx.client_tls { "https" } else { "http" };
    request.insert_header("X-Forwarded-Proto", proto)?;
    if !ctx.client_host.is_empty() {
        request.insert_header("X-Forwarded-Host", ctx.client_host.as_str())?;
    }
    if let Some(ip) = &ctx.client_ip {
        let forwarded_for = match request
            .headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(existing) => format!("{}, {}", existing, ip),
            None => ip.clone(),
        };
        request.insert_header("X-Forwarded-For", forwarded_for)?;
        request.insert_header("X-Real-IP", ip.as_str())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(tls: bool, ip: Option<&str>) -> ProxyCtx {
        ProxyCtx {
            upstream_addr: None,
            upstream_tls: false,
            upstream_selection: None,
            is_websocket: false,
            is_grpc: false,
            is_sse: false,
            client_tls: tls,
            client_host: "app.example.com".to_string(),
            client_ip: ip.map(ToOwned::to_owned),
        }
    }

    fn header(request: &RequestHeader, name: &str) -> Vec<String> {
        request
            .headers
            .get_all(name)
            .iter()
            .map(|value| value.to_str().expect("ascii").to_string())
            .collect()
    }

    #[test]
    fn split_cookie_headers_are_joined_with_semicolons() {
        let mut request =
            RequestHeader::build("POST", b"/", None).expect("request");
        request.append_header("cookie", "sid=abc").expect("cookie");
        request.append_header("cookie", "key=def").expect("cookie");

        merge_cookie_headers(&mut request).expect("merge");
        assert_eq!(header(&request, "cookie"), vec!["sid=abc; key=def"]);
    }

    #[test]
    fn a_single_cookie_header_is_left_alone() {
        let mut request =
            RequestHeader::build("GET", b"/", None).expect("request");
        request.append_header("cookie", "a=1; b=2").expect("cookie");

        merge_cookie_headers(&mut request).expect("merge");
        assert_eq!(header(&request, "cookie"), vec!["a=1; b=2"]);
    }

    #[test]
    fn forwarded_headers_describe_the_client() {
        let mut request =
            RequestHeader::build("GET", b"/", None).expect("request");
        request
            .append_header("x-forwarded-for", "203.0.113.9")
            .expect("xff");

        set_forwarded_headers(&mut request, &ctx(true, Some("198.51.100.4")))
            .expect("forwarded");
        assert_eq!(header(&request, "x-forwarded-proto"), vec!["https"]);
        assert_eq!(
            header(&request, "x-forwarded-host"),
            vec!["app.example.com"]
        );
        assert_eq!(
            header(&request, "x-forwarded-for"),
            vec!["203.0.113.9, 198.51.100.4"]
        );
        assert_eq!(header(&request, "x-real-ip"), vec!["198.51.100.4"]);

        let mut plain =
            RequestHeader::build("GET", b"/", None).expect("request");
        set_forwarded_headers(&mut plain, &ctx(false, None))
            .expect("forwarded");
        assert_eq!(header(&plain, "x-forwarded-proto"), vec!["http"]);
        assert!(header(&plain, "x-forwarded-for").is_empty());
    }
}
