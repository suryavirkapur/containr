//! deployment worker
//!
//! processes deployment jobs from the queue, cloning repos,
//! building images, and starting containers.

use std::collections::HashMap;
use std::path::PathBuf;

use git2::build::RepoBuilder;
use git2::FetchOptions;
use tokio::sync::mpsc;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::docker::{DockerContainerConfig, DockerContainerManager};
use crate::image::ImageManager;
use crate::route_updates::ProxyRouteUpdate;
use znskr_common::models::{Deployment, DeploymentStatus};
use znskr_common::Database;

// use shared type from common
use znskr_common::models::DeploymentJob;

/// deployment worker processes jobs from the queue
pub struct DeploymentWorker {
    db: Database,
    docker_manager: DockerContainerManager,
    image_manager: ImageManager,
    work_dir: PathBuf,
    stub_mode: bool,
    proxy_updates: Option<mpsc::Sender<ProxyRouteUpdate>>,
}

impl DeploymentWorker {
    /// creates a new deployment worker using Docker for containers
    pub async fn new(
        db: Database,
        work_dir: PathBuf,
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
            stub_mode,
            proxy_updates,
        })
    }

    /// creates a worker in stub mode (for development without docker)
    pub fn new_stub(
        db: Database,
        work_dir: PathBuf,
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
                if let Ok(Some(mut deployment)) = self.db.get_latest_deployment(job.app_id) {
                    deployment.status = DeploymentStatus::Failed;
                    deployment.logs.push(format!("error: {}", e));
                    let _ = self.db.save_deployment(&deployment);
                }
            }
        }

        info!("deployment worker stopped");
    }

    /// processes a single deployment job
    async fn process_job(&self, job: &DeploymentJob) -> anyhow::Result<()> {
        // get the latest deployment for this app
        let deployment = self
            .db
            .get_latest_deployment(job.app_id)?
            .ok_or_else(|| anyhow::anyhow!("deployment not found"))?;

        let deployment_id = deployment.id;

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
        let image_name = format!("znskr/{}:{}", job.app_id, commit_prefix);

        self.image_manager
            .build_image(&image_name, repo_path.to_str().unwrap(), None)
            .await?;

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
        let network_name = format!("znskr-{}", job.app_id);
        self.docker_manager.create_network(&network_name).await?;

        // check if app uses new multi-service model
        if app.has_services() {
            // multi-container deployment
            self.deploy_services(&app, &deployment, &network_name, &image_name, &env_vars).await?;
        } else {
            // legacy single-container deployment (backward compat)
            env_vars.insert("PORT".to_string(), app.port.to_string());

            // stop existing container if running
            let container_id = format!("znskr-{}", job.app_id);
            let _ = self.docker_manager.stop_container(&container_id).await;
            let _ = self.docker_manager.remove_container(&container_id).await;

            // start new container using Docker
            let config = DockerContainerConfig {
                id: container_id.clone(),
                image: image_name,
                env_vars,
                port: app.port,
                memory_limit: Some(512 * 1024 * 1024), // 512mb
                cpu_limit: Some(1.0),
                network: Some(network_name),
                health_check: None,
                restart_policy: "unless-stopped".to_string(),
            };

            let container_info = self.docker_manager.create_container(config).await?;

            // update deployment with container info
            let mut updated_deployment = deployment.clone();
            updated_deployment.status = DeploymentStatus::Running;
            updated_deployment.container_id = Some(container_info.id);
            updated_deployment.started_at = Some(chrono::Utc::now());
            self.db.save_deployment(&updated_deployment)?;

            self.send_proxy_refresh(app.id).await;
        }

        info!(
            app_id = %job.app_id,
            deployment_id = %deployment_id,
            "deployment completed successfully"
        );

        // cleanup repo directory
        let _ = tokio::fs::remove_dir_all(&repo_path).await;

        Ok(())
    }

    /// deploys multi-container services with dependency ordering
    async fn deploy_services(
        &self,
        app: &znskr_common::models::App,
        deployment: &Deployment,
        network_name: &str,
        image_name: &str,
        shared_env_vars: &HashMap<String, String>,
    ) -> anyhow::Result<()> {
        use znskr_common::models::{ServiceDeployment, RestartPolicy};

        // topological sort services by dependencies
        let sorted_services = self.topological_sort_services(&app.services)?;

        let mut service_deployments = Vec::new();

        for service in sorted_services {
            info!(
                service = %service.name,
                replicas = %service.replicas,
                "deploying service"
            );

            // deploy each replica
            for replica_idx in 0..service.replicas {
                let container_id = format!("znskr-{}-{}-{}", app.id, service.name, replica_idx);

                // stop existing container if running
                let _ = self.docker_manager.stop_container(&container_id).await;
                let _ = self.docker_manager.remove_container(&container_id).await;

                // merge shared env vars with service-specific PORT
                let mut env_vars = shared_env_vars.clone();
                env_vars.insert("PORT".to_string(), service.port.to_string());
                env_vars.insert("SERVICE_NAME".to_string(), service.name.clone());
                env_vars.insert("REPLICA_INDEX".to_string(), replica_idx.to_string());

                // convert health check if configured
                let health_check = service.health_check.as_ref().map(|hc| {
                    crate::docker::HealthCheckCommand {
                        cmd: vec![
                            "curl".to_string(),
                            "-f".to_string(),
                            format!("http://localhost:{}{}", service.port, hc.path),
                        ],
                        interval_secs: hc.interval_secs,
                        timeout_secs: hc.timeout_secs,
                        retries: hc.retries,
                    }
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

                let config = DockerContainerConfig {
                    id: container_id.clone(),
                    image: service_image,
                    env_vars,
                    port: service.port,
                    memory_limit: service.memory_limit,
                    cpu_limit: service.cpu_limit,
                    network: Some(network_name.to_string()),
                    health_check,
                    restart_policy,
                };

                let container_info = self.docker_manager.create_container(config).await?;

                // wait for dependencies to be healthy before continuing
                if service.health_check.is_some() {
                    let _ = self.docker_manager.wait_for_healthy(&container_id, 60).await;
                }

                // create service deployment record
                let mut sd = ServiceDeployment::new(service.id, deployment.id, replica_idx);
                sd.container_id = Some(container_info.id);
                sd.status = znskr_common::models::DeploymentStatus::Running;
                sd.started_at = Some(chrono::Utc::now());

                self.db.save_service_deployment(&sd)?;
                service_deployments.push(sd);

                self.send_proxy_refresh(app.id).await;
            }
        }

        // update main deployment
        let mut updated_deployment = deployment.clone();
        updated_deployment.status = znskr_common::models::DeploymentStatus::Running;
        updated_deployment.service_deployments = service_deployments;
        updated_deployment.started_at = Some(chrono::Utc::now());
        self.db.save_deployment(&updated_deployment)?;

        Ok(())
    }

    /// topological sort services by dependencies
    fn topological_sort_services(
        &self,
        services: &[znskr_common::models::ContainerService],
    ) -> anyhow::Result<Vec<znskr_common::models::ContainerService>> {
        use std::collections::{HashSet, VecDeque};

        let name_to_service: HashMap<String, &znskr_common::models::ContainerService> =
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

        info!(
            url = %job.github_url,
            branch = %job.branch,
            path = %repo_path.display(),
            "cloning repository"
        );

        // clone with shallow depth using git2
        // git2 is synchronous, so we spawn_blocking
        let url = job.github_url.clone();
        let branch = job.branch.clone();
        let path = repo_path.clone();

        tokio::task::spawn_blocking(move || {
            let mut fetch_opts = FetchOptions::new();
            fetch_opts.depth(1);

            RepoBuilder::new()
                .branch(&branch)
                .fetch_options(fetch_opts)
                .clone(&url, &path)
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
        updated.status = status.clone();
        updated.logs.push(format!(
            "[{}] status: {:?}",
            chrono::Utc::now().format("%Y-%m-%d %H:%M:%S"),
            status
        ));
        self.db.save_deployment(&updated)?;
        Ok(())
    }

    async fn send_proxy_refresh(&self, app_id: Uuid) {
        if let Some(sender) = &self.proxy_updates {
            let _ = sender
                .send(ProxyRouteUpdate::RefreshApp { app_id })
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use znskr_common::models::ContainerService;

    fn make_worker() -> DeploymentWorker {
        let root = std::env::temp_dir().join(format!("znskr-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let db_path = root.join("znskr.db");
        let db = Database::open(db_path.to_str().unwrap()).unwrap();
        let work_dir = root.join("work");
        DeploymentWorker::new_stub(db, work_dir, None).unwrap()
    }

    #[test]
    fn topological_sort_orders_dependencies() {
        let worker = make_worker();
        let app_id = Uuid::new_v4();

        let web = ContainerService::new(app_id, "web".to_string(), "".to_string(), 8080);
        let mut api = ContainerService::new(app_id, "api".to_string(), "".to_string(), 8081);
        api.depends_on = vec!["web".to_string()];

        let sorted = worker.topological_sort_services(&[api.clone(), web.clone()]).unwrap();
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
}
