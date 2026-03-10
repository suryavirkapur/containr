//! scheduled cron-job execution for deployed services

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::str::FromStr;

use anyhow::Context;
use chrono::{DateTime, Utc};
use croner::Cron;
use tokio::time::{Duration, MissedTickBehavior};
use tracing::{info, warn};
use uuid::Uuid;

use crate::docker::{
    DockerBindMount, DockerContainerConfig, DockerContainerManager,
};
use crate::image::{ImageManager, RegistryCredentials};
use crate::DockerNetworkAttachment;
use containr_common::models::{
    App, ContainerService, Deployment, DeploymentStatus,
};
use containr_common::{decrypt, derive_key, Database};

const CRON_POLL_INTERVAL_SECS: u64 = 10;

struct CronScheduleState {
    schedule: String,
    deployment_id: Uuid,
    next_run_at: DateTime<Utc>,
}

struct RunningCronJob {
    container_name: String,
    deployment_id: Uuid,
    service_name: String,
}

/// executes scheduled cron-job services from the latest running deployment
pub struct CronJobScheduler {
    db: Database,
    docker_manager: DockerContainerManager,
    image_manager: ImageManager,
    work_dir: PathBuf,
    encryption_secret: Option<String>,
}

impl CronJobScheduler {
    /// creates a new cron scheduler
    pub async fn new(
        db: Database,
        work_dir: PathBuf,
        encryption_secret: Option<String>,
    ) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&work_dir)?;

        Ok(Self {
            db,
            docker_manager: DockerContainerManager::new(),
            image_manager: ImageManager::new_headless(),
            work_dir,
            encryption_secret,
        })
    }

    /// runs the scheduler loop until shutdown
    pub async fn run(self) {
        let mut interval =
            tokio::time::interval(Duration::from_secs(CRON_POLL_INTERVAL_SECS));
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let _ = interval.tick().await;

        let mut schedules = HashMap::new();
        let mut running_jobs = HashMap::new();

        loop {
            interval.tick().await;

            if let Err(error) =
                self.poll_once(&mut schedules, &mut running_jobs).await
            {
                warn!(error = %error, "cron scheduler pass failed");
            }
        }
    }

    async fn poll_once(
        &self,
        schedules: &mut HashMap<(Uuid, Uuid), CronScheduleState>,
        running_jobs: &mut HashMap<(Uuid, Uuid), RunningCronJob>,
    ) -> anyhow::Result<()> {
        self.reconcile_running_jobs(running_jobs).await?;

        let apps = self.db.list_apps()?;
        let mut active_keys = HashSet::new();

        for app in apps {
            let Some(deployment) = self.resolve_running_deployment(app.id)?
            else {
                continue;
            };

            let shared_env_vars = self.build_shared_env_vars(&app);

            for service in
                app.services.iter().filter(|service| service.is_cron_job())
            {
                let Some(schedule) = service.schedule.as_deref() else {
                    continue;
                };

                let key = (app.id, service.id);
                active_keys.insert(key);

                let state = schedules.entry(key).or_insert(
                    self.build_schedule_state(schedule, deployment.id)?,
                );
                if state.schedule != schedule
                    || state.deployment_id != deployment.id
                {
                    *state =
                        self.build_schedule_state(schedule, deployment.id)?;
                }

                if running_jobs.contains_key(&key) {
                    continue;
                }

                if Utc::now() < state.next_run_at {
                    continue;
                }

                let image = self.resolve_service_image(service, &deployment)?;
                let container_name = self
                    .launch_cron_job(
                        &app,
                        &deployment,
                        service,
                        &image,
                        &shared_env_vars,
                    )
                    .await?;

                running_jobs.insert(
                    key,
                    RunningCronJob {
                        container_name,
                        deployment_id: deployment.id,
                        service_name: service.name.clone(),
                    },
                );
                *state = self.next_schedule_state(
                    schedule,
                    deployment.id,
                    Utc::now(),
                )?;
            }
        }

        schedules.retain(|key, _| active_keys.contains(key));
        running_jobs.retain(|key, _| active_keys.contains(key));

        Ok(())
    }

    fn resolve_running_deployment(
        &self,
        app_id: Uuid,
    ) -> anyhow::Result<Option<Deployment>> {
        Ok(self
            .db
            .list_deployments_by_app(app_id)?
            .into_iter()
            .find(|deployment| deployment.status == DeploymentStatus::Running))
    }

    fn build_schedule_state(
        &self,
        schedule: &str,
        deployment_id: Uuid,
    ) -> anyhow::Result<CronScheduleState> {
        self.next_schedule_state(schedule, deployment_id, Utc::now())
    }

    fn next_schedule_state(
        &self,
        schedule: &str,
        deployment_id: Uuid,
        from: DateTime<Utc>,
    ) -> anyhow::Result<CronScheduleState> {
        let cron = Cron::from_str(schedule)
            .with_context(|| format!("invalid cron schedule {}", schedule))?;
        let next_run_at =
            cron.find_next_occurrence(&from, false).with_context(|| {
                format!("schedule {} has no next run", schedule)
            })?;

        Ok(CronScheduleState {
            schedule: schedule.to_string(),
            deployment_id,
            next_run_at,
        })
    }

    fn build_shared_env_vars(&self, app: &App) -> HashMap<String, String> {
        let mut env_vars = HashMap::new();
        for env_var in &app.env_vars {
            env_vars.insert(env_var.key.clone(), env_var.value.clone());
        }
        env_vars
    }

    fn resolve_service_image(
        &self,
        service: &ContainerService,
        deployment: &Deployment,
    ) -> anyhow::Result<String> {
        for service_deployment in &deployment.service_deployments {
            if service_deployment.service_id != service.id {
                continue;
            }

            if let Some(image_id) = &service_deployment.image_id {
                return Ok(image_id.clone());
            }
        }

        if !service.image.trim().is_empty() {
            return Ok(service.image.clone());
        }

        if let Some(image_id) = &deployment.image_id {
            return Ok(image_id.clone());
        }

        Err(anyhow::anyhow!(
            "no deployed image found for cron job {}",
            service.name
        ))
    }

    async fn launch_cron_job(
        &self,
        app: &App,
        deployment: &Deployment,
        service: &ContainerService,
        image: &str,
        shared_env_vars: &HashMap<String, String>,
    ) -> anyhow::Result<String> {
        if !service.image.is_empty() {
            let registry_credentials =
                self.resolve_service_registry_auth(service)?;
            self.image_manager
                .pull_image_with_credentials(
                    image,
                    registry_credentials.as_ref(),
                )
                .await?;
        }

        let container_name = format!(
            "containr-cron-{}-{}-{}",
            self.short_id(&app.id.to_string()),
            self.truncate_name(&self.sanitize_name(&service.name), 12),
            Utc::now().format("%Y%m%d%H%M%S")
        );
        let network_name = app.network_name();
        self.docker_manager.create_network(&network_name).await?;

        let mut env_vars = shared_env_vars.clone();
        env_vars.insert("SERVICE_NAME".to_string(), service.name.clone());
        env_vars.insert(
            "CRON_SCHEDULE".to_string(),
            service.schedule.clone().unwrap_or_default(),
        );
        for env_var in &service.env_vars {
            env_vars.insert(env_var.key.clone(), env_var.value.clone());
        }

        let config = DockerContainerConfig {
            id: container_name.clone(),
            image: image.to_string(),
            env_vars,
            port: 0,
            additional_ports: Vec::new(),
            command: service.command.clone(),
            entrypoint: service.entrypoint.clone(),
            working_dir: service.working_dir.clone(),
            memory_limit: service.memory_limit,
            cpu_limit: service.cpu_limit,
            network: Some(DockerNetworkAttachment {
                name: network_name,
                aliases: vec![format!("{}-cron", service.name)],
            }),
            mounts: self.build_service_mounts(app.id, service)?,
            additional_networks: Vec::new(),
            health_check: None,
            restart_policy: "no".to_string(),
        };

        let _ = self.db.append_deployment_log(
            deployment.id,
            &format!("starting cron job {}", service.name),
        );
        self.docker_manager.create_container(config).await?;
        let _ = self.db.append_deployment_log(
            deployment.id,
            &format!(
                "cron job {} started in container {}",
                service.name, container_name
            ),
        );
        info!(
            app_id = %app.id,
            service = %service.name,
            container = %container_name,
            "cron job started"
        );

        Ok(container_name)
    }

    async fn reconcile_running_jobs(
        &self,
        running_jobs: &mut HashMap<(Uuid, Uuid), RunningCronJob>,
    ) -> anyhow::Result<()> {
        let keys = running_jobs.keys().cloned().collect::<Vec<_>>();
        let mut finished = Vec::new();

        for key in keys {
            let Some(job) = running_jobs.get(&key) else {
                continue;
            };

            if self.docker_manager.is_running(&job.container_name).await? {
                continue;
            }

            let state = self
                .docker_manager
                .get_state(&job.container_name)
                .await
                .ok();
            let status = state
                .as_ref()
                .map(|state| state.status.clone())
                .unwrap_or_else(|| "finished".to_string());
            let finished_at = state
                .and_then(|state| state.finished_at)
                .unwrap_or_else(|| Utc::now().to_rfc3339());

            let _ = self.db.append_deployment_log(
                job.deployment_id,
                &format!(
                    "cron job {} finished with status {} at {}",
                    job.service_name, status, finished_at
                ),
            );
            finished.push(key);
        }

        for key in finished {
            running_jobs.remove(&key);
        }

        Ok(())
    }

    fn build_service_mounts(
        &self,
        app_id: Uuid,
        service: &ContainerService,
    ) -> anyhow::Result<Vec<DockerBindMount>> {
        let mut mounts = Vec::new();
        let mounts_root = self
            .work_dir
            .join("app-mounts")
            .join(app_id.to_string())
            .join(service.id.to_string());

        for mount in &service.mounts {
            let source = mounts_root.join(&mount.name);
            std::fs::create_dir_all(&source)?;
            mounts.push(DockerBindMount {
                source: source.to_string_lossy().to_string(),
                target: mount.target.clone(),
                read_only: mount.read_only,
            });
        }

        Ok(mounts)
    }

    fn sanitize_name(&self, value: &str) -> String {
        let sanitized = value
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                    ch
                } else {
                    '-'
                }
            })
            .collect::<String>();

        if sanitized.is_empty() {
            "job".to_string()
        } else {
            sanitized
        }
    }

    fn truncate_name(&self, value: &str, max_len: usize) -> String {
        if value.len() <= max_len {
            return value.to_string();
        }

        value.chars().take(max_len).collect()
    }

    fn short_id(&self, value: &str) -> String {
        value.split('-').next().unwrap_or("job").to_string()
    }

    fn decrypt_stored_secret(&self, value: &str) -> anyhow::Result<String> {
        let trimmed = value.trim();
        let payload = trimmed.strip_prefix("enc:").unwrap_or(trimmed);

        if trimmed.starts_with("enc:") {
            let secret =
                self.encryption_secret.as_deref().ok_or_else(|| {
                    anyhow::anyhow!("encryption key is not configured")
                })?;
            let key = derive_key(secret);
            return decrypt(payload, &key).map_err(|error| {
                anyhow::anyhow!(
                    "failed to decrypt registry password: {}",
                    error
                )
            });
        }

        Ok(payload.to_string())
    }

    fn resolve_service_registry_auth(
        &self,
        service: &ContainerService,
    ) -> anyhow::Result<Option<RegistryCredentials>> {
        let Some(registry_auth) = service.registry_auth.as_ref() else {
            return Ok(None);
        };

        let password = self.decrypt_stored_secret(&registry_auth.password)?;

        Ok(Some(RegistryCredentials {
            server: registry_auth.server.clone(),
            username: registry_auth.username.clone(),
            password,
        }))
    }
}
