//! in-memory rate limiting for the login endpoint
//!
//! `POST /api/auth/login` verifies passwords, so unlimited attempts are
//! an online brute-force vector. failed logins are counted per client
//! ip and per account; too many failures inside the window block the
//! key for a backoff that doubles with each further failure. entries
//! live in a bounded map — memory cannot grow unboundedly under a spray
//! attack.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;

/// failures tolerated inside `WINDOW` before a key gets blocked
const MAX_FAILURES: u32 = 5;
/// how far back failures are counted
const WINDOW: Duration = Duration::from_secs(10 * 60);
/// backoff for the first failure past the limit; doubles from there
const BASE_BACKOFF: Duration = Duration::from_secs(15);
/// upper bound for the backoff
const MAX_BACKOFF: Duration = Duration::from_secs(60 * 60);
/// hard cap on tracked keys; the map prunes before it ever gets here
const MAX_ENTRIES: usize = 4096;

struct Attempts {
    failures: u32,
    window_started: Instant,
    blocked_until: Option<Instant>,
}

/// tracks failed logins per client ip and per account
#[derive(Clone, Default)]
pub struct LoginRateLimiter {
    attempts: Arc<DashMap<String, Attempts>>,
}

impl LoginRateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// seconds until the key may try again, if either the client ip or
    /// the account is currently blocked
    pub fn retry_after(&self, ip: &str, email: &str) -> Option<u64> {
        [format!("ip:{}", ip), format!("user:{}", normalize(email))]
            .iter()
            .filter_map(|key| self.blocked_for(key))
            .max()
    }

    /// counts a failed login for both the client ip and the account
    pub fn record_failure(&self, ip: &str, email: &str) {
        self.prune();
        self.fail(&format!("ip:{}", ip));
        self.fail(&format!("user:{}", normalize(email)));
    }

    /// clears the account's failure count after a successful login.
    /// the ip keeps its own count: one success does not wash away a
    /// spray against other accounts from the same address
    pub fn record_success(&self, email: &str) {
        self.attempts.remove(&format!("user:{}", normalize(email)));
    }

    fn blocked_for(&self, key: &str) -> Option<u64> {
        let entry = self.attempts.get(key)?;
        let until = entry.blocked_until?;
        let remaining = until.checked_duration_since(Instant::now())?;
        Some(remaining.as_secs().max(1))
    }

    fn fail(&self, key: &str) {
        if self.attempts.len() >= MAX_ENTRIES
            && !self.attempts.contains_key(key)
        {
            // under a spray of unique keys the map is at capacity; the
            // per-account limit still protects individual accounts
            return;
        }
        let now = Instant::now();
        let mut entry =
            self.attempts.entry(key.to_string()).or_insert(Attempts {
                failures: 0,
                window_started: now,
                blocked_until: None,
            });
        if now.duration_since(entry.window_started) > WINDOW {
            entry.failures = 0;
            entry.window_started = now;
        }
        entry.failures += 1;
        if entry.failures > MAX_FAILURES {
            let extra = (entry.failures - MAX_FAILURES).min(20);
            let backoff = BASE_BACKOFF
                .saturating_mul(1u32 << extra.saturating_sub(1))
                .min(MAX_BACKOFF);
            entry.blocked_until = Some(now + backoff);
        }
    }

    /// drops entries whose window expired and which are not blocked.
    /// keeps the map small under ordinary traffic
    fn prune(&self) {
        if self.attempts.len() < MAX_ENTRIES / 2 {
            return;
        }
        let now = Instant::now();
        self.attempts.retain(|_, entry| {
            let blocked = entry
                .blocked_until
                .map(|until| until > now)
                .unwrap_or(false);
            blocked || now.duration_since(entry.window_started) <= WINDOW
        });
    }
}

fn normalize(email: &str) -> String {
    email.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_below_the_limit_are_not_blocked() {
        let limiter = LoginRateLimiter::new();
        for _ in 0..MAX_FAILURES {
            limiter.record_failure("10.0.0.1", "a@b.c");
        }
        assert!(limiter.retry_after("10.0.0.1", "a@b.c").is_none());
    }

    #[test]
    fn crossing_the_limit_blocks_both_keys() {
        let limiter = LoginRateLimiter::new();
        for _ in 0..=MAX_FAILURES {
            limiter.record_failure("10.0.0.2", "a@b.c");
        }
        // the ip stays blocked even when asking about another account
        assert!(limiter.retry_after("10.0.0.2", "other@b.c").is_some());
        // the account stays blocked even from another ip
        assert!(limiter.retry_after("10.9.9.9", "a@b.c").is_some());
        // unrelated key is unaffected
        assert!(limiter.retry_after("10.9.9.9", "other@b.c").is_none());
    }

    #[test]
    fn success_clears_the_account_not_the_ip() {
        let limiter = LoginRateLimiter::new();
        for _ in 0..=MAX_FAILURES {
            limiter.record_failure("10.0.0.3", "a@b.c");
        }
        limiter.record_success("a@b.c");
        assert!(limiter.retry_after("10.9.9.9", "a@b.c").is_none());
        assert!(limiter.retry_after("10.0.0.3", "a@b.c").is_some());
    }

    #[test]
    fn email_normalization_folds_case_and_space() {
        let limiter = LoginRateLimiter::new();
        for _ in 0..=MAX_FAILURES {
            limiter.record_failure("10.0.0.4", " A@B.C ");
        }
        assert!(limiter.retry_after("10.0.0.4", "a@b.c").is_some());
    }

    #[test]
    fn backoff_grows_with_each_failure() {
        let limiter = LoginRateLimiter::new();
        let mut observed = Vec::new();
        for _ in 0..3 {
            for _ in 0..=MAX_FAILURES {
                limiter.record_failure("10.0.0.5", "a@b.c");
            }
            observed.push(
                limiter.retry_after("10.0.0.5", "a@b.c").expect("blocked"),
            );
        }
        assert!(observed[1] > observed[0]);
        assert!(observed[2] > observed[1]);
    }
}
