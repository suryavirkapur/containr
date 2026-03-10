use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use clap::{Args, Parser, Subcommand};
use containrctl::api_client::ApiClient;
use containrctl::client_config::ClientConfig;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Parser, Debug)]
#[command(name = "containrctl")]
#[command(about = "containr api client")]
#[command(version)]
struct Cli {
    #[arg(long, global = true)]
    config_path: Option<PathBuf>,
    #[arg(long, global = true)]
    instance: Option<String>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    Init(InitArgs),
    #[command(subcommand)]
    Config(ConfigCommand),
    Register(AuthArgs),
    Login(AuthArgs),
    Health,
    #[command(alias = "groups")]
    #[command(subcommand)]
    Projects(ProjectCommand),
    #[command(subcommand)]
    Services(ServiceCommand),
    #[command(subcommand)]
    Databases(DatabaseCommand),
    #[command(subcommand)]
    Queues(QueueCommand),
    #[command(subcommand)]
    Containers(ContainerCommand),
    #[command(subcommand)]
    System(SystemCommand),
}

#[derive(Args, Debug)]
struct InitArgs {
    #[arg(long, default_value = "default")]
    name: String,
    #[arg(long, default_value = "local")]
    instance_id: String,
    #[arg(long, default_value = "http://127.0.0.1:2077")]
    url: String,
    #[arg(long)]
    token: Option<String>,
    #[arg(long)]
    api_key: Option<String>,
    #[arg(long)]
    insecure: bool,
    #[arg(long, default_value_t = 180)]
    timeout_secs: u64,
}

#[derive(Subcommand, Debug)]
enum ConfigCommand {
    Show,
    SetUrl { url: String },
    SetToken { token: String },
    SetApiKey { api_key: String },
    SetInstanceId { instance_id: String },
    Use { name: String },
    ClearAuth,
}

#[derive(Args, Debug)]
struct AuthArgs {
    #[arg(long)]
    email: String,
    #[arg(long)]
    password: String,
}

#[derive(Subcommand, Debug)]
enum ProjectCommand {
    List,
    Get { id: String },
    Apply(ProjectApplyArgs),
    Delete { id: String },
    Metrics { id: String },
    Deploy(ProjectDeployArgs),
    Deployments { id: String },
    DeploymentLogs(ProjectDeploymentLogsArgs),
    Rollback(ProjectRollbackArgs),
}

#[derive(Args, Debug)]
struct ProjectApplyArgs {
    #[arg(long)]
    file: PathBuf,
    #[arg(long)]
    id: Option<String>,
    #[arg(long)]
    no_deploy: bool,
}

#[derive(Args, Debug)]
struct ProjectDeployArgs {
    #[arg(long)]
    id: String,
    #[arg(long)]
    branch: Option<String>,
    #[arg(long)]
    commit_sha: Option<String>,
    #[arg(long)]
    commit_message: Option<String>,
    #[arg(long)]
    rollout_strategy: Option<String>,
}

#[derive(Args, Debug)]
struct ProjectDeploymentLogsArgs {
    #[arg(long)]
    project_id: String,
    #[arg(long)]
    deployment_id: String,
    #[arg(long, default_value_t = 200)]
    limit: usize,
    #[arg(long, default_value_t = 0)]
    offset: usize,
}

#[derive(Args, Debug)]
struct ProjectRollbackArgs {
    #[arg(long)]
    project_id: String,
    #[arg(long)]
    deployment_id: String,
    #[arg(long)]
    rollout_strategy: Option<String>,
}

#[derive(Subcommand, Debug)]
enum DatabaseCommand {
    List(DatabaseListArgs),
    Create(DatabaseCreateArgs),
    Get { id: String },
    Logs(DatabaseLogsArgs),
    Expose(DatabaseExposeArgs),
    Pitr(DatabaseToggleArgs),
    Proxy(DatabaseExposeArgs),
    BaseBackup(DatabaseBaseBackupArgs),
    RestorePoint(DatabaseRestorePointArgs),
    Recover(DatabaseRecoverArgs),
    Start { id: String },
    Stop { id: String },
    Restart { id: String },
    Delete { id: String },
}

