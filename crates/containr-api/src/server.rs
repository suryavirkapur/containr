//! axum server setup

use axum::http::{
    header::{AUTHORIZATION, CONTENT_TYPE},
    HeaderValue, Method,
};
use axum::{
    routing::{delete, get, post, put},
    Router,
};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::sync::RwLock;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;
use utoipa::OpenApi;
use utoipa_scalar::{Scalar, Servable};

use crate::deployment_source::resolve_source_deployment_source;
use crate::github::DeploymentJob;
use crate::handlers::{
    apps, auth, certificates, containers, databases, deployments, github_app, github_repos, health,
    projects, queues, settings, storage, system, webhooks, websocket,
};
use crate::openapi::ApiDoc;
use crate::state::AppState;
use containr_common::models::{App, Deployment, DeploymentStatus};
use containr_common::{Config, Database, Result};

/// runs the api server
pub async fn run_server(
    config: Arc<RwLock<Config>>,
    config_path: PathBuf,
    data_dir: PathBuf,
    db: Database,
    proxy_update_tx: Option<mpsc::Sender<containr_runtime::ProxyRouteUpdate>>,
    cert_request_tx: Option<mpsc::Sender<String>>,
) -> Result<mpsc::Receiver<DeploymentJob>> {
    // create deployment queue channel
    let (tx, rx) = mpsc::channel::<DeploymentJob>(100);

    // create shared state
    let state = AppState::new(
        config.clone(),
        config_path,
        data_dir,
        db,
        tx,
        proxy_update_tx,
        cert_request_tx,
    );
    let replay_state = state.clone();
    let config_snapshot = config.read().await.clone();

    // cors layer
    let cors = if config_snapshot.security.cors_allowed_origins.is_empty() {
        CorsLayer::new()
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_headers([AUTHORIZATION, CONTENT_TYPE])
    } else {
        let origins = config_snapshot
            .security
            .cors_allowed_origins
            .iter()
            .filter_map(|origin| origin.parse::<HeaderValue>().ok())
            .collect::<Vec<_>>();

        CorsLayer::new()
            .allow_origin(AllowOrigin::list(origins))
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_headers([AUTHORIZATION, CONTENT_TYPE])
    };

    // build router
    let app = Router::new()
        // health
        .route("/health", get(health::health))
        .route("/api/system/stats", get(system::get_system_stats))
        // openapi docs
        .merge(Scalar::with_url("/api/docs", ApiDoc::openapi()))
        // auth
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/github", get(auth::github_start))
        .route("/api/auth/github/callback", get(auth::github_callback))
        // settings
        .route("/api/settings", get(settings::get_settings))
        .route("/api/settings", put(settings::update_settings))
        .route(
            "/api/settings/certificate",
            post(settings::issue_dashboard_certificate),
        )
        // github oauth (legacy)
        .route("/api/github/status", get(github_repos::github_status))
        .route("/api/github/repos", get(github_repos::github_repos))
        .route(
            "/api/github/disconnect",
            post(github_repos::github_disconnect),
        )
        // github app integration
        .route("/api/github/app", get(github_app::get_github_app))
        .route("/api/github/app", delete(github_app::delete_github_app))
        .route(
            "/api/github/app/manifest",
            get(github_app::get_app_manifest),
        )
        .route(
            "/api/github/app/callback",
            get(github_app::github_app_callback),
        )
        .route(
            "/api/github/app/install/callback",
            get(github_app::github_install_callback),
        )
        .route("/api/github/app/repos", get(github_app::get_app_repos))
        // apps
        .route("/api/apps", get(apps::list_apps))
        .route("/api/apps", post(apps::create_app))
        .route("/api/apps/{id}", get(apps::get_app))
        .route("/api/apps/{id}", put(apps::update_app))
        .route("/api/apps/{id}", delete(apps::delete_app))
        .route("/api/apps/{id}/metrics", get(apps::get_app_metrics))
        .route(
            "/api/apps/{id}/services/{service_name}/mounts/backup",
            get(apps::backup_service_mounts),
        )
        .route(
            "/api/apps/{id}/services/{service_name}/mounts/restore",
            post(apps::restore_service_mounts),
        )
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
            "/api/apps/{app_id}/deployments/{id}/rollback",
            post(deployments::rollback_deployment),
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
        // projects
        .route("/api/projects", get(projects::list_projects))
        .route("/api/projects", post(projects::create_project))
        .route("/api/projects/{id}", get(projects::get_project))
        .route("/api/projects/{id}", put(projects::update_project))
        .route("/api/projects/{id}", delete(projects::delete_project))
        .route(
            "/api/projects/{id}/metrics",
            get(projects::get_project_metrics),
        )
        .route(
            "/api/projects/{id}/services/{service_name}/mounts/backup",
            get(projects::backup_service_mounts),
        )
        .route(
            "/api/projects/{id}/services/{service_name}/mounts/restore",
            post(projects::restore_service_mounts),
        )
        .route(
            "/api/projects/{id}/deployments",
            get(projects::list_deployments),
        )
        .route(
            "/api/projects/{id}/deployments",
            post(projects::trigger_deployment),
        )
        .route(
            "/api/projects/{project_id}/deployments/{id}",
            get(projects::get_deployment),
        )
        .route(
            "/api/projects/{project_id}/deployments/{id}/rollback",
            post(projects::rollback_deployment),
        )
        .route(
            "/api/projects/{project_id}/deployments/{id}/logs",
            get(projects::get_deployment_logs),
        )
        .route(
            "/api/projects/{id}/certificate",
            get(projects::get_certificate),
        )
        .route(
            "/api/projects/{id}/certificate/reissue",
            post(projects::reissue_certificate),
        )
        .route(
            "/api/projects/{id}/logs/ws",
            get(websocket::container_logs_ws),
        )
        .route(
            "/api/projects/{project_id}/deployments/{id}/logs/ws",
            get(websocket::deployment_logs_ws),
        )
        // containers
        .route("/api/containers", get(containers::list_containers))
        .route(
            "/api/containers/{id}/status",
            get(containers::get_container_status),
        )
        .route(
            "/api/containers/{id}/logs",
            get(containers::get_container_logs),
        )
        .route(
            "/api/containers/{id}/exec/token",
            post(containers::issue_exec_token),
        )
        .route(
            "/api/containers/{id}/exec/ws",
            get(containers::container_exec_ws),
        )
        .route(
            "/api/containers/{id}/mounts",
            get(containers::list_container_mounts),
        )
        .route(
            "/api/containers/{id}/files",
            get(containers::list_volume_entries),
        )
        .route(
            "/api/containers/{id}/files",
            delete(containers::delete_volume_entry),
        )
        .route(
            "/api/containers/{id}/files/download",
            get(containers::download_volume_entry),
        )
        .route(
            "/api/containers/{id}/files/upload",
            post(containers::upload_volume_entry),
        )
        .route(
            "/api/containers/{id}/files/mkdir",
            post(containers::create_volume_directory),
        )
        // managed databases
        .route("/api/databases", get(databases::list_databases))
        .route("/api/databases", post(databases::create_database))
        .route("/api/databases/{id}", get(databases::get_database))
        .route("/api/databases/{id}", delete(databases::delete_database))
        .route("/api/databases/{id}/start", post(databases::start_database))
        .route("/api/databases/{id}/stop", post(databases::stop_database))
        .route(
            "/api/databases/{id}/restart",
            post(databases::restart_database),
        )
        .route(
            "/api/databases/{id}/logs",
            get(databases::get_database_logs),
        )
        .route(
            "/api/databases/{id}/expose",
            post(databases::expose_database),
        )
        .route("/api/databases/{id}/pitr", post(databases::configure_pitr))
        .route(
            "/api/databases/{id}/proxy",
            post(databases::configure_proxy),
        )
        .route(
            "/api/databases/{id}/pitr/base-backup",
            post(databases::create_pitr_base_backup),
        )
        .route(
            "/api/databases/{id}/pitr/restore-point",
            post(databases::create_restore_point),
        )
        .route(
            "/api/databases/{id}/pitr/recover",
            post(databases::recover_database),
        )
        .route(
            "/api/databases/{id}/export",
            post(databases::export_database),
        )
        .route("/api/databases/{id}/backups", get(databases::list_backups))
        .route(
            "/api/databases/{id}/backups/download",
            get(databases::download_backup),
        )
        // managed queues
        .route("/api/queues", get(queues::list_queues))
        .route("/api/queues", post(queues::create_queue))
        .route("/api/queues/{id}", get(queues::get_queue))
        .route("/api/queues/{id}", delete(queues::delete_queue))
        .route("/api/queues/{id}/start", post(queues::start_queue))
        .route("/api/queues/{id}/stop", post(queues::stop_queue))
        .route("/api/queues/{id}/expose", post(queues::expose_queue))
        // storage buckets
        .route("/api/buckets", get(storage::list_buckets))
        .route("/api/buckets", post(storage::create_bucket))
        .route("/api/buckets/{id}", get(storage::get_bucket))
        .route(
            "/api/buckets/{id}/connection",
            get(storage::get_bucket_connection),
        )
        .route("/api/buckets/{id}", delete(storage::delete_bucket))
        // webhooks
        .route("/webhooks/github", post(webhooks::github_webhook))
        // static files fallback (spa)
        .fallback(crate::static_files::serve_static)
        // middleware
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state);

    let addr: SocketAddr = format!(
        "{}:{}",
        config_snapshot.server.host, config_snapshot.server.port
    )
    .parse()
    .expect("invalid server address");

    tracing::info!("api server listening on {}", addr);

    // spawn server
    tokio::spawn(async move {
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        axum::serve(listener, app).await.unwrap();
    });

    tokio::spawn(async move {
        replay_interrupted_deployments(replay_state).await;
    });

    Ok(rx)
}

