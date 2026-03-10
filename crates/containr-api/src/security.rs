//! helpers for encrypting sensitive data at rest

use containr_common::{decrypt, derive_key, encrypt, Config};

const ENCRYPTED_PREFIX: &str = "enc:";
const PRIMARY_ENV_NAME: &str = "CONTAINR_ENCRYPTION_KEY";
const LEGACY_ENV_NAME: &str = "ZNSKR_ENCRYPTION_KEY";

pub fn resolve_encryption_secret(config: &Config) -> Option<String> {
    std::env::var(PRIMARY_ENV_NAME)
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var(LEGACY_ENV_NAME)
                .ok()
                .filter(|value| !value.is_empty())
        })
        .or_else(|| {
            let value = config.security.encryption_key.trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        })
}

#[cfg(test)]
fn clear_env_override() {
    std::env::remove_var(PRIMARY_ENV_NAME);
    std::env::remove_var(LEGACY_ENV_NAME);
}

pub fn encrypt_value(config: &Config, value: &str) -> Result<String, String> {
    let secret = resolve_encryption_secret(config)
        .ok_or_else(|| "encryption key is not configured".to_string())?;
    let key = derive_key(&secret);
    let encrypted = encrypt(value, &key).map_err(|e| e.to_string())?;
    Ok(format!("{}{}", ENCRYPTED_PREFIX, encrypted))
}

pub fn decrypt_value(
    config: &Config,
    value: &str,
    legacy_secret: Option<&str>,
) -> Result<String, String> {
    let trimmed = value.trim();
    let has_prefix = trimmed.starts_with(ENCRYPTED_PREFIX);
    let payload = trimmed.strip_prefix(ENCRYPTED_PREFIX).unwrap_or(trimmed);

    if let Some(secret) = resolve_encryption_secret(config) {
        let key = derive_key(&secret);
        if let Ok(plaintext) = decrypt(payload, &key) {
            return Ok(plaintext);
        }
    } else if has_prefix {
        return Err("encryption key is not configured".to_string());
    }

    if let Some(legacy) = legacy_secret {
        let key = derive_key(legacy);
        if let Ok(plaintext) = decrypt(payload, &key) {
            return Ok(plaintext);
        }
    }

    Ok(payload.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        clear_env_override();
        let mut config = Config::default();
        config.security.encryption_key = "test-secret".to_string();

        let encrypted = encrypt_value(&config, "payload")
            .expect("encryption should succeed with configured key");
        assert!(encrypted.starts_with(ENCRYPTED_PREFIX));

        let decrypted = decrypt_value(&config, &encrypted, None)
            .expect("decryption should succeed with configured key");
        assert_eq!(decrypted, "payload");
    }

    #[test]
    fn env_override_is_used() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        clear_env_override();
        std::env::set_var(PRIMARY_ENV_NAME, "env-secret");

        let config = Config::default();
        let encrypted = encrypt_value(&config, "payload")
            .expect("encryption should succeed with env override");
        let decrypted = decrypt_value(&config, &encrypted, None)
            .expect("decryption should succeed with env override");
        assert_eq!(decrypted, "payload");

        clear_env_override();
    }

    #[test]
    fn legacy_env_override_is_used() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        clear_env_override();
        std::env::set_var(LEGACY_ENV_NAME, "legacy-env-secret");

        let config = Config::default();
        let encrypted = encrypt_value(&config, "payload")
            .expect("encryption should succeed with legacy env override");
        let decrypted = decrypt_value(&config, &encrypted, None)
            .expect("decryption should succeed with legacy env override");
        assert_eq!(decrypted, "payload");

        clear_env_override();
    }

    #[test]
    fn legacy_secret_fallback_decrypts() {
        let _lock = ENV_LOCK.lock().expect("env lock should not be poisoned");
        clear_env_override();

        let legacy = "legacy-secret";
        let key = derive_key(legacy);
        let encrypted =
            encrypt("payload", &key).expect("legacy encryption should succeed");
        let stored = format!("{}{}", ENCRYPTED_PREFIX, encrypted);

        let mut config = Config::default();
        config.security.encryption_key = "wrong-secret".to_string();
        let decrypted = decrypt_value(&config, &stored, Some(legacy))
            .expect("decryption should fall back to legacy secret");
        assert_eq!(decrypted, "payload");
    }
}
