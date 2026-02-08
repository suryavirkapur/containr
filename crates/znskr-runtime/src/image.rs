//! image management
//!
//! high-level api for container image operations using bollard.

use std::path::Path;
use std::sync::Arc;

use bollard::query_parameters::{
    BuildImageOptions, CreateImageOptions, ListImagesOptions, RemoveImageOptions,
};
use bollard::{body_full, Docker};
use futures::StreamExt;
use tracing::{info, warn};

use crate::error::{ClientError, Result};

/// image information
#[derive(Debug, Clone)]
pub struct ImageInfo {
    pub name: String,
    pub digest: String,
    pub size: u64,
}

/// manages container image operations
#[derive(Clone)]
pub struct ImageManager {
    docker: Option<Arc<Docker>>,
    stub_mode: bool,
}

impl ImageManager {
    /// creates a new image manager
    /// panics if unable to connect to docker socket
    pub fn new() -> Self {
        match Docker::connect_with_socket_defaults() {
            Ok(docker) => {
                info!("image manager connected to docker socket");
                Self {
                    docker: Some(Arc::new(docker)),
                    stub_mode: false,
                }
            }
            Err(e) => {
                panic!("failed to connect to docker socket: {}", e);
            }
        }
    }

    /// creates a new image manager in stub mode (for development)
    pub fn new_stub() -> Self {
        warn!("image manager running in stub mode");
        Self {
            docker: None,
            stub_mode: true,
        }
    }

    /// creates a new image manager with no client but NOT in stub mode
    /// useful for testing build/pull commands that use external binaries
    pub fn new_headless() -> Self {
        match Docker::connect_with_socket_defaults() {
            Ok(docker) => Self {
                docker: Some(Arc::new(docker)),
                stub_mode: false,
            },
            Err(e) => {
                panic!("failed to connect to docker socket: {}", e);
            }
        }
    }

    /// returns true if running in stub mode
    pub fn is_stub(&self) -> bool {
        self.stub_mode
    }

    /// gets the docker client
    fn client(&self) -> &Docker {
        self.docker
            .as_ref()
            .expect("docker client not available in stub mode")
    }

    /// pulls an image from a registry
    pub async fn pull_image(&self, name: &str) -> Result<ImageInfo> {
        info!(name = %name, "pulling image");

        if self.stub_mode {
            return Ok(ImageInfo {
                name: name.to_string(),
                digest: "sha256:stub".to_string(),
                size: 0,
            });
        }

        let options = CreateImageOptions {
            from_image: Some(name.to_string()),
            ..Default::default()
        };

        let mut stream = self.client().create_image(Some(options), None, None);

        while let Some(result) = stream.next().await {
            match result {
                Ok(info) => {
                    // log progress if available
                    if let Some(status) = info.status {
                        if status.contains("Digest") || status.contains("Downloaded") {
                            info!(name = %name, status = %status, "pull progress");
                        }
                    }
                }
                Err(e) => {
                    return Err(ClientError::Operation(format!("pull failed: {}", e)));
                }
            }
        }

        info!(name = %name, "image pulled successfully");
        Ok(ImageInfo {
            name: name.to_string(),
            digest: "unknown".to_string(),
            size: 0,
        })
    }

    /// builds an image from a Dockerfile or Containerfile
    ///
    /// The dockerfile parameter can specify either "Dockerfile" or "Containerfile".
    /// If not provided, it will auto-detect which one exists in the context path,
    /// with Containerfile taking precedence if both exist.
    pub async fn build_image(
        &self,
        name: &str,
        context_path: &str,
        dockerfile: Option<&str>,
    ) -> Result<ImageInfo> {
        self.build_image_with_logs(name, context_path, dockerfile, |_| {})
            .await
    }

