//! /api/services routes

use axum::routing::{delete, get, patch, post};
use axum::Router;

use crate::handlers::services;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/services", get(services::list_services))
        .route("/api/services", post(services::create_service))
        .route(
            "/api/services/{id}/deployments",
            get(services::list_service_deployments),
        )
        .route(
            "/api/services/{id}/deployments",
            post(services::trigger_service_deployment),
        )
        .route(
            "/api/services/{id}/deployments/{deployment_id}",
            get(services::get_service_deployment),
        )
        .route(
            "/api/services/{id}/deployments/{deployment_id}/rollback",
            post(services::rollback_service_deployment),
        )
        .route(
            "/api/services/{id}/deployments/{deployment_id}/logs",
            get(services::get_service_deployment_logs),
        )
        .route("/api/services/{id}", get(services::get_service))
        .route("/api/services/{id}", patch(services::update_service))
        .route("/api/services/{id}", delete(services::delete_service))
        .route(
            "/api/services/{id}/settings",
            get(services::get_service_settings),
        )
        .route("/api/services/{id}/logs", get(services::get_service_logs))
        .route(
            "/api/services/{id}/http-logs",
            get(services::list_service_http_logs),
        )
        .route(
            "/api/services/{id}/actions/{action}",
            post(services::run_service_action),
        )
}
