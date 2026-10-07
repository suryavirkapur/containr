//! axum server setup

use axum::http::{
    header::{AUTHORIZATION, CONTENT_TYPE},
    HeaderValue, Method,
};
use axum::{
    routing::{delete, get, patch, post, put},
    Router,
};
use std::collections::HashSet;
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
use crate::domain::services::{run_database_action, ServiceAction};
use crate::github::DeploymentJob;
use crate::handlers::deployments::create_and_queue_deployment;
use crate::handlers::{
    auth, certificates, containers, gate, github_app, github_repos, health,
    projects, registries, settings, storage, system, updates, webhooks,
    websocket,
};
use crate::openapi::ApiDoc;
use crate::routes;
use crate::state::AppState;
use containr_common::managed_services::ServiceStatus;
use containr_common::models::{
    App, Deployment, DeploymentSource, DeploymentStatus,
};
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
    let config_snapshot = config.read().await.clone();

    // create shared state
    let state = AppState::new(
        config.clone(),
        config_path,
        data_dir,
        db,
        tx,
        proxy_update_tx,
        cert_request_tx,
    )?;
    let replay_state = state.clone();

    // cors layer
    let cors = if config_snapshot.security.cors_allowed_origins.is_empty() {
        CorsLayer::new()
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PATCH,
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
                Method::PATCH,
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
        .route("/api/system/info", get(system::get_system_info))
        .route("/api/system/disk-usage", get(system::get_disk_usage))
        .route("/api/system/cleanup", post(system::run_cleanup))
        .route("/api/system/backup", get(system::download_backup))
        .route(
            "/api/system/update",
            get(updates::check_update).post(updates::install_update),
        )
        // openapi docs
        .merge(Scalar::with_url("/api/docs", ApiDoc::openapi()))
        // services (canonical)
        .merge(routes::services::router())
        // service certificates and websockets
        .route(
            "/api/services/{id}/certificate",
            get(certificates::get_certificate),
        )
        .route(
            "/api/services/{id}/certificate/reissue",
            post(certificates::reissue_certificate),
        )
        .route(
            "/api/services/{id}/logs/ws",
            get(websocket::container_logs_ws),
        )
        .route(
            "/api/services/{id}/deployments/{deployment_id}/logs/ws",
            get(websocket::deployment_logs_ws),
        )
        // auth
        .route("/api/auth/status", get(auth::status))
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/me", get(auth::me))
        .route("/api/auth/github", get(auth::github_start))
        .route("/api/auth/github/callback", get(auth::github_callback))
        .route(
            "/api/auth/github/link",
            post(auth::github_link_start).delete(auth::github_unlink),
        )
        .route("/api/admin/users", get(auth::list_users))
        .route("/api/admin/users", post(auth::create_user))
        .route("/api/admin/users/{id}", delete(auth::delete_user))
        .route("/api/auth/password", post(auth::change_password))
        .route("/api/gate/pass", post(gate::create_gate_pass))
        // projects
        .route("/api/projects", get(projects::list_projects))
        .route("/api/projects/{id}", patch(projects::update_project))
        // container registries
        .route("/api/registries", get(registries::list_registries))
        .route("/api/registries", post(registries::create_registry))
        .route("/api/registries/{id}", delete(registries::delete_registry))
        // settings
        .route("/api/settings", get(settings::get_settings))
        .route("/api/settings", put(settings::update_settings))
        .route(
            "/api/settings/certificate",
            post(settings::issue_dashboard_certificate),
        )
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
        .route("/webhooks/deploy/{id}", post(webhooks::deploy_webhook))
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
        replay_interrupted_deployments(replay_state.clone()).await;
        restore_missing_containers(&replay_state).await;
    });

    Ok(rx)
}