#[derive(Subcommand, Debug)]
enum ServiceCommand {
    List(ServiceListArgs),
    Get { id: String },
    Logs(ServiceLogsArgs),
    Start { id: String },
    Stop { id: String },
    Restart { id: String },
    Delete { id: String },
}

#[derive(Args, Debug)]
struct ServiceListArgs {
    #[arg(long)]
    group_id: Option<String>,
}

#[derive(Args, Debug)]
struct ServiceLogsArgs {
    #[arg(long)]
    id: String,
    #[arg(long, default_value_t = 200)]
    tail: usize,
}

#[derive(Args, Debug)]
struct DatabaseListArgs {
    #[arg(long)]
    group_id: Option<String>,
}

#[derive(Args, Debug)]
struct DatabaseCreateArgs {
    #[arg(long)]
    name: String,
    #[arg(long, default_value = "postgres")]
    db_type: String,
    #[arg(long)]
    version: Option<String>,
    #[arg(long)]
    memory_limit_mb: Option<u64>,
    #[arg(long)]
    cpu_limit: Option<f64>,
    #[arg(long)]
    group_id: Option<String>,
}

#[derive(Args, Debug)]
struct DatabaseLogsArgs {
    #[arg(long)]
    id: String,
    #[arg(long, default_value_t = 200)]
    tail: usize,
}

#[derive(Subcommand, Debug)]
enum QueueCommand {
    List(QueueListArgs),
    Create(QueueCreateArgs),
    Get { id: String },
    Expose(QueueExposeArgs),
    Start { id: String },
    Stop { id: String },
    Delete { id: String },
}

#[derive(Args, Debug)]
struct DatabaseExposeArgs {
    #[arg(long)]
    id: String,
    #[arg(long)]
    enabled: bool,
    #[arg(long)]
    external_port: Option<u16>,
}

#[derive(Args, Debug)]
struct DatabaseToggleArgs {
    #[arg(long)]
    id: String,
    #[arg(long)]
    enabled: bool,
}

#[derive(Args, Debug)]
struct DatabaseBaseBackupArgs {
    #[arg(long)]
    id: String,
    #[arg(long)]
    label: Option<String>,
}

#[derive(Args, Debug)]
struct DatabaseRestorePointArgs {
    #[arg(long)]
    id: String,
    #[arg(long)]
    restore_point: Option<String>,
}

#[derive(Args, Debug)]
struct DatabaseRecoverArgs {
    #[arg(long)]
    id: String,
    #[arg(long)]
    restore_point: Option<String>,
    #[arg(long)]
    target_time: Option<String>,
}

#[derive(Args, Debug)]
struct QueueListArgs {
    #[arg(long)]
    group_id: Option<String>,
}

#[derive(Args, Debug)]
struct QueueCreateArgs {
    #[arg(long)]
    name: String,
    #[arg(long, default_value = "rabbitmq")]
    queue_type: String,
    #[arg(long)]
    version: Option<String>,
    #[arg(long)]
    memory_limit_mb: Option<u64>,
    #[arg(long)]
    cpu_limit: Option<f64>,
    #[arg(long)]
    group_id: Option<String>,
}

#[derive(Args, Debug)]
struct QueueExposeArgs {
    #[arg(long)]
    id: String,
    #[arg(long)]
    enabled: bool,
    #[arg(long)]
    external_port: Option<u16>,
}

#[derive(Subcommand, Debug)]
enum ContainerCommand {
    List,
    Logs(ContainerLogsArgs),
}

#[derive(Args, Debug)]
struct ContainerLogsArgs {
    #[arg(long)]
    id: String,
    #[arg(long, default_value_t = 200)]
    tail: usize,
}

#[derive(Subcommand, Debug)]
enum SystemCommand {
    Stats,
}

