//! containr-runtime: docker runtime integration for container management
//!
//! provides docker-based apis for managing containers, images, and deployments.

pub mod database_manager;
pub mod docker;
pub mod error;
pub mod image;
pub mod queue_manager;
pub mod route_updates;
pub mod storage_manager;
pub mod worker;

pub use database_manager::DatabaseManager;
pub use docker::{
    DockerBindMount, DockerContainerConfig, DockerContainerInfo, DockerContainerManager,
    DockerContainerState, DockerContainerStats, DockerContainerStatus, DockerExecSession,
    DockerMountInfo, DockerNetworkAttachment, INTERNAL_NETWORK_NAME,
};
pub use error::{ClientError, Result};
pub use image::{ImageInfo, ImageManager, RegistryCredentials};
pub use queue_manager::QueueManager;
pub use route_updates::ProxyRouteUpdate;
pub use storage_manager::StorageManager;
pub use worker::DeploymentWorker;

// re-export from common
pub use containr_common::models::DeploymentJob;
