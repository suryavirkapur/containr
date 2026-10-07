use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use clap::{Args, Parser, Subcommand};
use containr_cmd::api_client::ApiClient;
use containr_cmd::client_config::ClientConfig;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const SERVICES_PATH: &str = "/api/services";
const RESOURCE_KIND_APP: &str = "app_service";
const RESOURCE_KIND_DATABASE: &str = "managed_database";
const RESOURCE_KIND_QUEUE: &str = "managed_queue";

#[derive(Parser, Debug)]
#[command(name = "containr-cmd")]
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
    /// service id (projects are now app services)
    #[arg(long, alias = "service-id")]
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
    /// service id (projects are now app services)
    #[arg(long, alias = "service-id")]
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
    Create(ServiceCreateArgs),
    List(ServiceListArgs),
    Get { id: String },
    Settings { id: String },
    Update(ServiceUpdateArgs),
    Logs(ServiceLogsArgs),
    HttpLogs(ServiceHttpLogsArgs),
    Deploy(ServiceDeployArgs),
    Start { id: String },
    Stop { id: String },
    Restart { id: String },
    Delete { id: String },
}

/// deploys a service from git (default), a local directory or archive, or a
/// dockerfile
#[derive(Args, Debug)]
struct ServiceDeployArgs {
    id: String,
    /// branch to deploy for git services
    #[arg(long, conflicts_with_all = ["upload", "dockerfile"])]
    branch: Option<String>,
    /// directory to pack and upload, or an existing .tar/.tar.gz archive
    #[arg(long, conflicts_with = "dockerfile")]
    upload: Option<PathBuf>,
    /// dockerfile to build with an empty context
    #[arg(long)]
    dockerfile: Option<PathBuf>,
    /// extra file or directory names to leave out of an upload
    #[arg(long = "exclude")]
    exclude: Vec<String>,
}

#[derive(Args, Debug)]
struct ServiceListArgs {
    #[arg(long)]
    group_id: Option<String>,
}

#[derive(Args, Debug)]
struct ServiceCreateArgs {
    #[arg(long)]
    file: PathBuf,
}

#[derive(Args, Debug)]
struct ServiceLogsArgs {
    #[arg(long)]
    id: String,
    #[arg(long, default_value_t = 200)]
    tail: usize,
}

#[derive(Args, Debug)]
struct ServiceUpdateArgs {
    #[arg(long)]
    id: String,
    #[arg(long)]
    file: PathBuf,
}

