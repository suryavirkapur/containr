//! self-update from github releases
//!
//! releases publish one binary per platform (`containr-linux-amd64`,
//! `containr-linux-arm64`) next to a `.sha256` file. installing downloads
//! the binary beside the running one, verifies it, swaps it in with a rename
//! and re-execs the process with the same arguments. docker containers keep
//! running across the restart.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::{extract::State, http::HeaderMap, http::StatusCode, Json};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tracing::{error, info, warn};
use utoipa::ToSchema;

use crate::handlers::auth::{require_admin_user, ErrorResponse};
use crate::state::AppState;
use containr_runtime::worker;

type ApiError = (StatusCode, Json<ErrorResponse>);

const GITHUB_API: &str = "https://api.github.com";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
/// how long an install waits for a running deployment to finish
const DEPLOYMENT_WAIT: Duration = Duration::from_secs(120);
/// time for the install response to reach the browser before re-exec
const RESTART_DELAY: Duration = Duration::from_secs(1);

static INSTALLING: AtomicBool = AtomicBool::new(false);

/// result of checking github for a newer release
#[derive(Serialize, ToSchema)]
pub struct UpdateCheckResponse {
    pub current_version: String,
    /// newest release version, without the leading `v`
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub release_name: Option<String>,
    pub release_url: Option<String>,
    /// release notes (markdown)
    pub release_notes: Option<String>,
    pub published_at: Option<String>,
    /// whether this server can install the update itself
    pub can_install: bool,
    /// why installing isn't possible, when `can_install` is false
    pub install_blocker: Option<String>,
}

/// install request
#[derive(Deserialize, ToSchema)]
pub struct InstallUpdateRequest {
    /// release version to install, as returned by the check
    pub version: String,
}

/// install response
#[derive(Serialize, ToSchema)]
pub struct InstallUpdateResponse {
    pub version: String,
    /// containr restarts right after responding
    pub restarting: bool,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    body: Option<String>,
    published_at: Option<String>,
    draft: bool,
    prerelease: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

/// check github for a newer containr release (admin)
#[utoipa::path(
    get,
    path = "/api/system/update",
    tag = "system",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "update status", body = UpdateCheckResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "admin access required", body = ErrorResponse),
        (status = 502, description = "github error", body = ErrorResponse)
    )
)]
pub async fn check_update(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<UpdateCheckResponse>, ApiError> {
    let _admin = require_admin_user(&state, &headers).await?;
    let repo = state.config.read().await.updates.repo.clone();
    let current = current_version()?;

    let releases = fetch_releases(&repo).await?;
    let latest = newest_release(&releases, &current);
    let install_blocker = install_blocker();

    let response = match latest {
        Some((version, release)) => {
            let update_available = version > current;
            let missing_asset = update_available
                && platform_asset_name().is_some_and(|name| {
                    !release.assets.iter().any(|asset| asset.name == name)
                });
            let install_blocker = install_blocker.or_else(|| {
                missing_asset.then(|| {
                    "this release has no binary for this platform".to_string()
                })
            });
            UpdateCheckResponse {
                current_version: current.to_string(),
                latest_version: Some(version.to_string()),
                update_available,
                release_name: release.name.clone(),
                release_url: Some(release.html_url.clone()),
                release_notes: release.body.clone(),
                published_at: release.published_at.clone(),
                can_install: install_blocker.is_none(),
                install_blocker,
            }
        }
        None => UpdateCheckResponse {
            current_version: current.to_string(),
            latest_version: None,
            update_available: false,
            release_name: None,
            release_url: None,
            release_notes: None,
            published_at: None,
            can_install: install_blocker.is_none(),
            install_blocker,
        },
    };

    Ok(Json(response))
}

/// download and install a containr release, then restart (admin)
#[utoipa::path(
    post,
    path = "/api/system/update",
    tag = "system",
    security(("bearer" = [])),
    request_body = InstallUpdateRequest,
    responses(
        (status = 202, description = "update installed, restarting", body = InstallUpdateResponse),
        (status = 400, description = "invalid version", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "admin access required", body = ErrorResponse),
        (status = 409, description = "install not possible right now", body = ErrorResponse),
        (status = 502, description = "github or download error", body = ErrorResponse)
    )
)]
pub async fn install_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<InstallUpdateRequest>,
) -> Result<(StatusCode, Json<InstallUpdateResponse>), ApiError> {
    let admin = require_admin_user(&state, &headers).await?;
    if let Some(blocker) = install_blocker() {
        return Err(error(StatusCode::CONFLICT, blocker));
    }
    let target = parse_version(&request.version).ok_or_else(|| {
        error(StatusCode::BAD_REQUEST, "invalid version".to_string())
    })?;
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err(error(
            StatusCode::CONFLICT,
            "an update is already being installed".to_string(),
        ));
    }

    // queued deployments wait (and are replayed after the restart) so the
    // re-exec can't cut one off halfway
    worker::pause_deployments();
    let exe = match install(&state, &target).await {
        Ok(exe) => exe,
        Err(install_error) => {
            worker::resume_deployments();
            INSTALLING.store(false, Ordering::SeqCst);
            return Err(install_error);
        }
    };

    info!(
        version = %target,
        user = %admin.email,
        "installed containr update, restarting"
    );
    tokio::spawn(async move {
        tokio::time::sleep(RESTART_DELAY).await;
        restart(&exe);
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(InstallUpdateResponse {
            version: target.to_string(),
            restarting: true,
        }),
    ))
}