/// brings back apps and databases that are recorded as running but whose
/// containers no longer exist (removed by hand, lost with docker's data,
/// ...). without this they stay "running" in the ui while nothing serves
/// traffic. services stopped on purpose are left alone.
async fn restore_missing_containers(state: &AppState) {
    let docker = containr_runtime::DockerContainerManager::new();
    if docker.is_stub() {
        return;
    }
    let containers: HashSet<String> = match docker.list_containers().await {
        Ok(containers) => containers.into_iter().map(|c| c.id).collect(),
        Err(error) => {
            tracing::warn!(error = %error, "skipping container restore");
            return;
        }
    };

    let apps = match state.db.list_apps() {
        Ok(apps) => apps,
        Err(error) => {
            tracing::warn!(error = %error, "skipping container restore");
            return;
        }
    };
    for app in apps {
        if let Err(error) = restore_app(state, &app, &containers).await {
            tracing::warn!(
                app_id = %app.id,
                error = ?error,
                "failed to redeploy app with missing containers"
            );
        }
    }

    let users = match state.db.list_users() {
        Ok(users) => users,
        Err(error) => {
            tracing::warn!(error = %error, "skipping database restore");
            return;
        }
    };
    for user in users {
        let Ok(databases) = state.db.list_managed_databases_by_owner(user.id)
        else {
            continue;
        };
        for mut database in databases {
            let name = format!("containr-db-{}", database.id);
            if database.status != ServiceStatus::Running
                || containers.contains(&name)
            {
                continue;
            }
            tracing::warn!(
                database = %database.name,
                "database container is missing; starting it again"
            );
            if let Err(error) =
                run_database_action(state, ServiceAction::Start, &mut database)
                    .await
            {
                tracing::warn!(
                    database = %database.name,
                    error = ?error,
                    "failed to start database with missing container"
                );
            }
        }
    }
}

async fn restore_app(
    state: &AppState,
    app: &App,
    containers: &HashSet<String>,
) -> std::result::Result<(), String> {
    let mut deployments = state
        .db
        .list_deployments_by_app(app.id)
        .map_err(|e| e.to_string())?;
    deployments.sort_by_key(|deployment| deployment.created_at);
    // only the newest deployment counts; a pending or failed one is
    // handled by replay or by the user
    let Some(current) = deployments.last() else {
        return Ok(());
    };
    if current.status != DeploymentStatus::Running {
        return Ok(());
    }
    let missing = missing_service_names(app, current, containers);
    if missing.is_empty() {
        return Ok(());
    }
    if app.requires_source_checkout() && app.github_url.trim().is_empty() {
        tracing::warn!(
            app_id = %app.id,
            services = ?missing,
            "containers are missing but the app has no repo to rebuild from"
        );
        return Ok(());
    }

    tracing::warn!(
        app = %app.name,
        services = ?missing,
        "containers are missing; redeploying"
    );
    create_and_queue_deployment(
        state,
        app.owner_id,
        app,
        "redeploy".to_string(),
        Some("redeployed: containers were missing".to_string()),
        app.branch.clone(),
        app.rollout_strategy,
        None,
        None,
        false,
    )
    .await
    .map(|_| ())
    .map_err(|(_, body)| body.0.error)
}

/// long-running services the deployment runs that have no container,
/// running or stopped
fn missing_service_names(
    app: &App,
    deployment: &Deployment,
    containers: &HashSet<String>,
) -> Vec<String> {
    app.services
        .iter()
        .filter(|service| !service.is_cron_job())
        .filter(|service| {
            deployment.service_deployments.iter().any(|sd| {
                sd.service_id == service.id
                    && sd.status == DeploymentStatus::Running
            })
        })
        .filter(|service| {
            // containr-{app}-{service}-{replica}-{deployment}
            let prefix = format!("containr-{}-{}-", app.id, service.name);
            !containers.iter().any(|name| {
                name.strip_prefix(&prefix).is_some_and(|rest| {
                    rest.starts_with(|c: char| c.is_ascii_digit())
                })
            })
        })
        .map(|service| service.name.clone())
        .collect()
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
        if let Err(error) =
            replay_deployment_job(&state, &app, &deployment).await
        {
            tracing::warn!(
                app_id = %app.id,
                deployment_id = %deployment.id,
                error = %error,
                "failed to replay interrupted deployment"
            );
            mark_replayed_deployment_failed(
                &state.db,
                deployment.id,
                &error.to_string(),
            );
        }
    }
}

