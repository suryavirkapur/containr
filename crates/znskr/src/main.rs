//! znskr - platform as a service for docker containers
//!
//! this is the main binary that orchestrates all znskr services:
//! - api server (axum)
//! - deployment worker (docker)
//! - reverse proxy (pingora)

use std::collections::HashSet;
use std::path::PathBuf;

use clap::Parser;
use tracing::{info, warn, Level};
use tracing_subscriber::FmtSubscriber;

use znskr_common::{Config, Database};

/// znskr paas command line interface
#[derive(Parser, Debug)]
#[command(name = "znskr")]
#[command(about = "a rust-native paas for docker containers")]
#[command(version)]
struct Args {
    // config file path
    #[arg(short, long, default_value = "znskr.toml")]
    config: PathBuf,

    // data directory
    #[arg(short, long, default_value = "./data")]
    data_dir: PathBuf,

    // api server port
    #[arg(long, default_value = "3000")]
    api_port: u16,

    // http proxy port
    #[arg(long, default_value = "80")]
    http_port: u16,

    // https proxy port
    #[arg(long, default_value = "443")]
    https_port: u16,

    // log level
    #[arg(long, default_value = "info")]
    log_level: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    // setup logging
    let log_level = match args.log_level.as_str() {
        "trace" => Level::TRACE,
        "debug" => Level::DEBUG,
        "info" => Level::INFO,
        "warn" => Level::WARN,
        "error" => Level::ERROR,
        _ => Level::INFO,
    };

    let subscriber = FmtSubscriber::builder()
        .with_max_level(log_level)
        .with_target(false)
        .compact()
        .finish();

    tracing::subscriber::set_global_default(subscriber)?;

    info!("starting znskr v{}", env!("CARGO_PKG_VERSION"));

    // load or create config
    let config = load_or_create_config(&args).await?;

    // create data directory
    tokio::fs::create_dir_all(&args.data_dir).await?;

    // open database
    let db_path = args.data_dir.join("znskr.db");
    let db = Database::open(db_path.to_str().unwrap())?;
    info!(path = %db_path.display(), "database opened");

    // create route manager and challenge store for proxy
    let routes = znskr_proxy::RouteManager::new();
    let challenges = znskr_proxy::acme::ChallengeStore::new();

    // Load existing routes from database (async)
    // Run in a blocking context since we're in main before async starts
    let routes_clone = routes.clone();
    let db_clone = db.clone();
    let algorithm = config.proxy.load_balance;
    let base_domain_clone = config.proxy.base_domain.clone();
    tokio::spawn(async move {
        load_routes_from_db(&db_clone, &routes_clone, algorithm, &base_domain_clone).await;
    });

    // create certificate request channel (shared between api and proxy)
    let (cert_request_tx, mut cert_request_rx) = tokio::sync::mpsc::channel::<String>(64);

    // start api server and get deployment queue receiver
    let deployment_rx = znskr_api::run_server(
        config.clone(),
        args.config.clone(),
        db.clone(),
        Some(cert_request_tx.clone()),
    )
    .await?;
    info!(port = %config.server.port, "api server started");
    let acme_email = config.acme.email.clone();
    let acme_staging = config.acme.staging;
    let acme_certs_dir = PathBuf::from(config.acme.certs_dir.clone());
    let acme_base_domain = config.proxy.base_domain.clone();
    let acme_db = db.clone();
    let acme_challenges = challenges.clone();
    tokio::spawn(async move {
        let acme_enabled = !acme_email.is_empty();
        let acme_manager = if acme_enabled {
            Some(znskr_proxy::acme::AcmeManager::new(
                acme_db.clone(),
                acme_certs_dir,
                acme_email,
                acme_staging,
                acme_challenges,
            ))
        } else {
            None
        };
        if let Some(manager) = acme_manager.as_ref() {
            if !acme_base_domain.is_empty() {
                match acme_db.get_certificate(&acme_base_domain) {
                    Ok(Some(_)) => {}
                    Ok(None) => {
                        info!(domain = %acme_base_domain, "issuing base domain certificate");
                        if let Err(error) = manager.ensure_certificate(&acme_base_domain).await {
                            warn!(
                                domain = %acme_base_domain,
                                error = %error,
                                "base domain certificate issuance failed"
                            );
                        }
                    }
                    Err(error) => {
                        warn!(
                            domain = %acme_base_domain,
                            error = %error,
                            "failed to check base domain certificate"
                        );
                    }
                }
            }
        }
        let mut in_flight = HashSet::new();
        let mut blocked = HashSet::new();
        let mut logged_disabled = false;

        while let Some(domain) = cert_request_rx.recv().await {
            if domain.is_empty() {
                continue;
            }

            let manager = match &acme_manager {
                Some(manager) => manager,
                None => {
                    if !logged_disabled {
                        warn!("acme disabled: email not set");
                        logged_disabled = true;
                    }
                    continue;
                }
            };

            let allowed = match acme_db.get_app_by_domain(&domain) {
                Ok(Some(_)) => true,
                Ok(None) => domain == acme_base_domain,
                Err(error) => {
                    warn!(
                        domain = %domain,
                        error = %error,
                        "failed to check domain for acme issuance"
                    );
                    false
                }
            };
            if !allowed {
                if !blocked.contains(&domain) {
                    warn!(domain = %domain, "skipping acme issuance for unknown domain");
                    blocked.insert(domain.clone());
                }
                continue;
            }

            if in_flight.contains(&domain) {
                continue;
            }

            in_flight.insert(domain.clone());

            if let Err(error) = manager.ensure_certificate(&domain).await {
                warn!(
                    domain = %domain,
                    error = %error,
                    "certificate issuance failed"
                );
            }

            in_flight.remove(&domain);
        }
    });

