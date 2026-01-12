//! Pingora-based reverse proxy implementation
//!
//! High-performance reverse proxy using Cloudflare's Pingora framework.
//! Supports dynamic routing, ACME challenges, TLS termination,
//! WebSocket upgrades, gRPC (HTTP/2), and Server-Sent Events.

use async_trait::async_trait;
use pingora_core::prelude::*;
use pingora_http::{RequestHeader, ResponseHeader};
use pingora_proxy::{ProxyHttp, Session};
use std::sync::Arc;
use tracing::{info, warn};

use crate::acme::ChallengeStore;
use crate::routes::RouteManager;

/// Context for each request
pub struct ProxyCtx {
    /// The upstream address to forward to
    upstream_addr: Option<String>,
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
}

impl ZnskrProxy {
    /// Creates a new pingora proxy
    pub fn new(routes: RouteManager, challenges: ChallengeStore) -> Self {
        Self {
            routes: Arc::new(routes),
            challenges: Arc::new(challenges),
        }
    }
}

#[async_trait]
impl ProxyHttp for ZnskrProxy {
    type CTX = ProxyCtx;

    fn new_ctx(&self) -> Self::CTX {
        ProxyCtx {
            upstream_addr: None,
            is_websocket: false,
            is_grpc: false,
            is_sse: false,
        }
    }

    /// Called before connecting to upstream - handles routing, ACME, and protocol detection
    async fn request_filter(&self, session: &mut Session, ctx: &mut Self::CTX) -> Result<bool> {
        let req_header = session.req_header();
        let path = req_header.uri.path();
        let host = req_header
            .headers
            .get("host")
            .and_then(|h| h.to_str().ok())
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

        // Check for ACME challenge
        if path.starts_with("/.well-known/acme-challenge/") {
            let token = path.trim_start_matches("/.well-known/acme-challenge/");
            if let Some(key_auth) = self.challenges.get(token) {
                info!(token = %token, "serving ACME challenge via pingora");

                // Send challenge response
                let mut header = ResponseHeader::build(200, None)?;
                header.insert_header("Content-Type", "text/plain")?;
                session
                    .write_response_header(Box::new(header), false)
                    .await?;
                session
                    .write_response_body(Some(key_auth.into()), true)
                    .await?;

                return Ok(true); // Request handled, don't forward
            }
        }

        // Find route for this host
        match self.routes.get_route(host) {
            Some(route) => {
                ctx.upstream_addr =
                    Some(format!("{}:{}", route.upstream_host, route.upstream_port));
                Ok(false) // Continue to upstream
            }
            None => {
                warn!(host = %host, "no route found");

                // Send 404 response
                let mut header = ResponseHeader::build(404, None)?;
                header.insert_header("Content-Type", "text/plain")?;
                session
                    .write_response_header(Box::new(header), false)
                    .await?;
                session
                    .write_response_body(Some("No route configured for this host".into()), true)
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

        // Create peer - Pingora handles HTTP/1.1 upgrade for WebSocket
        // and HTTP/2 for gRPC automatically based on negotiation
        let mut peer = HttpPeer::new(addr, false, String::new());

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
) -> Server {
    let mut server = Server::new(None).unwrap();
    server.bootstrap();

    let proxy = ZnskrProxy::new(routes, challenges);

    let mut proxy_service = pingora_proxy::http_proxy_service(&server.configuration, proxy);

    proxy_service.add_tcp(&format!("0.0.0.0:{}", http_port));

    server.add_service(proxy_service);

    server
}
