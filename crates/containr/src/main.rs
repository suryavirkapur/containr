//! containr - platform as a service for docker containers
//!
//! this is the main binary that orchestrates all containr services:
//! - api server (axum)
//! - deployment worker (docker)
//! - reverse proxy (pingora)

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Context};
use bollard::query_parameters::ListContainersOptions;
use clap::{Args as ClapArgs, Parser, Subcommand};
use containr::systemd::{install_service_unit, ServiceUnitConfig};
use serde_json::json;
use tokio::sync::RwLock;
use tokio::time::MissedTickBehavior;
use tracing::{info, warn};

use containr_common::models::User;
use containr_common::{Config, Database};

mod logging;

const CERT_RENEWAL_CHECK_INTERVAL_SECS: u64 = 12 * 60 * 60;

/// containr paas command line interface
#[derive(Parser, Debug)]
#[command(name = "containr")]
#[command(about = "a rust-native paas for docker containers")]
#[command(version)]
struct Cli {
    #[command(flatten)]
    server: ServerArgs,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(ClapArgs, Debug, Clone)]
struct ServerArgs {
    // config file path
    #[arg(short, long, global = true, default_value = "containr.toml")]
    config: PathBuf,

    // data directory
    #[arg(short, long, global = true, default_value = "./data")]
    data_dir: PathBuf,

    // api server port
    #[arg(long, global = true, default_value = "2077")]
    api_port: u16,

    // http proxy port
    #[arg(long, global = true, default_value = "80")]
    http_port: u16,

    // https proxy port
    #[arg(long, global = true, default_value = "443")]
    https_port: u16,

    // log level
    #[arg(long, global = true, default_value = "info")]
    log_level: String,
}

#[derive(Subcommand, Debug)]
enum Command {
    Server,
    GenerateApiKey(GenerateApiKeyArgs),
    SetupSystemd(SetupSystemdArgs),
    #[command(subcommand)]
    Docker(DockerCommand),
}

#[derive(ClapArgs, Debug)]
struct GenerateApiKeyArgs {
    #[arg(long)]
    email: Option<String>,
    #[arg(long, default_value = "3650")]
    expiry_days: u64,
    #[arg(long)]
    raw: bool,
}

#[derive(ClapArgs, Debug)]
struct SetupSystemdArgs {
    #[arg(long, default_value = "containr")]
    service_name: String,
    #[arg(long, default_value = "/usr/local/bin/containr")]
    binary_path: PathBuf,
    #[arg(long, default_value = "/opt/containr")]
    working_directory: PathBuf,
    #[arg(long, default_value = "/opt/containr/containr.toml")]
    config_path: PathBuf,
    #[arg(long, default_value = "root")]
    user: String,
    #[arg(long, default_value = "info")]
    log_level: String,
    #[arg(long)]
    output: Option<PathBuf>,
    #[arg(long)]
    enable: bool,
    #[arg(long)]
    start: bool,
}

#[derive(Subcommand, Debug)]
enum DockerCommand {
    Check,
    Containers(DockerContainersArgs),
}

#[derive(ClapArgs, Debug)]
struct DockerContainersArgs {
    #[arg(long)]
    all: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        None | Some(Command::Server) => {
            let config = load_or_create_config(&cli.server).await?;
            let _logging =
                logging::init_file_logging(&cli.server.log_level, &config)?;
            run_server_command(&cli.server, config).await
        }
        Some(Command::GenerateApiKey(args)) => {
            let config = load_existing_config(&cli.server).await?;
            let _logging =
                logging::init_file_logging(&cli.server.log_level, &config)?;
            run_generate_api_key_command(&config, &args).await
        }
        Some(Command::SetupSystemd(args)) => {
            let _logging =
                logging::init_console_logging(&cli.server.log_level)?;
            run_setup_systemd_command(&args)
        }
        Some(Command::Docker(command)) => {
            let _logging =
                logging::init_console_logging(&cli.server.log_level)?;
            run_docker_command(command).await
        }
    }
}

