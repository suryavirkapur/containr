//! openapi documentation setup

use utoipa::openapi::security::{Http, HttpAuthScheme, SecurityScheme};
use utoipa::{Modify, OpenApi};

use crate::handlers::{apps, auth, containers, databases, health, queues, settings};

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
        (name = "databases", description = "managed databases"),
        (name = "queues", description = "managed queues"),
        (name = "containers", description = "container monitoring and volumes")
    ),
    paths(
        health::health,
        auth::register,
        auth::login,
        auth::github_start,
        auth::github_callback,
        settings::get_settings,
        settings::update_settings,
        settings::issue_dashboard_certificate,
        apps::list_apps,
        apps::create_app,
        apps::get_app,
        apps::get_app_metrics,
        apps::update_app,
        apps::delete_app,
        databases::list_databases,
        databases::create_database,
        databases::get_database,
        databases::delete_database,
        databases::start_database,
        databases::stop_database,
        queues::list_queues,
        queues::create_queue,
        queues::get_queue,
        queues::delete_queue,
        queues::start_queue,
        queues::stop_queue,
        containers::list_containers,
        containers::get_container_status,
        containers::get_container_logs,
        containers::list_container_mounts,
        containers::list_volume_entries,
        containers::delete_volume_entry,
        containers::download_volume_entry,
        containers::upload_volume_entry,
    ),
    components(
        schemas(
            health::HealthResponse,
            auth::LoginRequest,
            auth::RegisterRequest,
            auth::AuthResponse,
            auth::UserResponse,
            auth::ErrorResponse,
            settings::SettingsResponse,
            settings::UpdateSettingsRequest,
            settings::DashboardCertResponse,
            apps::CreateAppRequest,
            apps::UpdateAppRequest,
            apps::AppResponse,
            apps::EnvVarRequest,
            apps::EnvVarResponse,
            apps::AppMetricsResponse,
            databases::CreateDatabaseRequest,
            databases::DatabaseResponse,
            queues::CreateQueueRequest,
            queues::QueueResponse,
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
