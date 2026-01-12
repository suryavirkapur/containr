//! containerd grpc client
//!
//! connects to containerd via unix socket and provides methods for
//! managing containers and images using the containerd-client crate.

use containerd_client::services::v1::{
    container, containers_client::ContainersClient, images_client::ImagesClient,
    tasks_client::TasksClient, version_client::VersionClient, Container, CreateContainerRequest,
    CreateTaskRequest, DeleteContainerRequest, DeleteTaskRequest, GetContainerRequest,
    GetImageRequest, KillRequest, ListContainersRequest, ListImagesRequest, StartRequest,
};
use containerd_client::tonic::transport::Channel;
use containerd_client::tonic::Request;
use containerd_client::{connect, with_namespace};
use std::collections::HashMap;
use thiserror::Error;
use tracing::info;

/// containerd client errors
#[derive(Error, Debug)]
pub enum ClientError {
    #[error("connection failed: {0}")]
    Connection(String),

    #[error("container not found: {0}")]
    ContainerNotFound(String),

    #[error("image not found: {0}")]
    ImageNotFound(String),

    #[error("task error: {0}")]
    Task(String),

    #[error("grpc error: {0}")]
    Grpc(String),

    #[error("operation failed: {0}")]
    Operation(String),
}

impl From<containerd_client::tonic::Status> for ClientError {
    fn from(status: containerd_client::tonic::Status) -> Self {
        ClientError::Grpc(status.message().to_string())
    }
}

impl From<containerd_client::tonic::transport::Error> for ClientError {
    fn from(err: containerd_client::tonic::transport::Error) -> Self {
        ClientError::Connection(err.to_string())
    }
}

/// result type for containerd operations
pub type Result<T> = std::result::Result<T, ClientError>;

/// containerd grpc client wrapper
pub struct ContainerdClient {
    channel: Channel,
    namespace: String,
}

impl ContainerdClient {
    /// creates a new client connected to the containerd socket
    pub async fn connect(socket_path: &str, namespace: &str) -> Result<Self> {
        info!(socket = %socket_path, namespace = %namespace, "connecting to containerd");

        let channel = connect(socket_path).await?;

        // verify connection by getting version
        let mut version_client = VersionClient::new(channel.clone());
        let version = version_client.version(()).await?;
        let version_info = version.get_ref();

        info!(
            version = %version_info.version,
            revision = %version_info.revision,
            "connected to containerd"
        );

        Ok(Self {
            channel,
            namespace: namespace.to_string(),
        })
    }

    /// returns the namespace
    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    // --- container operations ---

    /// creates a new container
    pub async fn create_container(
        &self,
        id: &str,
        image: &str,
        labels: HashMap<String, String>,
    ) -> Result<Container> {
        let mut client = ContainersClient::new(self.channel.clone());

        let container = Container {
            id: id.to_string(),
            image: image.to_string(),
            labels,
            runtime: Some(container::Runtime {
                name: "io.containerd.runc.v2".to_string(),
                options: None,
            }),
            ..Default::default()
        };

        let req = with_namespace!(
            CreateContainerRequest {
                container: Some(container)
            },
            &self.namespace
        );

        let resp = client.create(req).await?;
        resp.into_inner()
            .container
            .ok_or_else(|| ClientError::Operation("container not returned".to_string()))
    }

    /// gets a container by id
    pub async fn get_container(&self, id: &str) -> Result<Container> {
        let mut client = ContainersClient::new(self.channel.clone());

        let req = with_namespace!(GetContainerRequest { id: id.to_string() }, &self.namespace);

        let resp = client.get(req).await?;
        resp.into_inner()
            .container
            .ok_or_else(|| ClientError::ContainerNotFound(id.to_string()))
    }

    /// lists all containers
    pub async fn list_containers(&self) -> Result<Vec<Container>> {
        let mut client = ContainersClient::new(self.channel.clone());

        let req = with_namespace!(ListContainersRequest { filters: vec![] }, &self.namespace);

        let resp = client.list(req).await?;
        Ok(resp.into_inner().containers)
    }

    /// deletes a container
    pub async fn delete_container(&self, id: &str) -> Result<()> {
        let mut client = ContainersClient::new(self.channel.clone());

        let req = with_namespace!(
            DeleteContainerRequest { id: id.to_string() },
            &self.namespace
        );

        client.delete(req).await?;
        Ok(())
    }

    // --- task operations ---

    /// creates and starts a task for a container
    pub async fn create_task(&self, container_id: &str) -> Result<u32> {
        let mut client = TasksClient::new(self.channel.clone());

        let req = with_namespace!(
            CreateTaskRequest {
                container_id: container_id.to_string(),
                ..Default::default()
            },
            &self.namespace
        );

        let resp = client.create(req).await?;
        Ok(resp.into_inner().pid)
    }

    /// starts a task
    pub async fn start_task(&self, container_id: &str) -> Result<()> {
        let mut client = TasksClient::new(self.channel.clone());

        let req = with_namespace!(
            StartRequest {
                container_id: container_id.to_string(),
                ..Default::default()
            },
            &self.namespace
        );

        client.start(req).await?;
        Ok(())
    }

    /// kills a task
    pub async fn kill_task(&self, container_id: &str, signal: u32) -> Result<()> {
        let mut client = TasksClient::new(self.channel.clone());

        let req = with_namespace!(
            KillRequest {
                container_id: container_id.to_string(),
                signal,
                ..Default::default()
            },
            &self.namespace
        );

        client.kill(req).await?;
        Ok(())
    }

    /// deletes a task
    pub async fn delete_task(&self, container_id: &str) -> Result<()> {
        let mut client = TasksClient::new(self.channel.clone());

        let req = with_namespace!(
            DeleteTaskRequest {
                container_id: container_id.to_string(),
            },
            &self.namespace
        );

        client.delete(req).await?;
        Ok(())
    }

    // --- image operations ---

    /// gets an image by name
    pub async fn get_image(&self, name: &str) -> Result<containerd_client::services::v1::Image> {
        let mut client = ImagesClient::new(self.channel.clone());

        let req = with_namespace!(
            GetImageRequest {
                name: name.to_string()
            },
            &self.namespace
        );

        let resp = client.get(req).await?;
        resp.into_inner()
            .image
            .ok_or_else(|| ClientError::ImageNotFound(name.to_string()))
    }

    /// lists all images
    pub async fn list_images(&self) -> Result<Vec<containerd_client::services::v1::Image>> {
        let mut client = ImagesClient::new(self.channel.clone());

        let req = with_namespace!(ListImagesRequest { filters: vec![] }, &self.namespace);

        let resp = client.list(req).await?;
        Ok(resp.into_inner().images)
    }

    /// checks if an image exists
    pub async fn image_exists(&self, name: &str) -> Result<bool> {
        match self.get_image(name).await {
            Ok(_) => Ok(true),
            Err(ClientError::ImageNotFound(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }
}

/// default socket path for containerd
pub const DEFAULT_SOCKET: &str = "/run/containerd/containerd.sock";

/// default namespace for znskr containers
pub const DEFAULT_NAMESPACE: &str = "znskr";

impl Clone for ContainerdClient {
    fn clone(&self) -> Self {
        Self {
            channel: self.channel.clone(),
            namespace: self.namespace.clone(),
        }
    }
}