/// downloads, verifies and swaps in the release binary. returns the path
/// of the (now replaced) executable to re-exec.
async fn install(
    state: &AppState,
    target: &Version,
) -> Result<PathBuf, ApiError> {
    let current = current_version()?;
    if *target <= current {
        return Err(error(
            StatusCode::BAD_REQUEST,
            format!("containr is already at {}", current),
        ));
    }
    let asset_name = platform_asset_name().ok_or_else(|| {
        error(
            StatusCode::CONFLICT,
            "self-update isn't supported on this platform".to_string(),
        )
    })?;

    let repo = state.config.read().await.updates.repo.clone();
    let releases = fetch_releases(&repo).await?;
    let release = releases
        .iter()
        .find(|release| {
            !release.draft
                && parse_version(&release.tag_name).as_ref() == Some(target)
        })
        .ok_or_else(|| {
            error(
                StatusCode::BAD_REQUEST,
                format!("release {} not found", target),
            )
        })?;
    let asset_url = |name: &str| {
        release
            .assets
            .iter()
            .find(|asset| asset.name == name)
            .map(|asset| asset.browser_download_url.clone())
            .ok_or_else(|| {
                error(
                    StatusCode::BAD_GATEWAY,
                    format!("release {} has no {} asset", target, name),
                )
            })
    };
    let binary_url = asset_url(asset_name)?;
    let checksum_url = asset_url(&format!("{}.sha256", asset_name))?;

    let exe = std::env::current_exe().map_err(internal)?;
    let exe_dir = exe.parent().ok_or_else(|| {
        internal(format!("{} has no parent directory", exe.display()))
    })?;
    let staged = exe_dir.join(format!(".containr-update-{}", target));

    let client = http_client(DOWNLOAD_TIMEOUT)?;
    let expected = fetch_checksum(&client, &checksum_url).await?;
    let staged_result = async {
        let actual = download(&client, &binary_url, &staged).await?;
        if actual != expected {
            return Err(error(
                StatusCode::BAD_GATEWAY,
                "downloaded binary doesn't match its sha256 checksum"
                    .to_string(),
            ));
        }
        set_executable(&staged).await?;
        verify_binary_version(&staged, target).await
    }
    .await;
    if let Err(staged_error) = staged_result {
        let _ = tokio::fs::remove_file(&staged).await;
        return Err(staged_error);
    }

    // a deployment that started before the pause gets to finish
    if let Err(busy) = wait_for_running_deployment().await {
        let _ = tokio::fs::remove_file(&staged).await;
        return Err(busy);
    }

    // keep the previous binary for a manual rollback
    let backup = exe.with_file_name(format!(
        "{}.previous",
        exe.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "containr".to_string())
    ));
    if let Err(copy_error) = tokio::fs::copy(&exe, &backup).await {
        let _ = tokio::fs::remove_file(&staged).await;
        return Err(internal(format!(
            "failed to back up {}: {}",
            exe.display(),
            copy_error
        )));
    }
    // a rename on the same filesystem atomically replaces the running binary
    if let Err(rename_error) = tokio::fs::rename(&staged, &exe).await {
        let _ = tokio::fs::remove_file(&staged).await;
        return Err(internal(format!(
            "failed to replace {}: {}",
            exe.display(),
            rename_error
        )));
    }

    Ok(exe)
}

/// replaces this process with the new binary, keeping pid and arguments so
/// systemd and other supervisors don't notice
fn restart(exe: &Path) {
    use std::os::unix::process::CommandExt;

    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let exec_error = std::process::Command::new(exe).args(&args).exec();
    // exec only returns on failure. exiting lets a supervisor (systemd)
    // start the new binary instead.
    error!(error = %exec_error, "failed to restart containr after update");
    std::process::exit(1);
}

