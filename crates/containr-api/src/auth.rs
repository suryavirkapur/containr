//! authentication module - jwt + password hashing

use argon2::{
    password_hash::{
        PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
    },
    Argon2,
};
use chrono::{Duration, Utc};
use jsonwebtoken::{
    decode, encode, DecodingKey, EncodingKey, Header, Validation,
};
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
    let hash =
        argon2
            .hash_password(password.as_bytes(), &salt)
            .map_err(|e| {
                Error::Internal(format!("failed to hash password: {}", e))
            })?;
    Ok(hash.to_string())
}

/// verifies a password against a hash
pub fn verify_password(password: &str, hash: &str) -> Result<bool> {
    let parsed_hash = PasswordHash::new(hash).map_err(|e| {
        Error::Internal(format!("invalid password hash: {}", e))
    })?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}

/// creates a jwt token for a user
pub fn create_token(
    user_id: Uuid,
    email: &str,
    secret: &str,
    expiry_hours: u64,
) -> Result<String> {
    let now = Utc::now();
    let exp = now + Duration::hours(expiry_hours as i64);

    create_claims_token(
        user_id,
        email,
        secret,
        now.timestamp(),
        exp.timestamp(),
    )
}

/// creates a long-lived api key for a user
pub fn create_api_key(
    user_id: Uuid,
    email: &str,
    secret: &str,
    expiry_days: u64,
) -> Result<String> {
    let now = Utc::now();
    let exp = now + Duration::days(expiry_days as i64);

    create_claims_token(
        user_id,
        email,
        secret,
        now.timestamp(),
        exp.timestamp(),
    )
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
    .map_err(|e| {
        Error::Internal(format!("failed to create exec token: {}", e))
    })?;

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

fn create_claims_token(
    user_id: Uuid,
    email: &str,
    secret: &str,
    issued_at: i64,
    expires_at: i64,
) -> Result<String> {
    let claims = Claims {
        sub: user_id,
        email: email.to_string(),
        exp: expires_at,
        iat: issued_at,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| Error::Internal(format!("failed to create token: {}", e)))
}

#[cfg(test)]
#[path = "auth_test.rs"]
mod auth_test;
