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
    #[arg(short, long, default_value = "znskr.json")]
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

    // start proxy server in background
    let proxy_routes = routes.clone();
    let proxy_challenges = challenges.clone();
    let http_port = config.proxy.http_port;
    let https_port = config.proxy.https_port;
    let certs_dir = config.acme.certs_dir.clone();

    tokio::spawn(async move {
        let server = znskr_proxy::proxy::ProxyServer::new(
            proxy_routes,
            proxy_challenges,
            http_port,
            https_port,
            certs_dir,
        );

        if let Err(e) = server.run().await {
            tracing::error!(error = %e, "proxy server failed");
        }
    });

    info!(
        http = %config.proxy.http_port,
        https = %config.proxy.https_port,
        "proxy server started"
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
        let config: Config = serde_json::from_str(&content)?;
        info!(path = %args.config.display(), "loaded config");
        Ok(config)
    } else {
        let mut config = Config::default();
        config.server.port = args.api_port;
        config.proxy.http_port = args.http_port;
        config.proxy.https_port = args.https_port;
        config.database.path = args.data_dir.join("znskr.db").to_string_lossy().to_string();
        config.acme.certs_dir = args.data_dir.join("certs").to_string_lossy().to_string();

        // save default config
        let content = serde_json::to_string_pretty(&config)?;
        tokio::fs::write(&args.config, &content).await?;
        info!(path = %args.config.display(), "created default config");

        Ok(config)
    }
}
