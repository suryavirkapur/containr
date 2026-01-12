//! znskr - platform as a service for docker containers
//!
//! this is the main binary that orchestrates all znskr services:
//! - api server (axum)
//! - deployment worker (containerd)
//! - reverse proxy (pingora)

use clap::Parser;
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
    let deployment_rx = znskr_api::run_server(config.clone(), db.clone()).await?;
    info!(port = %config.server.port, "api server started");

    // create route manager and challenge store for proxy
    let routes = znskr_proxy::RouteManager::new();
    let challenges = znskr_proxy::acme::ChallengeStore::new();

    // Load existing routes from database
    load_routes_from_db(&db, &routes);

    // start pingora proxy server in background thread
    // pingora has its own runtime so we run it in a separate thread
    let proxy_routes = routes.clone();
    let proxy_challenges = challenges.clone();
    let http_port = config.proxy.http_port;

    std::thread::spawn(move || {
        let server = znskr_proxy::pingora_proxy::create_proxy_server(
            proxy_routes,
            proxy_challenges,
            http_port,
        );
        server.run_forever();
    });

    info!(
        http = %config.proxy.http_port,
        "pingora proxy server started"
    );

    // start deployment worker
    // on macos, containerd isn't available so we use stub mode
    // on linux, try to connect to containerd, fallback to stub if not available
    let work_dir = args.data_dir.join("builds");

    #[cfg(target_os = "macos")]
    {
        tracing::warn!("containerd not available on macos - using stub mode");
        let worker = znskr_runtime::DeploymentWorker::new_stub(db.clone(), work_dir)?;
        tokio::spawn(async move {
            worker.run(deployment_rx).await;
        });
        info!("deployment worker started (stub mode)");
    }

    #[cfg(not(target_os = "macos"))]
    {
        let worker = znskr_runtime::DeploymentWorker::new(db.clone(), work_dir).await?;
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
fn load_routes_from_db(db: &znskr_common::Database, routes: &znskr_proxy::RouteManager) {
    // Get all apps - we need to scan all users' apps
    // For now, we'll get apps by checking running containers
    let output = std::process::Command::new("docker")
        .args([
            "ps",
            "--format",
            "{{.Names}}\t{{.Ports}}",
            "--filter",
            "name=znskr-",
        ])
        .output();

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            tracing::warn!("failed to list containers for routes: {}", e);
            return;
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 2 {
            continue;
        }

        let container_name = parts[0];
        let ports = parts[1];

        // Extract app_id from container name (format: znskr-{uuid})
        let app_id = container_name.strip_prefix("znskr-").unwrap_or("");
        if app_id.is_empty() {
            continue;
        }

        // Parse the app UUID
        let app_uuid = match uuid::Uuid::parse_str(app_id) {
            Ok(id) => id,
            Err(_) => continue,
        };

        // Get app from database
        let app = match db.get_app(app_uuid) {
            Ok(Some(a)) => a,
            _ => continue,
        };

        // Skip apps without domains
        let domain = match &app.domain {
            Some(d) => d.clone(),
            None => continue,
        };

        // Parse host port from Docker ports string (format: "0.0.0.0:32768->8080/tcp")
        let host_port = parse_docker_host_port(ports, app.port);
        if host_port == 0 {
            tracing::warn!(app_id = %app_id, "could not determine host port for container");
            continue;
        }

        // Add route
        routes.add_route(znskr_proxy::routes::Route {
            domain: domain.clone(),
            upstream_host: "127.0.0.1".to_string(),
            upstream_port: host_port,
            ssl_enabled: false,
        });

        tracing::info!(domain = %domain, port = %host_port, "loaded route from database");
    }
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