#[derive(Debug, Serialize)]
struct AuthRequest {
    email: String,
    password: String,
}

#[derive(Debug, Deserialize)]
struct ProjectSpec {
    name: String,
    #[serde(default)]
    source_url: Option<String>,
    #[serde(default)]
    github_url: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    domains: Option<Vec<String>>,
    #[serde(default)]
    domain: Option<String>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    env_vars: Option<Vec<EnvVarSpec>>,
    #[serde(default)]
    services: Vec<ServiceSpec>,
    #[serde(default)]
    rollout_strategy: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct EnvVarSpec {
    key: String,
    value: String,
    #[serde(default)]
    secret: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
struct HealthCheckSpec {
    path: String,
    #[serde(default)]
    interval_secs: Option<u32>,
    #[serde(default)]
    timeout_secs: Option<u32>,
    #[serde(default)]
    retries: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize)]
struct RegistryAuthSpec {
    #[serde(default)]
    server: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    password: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct ServiceMountSpec {
    name: String,
    target: String,
    #[serde(default)]
    read_only: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
struct ServiceSpec {
    name: String,
    #[serde(default)]
    image: Option<String>,
    #[serde(default)]
    service_type: Option<String>,
    #[serde(default)]
    port: u16,
    #[serde(default)]
    expose_http: Option<bool>,
    #[serde(default)]
    domains: Option<Vec<String>>,
    #[serde(default)]
    domain: Option<String>,
    #[serde(default)]
    additional_ports: Option<Vec<u16>>,
    #[serde(default)]
    replicas: Option<u32>,
    #[serde(default)]
    memory_limit_mb: Option<u64>,
    #[serde(default)]
    cpu_limit: Option<f64>,
    #[serde(default)]
    depends_on: Option<Vec<String>>,
    #[serde(default)]
    health_check: Option<HealthCheckSpec>,
    #[serde(default)]
    restart_policy: Option<String>,
    #[serde(default)]
    registry_auth: Option<RegistryAuthSpec>,
    #[serde(default)]
    env_vars: Option<Vec<EnvVarSpec>>,
    #[serde(default)]
    build_context: Option<String>,
    #[serde(default)]
    dockerfile_path: Option<String>,
    #[serde(default)]
    build_target: Option<String>,
    #[serde(default)]
    build_args: Option<Vec<EnvVarSpec>>,
    #[serde(default)]
    command: Option<Vec<String>>,
    #[serde(default)]
    entrypoint: Option<Vec<String>>,
    #[serde(default)]
    working_dir: Option<String>,
    #[serde(default)]
    schedule: Option<String>,
    #[serde(default)]
    mounts: Option<Vec<ServiceMountSpec>>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Command::Init(args) => run_init(cli.config_path.as_deref(), args),
        Command::Config(command) => run_config_command(
            cli.config_path.as_deref(),
            cli.instance.as_deref(),
            command,
        ),
        Command::Register(args) => {
            run_auth_command(
                cli.config_path.as_deref(),
                cli.instance.as_deref(),
                "/api/auth/register",
                args,
            )
            .await
        }
        Command::Login(args) => {
            run_auth_command(
                cli.config_path.as_deref(),
                cli.instance.as_deref(),
                "/api/auth/login",
                args,
            )
            .await
        }
        Command::Health => {
            run_get_json(
                cli.config_path.as_deref(),
                cli.instance.as_deref(),
                "/health",
                false,
            )
            .await
        }
        Command::Projects(command) => {
            run_project_command(
                cli.config_path.as_deref(),
                cli.instance.as_deref(),
                command,
            )
            .await
        }
        Command::Services(command) => {
            run_service_command(
                cli.config_path.as_deref(),
                cli.instance.as_deref(),
                command,
            )
            .await
        }
        Command::Databases(command) => {
            run_database_command(
                cli.config_path.as_deref(),
                cli.instance.as_deref(),
                command,
            )
            .await
        }
        Command::Queues(command) => {
            run_queue_command(
                cli.config_path.as_deref(),
                cli.instance.as_deref(),
                command,
            )
            .await
        }
        Command::Containers(ContainerCommand::List) => {
            run_get_json(
                cli.config_path.as_deref(),
                cli.instance.as_deref(),
                "/api/containers",
                true,
            )
            .await
        }
        Command::Containers(ContainerCommand::Logs(args)) => {
            run_container_logs(
                cli.config_path.as_deref(),
                cli.instance.as_deref(),
                args,
            )
            .await
        }
        Command::System(SystemCommand::Stats) => {
            run_get_json(
                cli.config_path.as_deref(),
                cli.instance.as_deref(),
                "/api/system/stats",
                true,
            )
            .await
        }
    }
}

fn run_init(config_path: Option<&Path>, args: InitArgs) -> Result<()> {
    let (mut config, path) = ClientConfig::load_or_create(config_path)?;
    let instance = config.ensure_instance(&args.name);
    instance.instance_id = args.instance_id;
    instance.url = args.url;
    instance.token = args.token;
    instance.api_key = args.api_key;
    instance.tls_verify = !args.insecure;
    instance.timeout_secs = args.timeout_secs;
    config.active_instance = args.name;
    config.save(&path)?;

    print_json(&json!({
        "config_path": path,
        "active_instance": config.active_instance,
    }))
}

fn run_config_command(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    command: ConfigCommand,
) -> Result<()> {
    let (mut config, path) = ClientConfig::load_or_create(config_path)?;

    match command {
        ConfigCommand::Show => {
            let output = json!({
                "config_path": path,
                "config": config.masked(),
            });
            print_json(&output)
        }
        ConfigCommand::SetUrl { url } => {
            let instance =
                resolve_instance_mut(&mut config, selected_instance)?;
            instance.url = url;
            config.save(&path)?;
            print_json(&json!({"config_path": path}))
        }
        ConfigCommand::SetToken { token } => {
            let instance =
                resolve_instance_mut(&mut config, selected_instance)?;
            instance.token = Some(token);
            instance.api_key = None;
            config.save(&path)?;
            print_json(&json!({"config_path": path}))
        }
        ConfigCommand::SetApiKey { api_key } => {
            let instance =
                resolve_instance_mut(&mut config, selected_instance)?;
            instance.api_key = Some(api_key);
            config.save(&path)?;
            print_json(&json!({"config_path": path}))
        }
        ConfigCommand::SetInstanceId { instance_id } => {
            let instance =
                resolve_instance_mut(&mut config, selected_instance)?;
            instance.instance_id = instance_id;
            config.save(&path)?;
            print_json(&json!({"config_path": path}))
        }
        ConfigCommand::Use { name } => {
            config.instance(&name)?;
            config.active_instance = name;
            config.save(&path)?;
            print_json(&json!({"config_path": path}))
        }
        ConfigCommand::ClearAuth => {
            let instance =
                resolve_instance_mut(&mut config, selected_instance)?;
            instance.token = None;
            instance.api_key = None;
            config.save(&path)?;
            print_json(&json!({"config_path": path}))
        }
    }
}

async fn run_auth_command(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    path: &str,
    args: AuthArgs,
) -> Result<()> {
    let (mut config, config_file_path) =
        ClientConfig::load_or_create(config_path)?;
    let instance_name = resolve_instance_name(&config, selected_instance);
    let instance = config.instance(&instance_name)?.clone();
    let client = ApiClient::new(&instance)?;

    let response = client
        .post_json(
            path,
            &AuthRequest {
                email: args.email,
                password: args.password,
            },
        )
        .await?;

    let token = extract_string(&response, &["token"])?;
    let email = extract_string(&response, &["user", "email"])?;

    let instance = config.instance_mut(&instance_name)?;
    instance.token = Some(token);
    instance.api_key = None;
    config.save(&config_file_path)?;

    print_json(&json!({
        "config_path": config_file_path,
        "instance": instance_name,
        "email": email,
        "token_stored": true,
    }))
}

async fn run_project_command(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    command: ProjectCommand,
) -> Result<()> {
    match command {
        ProjectCommand::List => {
            run_get_json(config_path, selected_instance, "/api/projects", true)
                .await
        }
        ProjectCommand::Get { id } => {
            run_get_json(
                config_path,
                selected_instance,
                &format!("/api/projects/{}", id),
                true,
            )
            .await
        }
        ProjectCommand::Apply(args) => {
            run_project_apply(config_path, selected_instance, args).await
        }
        ProjectCommand::Delete { id } => {
            run_delete_json(
                config_path,
                selected_instance,
                &format!("/api/projects/{}", id),
            )
            .await
        }
        ProjectCommand::Metrics { id } => {
            run_get_json(
                config_path,
                selected_instance,
                &format!("/api/projects/{}/metrics", id),
                true,
            )
            .await
        }
        ProjectCommand::Deploy(args) => {
            run_project_deploy(config_path, selected_instance, args).await
        }
        ProjectCommand::Deployments { id } => {
            run_get_json(
                config_path,
                selected_instance,
                &format!("/api/projects/{}/deployments", id),
                true,
            )
            .await
        }
        ProjectCommand::DeploymentLogs(args) => {
            run_project_deployment_logs(config_path, selected_instance, args)
                .await
        }
        ProjectCommand::Rollback(args) => {
            run_project_rollback(config_path, selected_instance, args).await
        }
    }
}

async fn run_service_command(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    command: ServiceCommand,
) -> Result<()> {
    match command {
        ServiceCommand::List(args) => {
            run_resource_list(
                config_path,
                selected_instance,
                "/api/services",
                args.group_id.as_deref(),
            )
            .await
        }
        ServiceCommand::Get { id } => {
            run_resource_get(
                config_path,
                selected_instance,
                "/api/services",
                &id,
            )
            .await
        }
        ServiceCommand::Logs(args) => {
            run_resource_logs(
                config_path,
                selected_instance,
                "/api/services",
                &args.id,
                args.tail,
            )
            .await
        }
        ServiceCommand::Start { id } => {
            run_resource_action(
                config_path,
                selected_instance,
                "/api/services",
                &id,
                "start",
            )
            .await
        }
        ServiceCommand::Stop { id } => {
            run_resource_action(
                config_path,
                selected_instance,
                "/api/services",
                &id,
                "stop",
            )
            .await
        }
        ServiceCommand::Restart { id } => {
            run_resource_action(
                config_path,
                selected_instance,
                "/api/services",
                &id,
                "restart",
            )
            .await
        }
        ServiceCommand::Delete { id } => {
            run_resource_delete(
                config_path,
                selected_instance,
                "/api/services",
                &id,
            )
            .await
        }
    }
}

async fn run_database_command(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    command: DatabaseCommand,
) -> Result<()> {
    match command {
        DatabaseCommand::List(args) => {
            run_resource_list(
                config_path,
                selected_instance,
                "/api/databases",
                args.group_id.as_deref(),
            )
            .await
        }
        DatabaseCommand::Create(args) => {
            let body = json!({
                "name": args.name,
                "db_type": args.db_type,
                "version": args.version,
                "memory_limit_mb": args.memory_limit_mb,
                "cpu_limit": args.cpu_limit,
                "group_id": args.group_id,
            });
            run_post_json(
                config_path,
                selected_instance,
                "/api/databases",
                &body,
            )
            .await
        }
        DatabaseCommand::Get { id } => {
            run_resource_get(
                config_path,
                selected_instance,
                "/api/databases",
                &id,
            )
            .await
        }
        DatabaseCommand::Logs(args) => {
            run_resource_logs(
                config_path,
                selected_instance,
                "/api/databases",
                &args.id,
                args.tail,
            )
            .await
        }
        DatabaseCommand::Expose(args) => {
            let body = json!({
                "enabled": args.enabled,
                "external_port": args.external_port,
            });
            run_post_json(
                config_path,
                selected_instance,
                &resource_action_path("/api/databases", &args.id, "expose"),
                &body,
            )
            .await
        }
        DatabaseCommand::Pitr(args) => {
            let body = json!({ "enabled": args.enabled });
            run_post_json(
                config_path,
                selected_instance,
                &resource_action_path("/api/databases", &args.id, "pitr"),
                &body,
            )
            .await
        }
        DatabaseCommand::Proxy(args) => {
            let body = json!({
                "enabled": args.enabled,
                "external_port": args.external_port,
            });
            run_post_json(
                config_path,
                selected_instance,
                &resource_action_path("/api/databases", &args.id, "proxy"),
                &body,
            )
            .await
        }
        DatabaseCommand::BaseBackup(args) => {
            let body = json!({
                "label": args.label,
            });
            run_post_json(
                config_path,
                selected_instance,
                &resource_nested_action_path(
                    "/api/databases",
                    &args.id,
                    &["pitr", "base-backup"],
                ),
                &body,
            )
            .await
        }
        DatabaseCommand::RestorePoint(args) => {
            let body = json!({
                "restore_point": args.restore_point,
            });
            run_post_json(
                config_path,
                selected_instance,
                &resource_nested_action_path(
                    "/api/databases",
                    &args.id,
                    &["pitr", "restore-point"],
                ),
                &body,
            )
            .await
        }
        DatabaseCommand::Recover(args) => {
            if args.restore_point.is_some() == args.target_time.is_some() {
                return Err(anyhow!(
                    "provide exactly one of --restore-point or --target-time"
                ));
            }

            let body = json!({
                "restore_point": args.restore_point,
                "target_time": args.target_time,
            });
            run_post_json(
                config_path,
                selected_instance,
                &resource_nested_action_path(
                    "/api/databases",
                    &args.id,
                    &["pitr", "recover"],
                ),
                &body,
            )
            .await
        }
        DatabaseCommand::Start { id } => {
            run_resource_action(
                config_path,
                selected_instance,
                "/api/databases",
                &id,
                "start",
            )
            .await
        }
        DatabaseCommand::Stop { id } => {
            run_resource_action(
                config_path,
                selected_instance,
                "/api/databases",
                &id,
                "stop",
            )
            .await
        }
        DatabaseCommand::Restart { id } => {
            run_resource_action(
                config_path,
                selected_instance,
                "/api/databases",
                &id,
                "restart",
            )
            .await
        }
        DatabaseCommand::Delete { id } => {
            run_resource_delete(
                config_path,
                selected_instance,
                "/api/databases",
                &id,
            )
            .await
        }
    }
}

async fn run_queue_command(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    command: QueueCommand,
) -> Result<()> {
    match command {
        QueueCommand::List(args) => {
            run_resource_list(
                config_path,
                selected_instance,
                "/api/queues",
                args.group_id.as_deref(),
            )
            .await
        }
        QueueCommand::Create(args) => {
            let body = json!({
                "name": args.name,
                "queue_type": args.queue_type,
                "version": args.version,
                "memory_limit_mb": args.memory_limit_mb,
                "cpu_limit": args.cpu_limit,
                "group_id": args.group_id,
            });
            run_post_json(config_path, selected_instance, "/api/queues", &body)
                .await
        }
        QueueCommand::Get { id } => {
            run_resource_get(config_path, selected_instance, "/api/queues", &id)
                .await
        }
        QueueCommand::Expose(args) => {
            let body = json!({
                "enabled": args.enabled,
                "external_port": args.external_port,
            });
            run_post_json(
                config_path,
                selected_instance,
                &resource_action_path("/api/queues", &args.id, "expose"),
                &body,
            )
            .await
        }
        QueueCommand::Start { id } => {
            run_resource_action(
                config_path,
                selected_instance,
                "/api/queues",
                &id,
                "start",
            )
            .await
        }
        QueueCommand::Stop { id } => {
            run_resource_action(
                config_path,
                selected_instance,
                "/api/queues",
                &id,
                "stop",
            )
            .await
        }
        QueueCommand::Delete { id } => {
            run_resource_delete(
                config_path,
                selected_instance,
                "/api/queues",
                &id,
            )
            .await
        }
    }
}

async fn run_resource_list(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    base_path: &str,
    group_id: Option<&str>,
) -> Result<()> {
    let path = grouped_resource_path(base_path, group_id);
    run_get_json(config_path, selected_instance, &path, true).await
}

async fn run_resource_get(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    base_path: &str,
    id: &str,
) -> Result<()> {
    let path = resource_item_path(base_path, id);
    run_get_json(config_path, selected_instance, &path, true).await
}

async fn run_resource_logs(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    base_path: &str,
    id: &str,
    tail: usize,
) -> Result<()> {
    let path = format!(
        "{}?tail={tail}",
        resource_action_path(base_path, id, "logs")
    );
    run_logs_command(config_path, selected_instance, &path).await
}

async fn run_resource_action(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    base_path: &str,
    id: &str,
    action: &str,
) -> Result<()> {
    let path = resource_action_path(base_path, id, action);
    run_post_empty(config_path, selected_instance, &path).await
}

async fn run_resource_delete(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    base_path: &str,
    id: &str,
) -> Result<()> {
    let path = resource_item_path(base_path, id);
    run_delete_json(config_path, selected_instance, &path).await
}

fn grouped_resource_path(base_path: &str, group_id: Option<&str>) -> String {
    match group_id {
        Some(group_id) => format!("{base_path}?group_id={group_id}"),
        None => base_path.to_string(),
    }
}

fn resource_item_path(base_path: &str, id: &str) -> String {
    format!("{base_path}/{id}")
}

fn resource_action_path(base_path: &str, id: &str, action: &str) -> String {
    format!("{}/{}/{}", base_path, id, action)
}

fn resource_nested_action_path(
    base_path: &str,
    id: &str,
    actions: &[&str],
) -> String {
    let mut path = resource_item_path(base_path, id);
    for action in actions {
        path.push('/');
        path.push_str(action);
    }
    path
}

async fn run_get_json(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    path: &str,
    require_auth: bool,
) -> Result<()> {
    let client = load_client(config_path, selected_instance, require_auth)?;
    let response = client.get_json(path).await?;
    print_json(&response)
}

async fn run_post_json(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    path: &str,
    body: &Value,
) -> Result<()> {
    let client = load_client(config_path, selected_instance, true)?;
    let response = client.post_json(path, body).await?;
    print_json(&response)
}

async fn run_post_empty(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    path: &str,
) -> Result<()> {
    let client = load_client(config_path, selected_instance, true)?;
    let response = client.post_empty(path).await?;
    print_json(&response)
}

async fn run_delete_json(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    path: &str,
) -> Result<()> {
    let client = load_client(config_path, selected_instance, true)?;
    let response = client.delete(path).await?;
    print_json(&response)
}

async fn run_logs_command(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    path: &str,
) -> Result<()> {
    let client = load_client(config_path, selected_instance, true)?;
    let response = client.get_json(path).await?;
    let logs = extract_string(&response, &["logs"])?;
    println!("{}", logs);
    Ok(())
}

async fn run_project_apply(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    args: ProjectApplyArgs,
) -> Result<()> {
    let spec = load_project_spec(&args.file)?;
    let body = build_project_body(&spec);
    let client = load_client(config_path, selected_instance, true)?;

    let project = match args.id.as_deref() {
        Some(id) => {
            client
                .put_json(&format!("/api/projects/{}", id), &body)
                .await?
        }
        None => client.post_json("/api/projects", &body).await?,
    };

    let deployment = match args.id.as_deref() {
        Some(id) if !args.no_deploy => Some(
            client
                .post_json(
                    &format!("/api/projects/{}/deployments", id),
                    &json!({}),
                )
                .await?,
        ),
        _ => None,
    };

    print_json(&json!({
        "project": project,
        "deployment": deployment,
    }))
}

async fn run_project_deploy(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    args: ProjectDeployArgs,
) -> Result<()> {
    let body = json!({
        "branch": args.branch,
        "commit_sha": args.commit_sha,
        "commit_message": args.commit_message,
        "rollout_strategy": args.rollout_strategy,
    });

    run_post_json(
        config_path,
        selected_instance,
        &format!("/api/projects/{}/deployments", args.id),
        &body,
    )
    .await
}

async fn run_project_deployment_logs(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    args: ProjectDeploymentLogsArgs,
) -> Result<()> {
    let client = load_client(config_path, selected_instance, true)?;
    let response = client
        .get_json(&format!(
            "/api/projects/{}/deployments/{}/logs?limit={}&offset={}",
            args.project_id, args.deployment_id, args.limit, args.offset
        ))
        .await?;

    if let Some(lines) = response.as_array() {
        for line in lines {
            if let Some(line) = line.as_str() {
                println!("{}", line);
            }
        }
        return Ok(());
    }

    print_json(&response)
}

async fn run_project_rollback(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    args: ProjectRollbackArgs,
) -> Result<()> {
    let body = json!({
        "rollout_strategy": args.rollout_strategy,
    });

    run_post_json(
        config_path,
        selected_instance,
        &format!(
            "/api/projects/{}/deployments/{}/rollback",
            args.project_id, args.deployment_id
        ),
        &body,
    )
    .await
}

async fn run_container_logs(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    args: ContainerLogsArgs,
) -> Result<()> {
    let client = load_client(config_path, selected_instance, true)?;
    let response = client
        .get_json(&format!(
            "/api/containers/{}/logs?tail={}",
            args.id, args.tail
        ))
        .await?;
    let logs = extract_string(&response, &["logs"])?;

    println!("{}", logs);
    Ok(())
}

fn load_project_spec(path: &Path) -> Result<ProjectSpec> {
    let content = fs::read_to_string(path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    toml::from_str(&content)
        .with_context(|| format!("failed to parse {}", path.display()))
}

fn build_project_body(spec: &ProjectSpec) -> Value {
    json!({
        "name": spec.name,
        "github_url": resolve_project_source_url(spec),
        "branch": spec.branch,
        "domains": spec.domains,
        "domain": spec.domain,
        "port": spec.port,
        "env_vars": spec.env_vars,
        "services": spec.services,
        "rollout_strategy": spec.rollout_strategy,
    })
}

fn resolve_project_source_url(spec: &ProjectSpec) -> String {
    spec.source_url
        .as_deref()
        .or(spec.github_url.as_deref())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn load_client(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    require_auth: bool,
) -> Result<ApiClient> {
    let (config, _) = ClientConfig::load_or_create(config_path)?;
    let instance_name = resolve_instance_name(&config, selected_instance);
    let instance = config.instance(&instance_name)?;
    let client = ApiClient::new(instance)?;

    if require_auth && !client.has_auth() {
        return Err(anyhow!(
            "instance '{}' is missing a token or api_key",
            instance_name
        ));
    }

    Ok(client)
}

fn resolve_instance_name(
    config: &ClientConfig,
    selected_instance: Option<&str>,
) -> String {
    match selected_instance {
        Some(instance) => instance.to_string(),
        None => config.active_instance.clone(),
    }
}

fn resolve_instance_mut<'a>(
    config: &'a mut ClientConfig,
    selected_instance: Option<&str>,
) -> Result<&'a mut containrctl::client_config::ClientInstanceConfig> {
    let name = resolve_instance_name(config, selected_instance);
    config.instance_mut(&name)
}

fn extract_string(value: &Value, path: &[&str]) -> Result<String> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment).ok_or_else(|| {
            anyhow!("missing response field {}", path.join("."))
        })?;
    }

    current.as_str().map(ToOwned::to_owned).ok_or_else(|| {
        anyhow!("response field {} is not a string", path.join("."))
    })
}

fn print_json<T: Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
