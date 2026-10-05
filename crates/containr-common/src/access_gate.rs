//! signed tokens for the containr login gate
//!
//! a gated domain lives on a different origin than the dashboard, so the
//! dashboard session can't be read there. the dashboard hands a logged-in
//! user a short-lived pass for one domain; the proxy trades it for a
//! session cookie scoped to that domain.

use chrono::{Duration, Utc};
use jsonwebtoken::{
    decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// cookie holding the gate session on a gated domain
pub const GATE_COOKIE: &str = "containr_gate";
/// path on a gated domain where the proxy accepts a pass
pub const GATE_CALLBACK_PATH: &str = "/__containr/gate";
/// how long a pass stays valid between the dashboard and the domain
pub const PASS_TTL_SECONDS: i64 = 60;
/// how long a gate session lasts before the user is sent back
pub const SESSION_TTL_SECONDS: i64 = 12 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateTokenKind {
    /// one hop from the dashboard to the gated domain
    Pass,
    /// stored in the gated domain's cookie
    Session,
}

impl GateTokenKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "gate_pass",
            Self::Session => "gate_session",
        }
    }

    fn ttl(self) -> Duration {
        match self {
            Self::Pass => Duration::seconds(PASS_TTL_SECONDS),
            Self::Session => Duration::seconds(SESSION_TTL_SECONDS),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct GateClaims {
    sub: Uuid,
    /// the gated domain this token is valid for
    host: String,
    kind: String,
    iat: i64,
    exp: i64,
}

/// signs a token for `user_id` on `host`
pub fn issue_gate_token(
    secret: &str,
    user_id: Uuid,
    host: &str,
    kind: GateTokenKind,
) -> Option<String> {
    let now = Utc::now();
    let claims = GateClaims {
        sub: user_id,
        host: host.to_ascii_lowercase(),
        kind: kind.as_str().to_string(),
        iat: now.timestamp(),
        exp: (now + kind.ttl()).timestamp(),
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .ok()
}

/// returns the user id when `token` is a valid, unexpired token of `kind`
/// for `host`
pub fn verify_gate_token(
    secret: &str,
    token: &str,
    host: &str,
    kind: GateTokenKind,
) -> Option<Uuid> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 5;
    let claims = decode::<GateClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .ok()?
    .claims;
    if claims.kind != kind.as_str() || !claims.host.eq_ignore_ascii_case(host) {
        return None;
    }
    Some(claims.sub)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_bound_to_host_kind_and_secret() {
        let user = Uuid::new_v4();
        let pass = issue_gate_token(
            "s3cret",
            user,
            "Adminer.Example.com",
            GateTokenKind::Pass,
        )
        .expect("pass");

        assert_eq!(
            verify_gate_token(
                "s3cret",
                &pass,
                "adminer.example.com",
                GateTokenKind::Pass
            ),
            Some(user)
        );
        assert_eq!(
            verify_gate_token(
                "s3cret",
                &pass,
                "other.example.com",
                GateTokenKind::Pass
            ),
            None
        );
        assert_eq!(
            verify_gate_token(
                "s3cret",
                &pass,
                "adminer.example.com",
                GateTokenKind::Session
            ),
            None
        );
        assert_eq!(
            verify_gate_token(
                "wrong",
                &pass,
                "adminer.example.com",
                GateTokenKind::Pass
            ),
            None
        );
        assert_eq!(
            verify_gate_token(
                "s3cret",
                "garbage",
                "adminer.example.com",
                GateTokenKind::Pass
            ),
            None
        );
    }
}