#[derive(Args, Debug)]
struct ServiceHttpLogsArgs {
    #[arg(long)]
    id: String,
    #[arg(long, default_value_t = 100)]
    limit: usize,
    #[arg(long, default_value_t = 0)]
    offset: usize,
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
    // reqwest uses rustls without a bundled crypto provider
    let _ = rustls::crypto::ring::default_provider().install_default();
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
            run_kind_list(
                config_path,
                selected_instance,
                None,
                RESOURCE_KIND_APP,
            )
            .await
        }
        ProjectCommand::Get { id } => {
            run_kind_operation(
                config_path,
                selected_instance,
                &id,
                RESOURCE_KIND_APP,
                KindOperation::Get,
            )
            .await
        }
        ProjectCommand::Apply(args) => {
            run_project_apply(config_path, selected_instance, args).await
        }
        ProjectCommand::Delete { id } => {
            run_kind_operation(
                config_path,
                selected_instance,
                &id,
                RESOURCE_KIND_APP,
                KindOperation::Delete,
            )
            .await
        }
        ProjectCommand::Metrics { .. } => unsupported("projects metrics"),
        ProjectCommand::Deploy(args) => {
            run_project_deploy(config_path, selected_instance, args).await
        }
        ProjectCommand::Deployments { id } => {
            run_get_json(
                config_path,
                selected_instance,
                &service_deployments_path(&id),
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
        ServiceCommand::Create(args) => {
            run_service_create(config_path, selected_instance, args).await
        }
        ServiceCommand::List(args) => {
            let path =
                grouped_resource_path(SERVICES_PATH, args.group_id.as_deref());
            run_get_json(config_path, selected_instance, &path, true).await
        }
        ServiceCommand::Get { id } => {
            run_get_json(
                config_path,
                selected_instance,
                &service_item_path(&id),
                true,
            )
            .await
        }
        ServiceCommand::Settings { id } => {
            run_get_json(
                config_path,
                selected_instance,
                &format!("{}/settings", service_item_path(&id)),
                true,
            )
            .await
        }
        ServiceCommand::Update(args) => {
            run_service_update(config_path, selected_instance, args).await
        }
        ServiceCommand::Logs(args) => {
            run_logs_command(
                config_path,
                selected_instance,
                &service_logs_path(&args.id, args.tail),
            )
            .await
        }
        ServiceCommand::HttpLogs(args) => {
            run_get_json(
                config_path,
                selected_instance,
                &format!(
                    "{}/http-logs?limit={}&offset={}",
                    service_item_path(&args.id),
                    args.limit,
                    args.offset
                ),
                true,
            )
            .await
        }
        ServiceCommand::Deploy(args) => {
            run_service_deploy(config_path, selected_instance, args).await
        }
        ServiceCommand::Start { id } => {
            run_post_empty(
                config_path,
                selected_instance,
                &service_action_path(&id, "start"),
            )
            .await
        }
        ServiceCommand::Stop { id } => {
            run_post_empty(
                config_path,
                selected_instance,
                &service_action_path(&id, "stop"),
            )
            .await
        }
        ServiceCommand::Restart { id } => {
            run_post_empty(
                config_path,
                selected_instance,
                &service_action_path(&id, "restart"),
            )
            .await
        }
        ServiceCommand::Delete { id } => {
            run_delete_json(
                config_path,
                selected_instance,
                &service_item_path(&id),
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
    let kind = RESOURCE_KIND_DATABASE;
    let (id, operation) = match command {
        DatabaseCommand::List(args) => {
            return run_kind_list(
                config_path,
                selected_instance,
                args.group_id.as_deref(),
                kind,
            )
            .await;
        }
        DatabaseCommand::Create(args) => {
            if is_queue_template(&args.db_type) {
                return Err(anyhow!(
                    "'{}' is a queue type; use `containr-cmd queues create`",
                    args.db_type
                ));
            }
            let body = template_create_body(
                args.name,
                args.db_type,
                args.version,
                args.memory_limit_mb,
                args.cpu_limit,
                args.group_id,
            );
            return run_post_json(
                config_path,
                selected_instance,
                SERVICES_PATH,
                &body,
            )
            .await;
        }
        DatabaseCommand::Expose(_) => return unsupported("databases expose"),
        DatabaseCommand::Pitr(_) => return unsupported("databases pitr"),
        DatabaseCommand::Proxy(_) => return unsupported("databases proxy"),
        DatabaseCommand::BaseBackup(_) => {
            return unsupported("databases base-backup");
        }
        DatabaseCommand::RestorePoint(_) => {
            return unsupported("databases restore-point");
        }
        DatabaseCommand::Recover(_) => return unsupported("databases recover"),
        DatabaseCommand::Get { id } => (id, KindOperation::Get),
        DatabaseCommand::Logs(args) => {
            (args.id, KindOperation::Logs { tail: args.tail })
        }
        DatabaseCommand::Start { id } => (id, KindOperation::Action("start")),
        DatabaseCommand::Stop { id } => (id, KindOperation::Action("stop")),
        DatabaseCommand::Restart { id } => {
            (id, KindOperation::Action("restart"))
        }
        DatabaseCommand::Delete { id } => (id, KindOperation::Delete),
    };

    run_kind_operation(config_path, selected_instance, &id, kind, operation)
        .await
}

async fn run_queue_command(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    command: QueueCommand,
) -> Result<()> {
    let kind = RESOURCE_KIND_QUEUE;
    let (id, operation) = match command {
        QueueCommand::List(args) => {
            return run_kind_list(
                config_path,
                selected_instance,
                args.group_id.as_deref(),
                kind,
            )
            .await;
        }
        QueueCommand::Create(args) => {
            if !is_queue_template(&args.queue_type) {
                return Err(anyhow!(
                    "unsupported queue type '{}'. supported: rabbitmq",
                    args.queue_type
                ));
            }
            let body = template_create_body(
                args.name,
                args.queue_type,
                args.version,
                args.memory_limit_mb,
                args.cpu_limit,
                args.group_id,
            );
            return run_post_json(
                config_path,
                selected_instance,
                SERVICES_PATH,
                &body,
            )
            .await;
        }
        QueueCommand::Expose(_) => return unsupported("queues expose"),
        QueueCommand::Get { id } => (id, KindOperation::Get),
        QueueCommand::Start { id } => (id, KindOperation::Action("start")),
        QueueCommand::Stop { id } => (id, KindOperation::Action("stop")),
        QueueCommand::Delete { id } => (id, KindOperation::Delete),
    };

    run_kind_operation(config_path, selected_instance, &id, kind, operation)
        .await
}

/// operation on a service that must be of a specific resource kind
enum KindOperation {
    Get,
    Logs { tail: usize },
    Action(&'static str),
    Delete,
}

fn unsupported(command: &str) -> Result<()> {
    Err(anyhow!(
        "`containr-cmd {command}` is not supported by this server version"
    ))
}

fn is_queue_template(template: &str) -> bool {
    template.trim().eq_ignore_ascii_case("rabbitmq")
}

fn template_create_body(
    name: String,
    template: String,
    version: Option<String>,
    memory_limit_mb: Option<u64>,
    cpu_limit: Option<f64>,
    group_id: Option<String>,
) -> Value {
    json!({
        "source": "template",
        "name": name,
        "template": template,
        "version": version,
        "memory_limit_mb": memory_limit_mb,
        "cpu_limit": cpu_limit,
        "group_id": group_id,
    })
}

async fn run_kind_list(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    group_id: Option<&str>,
    kind: &str,
) -> Result<()> {
    let client = load_client(config_path, selected_instance, true)?;
    let path = grouped_resource_path(SERVICES_PATH, group_id);
    let response = client.get_json(&path).await?;
    print_json(&filter_by_resource_kind(response, kind)?)
}

async fn run_kind_operation(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    id: &str,
    kind: &str,
    operation: KindOperation,
) -> Result<()> {
    let client = load_client(config_path, selected_instance, true)?;
    let service = fetch_service_of_kind(&client, id, kind).await?;

    match operation {
        KindOperation::Get => print_json(&service),
        KindOperation::Logs { tail } => {
            let response =
                client.get_json(&service_logs_path(id, tail)).await?;
            let logs = extract_string(&response, &["logs"])?;
            println!("{}", logs);
            Ok(())
        }
        KindOperation::Action(action) => {
            let response =
                client.post_empty(&service_action_path(id, action)).await?;
            print_json(&response)
        }
        KindOperation::Delete => {
            let response = client.delete(&service_item_path(id)).await?;
            print_json(&response)
        }
    }
}

async fn fetch_service_of_kind(
    client: &ApiClient,
    id: &str,
    kind: &str,
) -> Result<Value> {
    let service = client.get_json(&service_item_path(id)).await?;
    let actual = service
        .get("resource_kind")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if actual != kind {
        return Err(anyhow!("service {id} is a {actual}, expected a {kind}"));
    }
    Ok(service)
}

fn filter_by_resource_kind(value: Value, kind: &str) -> Result<Value> {
    let Value::Array(items) = value else {
        return Err(anyhow!("expected a json array of services"));
    };

    Ok(Value::Array(
        items
            .into_iter()
            .filter(|item| {
                item.get("resource_kind").and_then(Value::as_str) == Some(kind)
            })
            .collect(),
    ))
}

fn grouped_resource_path(base_path: &str, group_id: Option<&str>) -> String {
    match group_id {
        Some(group_id) => format!("{base_path}?group_id={group_id}"),
        None => base_path.to_string(),
    }
}

fn service_item_path(id: &str) -> String {
    format!("{SERVICES_PATH}/{id}")
}

fn service_action_path(id: &str, action: &str) -> String {
    format!("{SERVICES_PATH}/{id}/actions/{action}")
}

fn service_logs_path(id: &str, tail: usize) -> String {
    format!("{SERVICES_PATH}/{id}/logs?tail={tail}")
}

fn service_deployments_path(id: &str) -> String {
    format!("{SERVICES_PATH}/{id}/deployments")
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

async fn run_patch_json(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    path: &str,
    body: &Value,
) -> Result<()> {
    let client = load_client(config_path, selected_instance, true)?;
    let response = client.patch_json(path, body).await?;
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
    let client = load_client(config_path, selected_instance, true)?;

    let Some(id) = args.id.as_deref() else {
        if args.no_deploy {
            eprintln!(
                "note: the server queues an initial deployment when a \
                 service is created; --no-deploy only applies to updates"
            );
        }
        let body = build_project_create_body(&spec)?;
        let project = client.post_json(SERVICES_PATH, &body).await?;
        return print_json(&json!({
            "project": project,
            "deployment": Value::Null,
        }));
    };

    let existing =
        fetch_service_of_kind(&client, id, RESOURCE_KIND_APP).await?;
    let existing_name = existing.get("name").and_then(Value::as_str);
    let body = build_project_update_body(&spec, existing_name)?;
    let project = client.patch_json(&service_item_path(id), &body).await?;

    let deployment = if args.no_deploy {
        None
    } else {
        Some(
            client
                .post_json(&service_deployments_path(id), &json!({}))
                .await?,
        )
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
        &service_deployments_path(&args.id),
        &body,
    )
    .await
}

/// names never included in an upload
const UPLOAD_ALWAYS_EXCLUDED: &[&str] = &[".git", "node_modules", "target"];

async fn run_service_deploy(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    args: ServiceDeployArgs,
) -> Result<()> {
    let client = load_client(config_path, selected_instance, true)?;
    let base = service_item_path(&args.id);

    let response = if let Some(dockerfile) = args.dockerfile.as_deref() {
        let content = fs::read_to_string(dockerfile).with_context(|| {
            format!("failed to read {}", dockerfile.display())
        })?;
        client
            .post_json(
                &format!("{}/deploy/dockerfile", base),
                &json!({ "dockerfile": content }),
            )
            .await?
    } else if let Some(source) = args.upload.as_deref() {
        let (file_name, bytes) = upload_archive(source, &args.exclude)?;
        eprintln!(
            "uploading {} ({:.1} MB)",
            file_name,
            bytes.len() as f64 / 1_048_576.0
        );
        client
            .post_file(&format!("{}/deploy/upload", base), &file_name, bytes)
            .await?
    } else {
        client
            .post_json(
                &service_deployments_path(&args.id),
                &json!({ "branch": args.branch }),
            )
            .await?
    };

    print_json(&response)
}

/// returns an archive to upload: existing archives are sent as-is,
/// directories are packed into a gzipped tarball
fn upload_archive(
    source: &Path,
    extra_excludes: &[String],
) -> Result<(String, Vec<u8>)> {
    let metadata = fs::metadata(source)
        .with_context(|| format!("failed to read {}", source.display()))?;
    if metadata.is_file() {
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("upload.tar.gz")
            .to_string();
        let bytes = fs::read(source)
            .with_context(|| format!("failed to read {}", source.display()))?;
        return Ok((name, bytes));
    }

    let excludes = UPLOAD_ALWAYS_EXCLUDED
        .iter()
        .map(|name| name.to_string())
        .chain(extra_excludes.iter().cloned())
        .collect::<Vec<_>>();
    let encoder = flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::default(),
    );
    let mut builder = tar::Builder::new(encoder);
    builder.follow_symlinks(false);
    append_directory(&mut builder, source, Path::new(""), &excludes)?;
    let encoder = builder.into_inner().context("failed to finish archive")?;
    let bytes = encoder.finish().context("failed to compress archive")?;
    Ok(("upload.tar.gz".to_string(), bytes))
}

fn append_directory<W: std::io::Write>(
    builder: &mut tar::Builder<W>,
    root: &Path,
    relative: &Path,
    excludes: &[String],
) -> Result<()> {
    let directory = root.join(relative);
    let mut entries = fs::read_dir(&directory)
        .with_context(|| format!("failed to read {}", directory.display()))?
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let name = entry.file_name();
        if excludes.iter().any(|exclude| name == exclude.as_str()) {
            continue;
        }
        let path = relative.join(&name);
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            builder.append_dir(&path, entry.path())?;
            append_directory(builder, root, &path, excludes)?;
        } else if file_type.is_file() || file_type.is_symlink() {
            builder.append_path_with_name(entry.path(), &path)?;
        }
    }
    Ok(())
}

async fn run_project_deployment_logs(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    args: ProjectDeploymentLogsArgs,
) -> Result<()> {
    let client = load_client(config_path, selected_instance, true)?;
    let response = client
        .get_json(&format!(
            "{}/{}/logs?limit={}&offset={}",
            service_deployments_path(&args.project_id),
            args.deployment_id,
            args.limit,
            args.offset
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
            "{}/{}/rollback",
            service_deployments_path(&args.project_id),
            args.deployment_id
        ),
        &body,
    )
    .await
}

async fn run_service_update(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    args: ServiceUpdateArgs,
) -> Result<()> {
    let body = load_structured_value(&args.file)?;
    run_patch_json(
        config_path,
        selected_instance,
        &service_item_path(&args.id),
        &body,
    )
    .await
}

async fn run_service_create(
    config_path: Option<&Path>,
    selected_instance: Option<&str>,
    args: ServiceCreateArgs,
) -> Result<()> {
    let body = load_structured_value(&args.file)?;
    run_post_json(config_path, selected_instance, SERVICES_PATH, &body).await
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

fn load_structured_value(path: &Path) -> Result<Value> {
    let content = fs::read_to_string(path)
        .with_context(|| format!("failed to read {}", path.display()))?;

    if matches!(path.extension().and_then(|ext| ext.to_str()), Some("json")) {
        return serde_json::from_str(&content)
            .with_context(|| format!("failed to parse {}", path.display()));
    }

    if matches!(path.extension().and_then(|ext| ext.to_str()), Some("toml")) {
        let value: toml::Value = toml::from_str(&content)
            .with_context(|| format!("failed to parse {}", path.display()))?;
        return serde_json::to_value(value)
            .with_context(|| format!("failed to convert {}", path.display()));
    }

    serde_json::from_str(&content)
        .or_else(|json_error| {
            toml::from_str::<toml::Value>(&content)
                .map_err(anyhow::Error::from)
                .and_then(|value| serde_json::to_value(value).map_err(Into::into))
                .with_context(|| format!("failed to parse {}", path.display()))
                .map_err(|toml_error| anyhow!(
                    "failed to parse {} as json ({json_error}) or toml ({toml_error})",
                    path.display()
                ))
        })
}

fn build_project_create_body(spec: &ProjectSpec) -> Result<Value> {
    let service = select_project_service(spec, None)?;
    Ok(json!({
        "source": "git_repository",
        "name": spec.name,
        "github_url": resolve_project_source_url(spec),
        "branch": spec.branch,
        "env_vars": spec.env_vars,
        "service": service,
        "rollout_strategy": spec.rollout_strategy,
    }))
}

fn build_project_update_body(
    spec: &ProjectSpec,
    existing_service_name: Option<&str>,
) -> Result<Value> {
    let service = select_project_service(spec, existing_service_name)?;
    let github_url = resolve_project_source_url(spec);
    let github_url = (!github_url.is_empty()).then_some(github_url);
    Ok(json!({
        "github_url": github_url,
        "branch": spec.branch,
        "env_vars": spec.env_vars,
        "rollout_strategy": spec.rollout_strategy,
        "service": service,
    }))
}

/// picks the single service definition the api accepts per service entity.
/// project-level `port`/`domain(s)` are used when no services are listed
/// and as fallback domains for a service that defines none.
fn select_project_service(
    spec: &ProjectSpec,
    preferred_name: Option<&str>,
) -> Result<Value> {
    let selected = match spec.services.as_slice() {
        [] => {
            let port = spec.port.ok_or_else(|| {
                anyhow!(
                    "project spec must define `port` or a [[services]] entry"
                )
            })?;
            return Ok(json!({
                "name": spec.name,
                "port": port,
                "domains": spec.domains,
                "domain": spec.domain,
            }));
        }
        [service] => service,
        services => preferred_name
            .and_then(|name| {
                services.iter().find(|service| service.name == name)
            })
            .ok_or_else(|| {
                anyhow!(
                    "project spec defines {} services, but the server \
                     manages one service per entity; split the spec into \
                     one file per service or pass --id of a service whose \
                     name matches an entry",
                    services.len()
                )
            })?,
    };

    let mut value = serde_json::to_value(selected)
        .context("failed to encode service spec")?;
    if selected.domains.is_none() && selected.domain.is_none() {
        if let Some(object) = value.as_object_mut() {
            object.insert("domains".to_string(), json!(spec.domains));
            object.insert("domain".to_string(), json!(spec.domain));
        }
    }
    Ok(value)
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
) -> Result<&'a mut containr_cmd::client_config::ClientInstanceConfig> {
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

#[cfg(test)]
mod upload_tests {
    use super::upload_archive;
    use std::io::Read;

    #[test]
    fn upload_archive_skips_git_and_excluded_names() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        std::fs::write(root.join("Dockerfile"), "FROM scratch\n")
            .expect("write dockerfile");
        std::fs::create_dir_all(root.join(".git")).expect("git dir");
        std::fs::write(root.join(".git/HEAD"), "ref").expect("write head");
        std::fs::create_dir_all(root.join("src")).expect("src dir");
        std::fs::write(root.join("src/main.rs"), "fn main() {}")
            .expect("write main");
        std::fs::write(root.join("secret.env"), "X=1").expect("write env");

        let (name, bytes) =
            upload_archive(root, &["secret.env".to_string()]).expect("pack");
        assert_eq!(name, "upload.tar.gz");

        let mut decoder = flate2::read::GzDecoder::new(bytes.as_slice());
        let mut raw = Vec::new();
        decoder.read_to_end(&mut raw).expect("gunzip");
        let mut archive = tar::Archive::new(raw.as_slice());
        let paths = archive
            .entries()
            .expect("entries")
            .map(|entry| {
                entry
                    .expect("entry")
                    .path()
                    .expect("path")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();

        assert!(paths.iter().any(|path| path == "Dockerfile"));
        assert!(paths.iter().any(|path| path == "src/main.rs"));
        assert!(!paths.iter().any(|path| path.starts_with(".git")));
        assert!(!paths.iter().any(|path| path == "secret.env"));
    }
}
