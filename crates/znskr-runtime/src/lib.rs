//! znskr-runtime: containerd integration for container management
//!
//! provides grpc client for containerd and high-level apis for
//! managing containers, images, and deployments.

pub mod client;
pub mod container;
pub mod image;
pub mod worker;

pub use client::ContainerdClient;
pub use container::{ContainerConfig, ContainerInfo, ContainerManager, ContainerStatus};
pub use image::{ImageInfo, ImageManager};
pub use worker::DeploymentWorker;

// re-export from common
pub use znskr_common::models::DeploymentJob;
