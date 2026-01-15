//! image management
//!
//! high-level api for container image operations using docker.

use std::process::Command;
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
    stub_mode: bool,
}

impl ImageManager {
    /// creates a new image manager
    pub fn new() -> Self {
        Self { stub_mode: false }
    }

    /// creates a new image manager in stub mode (for development)
    pub fn new_stub() -> Self {
        warn!("image manager running in stub mode");
        Self {
            stub_mode: true,
        }
    }

    /// creates a new image manager with no client but NOT in stub mode
    /// useful for testing build/pull commands that use external binaries
    pub fn new_headless() -> Self {
        Self { stub_mode: false }
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

        let output = if which::which("docker").is_ok() {
            Command::new("docker").args(["pull", name]).output()
        } else {
            return Err(ClientError::Operation(
                "docker not found for image pull".to_string(),
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
            Err(e) => Err(ClientError::Operation(format!(
                "pull command failed: {}",
                e
            ))),
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
                    std::path::Path::new(context_path)
                        .join("Dockerfile")
                        .to_string_lossy()
                        .to_string()
                }
            }
        };

        info!(name = %name, context = %context_path, containerfile = %containerfile, "building image with containerfile");

        let output = if which::which("docker").is_ok() {
            Command::new("docker")
                .args(["build", "-f", &containerfile, "-t", name, context_path])
                .output()
        } else {
            return Err(ClientError::Operation(
                "docker not found for image build".to_string(),
            ));
        };

        match output {
            Ok(out) if out.status.success() => {
                info!(name = %name, "image built successfully");

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
            Err(e) => Err(ClientError::Operation(format!(
                "build command failed: {}",
                e
            ))),
        }
    }

    /// checks if an image exists locally
    pub async fn image_exists(&self, name: &str) -> Result<bool> {
        if self.stub_mode {
            return Ok(true);
        }

        let output = Command::new("docker")
            .args(["image", "inspect", name])
            .output()
            .map_err(|e| ClientError::Operation(format!("docker image inspect failed: {}", e)))?;

        Ok(output.status.success())
    }

    /// lists all images
    pub async fn list_images(&self) -> Result<Vec<ImageInfo>> {
        if self.stub_mode {
            return Ok(vec![]);
        }

        let output = Command::new("docker")
            .args(["images", "--format", "{{.Repository}}:{{.Tag}}|{{.ID}}|{{.Size}}"])
            .output()
            .map_err(|e| ClientError::Operation(format!("docker images failed: {}", e)))?;

        if !output.status.success() {
            return Err(ClientError::Operation("docker images failed".to_string()));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let images = stdout
            .lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.split('|').collect();
                if parts.len() < 2 {
                    return None;
                }
                Some(ImageInfo {
                    name: parts[0].to_string(),
                    digest: parts[1].to_string(),
                    size: 0,
                })
            })
            .collect();

        Ok(images)
    }

    /// removes an image
    pub async fn remove_image(&self, name: &str) -> Result<()> {
        info!(name = %name, "removing image");

        if self.stub_mode {
            return Ok(());
        }

        let output = Command::new("docker").args(["rmi", name]).output();

        match output {
            Ok(out) if out.status.success() => Ok(()),
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                Err(ClientError::Operation(format!("remove failed: {}", stderr)))
            }
            Err(e) => Err(ClientError::Operation(format!(
                "remove command failed: {}",
                e
            ))),
        }
    }
}
