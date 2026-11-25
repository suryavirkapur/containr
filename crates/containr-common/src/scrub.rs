//! redacts secrets carried in url query strings before they reach logs
//!
//! jwt tokens for websocket exec, deploy webhook tokens and the gate
//! password all travel as query parameters, and they end up in the
//! request trace span and the proxy's per-request log. those values are
//! credentials, so the query is rewritten with their values removed.

/// query keys whose values are credentials and never belong in logs
const SENSITIVE_KEYS: &[&str] =
    &["token", "pass", "password", "signature", "sig", "code"];

const REDACTED: &str = "REDACTED";

/// rewrites `uri` (typically a path plus query) so the values of
/// sensitive query keys are replaced with `REDACTED`. everything else —
/// the path, other parameters, their order and encoding — is preserved
pub fn scrub_sensitive_query(uri: &str) -> String {
    let Some(question_mark) = uri.find('?') else {
        return uri.to_string();
    };
    let (base, rest) = uri.split_at(question_mark + 1);

    let mut out = String::with_capacity(uri.len());
    out.push_str(base);
    for (index, pair) in rest.split('&').enumerate() {
        if index > 0 {
            out.push('&');
        }
        let (key, has_value) = match pair.split_once('=') {
            Some((key, _)) => (key, true),
            None => (pair, false),
        };
        if SENSITIVE_KEYS
            .iter()
            .any(|sensitive| key.eq_ignore_ascii_case(sensitive))
        {
            out.push_str(key);
            if has_value {
                out.push('=');
                out.push_str(REDACTED);
            }
        } else {
            out.push_str(pair);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::scrub_sensitive_query;

    #[test]
    fn sensitive_values_are_redacted() {
        assert_eq!(
            scrub_sensitive_query("/api/x?token=abc123&tail=100&pass=hunter2"),
            "/api/x?token=REDACTED&tail=100&pass=REDACTED"
        );
        assert_eq!(
            scrub_sensitive_query("/cb?code=oauth-secret&state=kept"),
            "/cb?code=REDACTED&state=kept"
        );
    }

    #[test]
    fn key_match_is_exact_and_case_insensitive() {
        assert_eq!(
            scrub_sensitive_query("/x?TOKEN=a&SIG=b&signature=c"),
            "/x?TOKEN=REDACTED&SIG=REDACTED&signature=REDACTED"
        );
        // suffix lookalikes are not secret keys on their own
        assert_eq!(
            scrub_sensitive_query("/x?token_count=3&codecs=av1"),
            "/x?token_count=3&codecs=av1"
        );
    }

    #[test]
    fn non_secret_queries_pass_through() {
        for uri in [
            "/api/services",
            "/api/services?page=2&filter=web",
            "/x?tokenless&flag",
        ] {
            assert_eq!(scrub_sensitive_query(uri), uri);
        }
    }

    #[test]
    fn bare_sensitive_key_keeps_no_value() {
        assert_eq!(scrub_sensitive_query("/x?token&next=1"), "/x?token&next=1");
    }
}