fn collect_interrupted_deployments(
    db: &Database,
) -> Result<Vec<(App, Deployment)>> {
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
    // uploaded sources are removed once their job ends and the target
    // service isn't persisted, so they can't be replayed
    if let Some(source_url) = deployment.source_url.as_deref() {
        if containr_runtime::worker::is_uploaded_source(
            &state.data_dir.join("builds"),
            std::path::Path::new(source_url),
        ) {
            anyhow::bail!(
                "uploaded source deployments cannot be replayed after restart"
            );
        }
    }

    // image-only apps have nothing to check out
    let source = if !app.requires_source_checkout() {
        DeploymentSource::None
    } else {
        let source_url = deployment
            .source_url
            .clone()
            .filter(|url| !url.trim().is_empty())
            .unwrap_or_else(|| app.github_url.clone());
        if source_url.trim().is_empty() {
            anyhow::bail!("deployment has no source url to recover");
        }
        resolve_source_deployment_source(state, app.owner_id, &source_url)
            .await
            .map_err(|(status, error)| {
                anyhow::anyhow!(
                    "source recovery failed with status {}: {}",
                    status,
                    error.error
                )
            })?
    };

    state.db.append_deployment_log(
        deployment.id,
        "deployment requeued after containr restart",
    )?;

    let job = DeploymentJob {
        deployment_id: deployment.id,
        app_id: app.id,
        commit_sha: deployment.commit_sha.clone(),
        commit_message: deployment.commit_message.clone(),
        branch: deployment.branch.clone(),
        source,
        rollout_strategy: deployment.rollout_strategy,
        rollback_from_deployment_id: deployment.rollback_from_deployment_id,
        local_build_service_id: None,
    };

    state.deployment_tx.send(job).await.map_err(|error| {
        anyhow::anyhow!("failed to requeue deployment: {}", error)
    })?;

    Ok(())
}

fn mark_replayed_deployment_failed(
    db: &Database,
    deployment_id: uuid::Uuid,
    message: &str,
) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use containr_common::models::{ContainerService, ServiceDeployment};
    use uuid::Uuid;

    fn app_with(names: &[&str]) -> App {
        let mut app = App::new("demo".to_string(), String::new(), Uuid::nil());
        app.services = names
            .iter()
            .map(|name| {
                ContainerService::new(
                    app.id,
                    name.to_string(),
                    "nginx:alpine".to_string(),
                    80,
                )
            })
            .collect();
        app
    }

    fn running(app: &App, status: DeploymentStatus) -> Deployment {
        let mut deployment = Deployment::new(app.id, "initial".to_string());
        deployment.status = DeploymentStatus::Running;
        deployment.service_deployments = app
            .services
            .iter()
            .map(|service| {
                let mut sd =
                    ServiceDeployment::new(service.id, deployment.id, 0);
                sd.status = status;
                sd
            })
            .collect();
        deployment
    }

    #[test]
    fn finds_services_whose_containers_are_gone() {
        let app = app_with(&["web", "web-worker"]);
        let deployment = running(&app, DeploymentStatus::Running);
        // only web-worker's container exists; its name shares the
        // "web-" prefix but must not count for web
        let containers = HashSet::from([format!(
            "containr-{}-web-worker-0-abcd1234",
            app.id
        )]);

        assert_eq!(
            missing_service_names(&app, &deployment, &containers),
            vec!["web".to_string()]
        );
    }

    #[test]
    fn ignores_services_stopped_on_purpose() {
        let app = app_with(&["web"]);
        let deployment = running(&app, DeploymentStatus::Stopped);
        assert!(missing_service_names(&app, &deployment, &HashSet::new())
            .is_empty());
    }
}
