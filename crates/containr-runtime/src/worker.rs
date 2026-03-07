//! deployment worker
//!
//! processes deployment jobs from the queue, cloning repos,
//! building images, and starting containers.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use git2::build::RepoBuilder;
use git2::{Cred, FetchOptions, RemoteCallbacks};
use tokio::sync::mpsc;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::docker::{
    DockerBindMount, DockerContainerConfig, DockerContainerManager, DockerNetworkAttachment,
    INTERNAL_NETWORK_NAME,
};
use crate::image::{ImageManager, RegistryCredentials};
use crate::route_updates::ProxyRouteUpdate;
use containr_common::models::{
    ContainerService, Deployment, DeploymentSource, DeploymentStatus, RolloutStrategy,
};
use containr_common::{decrypt, derive_key, Database};

// use shared type from common
use containr_common::models::DeploymentJob;

/// deployment worker processes jobs from the queue
pub struct DeploymentWorker {
    db: Database,
    docker_manager: DockerContainerManager,
    image_manager: ImageManager,
    work_dir: PathBuf,
    encryption_secret: Option<String>,
    stub_mode: bool,
    proxy_updates: Option<mpsc::Sender<ProxyRouteUpdate>>,
}

impl DeploymentWorker {
    /// creates a new deployment worker using Docker for containers
    pub async fn new(
        db: Database,
        work_dir: PathBuf,
        encryption_secret: Option<String>,
        proxy_updates: Option<mpsc::Sender<ProxyRouteUpdate>>,
    ) -> anyhow::Result<Self> {
        // Use Docker for container management
        let docker_manager = DockerContainerManager::new();
        let image_manager = ImageManager::new_headless(); // Uses docker/buildah CLI

        let stub_mode = docker_manager.is_stub();

        if stub_mode {
            warn!("docker not available - running in stub mode");
        } else {
            info!("deployment worker using Docker runtime");
        }

        // ensure work directory exists
        std::fs::create_dir_all(&work_dir)?;

        Ok(Self {
            db,
            docker_manager,
            image_manager,
            work_dir,
            encryption_secret,
            stub_mode,
            proxy_updates,
        })
    }

    /// creates a worker in stub mode (for development without docker)
    pub fn new_stub(
        db: Database,
        work_dir: PathBuf,
        encryption_secret: Option<String>,
        proxy_updates: Option<mpsc::Sender<ProxyRouteUpdate>>,
    ) -> anyhow::Result<Self> {
        warn!("deployment worker starting in stub mode");

        // ensure work directory exists
        std::fs::create_dir_all(&work_dir)?;

        Ok(Self {
            db,
            docker_manager: DockerContainerManager::new_stub(),
            image_manager: ImageManager::new_stub(),
            work_dir,
            encryption_secret,
            stub_mode: true,
            proxy_updates,
        })
    }

    /// returns true if running in stub mode
    pub fn is_stub(&self) -> bool {
        self.stub_mode
    }

    /// runs the worker, processing jobs from the channel
    pub async fn run(self, mut rx: mpsc::Receiver<DeploymentJob>) {
        info!(stub_mode = %self.stub_mode, "deployment worker started");

        while let Some(job) = rx.recv().await {
            info!(
                app_id = %job.app_id,
                deployment_id = %job.deployment_id,
                commit = %job.commit_sha,
                "processing deployment job"
            );

            if let Err(e) = self.process_job(&job).await {
                error!(
                    app_id = %job.app_id,
                    error = %e,
                    "deployment failed"
                );

                // update deployment status to failed
                if let Ok(Some(mut deployment)) = self.db.get_deployment(job.deployment_id) {
                    deployment.status = DeploymentStatus::Failed;
                    deployment.finished_at = Some(chrono::Utc::now());
                    let _ = self
                        .db
                        .append_deployment_log(deployment.id, &format!("error: {}", e));
                    let _ = self.db.save_deployment(&deployment);
                }
            }
        }

        info!("deployment worker stopped");
    }

