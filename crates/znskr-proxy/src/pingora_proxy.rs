//! Pingora-based reverse proxy implementation
//!
//! High-performance reverse proxy using Cloudflare's Pingora framework.
//! Supports dynamic routing, ACME challenges, TLS termination,
//! WebSocket upgrades, gRPC (HTTP/2), and Server-Sent Events.

use std::net::ToSocketAddrs;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use dashmap::DashMap;
use pingora_core::listeners::tls::TlsSettings;
use pingora_core::listeners::{TlsAccept, TlsAcceptCallbacks};
use pingora_core::prelude::*;
use pingora_core::tls::{
    ext,
    pkey::{PKey, Private},
    ssl,
    x509::X509,
};
use pingora_http::{RequestHeader, ResponseHeader};
use pingora_proxy::{ProxyHttp, Session};
use tracing::{info, warn};

use crate::acme::ChallengeStore;
use crate::routes::{RouteManager, SelectedUpstream};

/// Context for each request
pub struct ProxyCtx {
    /// The upstream address to forward to
    upstream_addr: Option<String>,
    upstream_selection: Option<SelectedUpstream>,
    /// Whether this is a WebSocket upgrade request
    is_websocket: bool,
    /// Whether this is a gRPC request
    is_grpc: bool,
    /// Whether this is an SSE request
    is_sse: bool,
}

/// Pingora-based proxy server
pub struct ZnskrProxy {
    routes: Arc<RouteManager>,
    challenges: Arc<ChallengeStore>,
    base_domain: String,
    api_upstream: String,
    certs_dir: PathBuf,
}

impl ZnskrProxy {
    /// Creates a new pingora proxy
    pub fn new(
        routes: RouteManager,
        challenges: ChallengeStore,
        base_domain: String,
        api_upstream: String,
        certs_dir: PathBuf,
    ) -> Self {
        Self {
            routes: Arc::new(routes),
            challenges: Arc::new(challenges),
            base_domain,
            api_upstream,
            certs_dir,
        }
    }

    fn has_certificate(&self, domain: &str) -> bool {
        self.certs_dir.join(format!("{}.pem", domain)).exists()
    }
}

pub struct DynamicCertResolver {
    certs_dir: PathBuf,
    cache: Arc<DashMap<String, (X509, PKey<Private>)>>,
}

impl DynamicCertResolver {
    pub fn new(certs_dir: PathBuf) -> Self {
        Self {
            certs_dir,
            cache: Arc::new(DashMap::new()),
        }
    }

    async fn load_cert(&self, domain: &str) -> Option<(X509, PKey<Private>)> {
        if let Some(cached) = self.cache.get(domain) {
            return Some(cached.value().clone());
        }

        let cert_path = self.certs_dir.join(format!("{}.pem", domain));
        let key_path = self.certs_dir.join(format!("{}.key", domain));

        let cert_bytes = tokio::fs::read(cert_path).await.ok()?;
        let key_bytes = tokio::fs::read(key_path).await.ok()?;

        let cert = X509::from_pem(&cert_bytes).ok()?;
        let key = PKey::private_key_from_pem(&key_bytes).ok()?;

        let pair = (cert, key);
        self.cache.insert(domain.to_string(), pair.clone());

        Some(pair)
    }
}

