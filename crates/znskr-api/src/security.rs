//! helpers for encrypting sensitive data at rest

use znskr_common::{decrypt, derive_key, encrypt, Config};

const ENCRYPTED_PREFIX: &str = "enc:";

pub fn resolve_encryption_secret(config: &Config) -> Option<String> {
    std::env::var("ZNSKR_ENCRYPTION_KEY")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            let value = config.security.encryption_key.trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        })
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
        let _lock = ENV_LOCK.lock().unwrap();
        std::env::remove_var("ZNSKR_ENCRYPTION_KEY");
        let mut config = Config::default();
        config.security.encryption_key = "test-secret".to_string();

        let encrypted = encrypt_value(&config, "payload").unwrap();
        assert!(encrypted.starts_with(ENCRYPTED_PREFIX));

        let decrypted = decrypt_value(&config, &encrypted, None).unwrap();
        assert_eq!(decrypted, "payload");
    }

    #[test]
    fn env_override_is_used() {
        let _lock = ENV_LOCK.lock().unwrap();
        std::env::set_var("ZNSKR_ENCRYPTION_KEY", "env-secret");

        let config = Config::default();
        let encrypted = encrypt_value(&config, "payload").unwrap();
        let decrypted = decrypt_value(&config, &encrypted, None).unwrap();
        assert_eq!(decrypted, "payload");

        std::env::remove_var("ZNSKR_ENCRYPTION_KEY");
    }

    #[test]
    fn legacy_secret_fallback_decrypts() {
        let _lock = ENV_LOCK.lock().unwrap();
        std::env::remove_var("ZNSKR_ENCRYPTION_KEY");

        let legacy = "legacy-secret";
        let key = derive_key(legacy);
        let encrypted = encrypt("payload", &key).unwrap();
        let stored = format!("{}{}", ENCRYPTED_PREFIX, encrypted);

        let mut config = Config::default();
        config.security.encryption_key = "wrong-secret".to_string();
        let decrypted = decrypt_value(&config, &stored, Some(legacy)).unwrap();
        assert_eq!(decrypted, "payload");
    }
}