    /// processes a single deployment job
    async fn process_job(&self, job: &DeploymentJob) -> anyhow::Result<()> {
        // get the deployment referenced by this job
        let deployment = self
            .db
            .get_deployment(job.deployment_id)?
            .ok_or_else(|| anyhow::anyhow!("deployment not found"))?;

        if deployment.app_id != job.app_id {
            return Err(anyhow::anyhow!("deployment app mismatch"));
        }

        let image_name = if let Some(source_deployment_id) = job.rollback_from_deployment_id {
            let source = self
                .db
                .get_deployment(source_deployment_id)?
                .ok_or_else(|| anyhow::anyhow!("rollback source deployment not found"))?;

            if source.app_id != job.app_id {
                return Err(anyhow::anyhow!("rollback source does not belong to app"));
            }

            let image = source
                .image_id
                .clone()
                .ok_or_else(|| anyhow::anyhow!("rollback source missing image artifact"))?;
            let _ = self.db.append_deployment_log(
                deployment.id,
                &format!(
                    "rollback: using image artifact from deployment {}",
                    source.id
                ),
            );
            image
        } else {
            // update status to cloning
            self.update_status(&deployment, DeploymentStatus::Cloning)?;

            // clone repository
            let repo_path = self.clone_repo(job).await?;

            // update status to building
            self.update_status(&deployment, DeploymentStatus::Building)?;

            // build docker image
            let commit_prefix = if job.commit_sha.len() >= 8 {
                &job.commit_sha[..8]
            } else {
                &job.commit_sha
            };
            let image_name = format!("containr/{}:{}", job.app_id, commit_prefix);

            self.image_manager
                .build_image_with_logs(&image_name, repo_path.to_str().unwrap(), None, |line| {
                    let _ = self.db.append_deployment_log(deployment.id, line);
                })
                .await?;

            // cleanup repo directory
            let _ = tokio::fs::remove_dir_all(&repo_path).await;
            image_name
        };

        // update status to starting
        self.update_status(&deployment, DeploymentStatus::Starting)?;

        // get app config
        let app = self
            .db
            .get_app(job.app_id)?
            .ok_or_else(|| anyhow::anyhow!("app not found"))?;

        // prepare shared env vars (all services inherit these)
        let mut env_vars = HashMap::new();
        for env in &app.env_vars {
            env_vars.insert(env.key.clone(), env.value.clone());
        }

        // create network for this app
        let network_name = format!("containr-{}", job.app_id);
        self.docker_manager.create_network(&network_name).await?;
        self.docker_manager
            .create_network(INTERNAL_NETWORK_NAME)
            .await?;

        // check if app uses new multi-service model
        if app.has_services() {
            // multi-container deployment
            self.deploy_services(
                &app,
                &deployment,
                &network_name,
                &image_name,
                &env_vars,
                job.rollout_strategy,
            )
            .await?;
        } else {
            self.deploy_legacy(
                &app,
                &deployment,
                &network_name,
                &image_name,
                &env_vars,
                job.rollout_strategy,
            )
            .await?;
        }

        info!(
            app_id = %job.app_id,
            deployment_id = %deployment.id,
            "deployment completed successfully"
        );

        Ok(())
    }

