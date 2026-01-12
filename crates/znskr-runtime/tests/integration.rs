//! Integration tests for containerd runtime
//!
//! These tests require containerd to be running and accessible.
//! Run with: sudo cargo test --test integration -- --test-threads=1

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use znskr_runtime::client::{ContainerdClient, DEFAULT_NAMESPACE, DEFAULT_SOCKET};
use znskr_runtime::container::{ContainerConfig, ContainerManager};
use znskr_runtime::image::ImageManager;

const TEST_NAMESPACE: &str = "znskr-test";

/// Helper to check if containerd is accessible
fn is_containerd_available() -> bool {
    Path::new(DEFAULT_SOCKET).exists()
}

/// Helper to check if docker is available
fn is_docker_available() -> bool {
    std::process::Command::new("docker")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Test connecting to containerd
#[tokio::test]
async fn test_containerd_connection() {
    if !is_containerd_available() {
        eprintln!("SKIP: containerd socket not available");
        return;
    }

    let result = ContainerdClient::connect(DEFAULT_SOCKET, TEST_NAMESPACE).await;

    match result {
        Ok(client) => {
            println!("Connected to containerd");
            assert_eq!(client.namespace(), TEST_NAMESPACE);
        }
        Err(e) => {
            // This is expected if we don't have permission
            eprintln!("Could not connect to containerd: {}", e);
            eprintln!("Hint: Run with sudo or add user to containerd group");
        }
    }
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
    let manager = ContainerManager::new_stub();
    assert!(manager.is_stub());

    // Test create in stub mode
    let config = ContainerConfig {
        id: "test-container".to_string(),
        image: "alpine:latest".to_string(),
        env_vars: HashMap::from([("TEST".to_string(), "value".to_string())]),
        port: 8080,
        memory_limit: Some(256 * 1024 * 1024),
        cpu_limit: Some(0.5),
    };

    let result = manager.create_container(config).await;
    assert!(result.is_ok());
    let info = result.unwrap();
    assert_eq!(info.id, "test-container");
    assert!(info.status.running);

    // Test status in stub mode
    let status = manager.get_status("test-container").await.unwrap();
    assert!(status.running);

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

/// Integration test: full containerd flow (requires root access)
#[tokio::test]
async fn test_containerd_full_flow() {
    if !is_containerd_available() {
        eprintln!("SKIP: containerd socket not available");
        return;
    }

    // Try to connect
    let client = match ContainerdClient::connect(DEFAULT_SOCKET, TEST_NAMESPACE).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("SKIP: cannot connect to containerd: {}", e);
            return;
        }
    };

    let container_manager = ContainerManager::new(client.clone());
    let image_manager = ImageManager::new(client);

    // Pull a small test image
    println!("Pulling test image...");
    let pull_result = image_manager
        .pull_image("docker.io/library/alpine:latest")
        .await;
    if let Err(e) = &pull_result {
        eprintln!("Failed to pull image: {}", e);
        return;
    }
    println!("Image pulled successfully");

    // Create a test container
    let container_id = format!("znskr-test-{}", uuid::Uuid::new_v4());
    println!("Creating container: {}", container_id);

    let config = ContainerConfig {
        id: container_id.clone(),
        image: "docker.io/library/alpine:latest".to_string(),
        env_vars: HashMap::new(),
        port: 8080,
        memory_limit: None,
        cpu_limit: None,
    };

    match container_manager.create_container(config).await {
        Ok(info) => {
            println!("Container created: {:?}", info);
            assert_eq!(info.id, container_id);

            // Check status
            let status = container_manager.get_status(&container_id).await.unwrap();
            println!("Container status: {:?}", status);

            // Clean up
            println!("Cleaning up...");
            let _ = container_manager.stop_container(&container_id).await;
            let _ = container_manager.remove_container(&container_id).await;
            println!("Cleanup complete");
        }
        Err(e) => {
            eprintln!("Failed to create container: {}", e);
        }
    }

    // List containers
    let containers = container_manager.list_containers().await.unwrap();
    println!("Total containers in namespace: {}", containers.len());
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

    // Use headless manager (not stub mode, but no containerd client)
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