async fn replay_interrupted_deployments(state: AppState) {
    let interrupted = match collect_interrupted_deployments(&state.db) {
        Ok(interrupted) => interrupted,
        Err(error) => {
            tracing::warn!(
                error = %error,
                "failed to enumerate interrupted deployments for startup replay"
            );
            return;
        }
    };

    if interrupted.is_empty() {
        return;
    }

    tracing::warn!(
        count = interrupted.len(),
        "replaying interrupted deployments after containr restart"
    );

    for (app, deployment) in interrupted {
        if let Err(error) = replay_deployment_job(&state, &app, &deployment).await {
            tracing::warn!(
                app_id = %app.id,
                deployment_id = %deployment.id,
                error = %error,
                "failed to replay interrupted deployment"
            );
            mark_replayed_deployment_failed(&state.db, deployment.id, &error.to_string());
        }
    }
}

fn collect_interrupted_deployments(db: &Database) -> Result<Vec<(App, Deployment)>> {
    let mut interrupted = Vec::new();

    for app in db.list_apps()? {
        let mut deployments = db.list_deployments_by_app(app.id)?;
        deployments.sort_by_key(|deployment| deployment.created_at);

        for deployment in deployments {
            if is_interrupted_deployment_status(deployment.status) {
                interrupted.push((app.clone(), deployment));
            }
        }
    }

    interrupted.sort_by_key(|(_, deployment)| deployment.created_at);
    Ok(interrupted)
}