    /// deploys multi-container services with dependency ordering
    async fn deploy_services(
        &self,
        app: &containr_common::models::App,
        deployment: &Deployment,
        network_name: &str,
        image_name: &str,
        shared_env_vars: &HashMap<String, String>,
        rollout_strategy: RolloutStrategy,
    ) -> anyhow::Result<()> {
        use containr_common::models::{RestartPolicy, ServiceDeployment};

        // topological sort services by dependencies
        let sorted_services = self.topological_sort_services(&app.services)?;
        let previous_running = self.get_previous_running_deployment(app.id, deployment.id)?;
        let mut old_containers: HashMap<(uuid::Uuid, u32), String> = HashMap::new();
        if let Some(prev) = previous_running {
            for sd in prev.service_deployments {
                if let Some(container_id) = sd.container_id {
                    old_containers.insert((sd.service_id, sd.replica_index), container_id);
                }
            }
        }

        let mut service_deployments = Vec::new();
        let mut new_container_ids = HashSet::new();
        let short_id = deployment
            .id
            .to_string()
            .split('-')
            .next()
            .unwrap_or("0")
            .to_string();

        for service in sorted_services {
            info!(
                service = %service.name,
                replicas = %service.replicas,
                "deploying service"
            );

            // deploy each replica
            for replica_idx in 0..service.replicas {
                let container_id = format!(
                    "containr-{}-{}-{}-{}",
                    app.id, service.name, replica_idx, short_id
                );
                let old_container = old_containers.get(&(service.id, replica_idx)).cloned();
                if matches!(rollout_strategy, RolloutStrategy::StopFirst) {
                    if let Some(old) = old_container.as_deref() {
                        let _ = self.docker_manager.stop_container(old).await;
                        let _ = self.docker_manager.remove_container(old).await;
                    }
                }

                // merge shared env vars with service-specific PORT
                let mut env_vars = shared_env_vars.clone();
                env_vars.insert("PORT".to_string(), service.port.to_string());
                env_vars.insert("SERVICE_NAME".to_string(), service.name.clone());
                env_vars.insert("REPLICA_INDEX".to_string(), replica_idx.to_string());

                // convert health check if configured
                let health_check =
                    service
                        .health_check
                        .as_ref()
                        .map(|hc| crate::docker::HealthCheckCommand {
                            cmd: vec![
                                "curl".to_string(),
                                "-f".to_string(),
                                format!("http://localhost:{}{}", service.port, hc.path),
                            ],
                            interval_secs: hc.interval_secs,
                            timeout_secs: hc.timeout_secs,
                            retries: hc.retries,
                        });

                // convert restart policy
                let restart_policy = match service.restart_policy {
                    RestartPolicy::Never => "no".to_string(),
                    RestartPolicy::Always => "always".to_string(),
                    RestartPolicy::OnFailure => "on-failure".to_string(),
                };

                // use service image if specified, otherwise use built image
                let service_image = if service.image.is_empty() {
                    image_name.to_string()
                } else {
                    service.image.clone()
                };

                if !service.image.is_empty() {
                    let registry_credentials = self.resolve_service_registry_auth(&service)?;
                    let _ = self.db.append_deployment_log(
                        deployment.id,
                        &format!("pulling service image {}", service_image),
                    );
                    self.image_manager
                        .pull_image_with_credentials(&service_image, registry_credentials.as_ref())
                        .await?;
                }

                let config = DockerContainerConfig {
                    id: container_id.clone(),
                    image: service_image,
                    env_vars,
                    port: service.port,
                    additional_ports: service.additional_ports.clone(),
                    command: service.command.clone(),
                    entrypoint: service.entrypoint.clone(),
                    working_dir: service.working_dir.clone(),
                    memory_limit: service.memory_limit,
                    cpu_limit: service.cpu_limit,
                    network: Some(DockerNetworkAttachment {
                        name: network_name.to_string(),
                        aliases: self.service_network_aliases(&service.name, replica_idx),
                    }),
                    mounts: self.build_service_mounts(app.id, &service)?,
                    additional_networks: vec![DockerNetworkAttachment {
                        name: INTERNAL_NETWORK_NAME.to_string(),
                        aliases: Vec::new(),
                    }],
                    health_check,
                    restart_policy,
                };

                let container_info = self.docker_manager.create_container(config).await?;

                // wait for dependencies to be healthy before continuing
                if service.health_check.is_some() {
                    if !self
                        .docker_manager
                        .wait_for_healthy(&container_id, 60)
                        .await?
                    {
                        let _ = self.docker_manager.stop_container(&container_id).await;
                        let _ = self.docker_manager.remove_container(&container_id).await;
                        return Err(anyhow::anyhow!(
                            "service {} replica {} failed health check",
                            service.name,
                            replica_idx
                        ));
                    }
                }

                // create service deployment record
                let mut sd = ServiceDeployment::new(service.id, deployment.id, replica_idx);
                sd.container_id = Some(container_info.id);
                sd.status = containr_common::models::DeploymentStatus::Running;
                sd.started_at = Some(chrono::Utc::now());

                self.db.save_service_deployment(&sd)?;
                service_deployments.push(sd);
                new_container_ids.insert(container_id);
            }
        }

        // update main deployment
        let mut updated_deployment = deployment.clone();
        updated_deployment.status = containr_common::models::DeploymentStatus::Running;
        updated_deployment.service_deployments = service_deployments;
        updated_deployment.image_id = Some(image_name.to_string());
        updated_deployment.started_at = Some(chrono::Utc::now());
        updated_deployment.finished_at = Some(chrono::Utc::now());
        self.db.save_deployment(&updated_deployment)?;
        self.send_proxy_refresh(app.id).await;

        if matches!(rollout_strategy, RolloutStrategy::StartFirst) {
            for old in old_containers.values() {
                if !new_container_ids.contains(old) {
                    let _ = self.docker_manager.stop_container(old).await;
                    let _ = self.docker_manager.remove_container(old).await;
                }
            }
        }

        Ok(())
    }

