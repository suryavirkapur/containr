//! openapi documentation setup

use utoipa::openapi::security::{Http, HttpAuthScheme, SecurityScheme};
use utoipa::{Modify, OpenApi};

use crate::handlers::{
    auth, certificates, containers, deployments, github_app, health, projects,
    registries, services, settings, storage, system, updates,
};

/// api documentation
#[derive(OpenApi)]
#[openapi(
    info(
        title = "containr api",
        version = "1.0.0",
        description = "containr paas api for managing services, deployments, and infrastructure"
    ),
    tags(
        (name = "health", description = "health check endpoints"),
        (name = "auth", description = "authentication endpoints"),
        (name = "settings", description = "server settings management"),
        (name = "deployments", description = "service deployment management"),
        (name = "services", description = "unified service inventory"),
        (name = "storage", description = "s3-compatible storage buckets"),
        (name = "containers", description = "container monitoring and volumes"),
        (name = "github-app", description = "github app integration"),
        (name = "system", description = "system monitoring"),
        (name = "certificates", description = "service certificate management"),
        (name = "registries", description = "private container registries"),
        (name = "projects", description = "projects grouping services on one network")
    ),
    paths(
        // health
        health::health,
        // system
        system::get_system_stats,
        system::get_system_info,
        system::get_disk_usage,
        system::run_cleanup,
        system::download_backup,
        updates::check_update,
        updates::install_update,
        // projects
        projects::list_projects,
        projects::update_project,
        // registries
        registries::list_registries,
        registries::create_registry,
        registries::delete_registry,
        // auth
        auth::status,
        auth::register,
        auth::login,
        auth::me,
        auth::list_users,
        auth::create_user,
        auth::delete_user,
        auth::change_password,
        auth::github_start,
        auth::github_callback,
        auth::github_link_start,
        auth::github_unlink,
        // settings
        settings::get_settings,
        settings::update_settings,
        settings::issue_dashboard_certificate,
        // certificates
        certificates::get_certificate,
        certificates::reissue_certificate,
        // github app
        github_app::get_github_app,
        github_app::delete_github_app,
        github_app::get_app_manifest,
        github_app::github_app_callback,
        github_app::github_install_callback,
        github_app::get_app_repos,
        // services
        services::create_service,
        services::list_services,
        services::get_service,
        services::get_service_settings,
        services::reveal_env_var,
        crate::handlers::gate::create_gate_pass,
        services::update_service,
        services::get_service_logs,
        services::list_service_http_logs,
        services::run_service_action,
        services::list_service_deployments,
        services::get_service_deployment,
        services::trigger_service_deployment,
        services::rollback_service_deployment,
        services::get_service_deployment_logs,
        services::delete_service,
        services::update_service_settings,
        services::move_service,
        services::get_service_metrics,
        services::deploy_upload,
        services::deploy_dockerfile,
        // storage
        storage::list_buckets,
        storage::create_bucket,
        storage::get_bucket,
        storage::get_bucket_connection,
        storage::delete_bucket,
        // containers
        containers::list_containers,
        containers::get_container_status,
        containers::get_container_logs,
        containers::issue_exec_token,
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
            system::SystemInfoResponse,
            system::DiskUsageEntryResponse,
            system::DiskUsageResponse,
            system::CleanupRequest,
            system::CleanupResponse,
            updates::UpdateCheckResponse,
            updates::InstallUpdateRequest,
            updates::InstallUpdateResponse,
            // projects
            projects::ProjectResponse,
            projects::UpdateProjectRequest,
            // registries
            registries::RegistryResponse,
            registries::CreateRegistryRequest,
            // auth
            auth::RegistrationStatusResponse,
            auth::LoginRequest,
            auth::RegisterRequest,
            auth::CreateUserRequest,
            auth::ChangePasswordRequest,
            auth::AuthResponse,
            auth::GithubLinkResponse,
            auth::UserResponse,
            auth::ErrorResponse,
            // settings
            settings::SettingsResponse,
            settings::UpdateSettingsRequest,
            settings::DashboardCertResponse,
            // certificates
            certificates::CertificateResponse,
            certificates::ReissueRequest,
            certificates::ReissueResponse,
            // github app
            github_app::GithubAppStatusResponse,
            github_app::AppDetails,
            github_app::InstallationDetails,
            github_app::AppReposResponse,
            github_app::RepoInfo,
            // deployments
            deployments::DeploymentResponse,
            deployments::DeploymentTriggerRequest,
            deployments::RollbackRequest,
            // services
            crate::domain::services::AutoDeploySettingsRequest,
            crate::domain::services::AutoDeploySettingsResponse,
            crate::domain::services::CreateServiceRequest,
            crate::domain::services::EditableEnvVarResponse,
            crate::domain::services::EnvVarRequest,
            crate::domain::services::HealthCheckResponse,
            crate::domain::services::HealthCheckRequest,
            crate::domain::services::HttpRequestLogResponse,
            crate::domain::services::InventoryServiceResponse,
            crate::domain::services::ServiceMountRequest,
            crate::domain::services::ServiceLogsResponse,
            crate::domain::services::ServiceSettingsResponse,
            crate::domain::services::RevealEnvVarRequest,
            crate::domain::services::RevealEnvVarResponse,
            crate::domain::services::LoginGateRequest,
            crate::domain::services::LoginGateResponse,
            crate::handlers::gate::GatePassRequest,
            crate::handlers::gate::GatePassResponse,
            crate::domain::services::ServiceSettingsServiceResponse,
            crate::domain::services::ServiceRegistryAuthResponse,
            crate::domain::services::ServiceRegistryAuthRequest,
            crate::domain::services::ServiceRequest,
            crate::domain::services::UpdateServiceRequest,
            crate::domain::services::BasicAuthRequest,
            crate::domain::services::BasicAuthResponse,
            crate::domain::services::PortMappingRequest,
            crate::domain::services::PortMappingResponse,
            crate::domain::services::MoveServiceRequest,
            crate::domain::services::DockerfileDeployRequest,
            crate::domain::services::ServiceContainerMetrics,
            crate::domain::services::ServiceMetricsResponse,
            services::SourceUploadForm,
            // storage
            storage::CreateBucketRequest,
            storage::BucketResponse,
            storage::BucketConnectionResponse,
            // containers
            containers::ContainerListItem,
            containers::ContainerStatusResponse,
            containers::ContainerLogsResponse,
            containers::ExecTokenResponse,
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
