//! deployment worker
//!
//! processes deployment jobs from the queue, cloning repos,
//! building images, and starting containers.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use tokio::sync::mpsc;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::client::{ContainerdClient, DEFAULT_NAMESPACE, DEFAULT_SOCKET};
use crate::container::{ContainerConfig, ContainerManager, ContainerStatus};
use crate::image::ImageManager;
use znskr_common::models::{Deployment, DeploymentStatus};
use znskr_common::Database;

/// deployment job received from the api
#[derive(Debug, Clone)]
pub struct DeploymentJob {
    pub app_id: Uuid,
    pub commit_sha: String,
    pub commit_message: Option<String>,
    pub github_url: String,
    pub branch: String,
}

/// deployment worker processes jobs from the queue
pub struct DeploymentWorker {
    db: Database,
    container_manager: ContainerManager,
    image_manager: ImageManager,
    work_dir: PathBuf,
}

impl DeploymentWorker {
    // creates a new deployment worker
    pub fn new(db: Database, work_dir: PathBuf) -> anyhow::Result<Self> {
        // try to connect to containerd, fall back to stub mode
        let client = match ContainerdClient::new(DEFAULT_SOCKET, DEFAULT_NAMESPACE) {
            Ok(client) => client,
            Err(e) => {
                warn!("could not connect to containerd: {}. running in stub mode.", e);
                ContainerdClient::new_unchecked(DEFAULT_SOCKET, DEFAULT_NAMESPACE)
            }
        };

        let container_manager = ContainerManager::new(client.clone());
        let image_manager = ImageManager::new(client);

        // ensure work directory exists
        std::fs::create_dir_all(&work_dir)?;

        Ok(Self {
            db,
            container_manager,
            image_manager,
            work_dir,
        })
    }

    // runs the worker, processing jobs from the channel
    pub async fn run(self, mut rx: mpsc::Receiver<DeploymentJob>) {
        info!("deployment worker started");

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
            }
        }

        info!("deployment worker stopped");
    }

    // processes a single deployment job
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
        let image_name = format!("znskr/{}:{}", job.app_id, &job.commit_sha[..8.min(job.commit_sha.len())]);
        self.build_image(&repo_path, &image_name).await?;

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
        let _ = self.container_manager.stop_container(&container_id).await;
        let _ = self.container_manager.remove_container(&container_id).await;

        // start new container
        let config = ContainerConfig {
            id: container_id.clone(),
            image: image_name,
            env_vars,
            port: app.port,
            memory_limit: Some(512 * 1024 * 1024), // 512mb
            cpu_limit: Some(1.0),
        };

        let container_info = self.container_manager.create_container(config).await?;

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

    // clones the git repository
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

    // builds a docker image from the repository
    async fn build_image(&self, repo_path: &PathBuf, image_name: &str) -> anyhow::Result<()> {
        info!(
            path = %repo_path.display(),
            image = %image_name,
            "building docker image"
        );

        // try to use buildah or docker
        let output = if which::which("buildah").is_ok() {
            Command::new("buildah")
                .args([
                    "build",
                    "-t",
                    image_name,
                    repo_path.to_str().unwrap(),
                ])
                .output()?
        } else {
            Command::new("docker")
                .args([
                    "build",
                    "-t",
                    image_name,
                    repo_path.to_str().unwrap(),
                ])
                .output()?
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!("image build failed: {}", stderr));
        }

        Ok(())
    }

    // updates deployment status
    fn update_status(&self, deployment: &Deployment, status: DeploymentStatus) -> anyhow::Result<()> {
        let mut updated = deployment.clone();
        updated.status = status;
        updated.logs.push(format!(
            "[{}] status: {:?}",
            chrono::Utc::now(),
            status
        ));
        self.db.save_deployment(&updated)?;
        Ok(())
    }
}
