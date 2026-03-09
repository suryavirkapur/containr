//! deployment worker
//!
//! processes deployment jobs from the queue, cloning repos,
//! building images, and starting containers.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use git2::build::RepoBuilder;
use git2::{Cred, FetchOptions, RemoteCallbacks};
use tokio::sync::mpsc;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::docker::{
    DockerBindMount, DockerContainerConfig, DockerContainerManager, DockerNetworkAttachment,
    INTERNAL_NETWORK_NAME,
};
use crate::image::{ImageBuildConfig, ImageManager, RegistryCredentials};
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

        // get app config
        let app = self
            .db
            .get_app(job.app_id)?
            .ok_or_else(|| anyhow::anyhow!("app not found"))?;

        let service_images = if let Some(source_deployment_id) = job.rollback_from_deployment_id {
            let source = self
                .db
                .get_deployment(source_deployment_id)?
                .ok_or_else(|| anyhow::anyhow!("rollback source deployment not found"))?;

            if source.app_id != job.app_id {
                return Err(anyhow::anyhow!("rollback source does not belong to app"));
            }

            let _ = self.db.append_deployment_log(
                deployment.id,
                &format!(
                    "rollback: using service image artifacts from deployment {}",
                    source.id
                ),
            );
            self.resolve_rollback_service_images(&app, &source)?
        } else {
            // update status to cloning
            self.update_status(&deployment, DeploymentStatus::Cloning)?;

            // clone repository
            let repo_path = self.clone_repo(job).await?;

            // update status to building
            self.update_status(&deployment, DeploymentStatus::Building)?;
            let service_images = self
                .build_service_images(&app, &deployment, &repo_path, &job.commit_sha)
                .await?;

            // cleanup repo directory
            let _ = tokio::fs::remove_dir_all(&repo_path).await;
            service_images
        };

        // update status to starting
        self.update_status(&deployment, DeploymentStatus::Starting)?;

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

        self.deploy_services(
            &app,
            &deployment,
            &network_name,
            &service_images,
            &env_vars,
            job.rollout_strategy,
        )
        .await?;

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
        service_images: &HashMap<Uuid, String>,
        shared_env_vars: &HashMap<String, String>,
        rollout_strategy: RolloutStrategy,
    ) -> anyhow::Result<()> {
        use containr_common::models::{RestartPolicy, ServiceDeployment};

        // topological sort services by dependencies
        let sorted_services = self.topological_sort_services(&app.services)?;
        let previous_running = self.get_previous_running_deployment(app.id, deployment.id)?;
        let legacy_previous_container = previous_running
            .as_ref()
            .and_then(|previous| previous.container_id.clone());
        let mut old_containers: HashMap<(uuid::Uuid, u32), String> = HashMap::new();
        if let Some(prev) = previous_running {
            for sd in prev.service_deployments {
                if let Some(container_id) = sd.container_id {
                    old_containers.insert((sd.service_id, sd.replica_index), container_id);
                }
            }
        }

        if matches!(rollout_strategy, RolloutStrategy::StopFirst) {
            if let Some(old) = legacy_previous_container.as_deref() {
                let _ = self.docker_manager.stop_container(old).await;
                let _ = self.docker_manager.remove_container(old).await;
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
                env_vars.insert("SERVICE_NAME".to_string(), service.name.clone());
                env_vars.insert("REPLICA_INDEX".to_string(), replica_idx.to_string());
                if service.port > 0 {
                    env_vars.insert("PORT".to_string(), service.port.to_string());
                }
                for env_var in &service.env_vars {
                    env_vars.insert(env_var.key.clone(), env_var.value.clone());
                }

                // convert health check if configured
                let health_check = service.health_check.as_ref().and_then(|hc| {
                    if service.port == 0 {
                        return None;
                    }

                    Some(crate::docker::HealthCheckCommand {
                        cmd: vec![
                            "curl".to_string(),
                            "-f".to_string(),
                            format!("http://localhost:{}{}", service.port, hc.path),
                        ],
                        interval_secs: hc.interval_secs,
                        timeout_secs: hc.timeout_secs,
                        retries: hc.retries,
                    })
                });

                // convert restart policy
                let restart_policy = match service.restart_policy {
                    RestartPolicy::Never => "no".to_string(),
                    RestartPolicy::Always => "always".to_string(),
                    RestartPolicy::OnFailure => "on-failure".to_string(),
                };

                let service_image = service_images
                    .get(&service.id)
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("missing image for service {}", service.name))?;

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
                    image: service_image.clone(),
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
                sd.image_id = Some(service_image.clone());
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
        updated_deployment.image_id = self.primary_deployment_image_id(service_images);
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
            if let Some(old) = legacy_previous_container.as_deref() {
                if !new_container_ids.contains(old) {
                    let _ = self.docker_manager.stop_container(old).await;
                    let _ = self.docker_manager.remove_container(old).await;
                }
            }
        }

        Ok(())
    }

    async fn build_service_images(
        &self,
        app: &containr_common::models::App,
        deployment: &Deployment,
        repo_path: &Path,
        commit_sha: &str,
    ) -> anyhow::Result<HashMap<Uuid, String>> {
        let commit_prefix = if commit_sha.len() >= 8 {
            &commit_sha[..8]
        } else {
            commit_sha
        };
        let mut service_images = HashMap::new();
        let mut built_by_key: HashMap<String, String> = HashMap::new();

        for service in &app.services {
            if !service.image.is_empty() {
                service_images.insert(service.id, service.image.clone());
                continue;
            }

            let build_config = self.resolve_service_build_config(repo_path, service)?;
            let build_key = self.service_build_cache_key(service, &build_config);
            if let Some(existing_image) = built_by_key.get(&build_key) {
                service_images.insert(service.id, existing_image.clone());
                continue;
            }

            let image_name = format!(
                "containr/{}:{}-{}",
                app.id,
                commit_prefix,
                self.sanitize_image_suffix(&service.name)
            );
            let _ = self.db.append_deployment_log(
                deployment.id,
                &format!("building image for service {}", service.name),
            );
            self.image_manager
                .build_image_config_with_logs(&image_name, &build_config, |line| {
                    let _ = self.db.append_deployment_log(deployment.id, line);
                })
                .await?;

            built_by_key.insert(build_key, image_name.clone());
            service_images.insert(service.id, image_name);
        }

        Ok(service_images)
    }

    fn resolve_service_build_config(
        &self,
        repo_path: &Path,
        service: &ContainerService,
    ) -> anyhow::Result<ImageBuildConfig> {
        let context_rel = service.build_context.as_deref().unwrap_or(".");
        let context_path = repo_path.join(context_rel);
        if !context_path.exists() {
            return Err(anyhow::anyhow!(
                "build context {} does not exist for service {}",
                context_rel,
                service.name
            ));
        }
        if !context_path.is_dir() {
            return Err(anyhow::anyhow!(
                "build context {} is not a directory for service {}",
                context_rel,
                service.name
            ));
        }

        let dockerfile = match service.dockerfile_path.as_deref() {
            Some(path) => Some(self.resolve_context_dockerfile_path(context_rel, path)?),
            None => None,
        };
        if let Some(ref dockerfile) = dockerfile {
            let dockerfile_path = context_path.join(dockerfile);
            if !dockerfile_path.exists() {
                return Err(anyhow::anyhow!(
                    "dockerfile {} does not exist for service {}",
                    dockerfile,
                    service.name
                ));
            }
        }

        let build_args = service
            .build_args
            .iter()
            .map(|arg| (arg.key.clone(), arg.value.clone()))
            .collect();

        Ok(ImageBuildConfig {
            context_path: context_path.to_string_lossy().to_string(),
            dockerfile,
            target: service.build_target.clone(),
            build_args,
        })
    }

    fn resolve_context_dockerfile_path(
        &self,
        context_rel: &str,
        dockerfile_path: &str,
    ) -> anyhow::Result<String> {
        let dockerfile = Path::new(dockerfile_path);
        if context_rel == "." {
            return Ok(dockerfile_path.to_string());
        }

        let context_path = Path::new(context_rel);
        if let Ok(stripped) = dockerfile.strip_prefix(context_path) {
            return Ok(stripped.to_string_lossy().to_string());
        }

        if dockerfile.is_absolute() {
            return Err(anyhow::anyhow!("dockerfile path must be relative"));
        }

        Ok(dockerfile_path.to_string())
    }

    fn service_build_cache_key(
        &self,
        service: &ContainerService,
        build_config: &ImageBuildConfig,
    ) -> String {
        let mut build_args = service
            .build_args
            .iter()
            .map(|arg| format!("{}={}", arg.key, arg.value))
            .collect::<Vec<_>>();
        build_args.sort();

        format!(
            "{}|{}|{}|{}",
            build_config.context_path,
            build_config.dockerfile.clone().unwrap_or_default(),
            build_config.target.clone().unwrap_or_default(),
            build_args.join(";")
        )
    }

    fn sanitize_image_suffix(&self, value: &str) -> String {
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
            "service".to_string()
        } else {
            sanitized
        }
    }

    fn resolve_rollback_service_images(
        &self,
        app: &containr_common::models::App,
        source: &Deployment,
    ) -> anyhow::Result<HashMap<Uuid, String>> {
        let mut source_images = HashMap::new();
        for service_deployment in &source.service_deployments {
            if let Some(image_id) = &service_deployment.image_id {
                source_images
                    .entry(service_deployment.service_id)
                    .or_insert_with(|| image_id.clone());
            }
        }

        let mut service_images = HashMap::new();
        for service in &app.services {
            if let Some(image_id) = source_images.get(&service.id) {
                service_images.insert(service.id, image_id.clone());
                continue;
            }

            if !service.image.is_empty() {
                service_images.insert(service.id, service.image.clone());
                continue;
            }

            if let Some(image_id) = &source.image_id {
                service_images.insert(service.id, image_id.clone());
                continue;
            }

            return Err(anyhow::anyhow!(
                "rollback source missing image artifact for service {}",
                service.name
            ));
        }

        Ok(service_images)
    }

    fn primary_deployment_image_id(
        &self,
        service_images: &HashMap<Uuid, String>,
    ) -> Option<String> {
        let unique = service_images
            .values()
            .cloned()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();

        if unique.len() == 1 {
            unique.into_iter().next()
        } else {
            None
        }
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
