//! axum server setup

use axum::{
    routing::{delete, get, post, put},
    Router,
};
use std::net::SocketAddr;
use tokio::sync::mpsc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::github::DeploymentJob;
use crate::handlers::{apps, auth, deployments, health, webhooks};
use crate::state::AppState;
use znskr_common::{Config, Database, Result};

/// runs the api server
pub async fn run_server(config: Config, db: Database) -> Result<mpsc::Receiver<DeploymentJob>> {
    // create deployment queue channel
    let (tx, rx) = mpsc::channel::<DeploymentJob>(100);

    // create shared state
    let state = AppState::new(config.clone(), db, tx);

    // cors layer
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // build router
    let app = Router::new()
        // health
        .route("/health", get(health::health))
        // auth
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/github/callback", get(auth::github_callback))
        // apps
        .route("/api/apps", get(apps::list_apps))
        .route("/api/apps", post(apps::create_app))
        .route("/api/apps/:id", get(apps::get_app))
        .route("/api/apps/:id", put(apps::update_app))
        .route("/api/apps/:id", delete(apps::delete_app))
        // deployments
        .route("/api/apps/:id/deployments", get(deployments::list_deployments))
        .route("/api/apps/:id/deployments", post(deployments::trigger_deployment))
        .route("/api/apps/:app_id/deployments/:id", get(deployments::get_deployment))
        .route("/api/apps/:app_id/deployments/:id/logs", get(deployments::get_deployment_logs))
        // webhooks
        .route("/webhooks/github", post(webhooks::github_webhook))
        // middleware
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state);

    let addr: SocketAddr = format!("{}:{}", config.server.host, config.server.port)
        .parse()
        .expect("invalid server address");

    tracing::info!("api server listening on {}", addr);

    // spawn server
    tokio::spawn(async move {
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        axum::serve(listener, app).await.unwrap();
    });

    Ok(rx)
}
