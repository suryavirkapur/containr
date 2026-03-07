//! containr-proxy: pingora-based reverse proxy with automatic ssl

pub mod acme;
pub mod pingora_proxy;
pub mod routes;
mod static_files;

pub use acme::ChallengeStore;
pub use routes::RouteManager;