    async fn deploy_legacy(
        &self,
        app: &containr_common::models::App,
        deployment: &Deployment,
        network_name: &str,
        image_name: &str,
        shared_env_vars: &HashMap<String, String>,
        rollout_strategy: RolloutStrategy,
    ) -> anyhow::Result<()> {
        let mut env_vars = shared_env_vars.clone();
        env_vars.insert("PORT".to_string(), app.port.to_string());

        let previous_running = self.get_previous_running_deployment(app.id, deployment.id)?;
        let previous_container_id = previous_running.and_then(|d| d.container_id);
        if matches!(rollout_strategy, RolloutStrategy::StopFirst) {
            if let Some(old) = previous_container_id.as_deref() {
                let _ = self.docker_manager.stop_container(old).await;
                let _ = self.docker_manager.remove_container(old).await;
            }
        }

        // generate unique container id for blue/green deployment
        // format: containr-{app_id}-{short_deployment_id}
        let short_id = deployment
            .id
            .to_string()
            .split('-')
            .next()
            .unwrap_or("0")
            .to_string();
        let container_id = format!("containr-{}-{}", app.id, short_id);

        // start new container using Docker
        let config = DockerContainerConfig {
            id: container_id.clone(),
            image: image_name.to_string(),
            env_vars,
            port: app.port,
            additional_ports: Vec::new(),
            command: None,
            entrypoint: None,
            working_dir: None,
            memory_limit: Some(512 * 1024 * 1024), // 512mb
            cpu_limit: Some(1.0),
            network: Some(DockerNetworkAttachment {
                name: network_name.to_string(),
                aliases: vec!["app".to_string()],
            }),
            mounts: Vec::new(),
            additional_networks: vec![DockerNetworkAttachment {
                name: INTERNAL_NETWORK_NAME.to_string(),
                aliases: Vec::new(),
            }],
            health_check: None,
            restart_policy: "unless-stopped".to_string(),
        };

        let container_info = self.docker_manager.create_container(config).await?;

        info!(container_id = %container_info.id, "waiting for container to stabilize");
        if !self
            .docker_manager
            .wait_for_healthy(&container_info.id, 10)
            .await?
        {
            let _ = self.docker_manager.stop_container(&container_info.id).await;
            let _ = self
                .docker_manager
                .remove_container(&container_info.id)
                .await;
            return Err(anyhow::anyhow!("container failed to stabilize"));
        }

        let mut updated_deployment = deployment.clone();
        updated_deployment.status = DeploymentStatus::Running;
        updated_deployment.container_id = Some(container_info.id.clone());
        updated_deployment.image_id = Some(image_name.to_string());
        updated_deployment.started_at = Some(chrono::Utc::now());
        updated_deployment.finished_at = Some(chrono::Utc::now());
        self.db.save_deployment(&updated_deployment)?;

        self.send_proxy_refresh(app.id).await;
        self.cleanup_old_containers(app.id, &container_info.id)
            .await;

        Ok(())
    }

    fn get_previous_running_deployment(
        &self,
        app_id: Uuid,
        current_deployment_id: Uuid,
    ) -> anyhow::Result<Option<Deployment>> {
        let deployments = self.db.list_deployments_by_app(app_id)?;
        Ok(deployments
            .into_iter()
            .filter(|d| d.id != current_deployment_id && d.status == DeploymentStatus::Running)
            .next())
    }

