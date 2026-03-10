//! containr-common: shared types and database models for the containr paas platform

pub mod config;
pub mod db;
pub mod encryption;
pub mod error;
pub mod managed_services;
pub mod models;
pub mod service_inventory;

pub use config::{CacheConfig, Config, DatabaseConfig, LoggingConfig};
pub use db::Database;
pub use encryption::{decrypt, derive_key, encrypt};
pub use error::{Error, Result};
pub use managed_services::{
    DatabaseType, ManagedDatabase, ServiceStatus, StorageBucket,
};
pub use service_inventory::{
    ServiceInventoryItem, ServiceResourceKind, ServiceRuntimeStatus,
};