/// reason this install can't update itself, if any
fn install_blocker() -> Option<String> {
    if platform_asset_name().is_none() {
        return Some(format!(
            "self-update isn't supported on {}/{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    }
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(exe_error) => {
            return Some(format!(
                "can't locate the containr binary: {}",
                exe_error
            ))
        }
    };
    if is_cargo_build(&exe) {
        return Some(
            "containr runs from a source build. update it with git pull \
             and rebuild"
                .to_string(),
        );
    }
    if !dir_is_writable(exe.parent()) {
        return Some(format!(
            "containr can't write to {}",
            exe.parent().unwrap_or(&exe).display()
        ));
    }
    None
}

fn dir_is_writable(dir: Option<&Path>) -> bool {
    let Some(dir) = dir else {
        return false;
    };
    let probe =
        dir.join(format!(".containr-write-test-{}", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// binaries under a cargo `target/{profile}` dir come from a source checkout,
/// which its own build step (e.g. the repo's systemd unit) would overwrite
fn is_cargo_build(exe: &Path) -> bool {
    let mut parts = exe.components().rev().skip(1);
    let profile = parts.next();
    let target = parts.next();
    matches!(
        (profile, target),
        (Some(profile), Some(target))
            if target.as_os_str() == "target"
                && matches!(
                    profile.as_os_str().to_str(),
                    Some("release" | "debug")
                )
    )
}

/// release asset for this platform, e.g. `containr-linux-amd64`
fn platform_asset_name() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("containr-linux-amd64"),
        ("linux", "aarch64") => Some("containr-linux-arm64"),
        _ => None,
    }
}

fn current_version() -> Result<Version, ApiError> {
    Version::parse(env!("CARGO_PKG_VERSION")).map_err(internal)
}

/// parses `v1.2.3` or `1.2.3`
fn parse_version(tag: &str) -> Option<Version> {
    Version::parse(tag.trim().trim_start_matches('v')).ok()
}

/// newest published release. prereleases only count when containr itself
/// runs a prerelease, so stable installs stay on stable releases.
fn newest_release<'a>(
    releases: &'a [GithubRelease],
    current: &Version,
) -> Option<(Version, &'a GithubRelease)> {
    let allow_prerelease = !current.pre.is_empty();
    releases
        .iter()
        .filter(|release| !release.draft)
        .filter(|release| allow_prerelease || !release.prerelease)
        .filter_map(|release| {
            let version = parse_version(&release.tag_name)?;
            (allow_prerelease || version.pre.is_empty())
                .then_some((version, release))
        })
        .max_by(|(left, _), (right, _)| left.cmp(right))
}

async fn wait_for_running_deployment() -> Result<(), ApiError> {
    let deadline = tokio::time::Instant::now() + DEPLOYMENT_WAIT;
    while worker::deployment_running() {
        if tokio::time::Instant::now() >= deadline {
            return Err(error(
                StatusCode::CONFLICT,
                "a deployment is still running. try again once it finishes"
                    .to_string(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Ok(())
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, ApiError> {
    reqwest::Client::builder()
        .user_agent(concat!("containr/", env!("CARGO_PKG_VERSION")))
        .timeout(timeout)
        .build()
        .map_err(internal)
}

async fn fetch_releases(repo: &str) -> Result<Vec<GithubRelease>, ApiError> {
    let repo = repo.trim();
    let valid_repo = repo.split_once('/').is_some_and(|(owner, name)| {
        let valid = |part: &str| {
            !part.is_empty()
                && part.chars().all(|c| {
                    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')
                })
        };
        valid(owner) && valid(name)
    });
    if !valid_repo {
        return Err(error(
            StatusCode::BAD_REQUEST,
            format!("updates.repo must be owner/repo, got {:?}", repo),
        ));
    }

    let url = format!("{}/repos/{}/releases?per_page=30", GITHUB_API, repo);
    let response = http_client(REQUEST_TIMEOUT)?
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|send_error| bad_gateway("reach github", send_error))?;
    let status = response.status();
    if !status.is_success() {
        warn!(%status, %repo, "github release lookup failed");
        let message = if status == StatusCode::FORBIDDEN
            || status == StatusCode::TOO_MANY_REQUESTS
        {
            "github rate limit reached. try again later".to_string()
        } else {
            format!("github returned {} for {}", status, repo)
        };
        return Err(error(StatusCode::BAD_GATEWAY, message));
    }
    response
        .json::<Vec<GithubRelease>>()
        .await
        .map_err(|parse_error| bad_gateway("read github releases", parse_error))
}

/// reads `<hex>` or `<hex>  <file>` from a `.sha256` asset
async fn fetch_checksum(
    client: &reqwest::Client,
    url: &str,
) -> Result<String, ApiError> {
    let text = client
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|fetch_error| bad_gateway("download checksum", fetch_error))?
        .text()
        .await
        .map_err(|fetch_error| bad_gateway("download checksum", fetch_error))?;
    parse_checksum(&text).ok_or_else(|| {
        error(
            StatusCode::BAD_GATEWAY,
            "release checksum file is malformed".to_string(),
        )
    })
}

fn parse_checksum(text: &str) -> Option<String> {
    let hash = text.split_whitespace().next()?.to_ascii_lowercase();
    (hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()))
        .then_some(hash)
}

/// streams `url` into `path` and returns the sha256 of what was written
async fn download(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
) -> Result<String, ApiError> {
    let mut response = client
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|fetch_error| bad_gateway("download update", fetch_error))?;
    let mut file = tokio::fs::File::create(path).await.map_err(internal)?;
    let mut hasher = Sha256::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|fetch_error| bad_gateway("download update", fetch_error))?
    {
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(internal)?;
    }
    file.sync_all().await.map_err(internal)?;
    Ok(hex::encode(hasher.finalize()))
}

async fn set_executable(path: &Path) -> Result<(), ApiError> {
    use std::os::unix::fs::PermissionsExt;

    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .await
        .map_err(internal)
}

/// runs `<binary> --version` so a broken or wrong download never replaces
/// the running binary
async fn verify_binary_version(
    path: &Path,
    target: &Version,
) -> Result<(), ApiError> {
    let output = tokio::time::timeout(
        REQUEST_TIMEOUT,
        tokio::process::Command::new(path).arg("--version").output(),
    )
    .await
    .map_err(|_| {
        error(
            StatusCode::BAD_GATEWAY,
            "the downloaded binary didn't respond to --version".to_string(),
        )
    })?
    .map_err(|run_error| {
        error(
            StatusCode::BAD_GATEWAY,
            format!("the downloaded binary doesn't run here: {}", run_error),
        )
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let reported = stdout.split_whitespace().last().and_then(parse_version);
    if !output.status.success() || reported.as_ref() != Some(target) {
        return Err(error(
            StatusCode::BAD_GATEWAY,
            format!(
                "the downloaded binary reports {:?}, expected {}",
                stdout.trim(),
                target
            ),
        ));
    }
    Ok(())
}

fn error(status: StatusCode, message: String) -> ApiError {
    (status, Json(ErrorResponse { error: message }))
}

fn bad_gateway(action: &str, source: impl std::fmt::Display) -> ApiError {
    warn!(error = %source, "failed to {}", action);
    error(
        StatusCode::BAD_GATEWAY,
        format!("failed to {}: {}", action, source),
    )
}

fn internal(source: impl std::fmt::Display) -> ApiError {
    error(StatusCode::INTERNAL_SERVER_ERROR, source.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, prerelease: bool, draft: bool) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_string(),
            name: None,
            html_url: String::new(),
            body: None,
            published_at: None,
            draft,
            prerelease,
            assets: Vec::new(),
        }
    }

    fn version(value: &str) -> Version {
        Version::parse(value).expect("version")
    }

    #[test]
    fn stable_installs_ignore_prereleases_and_drafts() {
        let releases = vec![
            release("v0.2.0", false, false),
            release("v0.3.0-alpha", true, false),
            release("v0.4.0", false, true),
            release("nightly", false, false),
        ];
        let (latest, _) =
            newest_release(&releases, &version("0.1.0")).expect("latest");
        assert_eq!(latest, version("0.2.0"));
    }

    #[test]
    fn prerelease_installs_see_prereleases() {
        let releases = vec![
            release("v0.1.15-alpha", true, false),
            release("v0.1.16-alpha", true, false),
            release("v0.1.16", false, false),
        ];
        let (latest, _) = newest_release(&releases, &version("0.1.15-alpha"))
            .expect("latest");
        assert_eq!(latest, version("0.1.16"));
        assert!(version("0.1.16-alpha") > version("0.1.15-alpha"));
    }

    #[test]
    fn checksum_files_parse_with_or_without_file_name() {
        let hash = "a".repeat(64);
        assert_eq!(parse_checksum(&hash), Some(hash.clone()));
        assert_eq!(
            parse_checksum(&format!("{}  containr-linux-amd64\n", hash)),
            Some(hash)
        );
        assert_eq!(parse_checksum("not-a-hash"), None);
    }

    #[test]
    fn cargo_builds_are_detected() {
        assert!(is_cargo_build(Path::new(
            "/root/containr/target/release/containr"
        )));
        assert!(is_cargo_build(Path::new("/src/target/debug/containr")));
        assert!(!is_cargo_build(Path::new("/usr/local/bin/containr")));
        assert!(!is_cargo_build(Path::new("/opt/release/containr")));
    }
}
