use std::collections::HashMap;
use std::path::PathBuf;

use uuid::Uuid;

use crate::docker::{
    DockerBindMount, DockerContainerConfig, DockerContainerManager,
    DockerNetworkAttachment, HealthCheckCommand,
};
use crate::image::{ImageManager, RegistryCredentials};
use containr_common::models::{
    App, ContainerService, Deployment, RestartPolicy,
};
use containr_common::{decrypt, derive_key};

pub struct AppServiceManager {
    docker_manager: DockerContainerManager,
    image_manager: ImageManager,
    work_dir: PathBuf,
    encryption_secret: Option<String>,
}

impl AppServiceManager {
    pub async fn new(
        work_dir: PathBuf,
        encryption_secret: Option<String>,
    ) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&work_dir)?;

        Ok(Self {
            docker_manager: DockerContainerManager::new(),
            image_manager: ImageManager::new_headless(),
            work_dir,
            encryption_secret,
        })
    }

    pub async fn start_service_replica(
        &self,
        app: &App,
        service: &ContainerService,
        deployment: &Deployment,
        image: &str,
        replica_index: u32,
    ) -> anyhow::Result<String> {
        self.docker_manager
            .create_network(&app.network_name())
            .await?;

        let container_name =
            self.container_name(app, service, deployment, replica_index);
        let _ = self.docker_manager.stop_container(&container_name).await;
        let _ = self.docker_manager.remove_container(&container_name).await;

        if !service.image.trim().is_empty() {
            let credentials = self.resolve_service_registry_auth(service)?;
            self.image_manager
                .pull_image_with_credentials(image, credentials.as_ref())
                .await?;
        }

        let config = DockerContainerConfig {
            id: container_name.clone(),
            image: image.to_string(),
            env_vars: self.build_env_vars(service, replica_index, app),
            port: service.port,
            additional_ports: service.additional_ports.clone(),
            command: service.command.clone(),
            entrypoint: service.entrypoint.clone(),
            working_dir: service.working_dir.clone(),
            memory_limit: service.memory_limit,
            cpu_limit: service.cpu_limit,
            network: Some(DockerNetworkAttachment {
                name: app.network_name(),
                aliases: self
                    .service_network_aliases(&service.name, replica_index),
            }),
            mounts: self.build_service_mounts(app.id, service)?,
            additional_networks: Vec::new(),
            health_check: self.build_health_check(service),
            restart_policy: self.restart_policy(service.restart_policy),
        };

        self.docker_manager.create_container(config).await?;

        if service.health_check.is_some()
            && !self
                .docker_manager
                .wait_for_healthy(&container_name, 60)
                .await?
        {
            let _ = self.docker_manager.stop_container(&container_name).await;
            let _ = self.docker_manager.remove_container(&container_name).await;
            return Err(anyhow::anyhow!(
                "service {} replica {} failed health check",
                service.name,
                replica_index
            ));
        }

        Ok(container_name)
    }

    pub async fn stop_service_replica(
        &self,
        container_name: &str,
    ) -> anyhow::Result<()> {
        self.docker_manager.stop_container(container_name).await?;
        self.docker_manager.remove_container(container_name).await?;
        Ok(())
    }

    pub async fn get_service_logs(
        &self,
        container_name: &str,
        tail: usize,
    ) -> anyhow::Result<String> {
        self.docker_manager
            .get_logs(container_name, tail)
            .await
            .map_err(Into::into)
    }

    pub async fn list_cron_job_containers(
        &self,
        app: &App,
        service: &ContainerService,
    ) -> anyhow::Result<Vec<String>> {
        let prefix = self.cron_container_prefix(app, service);
        let containers = self.docker_manager.list_containers().await?;

        Ok(containers
            .into_iter()
            .filter(|container| container.id.starts_with(&prefix))
            .map(|container| container.id)
            .collect())
    }

    fn build_env_vars(
        &self,
        service: &ContainerService,
        replica_index: u32,
        app: &App,
    ) -> HashMap<String, String> {
        let mut env_vars = HashMap::new();
        for env_var in &app.env_vars {
            env_vars.insert(env_var.key.clone(), env_var.value.clone());
        }
        env_vars.insert("SERVICE_NAME".to_string(), service.name.clone());
        env_vars.insert("REPLICA_INDEX".to_string(), replica_index.to_string());
        if service.port > 0 {
            env_vars.insert("PORT".to_string(), service.port.to_string());
        }
        for env_var in &service.env_vars {
            env_vars.insert(env_var.key.clone(), env_var.value.clone());
        }
        env_vars
    }

    fn build_health_check(
        &self,
        service: &ContainerService,
    ) -> Option<HealthCheckCommand> {
        let health_check = service.health_check.as_ref()?;
        if service.port == 0 {
            return None;
        }

        Some(HealthCheckCommand {
            cmd: vec![
                "curl".to_string(),
                "-f".to_string(),
                format!(
                    "http://localhost:{}{}",
                    service.port, health_check.path
                ),
            ],
            interval_secs: health_check.interval_secs,
            timeout_secs: health_check.timeout_secs,
            retries: health_check.retries,
        })
    }

    fn restart_policy(&self, restart_policy: RestartPolicy) -> String {
        match restart_policy {
            RestartPolicy::Never => "no".to_string(),
            RestartPolicy::Always => "always".to_string(),
            RestartPolicy::OnFailure => "on-failure".to_string(),
        }
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

    fn container_name(
        &self,
        app: &App,
        service: &ContainerService,
        deployment: &Deployment,
        replica_index: u32,
    ) -> String {
        format!(
            "containr-{}-{}-{}-{}",
            app.id,
            service.name,
            replica_index,
            self.short_id(&deployment.id.to_string())
        )
    }

    fn service_network_aliases(
        &self,
        service_name: &str,
        replica_index: u32,
    ) -> Vec<String> {
        vec![
            service_name.to_string(),
            format!("{}-{}", service_name, replica_index),
        ]
    }

    fn cron_container_prefix(
        &self,
        app: &App,
        service: &ContainerService,
    ) -> String {
        format!(
            "containr-cron-{}-{}-",
            self.short_id(&app.id.to_string()),
            self.truncate_name(&self.sanitize_name(&service.name), 12)
        )
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
        value
            .split('-')
            .next()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "0".to_string())
    }
}