    // start pingora proxy server in background thread
    // pingora has its own runtime so we run it in a separate thread
    let proxy_routes = routes.clone();
    let proxy_challenges = challenges.clone();
    let http_port = config.proxy.http_port;
    let https_port = config.proxy.https_port;
    let certs_dir = PathBuf::from(config.acme.certs_dir.clone());
    let base_domain = config.proxy.base_domain.clone();
    let base_domain_for_proxy = base_domain.clone();
    let api_host = resolve_api_host(&config.server.host);
    let api_upstream = format!("{}:{}", api_host, config.server.port);

    std::thread::spawn(move || {
        let server = znskr_proxy::pingora_proxy::create_proxy_server(
            proxy_routes,
            proxy_challenges,
            http_port,
            https_port,
            certs_dir,
            base_domain_for_proxy,
            api_upstream,
        );
        match server {
            Ok(server) => server.run_forever(),
            Err(error) => tracing::error!(error = %error, "failed to start pingora proxy"),
        }
    });

    info!(
        http = %config.proxy.http_port,
        https = %config.proxy.https_port,
        "pingora proxy server started"
    );

    // start deployment worker
    let work_dir = args.data_dir.join("builds");

    let (proxy_update_tx, mut proxy_update_rx) =
        tokio::sync::mpsc::channel::<znskr_runtime::ProxyRouteUpdate>(64);

    let proxy_routes_for_updates = routes.clone();
    let proxy_db_for_updates = db.clone();
    let proxy_algorithm = config.proxy.load_balance;
    tokio::spawn(async move {
        while let Some(update) = proxy_update_rx.recv().await {
            match update {
                znskr_runtime::ProxyRouteUpdate::RefreshApp { app_id } => {
                    let routes = proxy_routes_for_updates.clone();
                    let db = proxy_db_for_updates.clone();
                    let base_domain = base_domain.clone();

                    // connect to docker for route refresh
                    let docker = match bollard::Docker::connect_with_socket_defaults() {
                        Ok(d) => d,
                        Err(e) => {
                            tracing::warn!("failed to connect to docker for route refresh: {}", e);
                            continue;
                        }
                    };

                    refresh_routes_for_app(
                        &db,
                        &routes,
                        app_id,
                        proxy_algorithm,
                        &base_domain,
                        &docker,
                    )
                    .await;
                }
            }
        }
    });

    let worker =
        znskr_runtime::DeploymentWorker::new(db.clone(), work_dir, Some(proxy_update_tx)).await?;
    let stub_mode = worker.is_stub();
    tokio::spawn(async move {
        worker.run(deployment_rx).await;
    });
    if stub_mode {
        info!("deployment worker started (stub mode - docker not available)");
    } else {
        info!("deployment worker started (docker connected)");
    }

    info!("znskr is ready");
    info!("api: http://{}:{}", config.server.host, config.server.port);
    info!("proxy: http://0.0.0.0:{}", config.proxy.http_port);

    // keep running
    tokio::signal::ctrl_c().await?;
    info!("shutting down...");

    // flush database
    db.flush()?;

    Ok(())
}

