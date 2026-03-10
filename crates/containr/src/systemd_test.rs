use std::path::PathBuf;

use tempfile::TempDir;

use crate::systemd::{
    render_service_unit, write_service_unit, ServiceUnitConfig,
};

fn fixture() -> ServiceUnitConfig {
    ServiceUnitConfig {
        service_name: "containr".to_string(),
        user: "root".to_string(),
        working_directory: PathBuf::from("/opt/containr"),
        binary_path: PathBuf::from("/usr/local/bin/containr"),
        config_path: PathBuf::from("/opt/containr/containr.toml"),
        log_level: "info".to_string(),
    }
}

#[test]
fn render_service_unit_contains_expected_exec_start() {
    let content = match render_service_unit(&fixture()) {
        Ok(content) => content,
        Err(error) => panic!("failed to render service unit: {}", error),
    };

    assert!(content.contains("ExecStart=/usr/local/bin/containr server"));
    assert!(content.contains("--config /opt/containr/containr.toml"));
}

#[test]
fn write_service_unit_writes_output_file() {
    let tempdir = match TempDir::new() {
        Ok(tempdir) => tempdir,
        Err(error) => panic!("failed to create tempdir: {}", error),
    };
    let output_path = tempdir.path().join("containr.service");

    if let Err(error) = write_service_unit(&fixture(), &output_path) {
        panic!("failed to write service unit: {}", error);
    }

    let content = match std::fs::read_to_string(&output_path) {
        Ok(content) => content,
        Err(error) => panic!("failed to read service unit: {}", error),
    };

    assert!(content.contains("WantedBy=multi-user.target"));
}

#[test]
fn render_service_unit_rejects_relative_paths() {
    let mut config = fixture();
    config.binary_path = PathBuf::from("containr");

    match render_service_unit(&config) {
        Ok(_) => panic!("expected relative binary path to be rejected"),
        Err(error) => {
            assert!(error.to_string().contains("binary path must be absolute"))
        }
    }
}
