//! znskr - platform as a service for docker containers
//!
//! this is the main binary that orchestrates all znskr services:
//! - api server (axum)
//! - deployment worker (containerd)
//! - reverse proxy (pingora)

use clap::Parser;
use std::collections::HashSet;
use std::path::PathBuf;
use tracing::{info, Level};
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

    // start api server and get deployment queue receiver
    let deployment_rx = znskr_api::run_server(config.clone(), args.config.clone(), db.clone()).await?;
    info!(port = %config.server.port, "api server started");

    // create route manager and challenge store for proxy
    let routes = znskr_proxy::RouteManager::new();
    let challenges = znskr_proxy::acme::ChallengeStore::new();

    // Load existing routes from database
    load_routes_from_db(&db, &routes, config.proxy.load_balance);

    // start pingora proxy server in background thread
    // pingora has its own runtime so we run it in a separate thread
    let proxy_routes = routes.clone();
    let proxy_challenges = challenges.clone();
    let http_port = config.proxy.http_port;
    let https_port = config.proxy.https_port;
    let certs_dir = PathBuf::from(config.acme.certs_dir.clone());

    std::thread::spawn(move || {
        let server = znskr_proxy::pingora_proxy::create_proxy_server(
            proxy_routes,
            proxy_challenges,
            http_port,
            https_port,
            certs_dir,
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
    // on macos, containerd isn't available so we use stub mode
    // on linux, try to connect to containerd, fallback to stub if not available
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
                    let _ = tokio::task::spawn_blocking(move || {
                        refresh_routes_for_app(&db, &routes, app_id, proxy_algorithm);
                    })
                    .await;
                }
            }
        }
    });

    #[cfg(target_os = "macos")]
    {
        tracing::warn!("containerd not available on macos - using stub mode");
        let worker =
            znskr_runtime::DeploymentWorker::new_stub(db.clone(), work_dir, Some(proxy_update_tx))?;
        tokio::spawn(async move {
            worker.run(deployment_rx).await;
        });
        info!("deployment worker started (stub mode)");
    }

    #[cfg(not(target_os = "macos"))]
    {
        let worker = znskr_runtime::DeploymentWorker::new(
            db.clone(),
            work_dir,
            Some(proxy_update_tx),
        )
        .await?;
        let stub_mode = worker.is_stub();
        tokio::spawn(async move {
            worker.run(deployment_rx).await;
        });
        if stub_mode {
            info!("deployment worker started (stub mode - containerd not available)");
        } else {
            info!("deployment worker started (containerd connected)");
        }
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

/// Loads routes from database for all apps with domains
fn load_routes_from_db(
    db: &znskr_common::Database,
    routes: &znskr_proxy::RouteManager,
    algorithm: znskr_common::config::LoadBalanceAlgorithm,
) {
    let output = std::process::Command::new("docker")
        .args(["ps", "--format", "{{.Names}}", "--filter", "name=znskr-"])
        .output();

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            tracing::warn!("failed to list containers for routes: {}", e);
            return;
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut apps = HashSet::new();

    for name in stdout.lines() {
        if let Some(app_id) = parse_app_id_from_container_name(name) {
            apps.insert(app_id);
        }
    }

    for app_id in apps {
        refresh_routes_for_app(db, routes, app_id, algorithm);
    }
}

fn refresh_routes_for_app(
    db: &znskr_common::Database,
    routes: &znskr_proxy::RouteManager,
    app_id: uuid::Uuid,
    algorithm: znskr_common::config::LoadBalanceAlgorithm,
) {
    let app = match db.get_app(app_id) {
        Ok(Some(app)) => app,
        _ => return,
    };

    let domain = match &app.domain {
        Some(domain) => domain.clone(),
        None => return,
    };

    let mut upstreams = Vec::new();

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

        let output = std::process::Command::new("docker")
            .args([
                "ps",
                "--format",
                "{{.Names}}\t{{.Ports}}",
                "--filter",
                &format!("name=znskr-{}", app.id),
            ])
            .output();

        let output = match output {
            Ok(o) => o,
            Err(e) => {
                tracing::warn!(app_id = %app.id, "failed to list containers: {}", e);
                return;
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let prefix = format!("znskr-{}-{}-", app.id, service.name);

        for line in stdout.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 2 {
                continue;
            }

            let name = parts[0];
            let ports = parts[1];
            if !name.starts_with(&prefix) {
                continue;
            }

            let host_port = parse_docker_host_port(ports, service.port);
            if host_port == 0 {
                continue;
            }

            upstreams.push(znskr_proxy::routes::Upstream {
                host: "127.0.0.1".to_string(),
                port: host_port,
            });
        }
    } else {
        let output = std::process::Command::new("docker")
            .args([
                "ps",
                "--format",
                "{{.Names}}\t{{.Ports}}",
                "--filter",
                &format!("name=znskr-{}", app.id),
            ])
            .output();

        let output = match output {
            Ok(o) => o,
            Err(e) => {
                tracing::warn!(app_id = %app.id, "failed to list containers: {}", e);
                return;
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let name = format!("znskr-{}", app.id);

        for line in stdout.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 2 {
                continue;
            }

            let container_name = parts[0];
            let ports = parts[1];
            if container_name != name {
                continue;
            }

            let host_port = parse_docker_host_port(ports, app.port);
            if host_port == 0 {
                continue;
            }

            upstreams.push(znskr_proxy::routes::Upstream {
                host: "127.0.0.1".to_string(),
                port: host_port,
            });
        }
    }

    if upstreams.is_empty() {
        routes.remove_route(&domain);
        tracing::info!(domain = %domain, "removed route (no active upstreams)");
        return;
    }

    routes.add_route(znskr_proxy::routes::Route {
        domain: domain.clone(),
        upstreams,
        ssl_enabled: false,
        algorithm,
    });

    tracing::info!(domain = %domain, "refreshed routes for app");
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

/// Parses Docker port mapping to extract host port
fn parse_docker_host_port(ports_str: &str, container_port: u16) -> u16 {
    // Format: "0.0.0.0:32768->8080/tcp, ..."
    for mapping in ports_str.split(", ") {
        if mapping.contains(&format!("->{}/", container_port))
            || mapping.contains(&format!("->{}", container_port))
        {
            // Extract host port from "0.0.0.0:32768->8080/tcp"
            if let Some(host_part) = mapping.split("->").next() {
                if let Some(port_str) = host_part.rsplit(':').next() {
                    if let Ok(port) = port_str.parse::<u16>() {
                        return port;
                    }
                }
            }
        }
    }
    0
}
