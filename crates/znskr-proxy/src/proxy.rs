//! hyper-based reverse proxy
//!
//! implements dynamic routing with acme challenge handling.

use bytes::Bytes;
use dashmap::DashMap;
use http_body_util::{combinators::BoxBody, BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tracing::{error, info, warn};

use crate::acme::ChallengeStore;
use crate::routes::RouteManager;

/// proxy server that handles incoming requests
pub struct ProxyServer {
    routes: RouteManager,
    challenges: ChallengeStore,
    http_port: u16,
    https_port: u16,
}

impl ProxyServer {
    // creates a new proxy server
    pub fn new(
        routes: RouteManager,
        challenges: ChallengeStore,
        http_port: u16,
        https_port: u16,
        _certs_dir: String,
    ) -> Self {
        Self {
            routes,
            challenges,
            http_port,
            https_port,
        }
    }

    // runs the http proxy server
    pub async fn run(self) -> anyhow::Result<()> {
        let addr: SocketAddr = format!("0.0.0.0:{}", self.http_port).parse()?;

        info!(addr = %addr, "starting http proxy server");

        let listener = TcpListener::bind(addr).await?;

        let routes = Arc::new(self.routes);
        let challenges = Arc::new(self.challenges);

        loop {
            let (stream, remote_addr) = match listener.accept().await {
                Ok(conn) => conn,
                Err(e) => {
                    error!(error = %e, "failed to accept connection");
                    continue;
                }
            };

            let routes = routes.clone();
            let challenges = challenges.clone();

            tokio::spawn(async move {
                let io = TokioIo::new(stream);

                let service = service_fn(move |req: Request<Incoming>| {
                    let routes = routes.clone();
                    let challenges = challenges.clone();
                    async move { handle_request(req, routes, challenges, remote_addr).await }
                });

                if let Err(e) = http1::Builder::new().serve_connection(io, service).await {
                    if !e.to_string().contains("error shutting down connection") {
                        error!(error = %e, "connection error");
                    }
                }
            });
        }
    }
}

/// handles an incoming request
async fn handle_request(
    req: Request<Incoming>,
    routes: Arc<RouteManager>,
    challenges: Arc<ChallengeStore>,
    _remote_addr: SocketAddr,
) -> Result<Response<BoxBody<Bytes, hyper::Error>>, Infallible> {
    let path = req.uri().path().to_string();

    // check for acme challenge
    if path.starts_with("/.well-known/acme-challenge/") {
        let token = path.trim_start_matches("/.well-known/acme-challenge/");
        if let Some(key_auth) = challenges.get(token) {
            info!(token = %token, "serving acme challenge");
            return Ok(Response::new(full(key_auth)));
        }
    }

    // get host header before moving req
    let host = req
        .headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .map(|h| h.split(':').next().unwrap_or(h).to_string())
        .unwrap_or_default();

    // lookup route
    match routes.get_route(&host) {
        Some(route) => {
            // proxy the request to upstream
            match proxy_request(req, &route.upstream_host, route.upstream_port).await {
                Ok(resp) => Ok(resp),
                Err(e) => {
                    error!(error = %e, host = %host, "proxy error");
                    Ok(error_response(StatusCode::BAD_GATEWAY, "bad gateway"))
                }
            }
        }
        None => {
            warn!(host = %host, "no route found");
            Ok(error_response(
                StatusCode::NOT_FOUND,
                "no route configured for this host",
            ))
        }
    }
}

/// proxies a request to an upstream server
async fn proxy_request(
    _req: Request<Incoming>,
    upstream_host: &str,
    upstream_port: u16,
) -> anyhow::Result<Response<BoxBody<Bytes, hyper::Error>>> {
    // for mvp, we use a simple http client to forward requests
    // in production, you'd want connection pooling and keep-alive

    let upstream_addr = format!("{}:{}", upstream_host, upstream_port);

    // connect to upstream
    let stream = match tokio::net::TcpStream::connect(&upstream_addr).await {
        Ok(s) => s,
        Err(e) => {
            return Err(anyhow::anyhow!("failed to connect to upstream: {}", e));
        }
    };

    // for now, return a simple response indicating the proxy works
    // full implementation would forward the request and stream back the response
    let body = format!("proxying to {} - stub implementation", upstream_addr);
    Ok(Response::new(full(body)))
}

/// creates an error response
fn error_response(status: StatusCode, message: &str) -> Response<BoxBody<Bytes, hyper::Error>> {
    Response::builder()
        .status(status)
        .body(full(message.to_string()))
        .unwrap()
}

/// creates a full body from a string
fn full<T: Into<Bytes>>(chunk: T) -> BoxBody<Bytes, hyper::Error> {
    Full::new(chunk.into())
        .map_err(|never| match never {})
        .boxed()
}

/// creates an empty body
fn _empty() -> BoxBody<Bytes, hyper::Error> {
    Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed()
}
