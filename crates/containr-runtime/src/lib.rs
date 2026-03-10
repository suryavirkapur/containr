//! containr-runtime: docker runtime integration for container management
//!
//! provides docker-based apis for managing containers, images, and deployments.

pub mod app_service_manager;
pub mod cron_scheduler;
pub mod database_manager;
pub mod docker;
pub mod error;
pub mod image;
pub mod queue_manager;
pub mod route_updates;
pub mod storage_manager;
pub mod worker;

pub use app_service_manager::AppServiceManager;
pub use cron_scheduler::CronJobScheduler;
pub use database_manager::DatabaseManager;
pub use docker::{
    DockerBindMount, DockerContainerConfig, DockerContainerInfo,
    DockerContainerManager, DockerContainerState, DockerContainerStats,
    DockerContainerStatus, DockerExecSession, DockerMountInfo,
    DockerNetworkAttachment,
};
pub use error::{ClientError, Result};
pub use image::{ImageInfo, ImageManager, RegistryCredentials};
pub use queue_manager::QueueManager;
pub use route_updates::ProxyRouteUpdate;
pub use storage_manager::StorageManager;
pub use worker::DeploymentWorker;

// re-export from common
pub use containr_common::models::DeploymentJob;
