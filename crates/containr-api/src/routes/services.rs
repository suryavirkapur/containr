//! /api/services routes

use axum::routing::{delete, get, post};
use axum::Router;

use crate::handlers::services;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/services", get(services::list_services))
        .route("/api/services", post(services::create_service))
        .route("/api/services/{id}", get(services::get_service))
        .route("/api/services/{id}", delete(services::delete_service))
        .route("/api/services/{id}/logs", get(services::get_service_logs))
        .route("/api/services/{id}/start", post(services::start_service))
        .route("/api/services/{id}/stop", post(services::stop_service))
        .route(
            "/api/services/{id}/restart",
            post(services::restart_service),
        )
}
