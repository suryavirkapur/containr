use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::Context;
use containr_common::Config;
use tokio::sync::RwLock;
use tokio::time::MissedTickBehavior;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter};

pub struct LoggingRuntime {
    _guard: Option<tracing_appender::non_blocking::WorkerGuard>,
}

pub fn init_console_logging(log_level: &str) -> anyhow::Result<LoggingRuntime> {
    let filter = parse_filter(log_level)?;
    tracing_subscriber::registry()
        .with(filter)
        .with(
            fmt::layer()
                .with_target(false)
                .compact()
                .with_writer(std::io::stderr),
        )
        .try_init()
        .context("failed to initialize console logging")?;

    Ok(LoggingRuntime { _guard: None })
}

pub fn init_file_logging(
    log_level: &str,
    config: &Config,
) -> anyhow::Result<LoggingRuntime> {
    let log_dir = PathBuf::from(config.logging.dir.trim());
    std::fs::create_dir_all(&log_dir).with_context(|| {
        format!("failed to create log directory {}", log_dir.display())
    })?;

    let filter = parse_filter(log_level)?;
    let appender = tracing_appender::rolling::daily(&log_dir, "containr.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(appender);

    tracing_subscriber::registry()
        .with(filter)
        .with(
            fmt::layer()
                .with_target(false)
                .compact()
                .with_writer(std::io::stderr),
        )
        .with(
            fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .compact()
                .with_writer(non_blocking),
        )
        .try_init()
        .context("failed to initialize file logging")?;

    Ok(LoggingRuntime {
        _guard: Some(guard),
    })
}

pub async fn run_log_retention_task(config: std::sync::Arc<RwLock<Config>>) {
    if let Err(error) = cleanup_logs_from_config(config.clone()).await {
        tracing::warn!(error = %error, "initial log cleanup failed");
    }

    let mut interval = tokio::time::interval(Duration::from_secs(6 * 60 * 60));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let _ = interval.tick().await;

    loop {
        let _ = interval.tick().await;

        if let Err(error) = cleanup_logs_from_config(config.clone()).await {
            tracing::warn!(error = %error, "scheduled log cleanup failed");
        }
    }
}

async fn cleanup_logs_from_config(
    config: std::sync::Arc<RwLock<Config>>,
) -> anyhow::Result<()> {
    let snapshot = config.read().await.clone();
    cleanup_log_directory(
        Path::new(snapshot.logging.dir.trim()),
        snapshot.logging.retention_days,
    )
    .await
}

async fn cleanup_log_directory(
    dir: &Path,
    retention_days: u32,
) -> anyhow::Result<()> {
    if retention_days == 0 {
        return Ok(());
    }

    tokio::fs::create_dir_all(dir)
        .await
        .with_context(|| format!("failed to create {}", dir.display()))?;

    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(retention_days as u64 * 24 * 60 * 60))
        .context("failed to compute log retention cutoff")?;
    let mut entries = tokio::fs::read_dir(dir)
        .await
        .with_context(|| format!("failed to read {}", dir.display()))?;

    while let Some(entry) = entries.next_entry().await? {
        let metadata = entry.metadata().await?;
        if !metadata.is_file() {
            continue;
        }

        let Some(filename) = entry.file_name().to_str().map(str::to_string)
        else {
            continue;
        };
        if !filename.starts_with("containr.log") {
            continue;
        }

        let modified = metadata.modified()?;
        if modified >= cutoff {
            continue;
        }

        tokio::fs::remove_file(entry.path())
            .await
            .with_context(|| {
                format!("failed to remove old log {}", entry.path().display())
            })?;
    }

    Ok(())
}

fn parse_filter(log_level: &str) -> anyhow::Result<EnvFilter> {
    EnvFilter::try_new(log_level)
        .or_else(|_| EnvFilter::try_new("info"))
        .context("failed to parse log level")
}
