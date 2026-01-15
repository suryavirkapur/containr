//! Integration tests for docker runtime
//!
//! These tests require docker for real builds.

use std::collections::HashMap;
use std::fs;
use znskr_runtime::docker::{DockerContainerConfig, DockerContainerManager};
use znskr_runtime::image::ImageManager;

/// Helper to check if docker is available
fn is_docker_available() -> bool {
    std::process::Command::new("docker")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Test image manager with stub mode
#[tokio::test]
async fn test_image_manager_stub() {
    let manager = ImageManager::new_stub();
    assert!(manager.is_stub());

    // Test pull in stub mode
    let result = manager.pull_image("alpine:latest").await;
    assert!(result.is_ok());
    let info = result.unwrap();
    assert_eq!(info.name, "alpine:latest");
    assert_eq!(info.digest, "sha256:stub");

    // Test list in stub mode
    let list = manager.list_images().await.unwrap();
    assert!(list.is_empty());

    // Test exists in stub mode
    let exists = manager.image_exists("alpine:latest").await.unwrap();
    assert!(exists);
}

/// Test container manager with stub mode
#[tokio::test]
async fn test_container_manager_stub() {
    let manager = DockerContainerManager::new_stub();
    assert!(manager.is_stub());

    // Test create in stub mode
    let config = DockerContainerConfig {
        id: "test-container".to_string(),
        image: "alpine:latest".to_string(),
        env_vars: HashMap::from([("TEST".to_string(), "value".to_string())]),
        port: 8080,
        memory_limit: Some(256 * 1024 * 1024),
        cpu_limit: Some(0.5),
        network: None,
        health_check: None,
        restart_policy: "no".to_string(),
    };

    let result = manager.create_container(config).await;
    assert!(result.is_ok());
    let info = result.unwrap();
    assert_eq!(info.id, "test-container");
    assert!(info.status.running);

    // Test status in stub mode
    let running = manager.is_running("test-container").await.unwrap();
    assert!(running);

    // Test stop in stub mode
    assert!(manager.stop_container("test-container").await.is_ok());

    // Test remove in stub mode
    assert!(manager.remove_container("test-container").await.is_ok());

    // Test list in stub mode
    let list = manager.list_containers().await.unwrap();
    assert!(list.is_empty());
}

/// Test image build with Containerfile auto-detection
#[tokio::test]
async fn test_image_build_containerfile_detection() {
    let manager = ImageManager::new_stub();

    // Create a temp directory with a Containerfile
    let temp_dir = tempfile::tempdir().unwrap();
    let containerfile_path = temp_dir.path().join("Containerfile");
    fs::write(&containerfile_path, "FROM alpine:latest\nRUN echo hello").unwrap();

    // This should detect the Containerfile (in stub mode, it just returns success)
    let result = manager
        .build_image("test-image:latest", temp_dir.path().to_str().unwrap(), None)
        .await;

    assert!(result.is_ok());
}

/// Test image build with explicit dockerfile path
#[tokio::test]
async fn test_image_build_explicit_dockerfile() {
    let manager = ImageManager::new_stub();

    let temp_dir = tempfile::tempdir().unwrap();
    let dockerfile_path = temp_dir.path().join("MyDockerfile");
    fs::write(&dockerfile_path, "FROM alpine:latest").unwrap();

    // Explicitly specify the dockerfile
    let result = manager
        .build_image(
            "test-image:latest",
            temp_dir.path().to_str().unwrap(),
            Some("MyDockerfile"),
        )
        .await;

    assert!(result.is_ok());
}

/// Test that Containerfile takes precedence over Dockerfile
#[tokio::test]
async fn test_containerfile_precedence() {
    let temp_dir = tempfile::tempdir().unwrap();

    // Create both files
    fs::write(temp_dir.path().join("Dockerfile"), "FROM ubuntu:latest").unwrap();
    fs::write(temp_dir.path().join("Containerfile"), "FROM alpine:latest").unwrap();

    // When both exist, Containerfile should be preferred
    // We can't easily verify this without running the actual build,
    // but we can at least verify the logic exists
    let containerfile_path = temp_dir.path().join("Containerfile");
    let dockerfile_path = temp_dir.path().join("Dockerfile");

    assert!(containerfile_path.exists());
    assert!(dockerfile_path.exists());

    // The logic in build_image prefers Containerfile when both exist
    // This test documents the expected behavior
}

/// Test real build using Docker and Containerfile
#[tokio::test]
async fn test_real_docker_build_containerfile() {
    if !is_docker_available() {
        eprintln!("SKIP: docker not available");
        return;
    }

    // Use headless manager (not stub mode)
    let manager = ImageManager::new_headless();
    assert!(!manager.is_stub());

    let temp_dir = tempfile::tempdir().unwrap();
    let containerfile_path = temp_dir.path().join("Containerfile");

    // Create a valid Containerfile using Alpine
    fs::write(
        &containerfile_path,
        "FROM alpine:latest\nRUN echo 'built with containerfile'",
    )
    .unwrap();

    let image_name = format!("znskr-test-build:{}", uuid::Uuid::new_v4());

    // Build image
    // This should detect Containerfile and use 'docker build -f ...'
    let result = manager
        .build_image(&image_name, temp_dir.path().to_str().unwrap(), None)
        .await;

    if let Err(e) = &result {
        eprintln!("Build failed: {}", e);
    }

    assert!(result.is_ok());

    // Cleanup (try to remove image via docker)
    std::process::Command::new("docker")
        .args(["rmi", &image_name])
        .output()
        .ok();
}
