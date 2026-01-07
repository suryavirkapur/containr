//! deployment worker
//!
//! processes deployment jobs from the queue, cloning repos,
//! building images, and starting containers.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use crate::docker::{DockerContainerConfig, DockerContainerManager};
use crate::image::ImageManager;
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
}

impl DeploymentWorker {
    /// creates a new deployment worker using Docker for containers
    pub async fn new(db: Database, work_dir: PathBuf) -> anyhow::Result<Self> {
        // Use Docker for container management (simpler than containerd tasks)
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
        })
    }

    /// creates a worker in stub mode (for development without docker)
    pub fn new_stub(db: Database, work_dir: PathBuf) -> anyhow::Result<Self> {
        warn!("deployment worker starting in stub mode");

        // ensure work directory exists
        std::fs::create_dir_all(&work_dir)?;

        Ok(Self {
            db,
            docker_manager: DockerContainerManager::new_stub(),
            image_manager: ImageManager::new_stub(),
            work_dir,
            stub_mode: true,
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

        // prepare env vars
        let mut env_vars = HashMap::new();
        for env in &app.env_vars {
            env_vars.insert(env.key.clone(), env.value.clone());
        }
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
        };

        let container_info = self.docker_manager.create_container(config).await?;

        // update deployment with container info
        let mut updated_deployment = deployment.clone();
        updated_deployment.status = DeploymentStatus::Running;
        updated_deployment.container_id = Some(container_info.id);
        updated_deployment.started_at = Some(chrono::Utc::now());
        self.db.save_deployment(&updated_deployment)?;

        info!(
            app_id = %job.app_id,
            deployment_id = %deployment_id,
            "deployment completed successfully"
        );

        // cleanup repo directory
        let _ = tokio::fs::remove_dir_all(&repo_path).await;

        Ok(())
    }

    /// clones the git repository
    async fn clone_repo(&self, job: &DeploymentJob) -> anyhow::Result<PathBuf> {
        let commit_prefix = if job.commit_sha.len() >= 8 {
            &job.commit_sha[..8]
        } else {
            &job.commit_sha
        };
        let repo_path = self.work_dir.join(format!("{}_{}", job.app_id, commit_prefix));

        // remove if exists
        let _ = tokio::fs::remove_dir_all(&repo_path).await;

        info!(
            url = %job.github_url,
            branch = %job.branch,
            path = %repo_path.display(),
            "cloning repository"
        );

        // clone with depth 1 for speed
        let output = Command::new("git")
            .args([
                "clone",
                "--depth",
                "1",
                "--branch",
                &job.branch,
                &job.github_url,
                repo_path.to_str().unwrap(),
            ])
            .output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!("git clone failed: {}", stderr));
        }

        Ok(repo_path)
    }

    /// updates deployment status
    fn update_status(&self, deployment: &Deployment, status: DeploymentStatus) -> anyhow::Result<()> {
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
}