/// loads config from file or creates default
async fn load_or_create_config(args: &Args) -> anyhow::Result<Config> {
    if args.config.exists() {
        let content = tokio::fs::read_to_string(&args.config).await?;
        let config: Config = toml::from_str(&content)?;
        info!(path = %args.config.display(), "loaded config");
        Ok(config)
    } else {
        let mut config = Config::default();
        config.server.port = args.api_port;
        config.proxy.http_port = args.http_port;
        config.proxy.https_port = args.https_port;
        config.database.path = args.data_dir.join("znskr.db").to_string_lossy().to_string();
        config.acme.certs_dir = args.data_dir.join("certs").to_string_lossy().to_string();

        // save default config as toml
        let content = toml::to_string_pretty(&config)?;
        tokio::fs::write(&args.config, &content).await?;
        info!(path = %args.config.display(), "created default config");

        Ok(config)
    }
}

/// loads routes from database for all apps with domains
async fn load_routes_from_db(
    db: &znskr_common::Database,
    routes: &znskr_proxy::RouteManager,
    algorithm: znskr_common::config::LoadBalanceAlgorithm,
    base_domain: &str,
) {
    let docker = match bollard::Docker::connect_with_socket_defaults() {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!("failed to connect to docker for routes: {}", e);
            return;
        }
    };

    let mut filters: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    filters.insert("name".to_string(), vec!["znskr-".to_string()]);

    let options = bollard::query_parameters::ListContainersOptions {
        all: false,
        filters: Some(filters),
        ..Default::default()
    };

    let containers = match docker.list_containers(Some(options)).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("failed to list containers for routes: {}", e);
            return;
        }
    };

    let mut apps = HashSet::new();
    for container in containers {
        if let Some(names) = container.names {
            for name in names {
                let name = name.trim_start_matches('/');
                if let Some(app_id) = parse_app_id_from_container_name(name) {
                    apps.insert(app_id);
                }
            }
        }
    }

    for app_id in apps {
        refresh_routes_for_app(db, routes, app_id, algorithm, base_domain, &docker).await;
    }
}

