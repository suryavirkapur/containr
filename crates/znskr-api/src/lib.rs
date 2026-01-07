//! znskr-api: rest api and github webhook handler

pub mod auth;
pub mod github;
pub mod handlers;
pub mod server;
pub mod state;

pub use server::run_server;
pub use state::AppState;
