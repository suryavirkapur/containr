use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceUnitConfig {
    pub service_name: String,
    pub user: String,
    pub working_directory: PathBuf,
    pub binary_path: PathBuf,
    pub config_path: PathBuf,
    pub log_level: String,
}

impl ServiceUnitConfig {
    pub fn default_output_path(&self) -> PathBuf {
        PathBuf::from("/etc/systemd/system")
            .join(format!("{}.service", self.service_name))
    }
}

pub fn render_service_unit(config: &ServiceUnitConfig) -> Result<String> {
    validate_service_config(config)?;

    Ok(format!(
        "[Unit]\n\
Description=containr paas\n\
After=network.target docker.service\n\
Requires=docker.service\n\
\n\
[Service]\n\
Type=simple\n\
User={}\n\
WorkingDirectory={}\n\
ExecStart={} server --config {} --log-level {}\n\
Restart=always\n\
RestartSec=5\n\
\n\
[Install]\n\
WantedBy=multi-user.target\n",
        config.user,
        config.working_directory.display(),
        config.binary_path.display(),
        config.config_path.display(),
        config.log_level
    ))
}

pub fn write_service_unit(
    config: &ServiceUnitConfig,
    output_path: &Path,
) -> Result<()> {
    let content = render_service_unit(config)?;
    let parent = output_path.parent().ok_or_else(|| {
        anyhow!(
            "failed to resolve parent directory for {}",
            output_path.display()
        )
    })?;

    std::fs::create_dir_all(parent)
        .with_context(|| format!("failed to create {}", parent.display()))?;
    std::fs::write(output_path, content)
        .with_context(|| format!("failed to write {}", output_path.display()))
}

pub fn install_service_unit(
    config: &ServiceUnitConfig,
    output_path: Option<&Path>,
    enable: bool,
    start: bool,
) -> Result<PathBuf> {
    let resolved_output_path = match output_path {
        Some(path) => path.to_path_buf(),
        None => config.default_output_path(),
    };

    write_service_unit(config, &resolved_output_path)?;

    if enable || start {
        if resolved_output_path != config.default_output_path() {
            return Err(anyhow!(
                "enable/start requires the default systemd unit path {}",
                config.default_output_path().display()
            ));
        }

        run_systemctl(&["daemon-reload"])?;
        if enable {
            run_systemctl(&["enable", &config.service_name])?;
        }
        if start {
            run_systemctl(&["restart", &config.service_name])?;
        }
    }

    Ok(resolved_output_path)
}

fn run_systemctl(args: &[&str]) -> Result<()> {
    let output =
        Command::new("systemctl")
            .args(args)
            .output()
            .with_context(|| {
                format!("failed to run systemctl {}", args.join(" "))
            })?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.trim().is_empty() {
        return Err(anyhow!(
            "systemctl {} failed with status {}",
            args.join(" "),
            output.status
        ));
    }

    Err(anyhow!(
        "systemctl {} failed: {}",
        args.join(" "),
        stderr.trim()
    ))
}

fn validate_service_config(config: &ServiceUnitConfig) -> Result<()> {
    if config.service_name.trim().is_empty() {
        return Err(anyhow!("service name cannot be empty"));
    }
    if !config.working_directory.is_absolute() {
        return Err(anyhow!(
            "working directory must be absolute: {}",
            config.working_directory.display()
        ));
    }
    if !config.binary_path.is_absolute() {
        return Err(anyhow!(
            "binary path must be absolute: {}",
            config.binary_path.display()
        ));
    }
    if !config.config_path.is_absolute() {
        return Err(anyhow!(
            "config path must be absolute: {}",
            config.config_path.display()
        ));
    }

    Ok(())
}

#[cfg(test)]
#[path = "systemd_test.rs"]
mod systemd_test;
