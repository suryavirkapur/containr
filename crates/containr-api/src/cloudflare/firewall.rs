//! containr-owned nftables rules
//!
//! when every public domain is served through the cloudflare tunnel the
//! proxy's http/https ports no longer need to accept inbound traffic, so a
//! dedicated `inet containr` table drops them. loopback is always allowed
//! because cloudflared connects to the proxy locally. the table only ever
//! contains containr's rules, so docker and firewalld are untouched.

use std::process::Stdio;
use std::sync::OnceLock;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

static AVAILABLE: OnceLock<bool> = OnceLock::new();

/// whether the nft binary exists on this host
pub async fn is_available() -> bool {
    if let Some(available) = AVAILABLE.get() {
        return *available;
    }
    let available = Command::new("nft")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false);
    *AVAILABLE.get_or_init(|| available)
}

/// whether the containr table currently exists
pub async fn is_active() -> bool {
    if !is_available().await {
        return false;
    }
    Command::new("nft")
        .args(["list", "table", "inet", "containr"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false)
}

/// drops inbound tcp on `ports` for every interface except loopback
pub async fn apply(ports: &[u16]) -> Result<(), String> {
    if !is_available().await {
        return Err(
            "nft is not installed; cannot manage the host firewall".to_string()
        );
    }

    // recreate the table so the ruleset below is authoritative
    let _ = Command::new("nft")
        .args(["delete", "table", "inet", "containr"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;

    let ports = ports
        .iter()
        .map(|port| port.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let ruleset = format!(
        "table inet containr {{\n  chain input {{\n    type filter hook input \
         priority filter; policy accept;\n    iifname \"lo\" accept\n    ct \
         state {{ established, related }} accept\n    tcp dport {{ {} }} \
         counter drop\n  }}\n}}\n",
        ports
    );

    let mut child = Command::new("nft")
        .arg("-f")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to run nft: {}", error))?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "nft stdin unavailable".to_string())?
        .write_all(ruleset.as_bytes())
        .await
        .map_err(|error| format!("failed to write nft ruleset: {}", error))?;
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("failed to wait for nft: {}", error))?;
    if !output.status.success() {
        return Err(format!(
            "nft rejected the ruleset: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

/// removes the containr table; absence is not an error
pub async fn remove() -> Result<(), String> {
    if !is_available().await {
        return Ok(());
    }
    let status = Command::new("nft")
        .args(["delete", "table", "inet", "containr"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|error| format!("failed to run nft: {}", error))?;
    if !status.success() && is_active().await {
        return Err("failed to remove the containr firewall table".to_string());
    }
    Ok(())
}
