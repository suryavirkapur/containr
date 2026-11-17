//! runs the cloudflared connector that carries tunnel traffic to the proxy
//!
//! cloudflared is taken from PATH when present; otherwise a static binary
//! is downloaded into `{data_dir}/bin`. the process is supervised by the
//! cloudflare manager.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tracing::{info, warn};

const CLOUDFLARED_BIN_DIR: &str = "bin";

/// locates a usable cloudflared binary, downloading one when missing
pub async fn ensure_binary(data_dir: &Path) -> Result<PathBuf, String> {
    if binary_works("cloudflared").await {
        return Ok(PathBuf::from("cloudflared"));
    }

    let managed = data_dir.join(CLOUDFLARED_BIN_DIR).join(cloudflared_name());
    if managed.is_file() && binary_works(&managed).await {
        return Ok(managed);
    }

    download(data_dir).await
}

fn cloudflared_name() -> &'static str {
    if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    }
}

async fn binary_works(path: impl AsRef<std::ffi::OsStr>) -> bool {
    Command::new(path)
        .arg("version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false)
}

fn release_asset() -> Result<&'static str, String> {
    match std::env::consts::ARCH {
        "x86_64" => Ok("cloudflared-linux-amd64"),
        "aarch64" => Ok("cloudflared-linux-arm64"),
        arch => Err(format!(
            "no prebuilt cloudflared binary for {}; install it manually",
            arch
        )),
    }
}

/// fetches the latest cloudflared release binary into `{data_dir}/bin`
async fn download(data_dir: &Path) -> Result<PathBuf, String> {
    let asset = release_asset()?;
    let url = format!(
        "https://github.com/cloudflare/cloudflared/releases/latest/download/{}",
        asset
    );
    info!(url = %url, "downloading cloudflared");

    let response = reqwest::get(&url).await.map_err(|error| {
        format!("failed to download cloudflared: {}", error)
    })?;
    if !response.status().is_success() {
        return Err(format!(
            "cloudflared download returned status {}",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("failed to read cloudflared: {}", error))?;

    let dir = data_dir.join(CLOUDFLARED_BIN_DIR);
    tokio::fs::create_dir_all(&dir).await.map_err(|error| {
        format!("failed to create {}: {}", dir.display(), error)
    })?;
    let path = dir.join(cloudflared_name());
    tokio::fs::write(&path, &bytes).await.map_err(|error| {
        format!("failed to write {}: {}", path.display(), error)
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = tokio::fs::metadata(&path)
            .await
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_mode(0o755);
        tokio::fs::set_permissions(&path, permissions)
            .await
            .map_err(|error| error.to_string())?;
    }

    if !binary_works(&path).await {
        return Err(format!(
            "downloaded cloudflared at {} does not run",
            path.display()
        ));
    }
    Ok(path)
}

/// spawns `cloudflared tunnel run` with its output forwarded to the log
pub fn spawn(binary: &Path, token: &str) -> Result<Child, String> {
    let mut child = Command::new(binary)
        .args(["--no-autoupdate", "tunnel", "run", "--token", token])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("failed to start cloudflared: {}", error))?;

    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(forward_output(stdout, false));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(forward_output(stderr, true));
    }
    Ok(child)
}

async fn forward_output<R>(reader: R, is_err: bool)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if is_err {
            // cloudflared logs everything on stderr; keep it visible but not
            // alarming unless it looks like an error
            if line.contains("ERR") || line.contains("error") {
                warn!(target: "cloudflared", "{}", line);
            } else {
                info!(target: "cloudflared", "{}", line);
            }
        } else {
            info!(target: "cloudflared", "{}", line);
        }
    }
}
