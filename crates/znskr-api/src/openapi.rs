//! openapi documentation setup

use utoipa::openapi::security::{Http, HttpAuthScheme, SecurityScheme};
use utoipa::{Modify, OpenApi};

use crate::handlers::{apps, auth, health, settings};

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
        (name = "apps", description = "application management")
    ),
    paths(
        health::health,
        auth::register,
        auth::login,
        auth::github_callback,
        settings::get_settings,
        settings::update_settings,
        settings::issue_dashboard_certificate,
        apps::list_apps,
        apps::create_app,
        apps::get_app,
        apps::update_app,
        apps::delete_app,
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
