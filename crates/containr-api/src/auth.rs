//! authentication module - jwt + password hashing

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use containr_common::{Error, Result};

/// jwt claims structure
#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,
    pub email: String,
    pub exp: i64,
    pub iat: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExecTokenClaims {
    pub sub: Uuid,
    pub container_id: String,
    pub kind: String,
    pub exp: i64,
    pub iat: i64,
}

/// hashes a password using argon2
pub fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| Error::Internal(format!("failed to hash password: {}", e)))?;
    Ok(hash.to_string())
}

/// verifies a password against a hash
pub fn verify_password(password: &str, hash: &str) -> Result<bool> {
    let parsed_hash = PasswordHash::new(hash)
        .map_err(|e| Error::Internal(format!("invalid password hash: {}", e)))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}

/// creates a jwt token for a user
pub fn create_token(user_id: Uuid, email: &str, secret: &str, expiry_hours: u64) -> Result<String> {
    let now = Utc::now();
    let exp = now + Duration::hours(expiry_hours as i64);

    let claims = Claims {
        sub: user_id,
        email: email.to_string(),
        exp: exp.timestamp(),
        iat: now.timestamp(),
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| Error::Internal(format!("failed to create token: {}", e)))?;

    Ok(token)
}

pub fn create_exec_token(
    user_id: Uuid,
    container_id: &str,
    secret: &str,
    expiry_seconds: i64,
) -> Result<(String, i64)> {
    let now = Utc::now();
    let exp = now + Duration::seconds(expiry_seconds);

    let claims = ExecTokenClaims {
        sub: user_id,
        container_id: container_id.to_string(),
        kind: "container_exec".to_string(),
        exp: exp.timestamp(),
        iat: now.timestamp(),
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| Error::Internal(format!("failed to create exec token: {}", e)))?;

    Ok((token, exp.timestamp()))
}

/// validates a jwt token and returns the claims
pub fn validate_token(token: &str, secret: &str) -> Result<Claims> {
    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|e| Error::Unauthorized(format!("invalid token: {}", e)))?;

    Ok(token_data.claims)
}

pub fn validate_exec_token(
    token: &str,
    container_id: &str,
    secret: &str,
) -> Result<ExecTokenClaims> {
    let token_data = decode::<ExecTokenClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|e| Error::Unauthorized(format!("invalid exec token: {}", e)))?;

    let claims = token_data.claims;
    if claims.kind != "container_exec" {
        return Err(Error::Unauthorized("invalid exec token kind".to_string()));
    }
    if claims.container_id != container_id {
        return Err(Error::Unauthorized(
            "exec token does not match container".to_string(),
        ));
    }

    Ok(claims)
}

/// extracts the bearer token from an authorization header
pub fn extract_bearer_token(auth_header: &str) -> Option<&str> {
    auth_header.strip_prefix("Bearer ")
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::{create_exec_token, validate_exec_token};

    #[test]
    fn exec_token_round_trips_for_matching_container() {
        let user_id = Uuid::new_v4();
        let secret = "test-secret";

        let (token, _) = match create_exec_token(user_id, "containr-demo", secret, 60) {
            Ok(result) => result,
            Err(error) => panic!("expected exec token to be created: {}", error),
        };

        let claims = match validate_exec_token(&token, "containr-demo", secret) {
            Ok(claims) => claims,
            Err(error) => panic!("expected exec token to validate: {}", error),
        };

        assert_eq!(claims.sub, user_id);
        assert_eq!(claims.container_id, "containr-demo".to_string());
        assert_eq!(claims.kind, "container_exec".to_string());
    }

    #[test]
    fn exec_token_rejects_different_container_id() {
        let user_id = Uuid::new_v4();
        let secret = "test-secret";

        let (token, _) = match create_exec_token(user_id, "containr-demo", secret, 60) {
            Ok(result) => result,
            Err(error) => panic!("expected exec token to be created: {}", error),
        };

        match validate_exec_token(&token, "containr-other", secret) {
            Ok(_) => panic!("expected mismatched container id to be rejected"),
            Err(error) => assert_eq!(
                error.to_string(),
                "unauthorized: exec token does not match container".to_string()
            ),
        }
    }
}
