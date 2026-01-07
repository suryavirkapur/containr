//! image management
//!
//! high-level api for container image operations using containerd.

use std::process::Command;
use tracing::{error, info, warn};

use crate::client::{ClientError, ContainerdClient, Result};

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
    client: Option<ContainerdClient>,
    stub_mode: bool,
}

impl ImageManager {
    /// creates a new image manager with a containerd client
    pub fn new(client: ContainerdClient) -> Self {
        Self {
            client: Some(client),
            stub_mode: false,
        }
    }

    /// creates a new image manager in stub mode (for development)
    pub fn new_stub() -> Self {
        warn!("image manager running in stub mode");
        Self {
            client: None,
            stub_mode: true,
        }
    }

    /// creates a new image manager with no client but NOT in stub mode
    /// useful for testing build/pull commands that use external binaries
    pub fn new_headless() -> Self {
        Self {
            client: None,
            stub_mode: false,
        }
    }

    /// returns true if running in stub mode
    pub fn is_stub(&self) -> bool {
        self.stub_mode
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

        // use ctr or nerdctl to pull image since containerd-client
        // doesn't expose the content service easily
        let output = if which::which("nerdctl").is_ok() {
            Command::new("nerdctl")
                .args(["--namespace", "znskr", "pull", name])
                .output()
        } else if which::which("ctr").is_ok() {
            Command::new("ctr")
                .args(["--namespace", "znskr", "images", "pull", name])
                .output()
        } else {
            return Err(ClientError::Operation(
                "neither nerdctl nor ctr found for image pull".to_string(),
            ));
        };

        match output {
            Ok(out) if out.status.success() => {
                info!(name = %name, "image pulled successfully");
                Ok(ImageInfo {
                    name: name.to_string(),
                    digest: "unknown".to_string(),
                    size: 0,
                })
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                Err(ClientError::Operation(format!("pull failed: {}", stderr)))
            }
            Err(e) => Err(ClientError::Operation(format!("pull command failed: {}", e))),
        }
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
        info!(name = %name, context = %context_path, "building image");

        if self.stub_mode {
            return Ok(ImageInfo {
                name: name.to_string(),
                digest: "sha256:stub-build".to_string(),
                size: 0,
            });
        }

        // Determine which containerfile to use
        let containerfile = match dockerfile {
            Some(f) => f.to_string(),
            None => {
                // Auto-detect: prefer Containerfile over Dockerfile
                let containerfile_path = std::path::Path::new(context_path).join("Containerfile");
                let dockerfile_path = std::path::Path::new(context_path).join("Dockerfile");
                
                if containerfile_path.exists() {
                    info!(name = %name, "auto-detected Containerfile");
                    containerfile_path.to_string_lossy().to_string()
                } else if dockerfile_path.exists() {
                    info!(name = %name, "auto-detected Dockerfile");
                    dockerfile_path.to_string_lossy().to_string()
                } else {
                    // Default to Dockerfile for backward compatibility - assume in context
                    warn!(name = %name, "no Containerfile or Dockerfile found, defaulting to Dockerfile");
                    std::path::Path::new(context_path).join("Dockerfile").to_string_lossy().to_string()
                }
            }
        };

        info!(name = %name, context = %context_path, containerfile = %containerfile, "building image with containerfile");

        // use buildah or docker for building since containerd doesn't build images
        // buildah natively supports Containerfile, docker uses -f flag
        let output = if which::which("buildah").is_ok() {
            Command::new("buildah")
                .args(["build", "-f", &containerfile, "-t", name, context_path])
                .output()
        } else if which::which("docker").is_ok() {
            Command::new("docker")
                .args(["build", "-f", &containerfile, "-t", name, context_path])
                .output()
        } else {
            return Err(ClientError::Operation(
                "neither buildah nor docker found for image build".to_string(),
            ));
        };

        match output {
            Ok(out) if out.status.success() => {
                info!(name = %name, "image built successfully");

                // push to containerd if using buildah
                if which::which("buildah").is_ok() {
                    let push_output = Command::new("buildah")
                        .args([
                            "push",
                            name,
                            &format!("containers-storage:[overlay@/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs]{}:latest", name),
                        ])
                        .output();

                    if let Err(e) = push_output {
                        warn!(error = %e, "failed to push image to containerd storage");
                    }
                }

                Ok(ImageInfo {
                    name: name.to_string(),
                    digest: "local".to_string(),
                    size: 0,
                })
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                Err(ClientError::Operation(format!("build failed: {}", stderr)))
            }
            Err(e) => Err(ClientError::Operation(format!("build command failed: {}", e))),
        }
    }

    /// checks if an image exists locally
    pub async fn image_exists(&self, name: &str) -> Result<bool> {
        if self.stub_mode {
            return Ok(true);
        }

        match &self.client {
            Some(client) => client.image_exists(name).await,
            None => Ok(false),
        }
    }

    /// lists all images
    pub async fn list_images(&self) -> Result<Vec<ImageInfo>> {
        if self.stub_mode {
            return Ok(vec![]);
        }

        let client = self.client.as_ref().ok_or_else(|| {
            ClientError::Operation("no containerd client".to_string())
        })?;

        let images = client.list_images().await?;

        Ok(images
            .into_iter()
            .map(|img| ImageInfo {
                name: img.name,
                digest: img
                    .target
                    .map(|t| t.digest)
                    .unwrap_or_else(|| "unknown".to_string()),
                size: 0,
            })
            .collect())
    }

    /// removes an image
    pub async fn remove_image(&self, name: &str) -> Result<()> {
        info!(name = %name, "removing image");

        if self.stub_mode {
            return Ok(());
        }

        // use ctr to remove image
        let output = Command::new("ctr")
            .args(["--namespace", "znskr", "images", "rm", name])
            .output();

        match output {
            Ok(out) if out.status.success() => Ok(()),
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                Err(ClientError::Operation(format!("remove failed: {}", stderr)))
            }
            Err(e) => Err(ClientError::Operation(format!("remove command failed: {}", e))),
        }
    }
}
