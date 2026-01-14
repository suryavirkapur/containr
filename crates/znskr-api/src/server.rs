//! axum server setup

use axum::{
    routing::{delete, get, post, put},
    Router,
};
use std::net::SocketAddr;
use std::path::PathBuf;
use tokio::sync::mpsc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use utoipa::OpenApi;
use utoipa_scalar::{Scalar, Servable};

use crate::github::DeploymentJob;
use crate::handlers::{apps, auth, certificates, databases, deployments, health, settings, storage, webhooks, websocket};
use crate::openapi::ApiDoc;
use crate::state::AppState;
use znskr_common::{Config, Database, Result};

/// runs the api server
pub async fn run_server(
    config: Config,
    config_path: PathBuf,
    db: Database,
) -> Result<mpsc::Receiver<DeploymentJob>> {
    // create deployment queue channel
    let (tx, rx) = mpsc::channel::<DeploymentJob>(100);

    // create shared state
    let state = AppState::new(config.clone(), config_path, db, tx);

    // cors layer
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // build router
    let app = Router::new()
        // health
        .route("/health", get(health::health))
        // openapi docs
        .merge(Scalar::with_url("/api/docs", ApiDoc::openapi()))
        // auth
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/github/callback", get(auth::github_callback))
        // settings
        .route("/api/settings", get(settings::get_settings))
        .route("/api/settings", put(settings::update_settings))
        .route(
            "/api/settings/certificate",
            post(settings::issue_dashboard_certificate),
        )
        // apps
        .route("/api/apps", get(apps::list_apps))
        .route("/api/apps", post(apps::create_app))
        .route("/api/apps/{id}", get(apps::get_app))
        .route("/api/apps/{id}", put(apps::update_app))
        .route("/api/apps/{id}", delete(apps::delete_app))
        // deployments
        .route(
            "/api/apps/{id}/deployments",
            get(deployments::list_deployments),
        )
        .route(
            "/api/apps/{id}/deployments",
            post(deployments::trigger_deployment),
        )
        .route(
            "/api/apps/{app_id}/deployments/{id}",
            get(deployments::get_deployment),
        )
        .route(
            "/api/apps/{app_id}/deployments/{id}/logs",
            get(deployments::get_deployment_logs),
        )
        // certificates
        .route(
            "/api/apps/{id}/certificate",
            get(certificates::get_certificate),
        )
        .route(
            "/api/apps/{id}/certificate/reissue",
            post(certificates::reissue_certificate),
        )
        // websocket logs
        .route("/api/apps/{id}/logs/ws", get(websocket::container_logs_ws))
        .route(
            "/api/apps/{app_id}/deployments/{id}/logs/ws",
            get(websocket::deployment_logs_ws),
        )
        // managed databases
        .route("/api/databases", get(databases::list_databases))
        .route("/api/databases", post(databases::create_database))
        .route("/api/databases/{id}", get(databases::get_database))
        .route("/api/databases/{id}", delete(databases::delete_database))
        .route("/api/databases/{id}/start", post(databases::start_database))
        .route("/api/databases/{id}/stop", post(databases::stop_database))
        // storage buckets
        .route("/api/buckets", get(storage::list_buckets))
        .route("/api/buckets", post(storage::create_bucket))
        .route("/api/buckets/{id}", get(storage::get_bucket))
        .route("/api/buckets/{id}", delete(storage::delete_bucket))
        // webhooks
        .route("/webhooks/github", post(webhooks::github_webhook))
        // static files fallback (spa)
        .fallback(crate::static_files::serve_static)
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

