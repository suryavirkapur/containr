//! validation for remote git source urls
//!
//! a service's repository url reaches `git clone`, so it must be an
//! https url to a public host: anything else (file, ssh, scp-style,
//! local paths, credentials, internal addresses) is rejected before it
//! ever reaches the worker.

/// a repository url that passed validation, with its lowercased host
#[derive(Debug, Clone)]
pub struct GitSourceUrl {
    /// the trimmed url as the user supplied it
    pub url: String,
    /// lowercased host from the url
    pub host: String,
}

impl GitSourceUrl {
    /// whether the repository is hosted on github.com. github oauth and
    /// installation tokens may only be attached to clones from this host
    pub fn is_github_host(&self) -> bool {
        is_github_host(&self.host)
    }
}

/// whether `host` is github.com (already-normalized, lowercase)
pub fn is_github_host(host: &str) -> bool {
    host.trim_end_matches('.')
        .eq_ignore_ascii_case("github.com")
}

/// validates a user-supplied git repository url for cloning.
/// only `https://` urls with a public host are accepted.
pub fn validate_git_source_url(input: &str) -> Result<GitSourceUrl, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("repository url cannot be empty".to_string());
    }

    let parsed = url::Url::parse(trimmed)
        .map_err(|_| "repository url is not a valid url".to_string())?;

    if parsed.scheme() != "https" {
        return Err(
            "repository url must use https (ssh, file and local urls are \
             not allowed)"
                .to_string(),
        );
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("repository url must not contain credentials".to_string());
    }

    let host = parsed
        .host()
        .ok_or_else(|| "repository url has no host".to_string())?;
    let host_str = parsed
        .host_str()
        .map(str::to_string)
        .ok_or_else(|| "repository url has no host".to_string())?;

    match host {
        url::Host::Ipv4(ip) => {
            if ipv4_blocked(ip) {
                return Err(
                    "repository url points at a non-public address".to_string()
                );
            }
        }
        url::Host::Ipv6(ip) => {
            if ipv6_blocked(ip) {
                return Err(
                    "repository url points at a non-public address".to_string()
                );
            }
        }
        url::Host::Domain(domain) => {
            let domain = domain.trim_end_matches('.');
            let lower = domain.to_ascii_lowercase();
            if lower == "localhost" || lower.ends_with(".localhost") {
                return Err(
                    "repository url must not point at localhost".to_string()
                );
            }
            // a single-label name is almost always an internal host;
            // public forges use a fqdn
            if !lower.contains('.') {
                return Err(
                    "repository url must use a fully qualified host name"
                        .to_string(),
                );
            }
        }
    }

    Ok(GitSourceUrl {
        url: trimmed.to_string(),
        host: host_str,
    })
}

/// blocks every ipv4 range that cannot be a public forge host
fn ipv4_blocked(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || o[0] == 0
        // carrier grade nat 100.64.0.0/10
        || (o[0] == 100 && (64..=127).contains(&o[1]))
        // benchmarking 198.18.0.0/15
        || (o[0] == 198 && (18..=19).contains(&o[1]))
        // ietf protocol assignments 192.0.0.0/24
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        // reserved 240.0.0.0/4
        || o[0] >= 240
}

/// blocks every ipv6 range that cannot be a public forge host
fn ipv6_blocked(ip: std::net::Ipv6Addr) -> bool {
    // ipv4-mapped (::ffff:a.b.c.d) and compatible (::a.b.c.d) addresses
    // obey the ipv4 rules
    if let Some(v4) = ip.to_ipv4() {
        return ipv4_blocked(v4);
    }
    let segments = ip.segments();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        // unique local fc00::/7
        || (segments[0] & 0xfe00) == 0xfc00
        // link local fe80::/10
        || (segments[0] & 0xffc0) == 0xfe80
        // documentation 2001:db8::/32
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
}

/// whether `input` is a bare hostname without a scheme, which parses as
/// a valid https repo url when prefixed with `https://`
#[cfg(test)]
fn parse_with_https(input: &str) -> Result<GitSourceUrl, String> {
    validate_git_source_url(&format!("https://{}", input))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_ok(url: &str) {
        assert!(
            validate_git_source_url(url).is_ok(),
            "expected {} to be accepted",
            url
        );
    }

    fn assert_rejected(url: &str) {
        assert!(
            validate_git_source_url(url).is_err(),
            "expected {} to be rejected",
            url
        );
    }

    #[test]
    fn accepts_public_https_hosts() {
        for url in [
            "https://github.com/owner/repo",
            "https://github.com/owner/repo.git",
            "https://gitlab.com/group/sub/repo",
            "https://git.example.com:8443/repo.git",
            "https://GITHUB.COM/Owner/Repo",
            "https://8.8.8.8/repo.git",
        ] {
            assert_ok(url);
        }
        let parsed =
            validate_git_source_url("https://github.com/o/r").expect("ok");
        assert_eq!(parsed.host, "github.com");
        assert!(parsed.is_github_host());
        assert!(!validate_git_source_url("https://gitlab.com/o/r")
            .expect("ok")
            .is_github_host());
    }

    #[test]
    fn rejects_non_https_schemes() {
        for url in [
            "http://github.com/owner/repo",
            "ssh://git@github.com/owner/repo",
            "git@github.com:owner/repo.git",
            "git://github.com/owner/repo",
            "file:///srv/repo",
            "ftp://github.com/repo",
        ] {
            assert_rejected(url);
        }
    }

    #[test]
    fn rejects_local_and_relative_inputs() {
        for url in [
            "/srv/repo",
            "./repo",
            "repo",
            "relative/path",
            "~/repo",
            "C:\\repo",
        ] {
            assert_rejected(url);
        }
    }

    #[test]
    fn rejects_credentials_in_url() {
        for url in [
            "https://user@github.com/repo",
            "https://user:pass@github.com/repo",
            "https://oauth2:token@gitlab.com/repo",
        ] {
            assert_rejected(url);
        }
    }

    #[test]
    fn rejects_internal_ip_literals() {
        for host in [
            "127.0.0.1",
            "10.0.0.4",
            "172.16.5.5",
            "172.31.5.5",
            "192.168.1.10",
            "169.254.169.254",
            "100.64.1.1",
            "0.0.0.0",
            "224.0.0.1",
            "192.0.2.10",
            "198.51.100.10",
            "203.0.113.10",
            "198.18.0.1",
            "[::1]",
            "[::ffff:127.0.0.1]",
            "[fe80::1]",
            "[fc00::1]",
            "[fd00::1]",
            "[2001:db8::1]",
        ] {
            assert!(ip_blocked_host(host), "expected {} rejected", host);
        }
    }

    fn ip_blocked_host(host: &str) -> bool {
        validate_git_source_url(&format!("https://{}/repo", host)).is_err()
    }

    #[test]
    fn rejects_localhost_and_single_label_hosts() {
        for host in [
            "localhost",
            "localhost.",
            "api.localhost",
            "git",
            "gitea",
            "internal",
        ] {
            assert!(
                parse_with_https(host).is_err(),
                "expected {} rejected",
                host
            );
        }
    }
}