    fn build_service_mounts(
        &self,
        app_id: Uuid,
        service: &containr_common::models::ContainerService,
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

    fn decrypt_stored_secret(&self, value: &str) -> anyhow::Result<String> {
        let trimmed = value.trim();
        let payload = trimmed.strip_prefix("enc:").unwrap_or(trimmed);

        if trimmed.starts_with("enc:") {
            let secret = self
                .encryption_secret
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("encryption key is not configured"))?;
            let key = derive_key(secret);
            return decrypt(payload, &key).map_err(|error| {
                anyhow::anyhow!("failed to decrypt registry password: {}", error)
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

    /// topological sort services by dependencies
    fn topological_sort_services(
        &self,
        services: &[containr_common::models::ContainerService],
    ) -> anyhow::Result<Vec<containr_common::models::ContainerService>> {
        use std::collections::{HashSet, VecDeque};

        let name_to_service: HashMap<String, &containr_common::models::ContainerService> =
            services.iter().map(|s| (s.name.clone(), s)).collect();

        let mut in_degree: HashMap<String, usize> = HashMap::new();
        let mut adj_list: HashMap<String, Vec<String>> = HashMap::new();

        // initialize
        for service in services {
            in_degree.insert(service.name.clone(), 0);
            adj_list.insert(service.name.clone(), Vec::new());
        }

        // build graph
        for service in services {
            for dep in &service.depends_on {
                if let Some(edges) = adj_list.get_mut(dep) {
                    edges.push(service.name.clone());
                }
                if let Some(degree) = in_degree.get_mut(&service.name) {
                    *degree += 1;
                }
            }
        }

        // kahn's algorithm
        let mut queue: VecDeque<String> = in_degree
            .iter()
            .filter(|(_, &degree)| degree == 0)
            .map(|(name, _)| name.clone())
            .collect();

        let mut sorted = Vec::new();
        let mut visited = HashSet::new();

        while let Some(name) = queue.pop_front() {
            if visited.contains(&name) {
                continue;
            }
            visited.insert(name.clone());

            if let Some(service) = name_to_service.get(&name) {
                sorted.push((*service).clone());
            }

            if let Some(neighbors) = adj_list.get(&name) {
                for neighbor in neighbors {
                    if let Some(degree) = in_degree.get_mut(neighbor) {
                        *degree -= 1;
                        if *degree == 0 {
                            queue.push_back(neighbor.clone());
                        }
                    }
                }
            }
        }

        if sorted.len() != services.len() {
            return Err(anyhow::anyhow!("circular dependency detected in services"));
        }

        Ok(sorted)
    }

    /// clones the git repository using git2
    async fn clone_repo(&self, job: &DeploymentJob) -> anyhow::Result<PathBuf> {
        let commit_prefix = if job.commit_sha.len() >= 8 {
            &job.commit_sha[..8]
        } else {
            &job.commit_sha
        };
        let repo_path = self
            .work_dir
            .join(format!("{}_{}", job.app_id, commit_prefix));

        // remove if exists
        let _ = tokio::fs::remove_dir_all(&repo_path).await;

        let source = job.source.clone();
        let source_url = match &source {
            DeploymentSource::LocalPath { path } => path.clone(),
            DeploymentSource::RemoteGit { url, .. } => url.clone(),
        };

        info!(
            url = %source_url,
            branch = %job.branch,
            path = %repo_path.display(),
            "cloning repository"
        );

        // clone with shallow depth using git2
        // git2 is synchronous, so we spawn_blocking
        let url = source_url;
        let branch = job.branch.clone();
        let path = repo_path.clone();
        let source = source.clone();

        tokio::task::spawn_blocking(move || {
            let mut builder = RepoBuilder::new();
            builder.branch(&branch);

            if let DeploymentSource::RemoteGit {
                token: Some(token), ..
            } = &source
            {
                let mut fetch_opts = FetchOptions::new();
                fetch_opts.depth(1);
                let token = token.clone();
                let mut callbacks = RemoteCallbacks::new();
                callbacks.credentials(move |_url, _username, _allowed| {
                    Cred::userpass_plaintext("x-access-token", &token)
                });
                fetch_opts.remote_callbacks(callbacks);
                builder.fetch_options(fetch_opts);
            } else if matches!(source, DeploymentSource::RemoteGit { .. }) {
                let mut fetch_opts = FetchOptions::new();
                fetch_opts.depth(1);
                builder.fetch_options(fetch_opts);
            }

            builder.clone(&url, &path)
        })
        .await?
        .map_err(|e| anyhow::anyhow!("git clone failed: {}", e))?;

        Ok(repo_path)
    }

    /// updates deployment status
    fn update_status(
        &self,
        deployment: &Deployment,
        status: DeploymentStatus,
    ) -> anyhow::Result<()> {
        let mut updated = deployment.clone();
        updated.status = status;
        let _ = self.db.append_deployment_log(
            updated.id,
            &format!(
                "[{}] status: {:?}",
                chrono::Utc::now().format("%Y-%m-%d %H:%M:%S"),
                status
            ),
        );
        self.db.save_deployment(&updated)?;
        Ok(())
    }

    async fn send_proxy_refresh(&self, app_id: Uuid) {
        if let Some(sender) = &self.proxy_updates {
            let _ = sender.send(ProxyRouteUpdate::RefreshApp { app_id }).await;
        }
    }

    /// cleans up old containers for an app (all except the current one)
    async fn cleanup_old_containers(&self, app_id: Uuid, current_container_id: &str) {
        info!("cleaning up old containers for app {}", app_id);

        // list all containers
        match self.docker_manager.list_containers().await {
            Ok(containers) => {
                let app_prefix = format!("containr-{}-", app_id);
                // also check for the legacy name format
                let legacy_name = format!("containr-{}", app_id);

                for container in containers {
                    // skip current container
                    if container.id == current_container_id {
                        continue;
                    }

                    // check if container belongs to this app
                    // either specific deployment ID or legacy name
                    if container.id.starts_with(&app_prefix) || container.id == legacy_name {
                        info!(container_id = %container.id, "removing old container");
                        let _ = self.docker_manager.stop_container(&container.id).await;
                        let _ = self.docker_manager.remove_container(&container.id).await;
                    }
                }
            }
            Err(e) => {
                warn!("failed to list containers for cleanup: {}", e);
            }
        }
    }

    fn service_network_aliases(&self, service_name: &str, replica_index: u32) -> Vec<String> {
        vec![
            service_name.to_string(),
            format!("{}-{}", service_name, replica_index),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use containr_common::models::ContainerService;
    use containr_common::{encrypt, DatabaseBackendKind, DatabaseConfig};

    fn make_worker() -> DeploymentWorker {
        let root = std::env::temp_dir().join(format!("containr-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let db = Database::open(&DatabaseConfig {
            backend: DatabaseBackendKind::Sled,
            path: root.join("containr.db").to_string_lossy().to_string(),
        })
        .unwrap();
        let work_dir = root.join("work");
        DeploymentWorker::new_stub(db, work_dir, Some("test-secret".to_string()), None).unwrap()
    }

    #[test]
    fn topological_sort_orders_dependencies() {
        let worker = make_worker();
        let app_id = Uuid::new_v4();

        let web = ContainerService::new(app_id, "web".to_string(), "".to_string(), 8080);
        let mut api = ContainerService::new(app_id, "api".to_string(), "".to_string(), 8081);
        api.depends_on = vec!["web".to_string()];

        let sorted = worker
            .topological_sort_services(&[api.clone(), web.clone()])
            .unwrap();
        let names: Vec<String> = sorted.into_iter().map(|s| s.name).collect();

        assert_eq!(names, vec!["web".to_string(), "api".to_string()]);
    }

    #[test]
    fn topological_sort_detects_cycles() {
        let worker = make_worker();
        let app_id = Uuid::new_v4();

        let mut web = ContainerService::new(app_id, "web".to_string(), "".to_string(), 8080);
        let mut api = ContainerService::new(app_id, "api".to_string(), "".to_string(), 8081);
        web.depends_on = vec!["api".to_string()];
        api.depends_on = vec!["web".to_string()];

        let result = worker.topological_sort_services(&[api, web]);
        assert!(result.is_err());
    }

    #[test]
    fn resolve_service_registry_auth_decrypts_encrypted_password() {
        let worker = make_worker();
        let app_id = Uuid::new_v4();
        let key = derive_key("test-secret");
        let encrypted_password = encrypt("super-secret", &key).unwrap();

        let mut service = ContainerService::new(
            app_id,
            "web".to_string(),
            "ghcr.io/demo/private:1".to_string(),
            8080,
        );
        service.registry_auth = Some(containr_common::models::ServiceRegistryAuth {
            server: Some("ghcr.io".to_string()),
            username: "demo-user".to_string(),
            password: format!("enc:{}", encrypted_password),
        });

        let registry_auth = worker.resolve_service_registry_auth(&service).unwrap();
        assert!(registry_auth.is_some());
        let registry_auth = registry_auth.unwrap();
        assert_eq!(registry_auth.username, "demo-user");
        assert_eq!(registry_auth.password, "super-secret");
    }
}