async fn refresh_routes_for_app(
    db: &znskr_common::Database,
    routes: &znskr_proxy::RouteManager,
    app_id: uuid::Uuid,
    algorithm: znskr_common::config::LoadBalanceAlgorithm,
    base_domain: &str,
    docker: &bollard::Docker,
) {
    let app = match db.get_app(app_id) {
        Ok(Some(app)) => app,
        _ => return,
    };

    let mut upstreams = Vec::new();
    let network_name = format!("znskr-{}", app.id);

    // list containers for this app
    let mut filters: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    filters.insert("name".to_string(), vec![format!("znskr-{}", app.id)]);

    let options = bollard::query_parameters::ListContainersOptions {
        all: false,
        filters: Some(filters),
        ..Default::default()
    };

    let containers = match docker.list_containers(Some(options)).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(app_id = %app.id, "failed to list containers: {}", e);
            return;
        }
    };

    if app.has_services() {
        let service = match select_exposed_service(&app) {
            Some(service) => service,
            None => {
                tracing::warn!(
                    app_id = %app.id,
                    "no exposed service selected for multi-service app"
                );
                return;
            }
        };

        let active_service_container_ids = db
            .get_latest_deployment(app.id)
            .ok()
            .flatten()
            .filter(|d| d.status == znskr_common::models::DeploymentStatus::Running)
            .map(|d| {
                d.service_deployments
                    .into_iter()
                    .filter(|sd| sd.service_id == service.id)
                    .filter_map(|sd| sd.container_id)
                    .collect::<HashSet<_>>()
            })
            .filter(|set| !set.is_empty());

        let prefix = format!("znskr-{}-{}-", app.id, service.name);

        for container in &containers {
            if let Some(names) = &container.names {
                for name in names {
                    let name = name.trim_start_matches('/');
                    if let Some(active_ids) = &active_service_container_ids {
                        if !active_ids.contains(name) {
                            continue;
                        }
                    } else if !name.starts_with(&prefix) || name.is_empty() {
                        continue;
                    }

                    if let Some(ip) = get_container_ip(docker, name, &network_name).await {
                        upstreams.push(znskr_proxy::routes::Upstream {
                            host: ip,
                            port: service.port,
                        });
                    }
                }
            }
        }
    } else {
        let expected_name = format!("znskr-{}", app.id);

        for container in &containers {
            if let Some(names) = &container.names {
                for name in names {
                    let name = name.trim_start_matches('/');

                    // if route is being refreshed due to a deployment, we might have a specific container ID
                    // from the running deployment. we should prioritize that.
                    // however, `list_containers` here is generic.
                    // instead, we should check if the container name matches what we expect from the deployment

                    // check against specific container id if we have one
                    // we don't have the deployment object here readily available in this loop context
                    // but we can trust the logic that if a container exists and matches the prefix, it's a candidate

                    // Logic update:
                    // 1. If the app has a specific 'running' deployment with a container_id, we should try to match that.
                    // 2. Otherwise, fallback to any container with correctly matching name.

                    // To do this properly, we need to know the active container ID.
                    // We can fetch the latest running deployment.

                    // Refined Logic:
                    // We only want to add the upstream if it is THE active container.
                    // If we have a running deployment, we should strictly match its container_id if possible.

                    let active_container_id = db
                        .get_latest_deployment(app.id)
                        .ok()
                        .flatten()
                        .filter(|d| d.status == znskr_common::models::DeploymentStatus::Running)
                        .and_then(|d| d.container_id);

                    if let Some(target_id) = active_container_id {
                        if name != target_id {
                            continue; // Valid container exists but this isn't it (e.g. it's the old one being drained)
                        }
                    } else {
                        // No active deployment record? Fallback to legacy name check
                        if name != expected_name && !name.starts_with(&format!("znskr-{}-", app.id))
                        {
                            continue;
                        }
                    }

                    if let Some(ip) = get_container_ip(docker, name, &network_name).await {
                        upstreams.push(znskr_proxy::routes::Upstream {
                            host: ip,
                            port: app.port,
                        });
                    }
                }
            }
        }
    }

    // always register subdomain route: {app.name}.{base_domain}
    let subdomain = format!("{}.{}", app.name, base_domain);

    if upstreams.is_empty() {
        routes.remove_route(&subdomain);
        for custom_domain in app.custom_domains() {
            routes.remove_route(&custom_domain);
        }
        tracing::info!(subdomain = %subdomain, "removed routes (no active upstreams)");
        return;
    }

    routes.add_route(znskr_proxy::routes::Route {
        domain: subdomain.clone(),
        upstreams: upstreams.clone(),
        ssl_enabled: false,
        algorithm,
    });
    tracing::info!(subdomain = %subdomain, "refreshed subdomain route for app");

    // also register custom domains if set
    for custom_domain in app.custom_domains() {
        routes.add_route(znskr_proxy::routes::Route {
            domain: custom_domain.clone(),
            upstreams: upstreams.clone(),
            ssl_enabled: true,
            algorithm,
        });
        tracing::info!(domain = %custom_domain, "refreshed custom domain route for app");
    }
}

fn select_exposed_service(
    app: &znskr_common::models::App,
) -> Option<znskr_common::models::ContainerService> {
    if app.services.is_empty() {
        return None;
    }

    if let Some(service) = app.services.iter().find(|service| service.name == "web") {
        return Some(service.clone());
    }

    if app.services.len() == 1 {
        return app.services.first().cloned();
    }

    None
}

fn parse_app_id_from_container_name(name: &str) -> Option<uuid::Uuid> {
    let suffix = name.strip_prefix("znskr-")?;
    if suffix.len() < 36 {
        return None;
    }
    let id_str = &suffix[..36];
    uuid::Uuid::parse_str(id_str).ok()
}

async fn get_container_ip(
    docker: &bollard::Docker,
    container_name: &str,
    network_name: &str,
) -> Option<String> {
    use bollard::query_parameters::InspectContainerOptions;

    let inspect = docker
        .inspect_container(container_name, None::<InspectContainerOptions>)
        .await
        .ok()?;

    let networks = inspect.network_settings?.networks?;

    // try specific network first
    if let Some(network) = networks.get(network_name) {
        if let Some(ip) = &network.ip_address {
            if !ip.is_empty() {
                return Some(ip.clone());
            }
        }
    }

    // fallback: return first available ip
    for (_, network) in networks {
        if let Some(ip) = network.ip_address {
            if !ip.is_empty() {
                return Some(ip);
            }
        }
    }

    None
}

fn resolve_api_host(host: &str) -> String {
    if host == "0.0.0.0" {
        return "127.0.0.1".to_string();
    }
    if host == "::" {
        return "::1".to_string();
    }
    host.to_string()
}