    /// builds an image and streams log output to a callback
    pub async fn build_image_with_logs<F>(
        &self,
        name: &str,
        context_path: &str,
        dockerfile: Option<&str>,
        mut log_line: F,
    ) -> Result<ImageInfo>
    where
        F: FnMut(&str),
    {
        info!(name = %name, context = %context_path, "building image");

        if self.stub_mode {
            log_line("[stub] build skipped (docker not available)");
            return Ok(ImageInfo {
                name: name.to_string(),
                digest: "sha256:stub-build".to_string(),
                size: 0,
            });
        }

        // determine which containerfile to use
        let containerfile = match dockerfile {
            Some(f) => f.to_string(),
            None => {
                // auto-detect: prefer Containerfile over Dockerfile
                let containerfile_path = Path::new(context_path).join("Containerfile");
                let dockerfile_path = Path::new(context_path).join("Dockerfile");

                if containerfile_path.exists() {
                    info!(name = %name, "auto-detected Containerfile");
                    "Containerfile".to_string()
                } else if dockerfile_path.exists() {
                    info!(name = %name, "auto-detected Dockerfile");
                    "Dockerfile".to_string()
                } else {
                    // default to Dockerfile for backward compatibility
                    warn!(name = %name, "no Containerfile or Dockerfile found, defaulting to Dockerfile");
                    "Dockerfile".to_string()
                }
            }
        };

        info!(name = %name, context = %context_path, containerfile = %containerfile, "building image with containerfile");

        // create tar archive of the context directory
        let tar_data = create_tar_archive(context_path)
            .map_err(|e| ClientError::Operation(format!("failed to create tar archive: {}", e)))?;

        let options = BuildImageOptions {
            dockerfile: containerfile,
            t: Some(name.to_string()),
            rm: true,
            ..Default::default()
        };

        let mut stream =
            self.client()
                .build_image(options, None, Some(body_full(bytes::Bytes::from(tar_data))));

        while let Some(result) = stream.next().await {
            match result {
                Ok(info) => {
                    // log build output
                    if let Some(stream_output) = info.stream {
                        let trimmed = stream_output.trim();
                        if !trimmed.is_empty() {
                            info!(name = %name, output = %trimmed, "build");
                            log_line(trimmed);
                        }
                    }
                    if let Some(error_detail) = info.error_detail {
                        if let Some(msg) = error_detail.message {
                            log_line(&format!("build error: {}", msg));
                            return Err(ClientError::Operation(format!("build failed: {}", msg)));
                        }
                    }
                }
                Err(e) => {
                    log_line(&format!("build error: {}", e));
                    return Err(ClientError::Operation(format!("build failed: {}", e)));
                }
            }
        }

        info!(name = %name, "image built successfully");

        Ok(ImageInfo {
            name: name.to_string(),
            digest: "local".to_string(),
            size: 0,
        })
    }

    /// checks if an image exists locally
    pub async fn image_exists(&self, name: &str) -> Result<bool> {
        if self.stub_mode {
            return Ok(true);
        }

        match self.client().inspect_image(name).await {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }

    /// lists all images
    pub async fn list_images(&self) -> Result<Vec<ImageInfo>> {
        if self.stub_mode {
            return Ok(vec![]);
        }

        let options = ListImagesOptions {
            all: false,
            ..Default::default()
        };

        let images = self
            .client()
            .list_images(Some(options))
            .await
            .map_err(|e| ClientError::Operation(format!("docker images failed: {}", e)))?;

        let infos: Vec<ImageInfo> = images
            .into_iter()
            .map(|img| {
                let name = img
                    .repo_tags
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "<none>".to_string());
                let digest = img.id.clone();
                let size = img.size as u64;

                ImageInfo { name, digest, size }
            })
            .collect();

        Ok(infos)
    }

    /// removes an image
    pub async fn remove_image(&self, name: &str) -> Result<()> {
        info!(name = %name, "removing image");

        if self.stub_mode {
            return Ok(());
        }

        let options = RemoveImageOptions {
            force: true,
            ..Default::default()
        };

        match self.client().remove_image(name, Some(options), None).await {
            Ok(_) => Ok(()),
            Err(e) => {
                let err_str = e.to_string();
                Err(ClientError::Operation(format!(
                    "remove failed: {}",
                    err_str
                )))
            }
        }
    }
}

/// creates a tar archive of the given directory
fn create_tar_archive(path: &str) -> std::io::Result<Vec<u8>> {
    let mut archive = tar::Builder::new(Vec::new());
    archive.append_dir_all(".", path)?;
    archive.into_inner()
}

impl Default for ImageManager {
    fn default() -> Self {
        Self::new()
    }
}