async fn replay_deployment_job(
    state: &AppState,
    app: &App,
    deployment: &Deployment,
) -> anyhow::Result<()> {
    let source_url = deployment
        .source_url
        .clone()
        .unwrap_or_else(|| app.github_url.clone());
    let source = resolve_source_deployment_source(state, app.owner_id, &source_url)
        .await
        .map_err(|(status, error)| {
            anyhow::anyhow!(
                "source recovery failed with status {}: {}",
                status,
                error.error
            )
        })?;

    state
        .db
        .append_deployment_log(deployment.id, "deployment requeued after containr restart")?;

    let job = DeploymentJob {
        deployment_id: deployment.id,
        app_id: app.id,
        commit_sha: deployment.commit_sha.clone(),
        commit_message: deployment.commit_message.clone(),
        branch: deployment.branch.clone(),
        source,
        rollout_strategy: deployment.rollout_strategy,
        rollback_from_deployment_id: deployment.rollback_from_deployment_id,
    };

    state
        .deployment_tx
        .send(job)
        .await
        .map_err(|error| anyhow::anyhow!("failed to requeue deployment: {}", error))?;

    Ok(())
}

fn mark_replayed_deployment_failed(db: &Database, deployment_id: uuid::Uuid, message: &str) {
    let Ok(Some(mut deployment)) = db.get_deployment(deployment_id) else {
        return;
    };

    deployment.status = DeploymentStatus::Failed;
    deployment.finished_at = Some(chrono::Utc::now());
    let _ = db.append_deployment_log(
        deployment.id,
        &format!("startup replay failed: {}", message),
    );
    let _ = db.save_deployment(&deployment);
}

fn is_interrupted_deployment_status(status: DeploymentStatus) -> bool {
    matches!(
        status,
        DeploymentStatus::Pending
            | DeploymentStatus::Cloning
            | DeploymentStatus::Building
            | DeploymentStatus::Pushing
            | DeploymentStatus::Starting
    )
}
