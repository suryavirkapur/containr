//! openapi documentation setup

use utoipa::openapi::security::{Http, HttpAuthScheme, SecurityScheme};
use utoipa::{Modify, OpenApi};

use crate::handlers::{
    apps, auth, certificates, containers, databases, deployments, git, github_app, health, queues,
    settings, storage, system,
};

/// api documentation
#[derive(OpenApi)]
#[openapi(
    info(
        title = "znskr api",
        version = "1.0.0",
        description = "znskr paas api for managing apps and deployments"
    ),
    tags(
        (name = "health", description = "health check endpoints"),
        (name = "auth", description = "authentication endpoints"),
        (name = "settings", description = "server settings management"),
        (name = "apps", description = "application management"),
        (name = "deployments", description = "deployment management"),
        (name = "certificates", description = "ssl certificate management"),
        (name = "git", description = "git push management"),
        (name = "databases", description = "managed databases"),
        (name = "queues", description = "managed queues"),
        (name = "storage", description = "s3-compatible storage buckets"),
        (name = "containers", description = "container monitoring and volumes"),
        (name = "github-app", description = "github app integration"),
        (name = "system", description = "system monitoring")
    ),
    paths(
        // health
        health::health,
        // system
        system::get_system_stats,
        // auth
        auth::register,
        auth::login,
        auth::github_start,
        auth::github_callback,
        // settings
        settings::get_settings,
        settings::update_settings,
        settings::issue_dashboard_certificate,
        // github app
        github_app::get_github_app,
        github_app::delete_github_app,
        github_app::get_app_manifest,
        github_app::github_app_callback,
        github_app::github_install_callback,
        github_app::get_app_repos,
        // apps
        apps::list_apps,
        apps::create_app,
        apps::get_app,
        apps::get_app_metrics,
        apps::update_app,
        apps::delete_app,
        // deployments
        deployments::list_deployments,
        deployments::get_deployment,
        deployments::trigger_deployment,
        deployments::rollback_deployment,
        deployments::get_deployment_logs,
        // git
        git::get_git_info,
        git::enable_git,
        git::rotate_git_token,
        // certificates
        certificates::get_certificate,
        certificates::reissue_certificate,
        // databases
        databases::list_databases,
        databases::create_database,
        databases::get_database,
        databases::delete_database,
        databases::start_database,
        databases::stop_database,
        databases::get_database_logs,
        databases::expose_database,
        databases::export_database,
        databases::list_backups,
        databases::download_backup,
        // queues
        queues::list_queues,
        queues::create_queue,
        queues::get_queue,
        queues::delete_queue,
        queues::start_queue,
        queues::stop_queue,
        // storage
        storage::list_buckets,
        storage::create_bucket,
        storage::get_bucket,
        storage::delete_bucket,
        // containers
        containers::list_containers,
        containers::get_container_status,
        containers::get_container_logs,
        containers::list_container_mounts,
        containers::list_volume_entries,
        containers::delete_volume_entry,
        containers::download_volume_entry,
        containers::upload_volume_entry,
        containers::create_volume_directory,
    ),
    components(
        schemas(
            // health
            health::HealthResponse,
            // system
            system::SystemStats,
            // auth
            auth::LoginRequest,
            auth::RegisterRequest,
            auth::AuthResponse,
            auth::UserResponse,
            auth::ErrorResponse,
            // settings
            settings::SettingsResponse,
            settings::UpdateSettingsRequest,
            settings::DashboardCertResponse,
            // github app
            github_app::GithubAppStatusResponse,
            github_app::AppDetails,
            github_app::InstallationDetails,
            github_app::AppReposResponse,
            github_app::RepoInfo,
            // apps
            apps::CreateAppRequest,
            apps::UpdateAppRequest,
            apps::AppResponse,
            apps::EnvVarRequest,
            apps::EnvVarResponse,
            apps::AppMetricsResponse,
            // deployments
            deployments::DeploymentResponse,
            deployments::DeploymentTriggerRequest,
            deployments::RollbackRequest,
            // certificates
            certificates::CertificateResponse,
            certificates::ReissueRequest,
            certificates::ReissueResponse,
            // git
            git::GitInfoResponse,
            git::GitEnableResponse,
            // databases
            databases::CreateDatabaseRequest,
            databases::DatabaseResponse,
            databases::LogsResponse,
            databases::ExposeRequest,
            databases::ExportResponse,
            databases::BackupInfo,
            // queues
            queues::CreateQueueRequest,
            queues::QueueResponse,
            // storage
            storage::CreateBucketRequest,
            storage::BucketResponse,
            // containers
            containers::ContainerListItem,
            containers::ContainerStatusResponse,
            containers::ContainerLogsResponse,
            containers::ContainerMountResponse,
            containers::VolumeEntry,
        )
    ),
    modifiers(&SecurityAddon)
)]
pub struct ApiDoc;

/// adds bearer token security to the openapi spec
struct SecurityAddon;

impl Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        if let Some(components) = openapi.components.as_mut() {
            components.add_security_scheme(
                "bearer",
                SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
            );
        }
    }
}
