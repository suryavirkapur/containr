//! aes-256-gcm encryption for sensitive credentials
//!
//! provides encrypt/decrypt functions for storing database passwords
//! and storage bucket secrets securely.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use rand::Rng;

/// encryption errors
#[derive(Debug, thiserror::Error)]
pub enum EncryptionError {
    #[error("encryption failed: {0}")]
    Encryption(String),
    #[error("decryption failed: {0}")]
    Decryption(String),
    #[error("invalid key length")]
    InvalidKeyLength,
    #[error("invalid data format")]
    InvalidFormat,
}

/// result type for encryption operations
pub type Result<T> = std::result::Result<T, EncryptionError>;

/// nonce size for aes-256-gcm (96 bits)
const NONCE_SIZE: usize = 12;

/// encrypts plaintext using aes-256-gcm
/// returns base64-encoded ciphertext with nonce prepended
pub fn encrypt(plaintext: &str, key: &[u8]) -> Result<String> {
    if key.len() != 32 {
        return Err(EncryptionError::InvalidKeyLength);
    }

    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| EncryptionError::Encryption(e.to_string()))?;

    // generate random nonce
    let mut nonce_bytes = [0u8; NONCE_SIZE];
    rand::rng().fill(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    // encrypt
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| EncryptionError::Encryption(e.to_string()))?;

    // prepend nonce to ciphertext and base64 encode
    let mut combined = nonce_bytes.to_vec();
    combined.extend(ciphertext);

    Ok(base64_encode(&combined))
}

/// decrypts base64-encoded ciphertext using aes-256-gcm
pub fn decrypt(encrypted: &str, key: &[u8]) -> Result<String> {
    if key.len() != 32 {
        return Err(EncryptionError::InvalidKeyLength);
    }

    let combined = base64_decode(encrypted)?;

    if combined.len() < NONCE_SIZE {
        return Err(EncryptionError::InvalidFormat);
    }

    let (nonce_bytes, ciphertext) = combined.split_at(NONCE_SIZE);
    let nonce = Nonce::from_slice(nonce_bytes);

    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| EncryptionError::Decryption(e.to_string()))?;

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| EncryptionError::Decryption(e.to_string()))?;

    String::from_utf8(plaintext).map_err(|e| EncryptionError::Decryption(e.to_string()))
}

/// derives a 256-bit key from a secret string using sha256
pub fn derive_key(secret: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    hasher.finalize().into()
}

/// simple base64 encoding
fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

/// simple base64 decoding
fn base64_decode(data: &str) -> Result<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_e| EncryptionError::InvalidFormat)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt() {
        let key = derive_key("test-secret-key");
        let plaintext = "my-database-password";

        let encrypted = encrypt(plaintext, &key).unwrap();
        let decrypted = decrypt(&encrypted, &key).unwrap();

        assert_eq!(plaintext, decrypted);
    }

    #[test]
    fn test_different_keys_fail() {
        let key1 = derive_key("key-one");
        let key2 = derive_key("key-two");
        let plaintext = "secret";

        let encrypted = encrypt(plaintext, &key1).unwrap();
        let result = decrypt(&encrypted, &key2);

        assert!(result.is_err());
    }
}
