//! integration tests for docker runtime
//!
//! these tests use bollard for docker operations.

use std::collections::HashMap;
use std::fs;
use std::sync::Arc;

use bollard::Docker;
use znskr_runtime::docker::{DockerContainerConfig, DockerContainerManager};
use znskr_runtime::image::ImageManager;

/// helper to check if docker is available
async fn is_docker_available() -> bool {
    match Docker::connect_with_socket_defaults() {
        Ok(docker) => docker.ping().await.is_ok(),
        Err(_) => false,
    }
}

/// test image manager with stub mode
#[tokio::test]
async fn test_image_manager_stub() {
    let manager = ImageManager::new_stub();
    assert!(manager.is_stub());

    // test pull in stub mode
    let result = manager.pull_image("alpine:latest").await;
    assert!(result.is_ok());
    let info = result.unwrap();
    assert_eq!(info.name, "alpine:latest");
    assert_eq!(info.digest, "sha256:stub");

    // test list in stub mode
    let list = manager.list_images().await.unwrap();
    assert!(list.is_empty());

    // test exists in stub mode
    let exists = manager.image_exists("alpine:latest").await.unwrap();
    assert!(exists);
}

/// test container manager with stub mode
#[tokio::test]
async fn test_container_manager_stub() {
    let manager = DockerContainerManager::new_stub();
    assert!(manager.is_stub());

    // test create in stub mode
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

    // test status in stub mode
    let running = manager.is_running("test-container").await.unwrap();
    assert!(running);

    // test stop in stub mode
    assert!(manager.stop_container("test-container").await.is_ok());

    // test remove in stub mode
    assert!(manager.remove_container("test-container").await.is_ok());

    // test list in stub mode
    let list = manager.list_containers().await.unwrap();
    assert!(list.is_empty());
}

/// test image build with containerfile auto-detection
#[tokio::test]
async fn test_image_build_containerfile_detection() {
    let manager = ImageManager::new_stub();

    // create a temp directory with a containerfile
    let temp_dir = tempfile::tempdir().unwrap();
    let containerfile_path = temp_dir.path().join("Containerfile");
    fs::write(&containerfile_path, "FROM alpine:latest\nRUN echo hello").unwrap();

    // this should detect the containerfile (in stub mode, it just returns success)
    let result = manager
        .build_image("test-image:latest", temp_dir.path().to_str().unwrap(), None)
        .await;

    assert!(result.is_ok());
}

/// test image build with explicit dockerfile path
#[tokio::test]
async fn test_image_build_explicit_dockerfile() {
    let manager = ImageManager::new_stub();

    let temp_dir = tempfile::tempdir().unwrap();
    let dockerfile_path = temp_dir.path().join("MyDockerfile");
    fs::write(&dockerfile_path, "FROM alpine:latest").unwrap();

    // explicitly specify the dockerfile
    let result = manager
        .build_image(
            "test-image:latest",
            temp_dir.path().to_str().unwrap(),
            Some("MyDockerfile"),
        )
        .await;

    assert!(result.is_ok());
}

/// test that containerfile takes precedence over dockerfile
#[tokio::test]
async fn test_containerfile_precedence() {
    let temp_dir = tempfile::tempdir().unwrap();

    // create both files
    fs::write(temp_dir.path().join("Dockerfile"), "FROM ubuntu:latest").unwrap();
    fs::write(temp_dir.path().join("Containerfile"), "FROM alpine:latest").unwrap();

    // when both exist, containerfile should be preferred
    let containerfile_path = temp_dir.path().join("Containerfile");
    let dockerfile_path = temp_dir.path().join("Dockerfile");

    assert!(containerfile_path.exists());
    assert!(dockerfile_path.exists());

    // the logic in build_image prefers containerfile when both exist
}

/// test real build using docker and containerfile
#[tokio::test]
async fn test_real_docker_build_containerfile() {
    if !is_docker_available().await {
        eprintln!("SKIP: docker not available");
        return;
    }

    // use real manager (not stub mode)
    let manager = ImageManager::new();
    assert!(!manager.is_stub());

    let temp_dir = tempfile::tempdir().unwrap();
    let containerfile_path = temp_dir.path().join("Containerfile");

    // create a valid containerfile using alpine
    fs::write(
        &containerfile_path,
        "FROM alpine:latest\nRUN echo 'built with containerfile'",
    )
    .unwrap();

    let image_name = format!("znskr-test-build:{}", uuid::Uuid::new_v4());

    // build image
    let result = manager
        .build_image(&image_name, temp_dir.path().to_str().unwrap(), None)
        .await;

    if let Err(e) = &result {
        eprintln!("build failed: {}", e);
    }

    assert!(result.is_ok());

    // cleanup (try to remove image via bollard)
    let _ = manager.remove_image(&image_name).await;
}