#[async_trait]
impl TlsAccept for DynamicCertResolver {
    async fn certificate_callback(&self, ssl: &mut pingora_core::protocols::tls::TlsRef) -> () {
        let domain = match ssl.servername(ssl::NameType::HOST_NAME) {
            Some(name) => name.to_string(),
            None => {
                warn!("tls handshake missing server name");
                return;
            }
        };

        match self.load_cert(&domain).await {
            Some((cert, key)) => {
                if let Err(error) = ext::ssl_use_certificate(ssl, &cert) {
                    warn!(error = %error, domain = %domain, "failed to set tls certificate");
                    return;
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
impl ProxyHttp for ZnskrProxy {
    type CTX = ProxyCtx;

    fn new_ctx(&self) -> Self::CTX {
        ProxyCtx {
            upstream_addr: None,
            upstream_selection: None,
            is_websocket: false,
            is_grpc: false,
            is_sse: false,
        }
    }

    /// Called before connecting to upstream - handles routing, ACME, and protocol detection
    async fn request_filter(&self, session: &mut Session, ctx: &mut Self::CTX) -> Result<bool> {
        let req_header = session.req_header();
        let path = req_header.uri.path();
        // try Host header first, then :authority pseudo-header (HTTP/2), then URI host
        let host = req_header
            .headers
            .get("host")
            .and_then(|h| h.to_str().ok())
            .or_else(|| req_header.uri.host())
            .or_else(|| req_header.uri.authority().map(|a| a.as_str()))
            .map(|h| h.split(':').next().unwrap_or(h))
            .unwrap_or("");

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
                header.insert_header("Content-Length", key_auth.len().to_string())?;
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
        let is_tls = session.digest().map(|d| d.ssl_digest.is_some()).unwrap_or(false);
        let https_required = if host.is_empty() {
            false
        } else if host == self.base_domain {
            true
        } else if let Some(route) = self.routes.get_route(host) {
            route.ssl_enabled
        } else {
            false
        };

        if !is_tls && https_required {
            if self.has_certificate(host) {
                let uri = req_header.uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
                let redirect_url = format!("https://{}{}", host, uri);
                info!(host = %host, "redirecting http to https");

                let mut header = ResponseHeader::build(301, None)?;
                header.insert_header("Location", &redirect_url)?;
                header.insert_header("Content-Length", "0")?;
                session.write_response_header(Box::new(header), true).await?;
            } else {
                let body = "https required; certificate provisioning in progress";
                let mut header = ResponseHeader::build(426, None)?;
                header.insert_header("Content-Type", "text/plain")?;
                header.insert_header("Content-Length", body.len().to_string())?;
                session
                    .write_response_header(Box::new(header), false)
                    .await?;
                session.write_response_body(Some(body.into()), true).await?;
            }

            return Ok(true);
        }

        if host == self.base_domain && (path.starts_with("/api") || path.starts_with("/git")) {
            ctx.upstream_addr = Some(self.api_upstream.clone());
            ctx.upstream_selection = None;
            return Ok(false);
        }

        // Find route for this host
        match self.routes.select_upstream(host) {
            Some(selection) => {
                ctx.upstream_addr = Some(selection.address());
                ctx.upstream_selection = Some(selection);
                Ok(false) // Continue to upstream
            }
            None => {
                // serve embedded static assets only for the base domain
                if host == self.base_domain {
                    if let Some(asset) = crate::static_files::load_static(path) {
                        let mut header = ResponseHeader::build(200, None)?;
                        header.insert_header("Content-Type", asset.content_type)?;
                        header.insert_header("Content-Length", asset.data.len().to_string())?;
                        session
                            .write_response_header(Box::new(header), false)
                            .await?;
                        session
                            .write_response_body(Some(Bytes::from(asset.data)), true)
                            .await?;
                        return Ok(true);
                    }
                }

                warn!(host = %host, "no route found");

                // Send 404 response
                let body = "no route found";
                let mut header = ResponseHeader::build(404, None)?;
                header.insert_header("Content-Type", "text/plain")?;
                header.insert_header("Content-Length", body.len().to_string())?;
                session
                    .write_response_header(Box::new(header), false)
                    .await?;
                session
                    .write_response_body(Some(body.into()), true)
                    .await?;

                Ok(true) // Request handled
            }
        }
    }

    /// Modify request before forwarding to upstream
    async fn upstream_request_filter(
        &self,
        _session: &mut Session,
        upstream_request: &mut RequestHeader,
        ctx: &mut Self::CTX,
    ) -> Result<()> {
        // For WebSocket, ensure connection headers are preserved
        if ctx.is_websocket {
            // Pingora handles WebSocket upgrades natively, but ensure headers are passed
            upstream_request.insert_header("X-Forwarded-Proto", "http")?;
        }

        // For gRPC, ensure proper headers
        if ctx.is_grpc {
            upstream_request.insert_header("X-Forwarded-Proto", "http")?;
        }

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
        let addr = ctx
            .upstream_addr
            .as_ref()
            .ok_or_else(|| Error::explain(ErrorType::InternalError, "no upstream configured"))?;

        let mut resolved = addr
            .to_socket_addrs()
            .map_err(|error| {
                Error::explain(
                    ErrorType::InternalError,
                    format!("failed to resolve upstream address: {}", error),
                )
            })?;

        let socket_addr = resolved.next().ok_or_else(|| {
            Error::explain(ErrorType::InternalError, "no upstream address resolved")
        })?;

        // Create peer - Pingora handles HTTP/1.1 upgrade for WebSocket
        // and HTTP/2 for gRPC automatically based on negotiation
        let mut peer = HttpPeer::new(socket_addr, false, String::new());

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
    async fn logging(&self, session: &mut Session, _e: Option<&Error>, ctx: &mut Self::CTX) {
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
    }
}

/// Creates and runs the pingora proxy server
pub fn create_proxy_server(
    routes: RouteManager,
    challenges: ChallengeStore,
    http_port: u16,
    https_port: u16,
    certs_dir: PathBuf,
    base_domain: String,
    api_upstream: String,
) -> anyhow::Result<Server> {
    let mut server = Server::new(None).unwrap();
    server.bootstrap();

    let proxy = ZnskrProxy::new(routes, challenges, base_domain, api_upstream, certs_dir.clone());

    let mut proxy_service = pingora_proxy::http_proxy_service(&server.configuration, proxy);

    proxy_service.add_tcp(&format!("0.0.0.0:{}", http_port));

    let resolver = DynamicCertResolver::new(certs_dir);
    let callbacks: TlsAcceptCallbacks = Box::new(resolver);
    let mut tls_settings = TlsSettings::with_callbacks(callbacks)?;
    tls_settings.enable_h2();
    proxy_service.add_tls_with_settings(&format!("0.0.0.0:{}", https_port), None, tls_settings);

    server.add_service(proxy_service);

    Ok(server)
}
