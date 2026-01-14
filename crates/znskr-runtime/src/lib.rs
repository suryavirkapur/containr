//! znskr-runtime: containerd integration for container management
//!
//! provides grpc client for containerd and high-level apis for
//! managing containers, images, and deployments.

pub mod client;
pub mod container;
pub mod database_manager;
pub mod docker;
pub mod image;
pub mod route_updates;
pub mod storage_manager;
pub mod worker;

pub use client::ContainerdClient;
pub use container::{ContainerConfig, ContainerInfo, ContainerManager, ContainerStatus};
pub use database_manager::DatabaseManager;
pub use docker::{
    DockerContainerConfig, DockerContainerInfo, DockerContainerManager, DockerContainerStatus,
};
pub use image::{ImageInfo, ImageManager};
pub use route_updates::ProxyRouteUpdate;
pub use storage_manager::StorageManager;
pub use worker::DeploymentWorker;

// re-export from common
pub use znskr_common::models::DeploymentJob;