async fn run_server_command(
    args: &ServerArgs,
    config: Config,
) -> anyhow::Result<()> {
    info!("starting containr v{}", env!("CARGO_PKG_VERSION"));

    // create data directory
    tokio::fs::create_dir_all(&args.data_dir).await?;

    // open database
    let db = Database::open(&config.database)?;
    bootstrap_admin_user(&db)?;
    info!(
        path = %config.database.sqlite_path().display(),
        "database opened"
    );
    let shared_config = Arc::new(RwLock::new(config.clone()));
    tokio::spawn(logging::run_log_retention_task(shared_config.clone()));

    // create route manager and challenge store for proxy
    let routes = containr_proxy::RouteManager::new();
    let challenges = containr_proxy::acme::ChallengeStore::new();

    // Load existing routes from database (async)
    // Run in a blocking context since we're in main before async starts
    let routes_clone = routes.clone();
    let db_clone = db.clone();
    let algorithm = config.proxy.load_balance;
    let base_domain_clone = config.proxy.base_domain.clone();
    tokio::spawn(async move {
        load_routes_from_db(
            &db_clone,
            &routes_clone,
            algorithm,
            &base_domain_clone,
        )
        .await;
    });

    // create certificate request channel (shared between api and proxy)
    let (cert_request_tx, mut cert_request_rx) =
        tokio::sync::mpsc::channel::<String>(64);
    let (proxy_update_tx, mut proxy_update_rx) =
        tokio::sync::mpsc::channel::<containr_runtime::ProxyRouteUpdate>(64);

    // start api server and get deployment queue receiver
    let deployment_rx = containr_api::run_server(
        shared_config.clone(),
        args.config.clone(),
        args.data_dir.clone(),
        db.clone(),
        Some(proxy_update_tx.clone()),
        Some(cert_request_tx.clone()),
    )
    .await?;
    info!(port = %config.server.port, "api server started");
    let acme_email = config.acme.email.clone();
    let acme_staging = config.acme.staging;
    let acme_certs_dir = PathBuf::from(config.acme.certs_dir.clone());
    let acme_db = db.clone();
    let acme_challenges = challenges.clone();
    let acme_config = shared_config.clone();
    tokio::spawn(async move {
        let acme_enabled = !acme_email.is_empty();
        let acme_manager = if acme_enabled {
            Some(containr_proxy::acme::AcmeManager::new(
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
            if let Err(error) = manager.sync_stored_certificates_to_disk().await
            {
                warn!(error = %error, "failed to restore stored certificates to disk");
            }

            if let Err(error) =
                renew_managed_certificates(&acme_db, manager, &acme_config)
                    .await
            {
                warn!(error = %error, "initial certificate renewal pass failed");
            }
        }

        let mut renewal_interval = tokio::time::interval(
            tokio::time::Duration::from_secs(CERT_RENEWAL_CHECK_INTERVAL_SECS),
        );
        renewal_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let _ = renewal_interval.tick().await;

        let mut in_flight = HashSet::new();
        let mut blocked = HashSet::new();
        let mut logged_disabled = false;
        let mut cert_requests_closed = false;

        loop {
            tokio::select! {
                maybe_domain = cert_request_rx.recv(), if !cert_requests_closed => {
                    let Some(domain) = maybe_domain else {
                        cert_requests_closed = true;
                        if acme_manager.is_none() {
                            break;
                        }
                        continue;
                    };

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
                        Ok(None) => storage_or_dashboard_domain_allowed(&acme_config, &domain).await,
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
                _ = renewal_interval.tick(), if acme_manager.is_some() => {
                    if let Some(manager) = acme_manager.as_ref() {
                        if let Err(error) =
                            renew_managed_certificates(&acme_db, manager, &acme_config).await
                        {
                            warn!(error = %error, "scheduled certificate renewal pass failed");
                        }
                    }
                }
            }

            if cert_requests_closed && acme_manager.is_none() {
                break;
            }
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
    let api_host = resolve_api_host(&config.server.host);
    let api_upstream = format!("{}:{}", api_host, config.server.port);
    let proxy_config = shared_config.clone();
    let proxy_db = db.clone();

    std::thread::spawn(move || {
        let server = containr_proxy::pingora_proxy::create_proxy_server(
            proxy_routes,
            proxy_challenges,
            http_port,
            https_port,
            certs_dir,
            proxy_config,
            api_upstream,
            proxy_db,
        );
        match server {
            Ok(server) => server.run_forever(),
            Err(error) => {
                tracing::error!(error = %error, "failed to start pingora proxy")
            }
        }
    });

    info!(
        http = %config.proxy.http_port,
        https = %config.proxy.https_port,
        "pingora proxy server started"
    );

    // start deployment worker
    let work_dir = args.data_dir.join("builds");

    let proxy_routes_for_updates = routes.clone();
    let proxy_db_for_updates = db.clone();
    let proxy_algorithm = config.proxy.load_balance;
    tokio::spawn(async move {
        while let Some(update) = proxy_update_rx.recv().await {
            match update {
                containr_runtime::ProxyRouteUpdate::RefreshApp { app_id } => {
                    let routes = proxy_routes_for_updates.clone();
                    let db = proxy_db_for_updates.clone();
                    let base_domain = base_domain.clone();

                    // connect to docker for route refresh
                    let docker =
                        match bollard::Docker::connect_with_socket_defaults() {
                            Ok(d) => d,
                            Err(e) => {
                                tracing::warn!(
                                    "failed to connect to docker for route refresh: {}",
                                    e
                                );
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
                containr_runtime::ProxyRouteUpdate::RemoveApp { app } => {
                    remove_app_routes(
                        &proxy_routes_for_updates,
                        &app,
                        &base_domain,
                    );
                }
            }
        }
    });

    let encryption_secret =
        containr_api::security::resolve_encryption_secret(&config);
    let cron_scheduler = containr_runtime::CronJobScheduler::new(
        db.clone(),
        work_dir.clone(),
        encryption_secret.clone(),
    )
    .await?;
    let worker = containr_runtime::DeploymentWorker::new(
        db.clone(),
        work_dir,
        encryption_secret,
        Some(proxy_update_tx),
    )
    .await?;
    let stub_mode = worker.is_stub();
    tokio::spawn(async move {
        worker.run(deployment_rx).await;
    });
    if stub_mode {
        info!("deployment worker started (stub mode - docker not available)");
    } else {
        info!("deployment worker started (docker connected)");
    }

    tokio::spawn(async move {
        cron_scheduler.run().await;
    });
    info!("cron scheduler started");

    info!("containr is ready");
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
async fn load_or_create_config(args: &ServerArgs) -> anyhow::Result<Config> {
    if args.config.exists() {
        let content = tokio::fs::read_to_string(&args.config).await?;
        let mut config: Config = toml::from_str(&content)?;
        normalize_config_paths(args, &mut config);
        Ok(config)
    } else {
        let mut config = Config::default();
        config.server.port = args.api_port;
        config.proxy.http_port = args.http_port;
        config.proxy.https_port = args.https_port;
        normalize_config_paths(args, &mut config);

        // save default config as toml
        if let Some(parent) = args.config.parent() {
            if !parent.as_os_str().is_empty() {
                tokio::fs::create_dir_all(parent).await?;
            }
        }
        let content = toml::to_string_pretty(&config)?;
        tokio::fs::write(&args.config, &content).await?;

        Ok(config)
    }
}

async fn load_existing_config(args: &ServerArgs) -> anyhow::Result<Config> {
    if !args.config.exists() {
        return Err(anyhow!(
            "config file not found: {}",
            args.config.display()
        ));
    }

    let content = tokio::fs::read_to_string(&args.config)
        .await
        .with_context(|| format!("failed to read {}", args.config.display()))?;
    let mut config = toml::from_str(&content).with_context(|| {
        format!("failed to parse {}", args.config.display())
    })?;
    normalize_config_paths(args, &mut config);
    Ok(config)
}

async fn run_generate_api_key_command(
    config: &Config,
    args: &GenerateApiKeyArgs,
) -> anyhow::Result<()> {
    let db = open_database_for_admin_command(&config.database)?;
    bootstrap_admin_user(&db)?;

    let user = resolve_api_key_user(&db, args.email.as_deref())?;
    let api_key = containr_api::auth::create_api_key(
        user.id,
        &user.email,
        &config.auth.jwt_secret,
        args.expiry_days,
    )?;
    let expires_at =
        chrono::Utc::now() + chrono::Duration::days(args.expiry_days as i64);

    if args.raw {
        println!("{}", api_key);
        return Ok(());
    }

    let output = json!({
        "user_id": user.id,
        "email": user.email,
        "expires_at": expires_at.to_rfc3339(),
        "api_key": api_key,
    });
    println!("{}", serde_json::to_string_pretty(&output)?);

    Ok(())
}

fn open_database_for_admin_command(
    config: &containr_common::DatabaseConfig,
) -> anyhow::Result<Database> {
    Database::open(config).map_err(Into::into)
}

fn resolve_api_key_user(
    db: &Database,
    email: Option<&str>,
) -> anyhow::Result<User> {
    if let Some(email) = email {
        return db
            .get_user_by_email(email)?
            .ok_or_else(|| anyhow!("user not found for email {}", email));
    }

    let mut users = db.list_users()?;
    if users.is_empty() {
        return Err(anyhow!(
            "no users exist yet; register a user before generating an api key"
        ));
    }

    users.sort_by_key(|user| (!user.is_admin, user.created_at));
    users.into_iter().next().ok_or_else(|| {
        anyhow!("failed to select a user for api key generation")
    })
}

fn run_setup_systemd_command(args: &SetupSystemdArgs) -> anyhow::Result<()> {
    let config = ServiceUnitConfig {
        service_name: args.service_name.clone(),
        user: args.user.clone(),
        working_directory: args.working_directory.clone(),
        binary_path: args.binary_path.clone(),
        config_path: args.config_path.clone(),
        log_level: args.log_level.clone(),
    };
    let output_path = install_service_unit(
        &config,
        args.output.as_deref(),
        args.enable,
        args.start,
    )?;

    println!("{}", output_path.display());
    Ok(())
}

async fn run_docker_command(command: DockerCommand) -> anyhow::Result<()> {
    match command {
        DockerCommand::Check => run_docker_check().await,
        DockerCommand::Containers(args) => run_docker_containers(args).await,
    }
}

async fn run_docker_check() -> anyhow::Result<()> {
    let docker = connect_docker()?;
    let ping = docker
        .ping()
        .await
        .context("failed to ping docker socket")?;
    let version = docker
        .version()
        .await
        .context("failed to query docker version")?;

    let output = json!({
        "ping": ping,
        "version": version,
    });
    println!("{}", serde_json::to_string_pretty(&output)?);

    Ok(())
}

async fn run_docker_containers(
    args: DockerContainersArgs,
) -> anyhow::Result<()> {
    let docker = connect_docker()?;
    let containers = docker
        .list_containers(Some(ListContainersOptions {
            all: args.all,
            ..Default::default()
        }))
        .await
        .context("failed to list containers through docker socket")?;

    println!("{}", serde_json::to_string_pretty(&containers)?);
    Ok(())
}

fn normalize_config_paths(args: &ServerArgs, config: &mut Config) {
    let default_database = containr_common::DatabaseConfig::default().path;
    if config.database.path.trim().is_empty()
        || config.database.path == default_database
    {
        config.database.path = args
            .data_dir
            .join("containr.sqlite3")
            .to_string_lossy()
            .to_string();
    }

    let default_cache = containr_common::CacheConfig::default().path;
    if config.cache.path.trim().is_empty() || config.cache.path == default_cache
    {
        config.cache.path =
            args.data_dir.join("cache").to_string_lossy().to_string();
    }

    let default_logs = containr_common::LoggingConfig::default().dir;
    if config.logging.dir.trim().is_empty()
        || config.logging.dir == default_logs
    {
        config.logging.dir =
            args.data_dir.join("logs").to_string_lossy().to_string();
    }

    let default_certs = Config::default().acme.certs_dir;
    if config.acme.certs_dir.trim().is_empty()
        || config.acme.certs_dir == default_certs
    {
        config.acme.certs_dir =
            args.data_dir.join("certs").to_string_lossy().to_string();
    }
}

fn connect_docker() -> anyhow::Result<bollard::Docker> {
    bollard::Docker::connect_with_socket_defaults()
        .context("failed to connect to docker socket")
}

fn bootstrap_admin_user(db: &Database) -> anyhow::Result<()> {
    let mut users = db.list_users()?;
    if users.is_empty() || users.iter().any(|user| user.is_admin) {
        return Ok(());
    }

    users.sort_by_key(|user| user.created_at);
    let mut admin = users.remove(0);
    admin.is_admin = true;
    admin.updated_at = chrono::Utc::now();
    db.save_user(&admin)?;
    warn!(
        user_id = %admin.id,
        email = %admin.email,
        "promoted existing user to admin during startup bootstrap"
    );
    Ok(())
}

/// loads routes from database for all apps with domains
async fn load_routes_from_db(
    db: &containr_common::Database,
    routes: &containr_proxy::RouteManager,
    algorithm: containr_common::config::LoadBalanceAlgorithm,
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
    filters.insert("name".to_string(), vec!["containr-".to_string()]);

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
        refresh_routes_for_app(
            db,
            routes,
            app_id,
            algorithm,
            base_domain,
            &docker,
        )
        .await;
    }
}

async fn refresh_routes_for_app(
    db: &containr_common::Database,
    routes: &containr_proxy::RouteManager,
    app_id: uuid::Uuid,
    algorithm: containr_common::config::LoadBalanceAlgorithm,
    base_domain: &str,
    docker: &bollard::Docker,
) {
    let app = match db.get_app(app_id) {
        Ok(Some(app)) => app,
        _ => return,
    };
    let latest_running_deployment = db
        .get_latest_deployment(app.id)
        .ok()
        .flatten()
        .filter(|deployment| {
            deployment.status
                == containr_common::models::DeploymentStatus::Running
        });
    let routing_app = latest_running_deployment
        .as_ref()
        .and_then(|deployment| deployment.app_snapshot.clone())
        .unwrap_or_else(|| app.clone());

    let mut upstreams = Vec::new();
    let network_name = format!("containr-{}", app.id);

    // list containers for this app
    let mut filters: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    filters.insert("name".to_string(), vec![format!("containr-{}", app.id)]);

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

    let public_services = exposed_services(&routing_app);
    if public_services.is_empty() {
        remove_app_routes(routes, &app, base_domain);
        tracing::warn!(app_id = %app.id, "no exposed http service selected for app");
        return;
    }

    remove_app_routes(routes, &app, base_domain);

    let primary_service = match select_exposed_service(&routing_app) {
        Some(service) => service,
        None => return,
    };

    for service in public_services {
        upstreams.clear();

        let active_container_ids =
            latest_running_deployment.as_ref().and_then(|deployment| {
                active_http_container_ids(deployment, service.id)
            });
        let service_prefix = format!("containr-{}-{}-", app.id, service.name);
        let legacy_prefix =
            legacy_service_container_prefix(&routing_app, &service);

        for container in &containers {
            if let Some(names) = &container.names {
                for name in names {
                    let name = name.trim_start_matches('/');
                    if name.is_empty() {
                        continue;
                    }

                    if let Some(active_ids) = &active_container_ids {
                        if !active_ids.contains(name) {
                            continue;
                        }
                    } else {
                        let matches_service_prefix =
                            name.starts_with(&service_prefix);
                        let matches_legacy_prefix = legacy_prefix
                            .as_deref()
                            .map(|prefix| name.starts_with(prefix))
                            .unwrap_or(false);

                        if !matches_service_prefix && !matches_legacy_prefix {
                            continue;
                        }
                    }

                    if let Some(ip) =
                        get_container_ip(docker, name, &network_name).await
                    {
                        upstreams.push(containr_proxy::routes::Upstream {
                            host: ip,
                            port: service.port,
                        });
                    }
                }
            }
        }

        let service_domain =
            service_subdomain(&routing_app, &service, base_domain);
        if upstreams.is_empty() {
            routes.remove_route(&service_domain);
            continue;
        }

        routes.add_route(containr_proxy::routes::Route {
            domain: service_domain.clone(),
            app_id: Some(app.id),
            service_id: Some(service.id),
            upstreams: upstreams.clone(),
            ssl_enabled: false,
            algorithm,
        });
        tracing::info!(domain = %service_domain, "refreshed service route for app");

        for custom_domain in service.custom_domains() {
            routes.add_route(containr_proxy::routes::Route {
                domain: custom_domain.clone(),
                app_id: Some(app.id),
                service_id: Some(service.id),
                upstreams: upstreams.clone(),
                ssl_enabled: true,
                algorithm,
            });
            tracing::info!(
                domain = %custom_domain,
                service = %service.name,
                "refreshed custom domain route for service"
            );
        }

        if service.id == primary_service.id {
            let subdomain = app_subdomain(&routing_app, base_domain);
            routes.add_route(containr_proxy::routes::Route {
                domain: subdomain.clone(),
                app_id: Some(app.id),
                service_id: Some(service.id),
                upstreams: upstreams.clone(),
                ssl_enabled: false,
                algorithm,
            });
            tracing::info!(subdomain = %subdomain, "refreshed subdomain route for app");
        }
    }
}

fn remove_app_routes(
    routes: &containr_proxy::RouteManager,
    app: &containr_common::models::App,
    base_domain: &str,
) {
    for route in routes.list_routes() {
        if route.app_id == Some(app.id) {
            routes.remove_route(&route.domain);
        }
    }

    let subdomain = app_subdomain(app, base_domain);
    routes.remove_route(&subdomain);
    for custom_domain in app.custom_domains() {
        routes.remove_route(&custom_domain);
    }

    let service_suffix = format!(".{}.{}", app.name, base_domain);
    for route in routes.list_routes() {
        if route.domain.ends_with(&service_suffix) {
            routes.remove_route(&route.domain);
        }
    }
}

async fn renew_managed_certificates(
    db: &containr_common::Database,
    manager: &containr_proxy::acme::AcmeManager,
    config: &Arc<RwLock<Config>>,
) -> anyhow::Result<()> {
    let domains = collect_managed_certificate_domains(db, config).await?;
    if domains.is_empty() {
        return Ok(());
    }

    info!(count = domains.len(), "running certificate renewal pass");

    for domain in domains {
        if let Err(error) = manager.ensure_certificate(&domain).await {
            warn!(domain = %domain, error = %error, "certificate renewal failed");
        }
    }

    Ok(())
}

async fn collect_managed_certificate_domains(
    db: &containr_common::Database,
    config: &Arc<RwLock<Config>>,
) -> anyhow::Result<Vec<String>> {
    let mut domains = HashSet::new();
    let config = config.read().await;
    let normalized_base_domain = config.proxy.base_domain.trim().to_lowercase();
    if !normalized_base_domain.is_empty() {
        domains.insert(normalized_base_domain);
    }
    if let Some(storage_domain) = config
        .storage
        .rustfs_public_hostname
        .as_deref()
        .map(str::trim)
        .filter(|domain| !domain.is_empty())
    {
        let normalized = storage_domain
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/')
            .to_lowercase();
        if !normalized.is_empty() {
            domains.insert(normalized);
        }
    }

    for app in db.list_apps()? {
        for domain in app.custom_domains() {
            let normalized = domain.trim().to_lowercase();
            if !normalized.is_empty() {
                domains.insert(normalized);
            }
        }
    }

    let mut domains: Vec<String> = domains.into_iter().collect();
    domains.sort();

    Ok(domains)
}

async fn storage_or_dashboard_domain_allowed(
    config: &Arc<RwLock<Config>>,
    domain: &str,
) -> bool {
    let config = config.read().await;
    let normalized_domain = domain.trim().to_lowercase();
    if normalized_domain == config.proxy.base_domain.trim().to_lowercase() {
        return true;
    }

    config
        .storage
        .rustfs_public_hostname
        .as_deref()
        .map(str::trim)
        .filter(|hostname| !hostname.is_empty())
        .map(|hostname| {
            hostname
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .trim_end_matches('/')
                .eq_ignore_ascii_case(&normalized_domain)
        })
        .unwrap_or(false)
}

fn select_exposed_service(
    app: &containr_common::models::App,
) -> Option<containr_common::models::ContainerService> {
    app.services
        .iter()
        .find(|service| service.is_public_http() && service.name == "web")
        .cloned()
        .or_else(|| {
            app.services
                .iter()
                .find(|service| service.is_public_http())
                .cloned()
        })
}

fn exposed_services(
    app: &containr_common::models::App,
) -> Vec<containr_common::models::ContainerService> {
    app.services
        .iter()
        .filter(|service| service.is_public_http())
        .cloned()
        .collect()
}

fn app_subdomain(
    app: &containr_common::models::App,
    base_domain: &str,
) -> String {
    format!("{}.{}", app.name, base_domain)
}

fn service_subdomain(
    app: &containr_common::models::App,
    service: &containr_common::models::ContainerService,
    base_domain: &str,
) -> String {
    format!("{}.{}.{}", service.name, app.name, base_domain)
}

fn active_http_container_ids(
    deployment: &containr_common::models::Deployment,
    service_id: uuid::Uuid,
) -> Option<HashSet<String>> {
    let container_ids = deployment
        .service_deployments
        .iter()
        .filter(|deployment| deployment.service_id == service_id)
        .filter_map(|deployment| deployment.container_id.clone())
        .collect::<HashSet<_>>();

    if !container_ids.is_empty() {
        return Some(container_ids);
    }

    deployment.container_id.clone().map(|container_id| {
        let mut ids = HashSet::new();
        ids.insert(container_id);
        ids
    })
}

fn legacy_service_container_prefix(
    app: &containr_common::models::App,
    service: &containr_common::models::ContainerService,
) -> Option<String> {
    if app.services.len() == 1 && service.name == "web" {
        return Some(format!("containr-{}-", app.id));
    }

    None
}

fn parse_app_id_from_container_name(name: &str) -> Option<uuid::Uuid> {
    let suffix = name.strip_prefix("containr-")?;
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

#[cfg(test)]
mod tests {
    use super::{
        active_http_container_ids, legacy_service_container_prefix,
        select_exposed_service,
    };
    use containr_common::models::{
        App, ContainerService, Deployment, DeploymentStatus, ServiceDeployment,
        ServiceType,
    };
    use uuid::Uuid;

    #[test]
    fn select_exposed_service_prefers_named_web_service() {
        let owner_id = Uuid::new_v4();
        let mut app = App::new(
            "demo".to_string(),
            "https://example.com/repo".to_string(),
            owner_id,
        );

        let mut web = ContainerService::new(
            app.id,
            "web".to_string(),
            "nginx:latest".to_string(),
            8080,
        );
        let mut api = ContainerService::new(
            app.id,
            "api".to_string(),
            "nginx:latest".to_string(),
            3000,
        );
        web.service_type = ServiceType::WebService;
        web.expose_http = true;
        api.service_type = ServiceType::WebService;
        api.expose_http = true;
        app.services = vec![api, web.clone()];

        let selected = select_exposed_service(&app);
        assert_eq!(
            selected.map(|service| service.name),
            Some("web".to_string())
        );
    }

    #[test]
    fn select_exposed_service_returns_first_public_service_without_web() {
        let owner_id = Uuid::new_v4();
        let mut app = App::new(
            "demo".to_string(),
            "https://example.com/repo".to_string(),
            owner_id,
        );

        let mut api = ContainerService::new(
            app.id,
            "api".to_string(),
            "nginx:latest".to_string(),
            3000,
        );
        api.service_type = ServiceType::WebService;
        api.expose_http = true;
        let worker = ContainerService::new(
            app.id,
            "worker".to_string(),
            "busybox:latest".to_string(),
            9000,
        );
        app.services = vec![api, worker];

        let selected = select_exposed_service(&app);
        assert_eq!(
            selected.map(|service| service.name),
            Some("api".to_string())
        );
    }

    #[test]
    fn select_exposed_service_returns_none_without_public_service() {
        let owner_id = Uuid::new_v4();
        let mut app = App::new(
            "demo".to_string(),
            "https://example.com/repo".to_string(),
            owner_id,
        );

        let api = ContainerService::new(
            app.id,
            "api".to_string(),
            "nginx:latest".to_string(),
            3000,
        );
        let worker = ContainerService::new(
            app.id,
            "worker".to_string(),
            "busybox:latest".to_string(),
            9000,
        );
        app.services = vec![api, worker];

        let selected = select_exposed_service(&app);
        assert!(selected.is_none());
    }

    #[test]
    fn active_http_container_ids_prefers_service_deployments() {
        let service_id = Uuid::new_v4();
        let mut deployment =
            Deployment::new(Uuid::new_v4(), "abc123".to_string());
        deployment.container_id = Some("containr-legacy".to_string());

        let mut first = ServiceDeployment::new(service_id, deployment.id, 0);
        first.container_id = Some("containr-service-0".to_string());
        let mut second = ServiceDeployment::new(service_id, deployment.id, 1);
        second.container_id = Some("containr-service-1".to_string());
        deployment.service_deployments = vec![first, second];

        let container_ids =
            active_http_container_ids(&deployment, service_id).unwrap();
        assert_eq!(container_ids.len(), 2);
        assert!(container_ids.contains("containr-service-0"));
        assert!(container_ids.contains("containr-service-1"));
        assert!(!container_ids.contains("containr-legacy"));
    }

    #[test]
    fn active_http_container_ids_falls_back_to_legacy_container() {
        let service_id = Uuid::new_v4();
        let mut deployment =
            Deployment::new(Uuid::new_v4(), "abc123".to_string());
        deployment.container_id = Some("containr-legacy".to_string());

        let container_ids =
            active_http_container_ids(&deployment, service_id).unwrap();
        assert_eq!(container_ids.len(), 1);
        assert!(container_ids.contains("containr-legacy"));
    }

    #[test]
    fn interrupted_deployment_status_only_matches_in_progress_states() {
        assert!(matches!(
            DeploymentStatus::Pending,
            DeploymentStatus::Pending
                | DeploymentStatus::Cloning
                | DeploymentStatus::Building
                | DeploymentStatus::Pushing
                | DeploymentStatus::Starting
        ));
        assert!(matches!(
            DeploymentStatus::Cloning,
            DeploymentStatus::Pending
                | DeploymentStatus::Cloning
                | DeploymentStatus::Building
                | DeploymentStatus::Pushing
                | DeploymentStatus::Starting
        ));
        assert!(matches!(
            DeploymentStatus::Building,
            DeploymentStatus::Pending
                | DeploymentStatus::Cloning
                | DeploymentStatus::Building
                | DeploymentStatus::Pushing
                | DeploymentStatus::Starting
        ));
        assert!(matches!(
            DeploymentStatus::Pushing,
            DeploymentStatus::Pending
                | DeploymentStatus::Cloning
                | DeploymentStatus::Building
                | DeploymentStatus::Pushing
                | DeploymentStatus::Starting
        ));
        assert!(matches!(
            DeploymentStatus::Starting,
            DeploymentStatus::Pending
                | DeploymentStatus::Cloning
                | DeploymentStatus::Building
                | DeploymentStatus::Pushing
                | DeploymentStatus::Starting
        ));
        assert!(!matches!(
            DeploymentStatus::Running,
            DeploymentStatus::Pending
                | DeploymentStatus::Cloning
                | DeploymentStatus::Building
                | DeploymentStatus::Pushing
                | DeploymentStatus::Starting
        ));
        assert!(!matches!(
            DeploymentStatus::Failed,
            DeploymentStatus::Pending
                | DeploymentStatus::Cloning
                | DeploymentStatus::Building
                | DeploymentStatus::Pushing
                | DeploymentStatus::Starting
        ));
        assert!(!matches!(
            DeploymentStatus::Stopped,
            DeploymentStatus::Pending
                | DeploymentStatus::Cloning
                | DeploymentStatus::Building
                | DeploymentStatus::Pushing
                | DeploymentStatus::Starting
        ));
    }

    #[test]
    fn legacy_service_container_prefix_is_only_used_for_single_web_service() {
        let owner_id = Uuid::new_v4();
        let mut app = App::new(
            "demo".to_string(),
            "https://example.com/repo".to_string(),
            owner_id,
        );
        app.ensure_service_model();

        let prefix = legacy_service_container_prefix(&app, &app.services[0]);
        assert_eq!(prefix, Some(format!("containr-{}-", app.id)));

        let mut multi_service_app = app.clone();
        multi_service_app.services.push(ContainerService::new(
            multi_service_app.id,
            "worker".to_string(),
            "busybox:latest".to_string(),
            9000,
        ));

        let prefix = legacy_service_container_prefix(
            &multi_service_app,
            &multi_service_app.services[0],
        );
        assert!(prefix.is_none());
    }
}
