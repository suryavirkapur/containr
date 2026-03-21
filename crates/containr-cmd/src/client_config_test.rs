use std::path::PathBuf;

use tempfile::TempDir;

use crate::client_config::ClientConfig;

fn temp_path(tempdir: &TempDir) -> PathBuf {
    tempdir.path().join("config.toml")
}

#[test]
fn save_and_load_round_trip_preserves_instance_details() {
    let tempdir = match TempDir::new() {
        Ok(tempdir) => tempdir,
        Err(error) => panic!("failed to create tempdir: {}", error),
    };
    let path = temp_path(&tempdir);

    let mut config = ClientConfig::default();
    let instance = config.ensure_instance("staging");
    instance.instance_id = "staging-01".to_string();
    instance.url = "https://staging.example.com".to_string();
    instance.token = Some("token-123".to_string());
    config.active_instance = "staging".to_string();

    if let Err(error) = config.save(&path) {
        panic!("failed to save config: {}", error);
    }

    let loaded = match ClientConfig::load(&path) {
        Ok(config) => config,
        Err(error) => panic!("failed to load config: {}", error),
    };

    assert_eq!(loaded.active_instance, "staging".to_string());

    let staging = match loaded.instance("staging") {
        Ok(instance) => instance,
        Err(error) => panic!("failed to resolve staging instance: {}", error),
    };

    assert_eq!(staging.instance_id, "staging-01".to_string());
    assert_eq!(staging.url, "https://staging.example.com".to_string());
    assert_eq!(staging.token, Some("token-123".to_string()));
}

#[test]
fn masked_redacts_token_and_api_key_values() {
    let mut config = ClientConfig::default();
    let instance = config.ensure_instance("default");
    instance.token = Some("secret-token".to_string());
    instance.api_key = Some("secret-api-key".to_string());

    let masked = config.masked();
    let instance = match masked.instance("default") {
        Ok(instance) => instance,
        Err(error) => panic!("failed to resolve default instance: {}", error),
    };

    assert_eq!(instance.token, Some("<redacted>".to_string()));
    assert_eq!(instance.api_key, Some("<redacted>".to_string()));
}
