//! Database layer for containr using proper relational tables

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration as StdDuration;

use chrono::{DateTime, Utc};
use serde_json;
use sqlx::migrate::Migrator;
use sqlx::sqlite::{
    Sqlite, SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions,
    SqliteRow, SqliteSynchronous,
};
use sqlx::{Pool, Row};
use uuid::Uuid;

use crate::config::DatabaseConfig;
use crate::error::{Error, Result};
use crate::managed_services::{
    DatabaseCredentials, DatabaseType, ManagedDatabase, ManagedQueue,
    QueueCredentials, QueueType, ServiceStatus, StorageBucket,
};
use crate::models::{
    App, BuildArg, Certificate, ContainerService, Deployment, DeploymentStatus,
    EnvVar, GithubAppConfig, GithubInstallation, HealthCheck, HttpRequestLog,
    Project, RestartPolicy, RolloutStrategy, ServiceDeployment, ServiceHealth,
    ServiceMount, ServiceRegistryAuth, ServiceType, User,
};
use crate::service_inventory::{
    summarize_app_service_runtime, ServiceInventoryItem, ServiceResourceKind,
    ServiceRuntimeStatus,
};

const MIGRATOR: Migrator = sqlx::migrate!("./migrations");
const MAX_HTTP_REQUEST_LOGS_PER_SERVICE: i64 = 2000;

/// Database wrapper providing typed access through sqlite/sqlx store
#[derive(Clone)]
pub struct Database {
    store: Arc<SqliteDatabase>,
}

impl Database {
    pub fn open(config: &DatabaseConfig) -> Result<Self> {
        let store = SqliteDatabase::open(&config.sqlite_path())?;
        Ok(Self {
            store: Arc::new(store),
        })
    }

    pub fn flush(&self) -> Result<()> {
        self.store.flush()
    }

    pub fn save_user(&self, user: &User) -> Result<()> {
        self.store.save_user(user)
    }

    pub fn get_user(&self, id: Uuid) -> Result<Option<User>> {
        self.store.get_user(id)
    }

    pub fn list_users(&self) -> Result<Vec<User>> {
        self.store.list_users()
    }

    pub fn has_admin_user(&self) -> Result<bool> {
        Ok(self.list_users()?.into_iter().any(|u| u.is_admin))
    }

    pub fn get_user_by_email(&self, email: &str) -> Result<Option<User>> {
        self.store.get_user_by_email(email)
    }

    pub fn get_user_by_github_id(
        &self,
        github_id: i64,
    ) -> Result<Option<User>> {
        self.store.get_user_by_github_id(github_id)
    }

    pub fn save_app(&self, app: &App) -> Result<()> {
        self.store.save_app(app)
    }

    pub fn save_project(&self, project: &Project) -> Result<()> {
        self.save_app(project)
    }

    pub fn get_app(&self, id: Uuid) -> Result<Option<App>> {
        self.store.get_app(id)
    }

    pub fn get_project(&self, id: Uuid) -> Result<Option<Project>> {
        self.get_app(id)
    }

    pub fn list_apps(&self) -> Result<Vec<App>> {
        self.store.list_apps()
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        self.list_apps()
    }

    pub fn list_apps_by_owner(&self, owner_id: Uuid) -> Result<Vec<App>> {
        self.store.list_apps_by_owner(owner_id)
    }

    pub fn list_projects_by_owner(
        &self,
        owner_id: Uuid,
    ) -> Result<Vec<Project>> {
        self.list_apps_by_owner(owner_id)
    }

    pub fn get_app_by_domain(&self, domain: &str) -> Result<Option<App>> {
        self.store.get_app_by_domain(domain)
    }

    pub fn get_project_by_domain(
        &self,
        domain: &str,
    ) -> Result<Option<Project>> {
        self.get_app_by_domain(domain)
    }

    pub fn delete_app(&self, id: Uuid) -> Result<bool> {
        self.store.delete_app(id)
    }

    pub fn delete_project(&self, id: Uuid) -> Result<bool> {
        self.delete_app(id)
    }

    pub fn get_app_by_github_url(
        &self,
        github_url: &str,
        branch: &str,
    ) -> Result<Option<App>> {
        self.store.get_app_by_github_url(github_url, branch)
    }

    pub fn get_project_by_github_url(
        &self,
        github_url: &str,
        branch: &str,
    ) -> Result<Option<Project>> {
        self.get_app_by_github_url(github_url, branch)
    }

    pub fn save_service(&self, service: &ContainerService) -> Result<()> {
        self.store.save_service(service)
    }

    pub fn get_service(&self, id: Uuid) -> Result<Option<ContainerService>> {
        self.store.get_service(id)
    }

    pub fn list_services_by_app(
        &self,
        app_id: Uuid,
    ) -> Result<Vec<ContainerService>> {
        self.store.list_services_by_app(app_id)
    }

    pub fn delete_service(&self, id: Uuid) -> Result<bool> {
        self.store.delete_service(id)
    }

    pub fn delete_services_by_app(&self, app_id: Uuid) -> Result<usize> {
        let services = self.list_services_by_app(app_id)?;
        let count = services.len();
        for s in services {
            self.delete_service(s.id)?;
        }
        Ok(count)
    }

    pub fn save_service_deployment(
        &self,
        deployment: &ServiceDeployment,
    ) -> Result<()> {
        self.store.save_service_deployment(deployment)
    }

    pub fn get_service_deployment(
        &self,
        id: Uuid,
    ) -> Result<Option<ServiceDeployment>> {
        self.store.get_service_deployment(id)
    }

    pub fn list_service_deployments(
        &self,
        deployment_id: Uuid,
    ) -> Result<Vec<ServiceDeployment>> {
        self.store.list_service_deployments(deployment_id)
    }

    pub fn list_service_deployments_by_service(
        &self,
        service_id: Uuid,
    ) -> Result<Vec<ServiceDeployment>> {
        self.store.list_service_deployments_by_service(service_id)
    }

    pub fn save_deployment(&self, deployment: &Deployment) -> Result<()> {
        self.store.save_deployment(deployment)
    }

    pub fn get_deployment(&self, id: Uuid) -> Result<Option<Deployment>> {
        self.store.get_deployment(id)
    }

    pub fn list_deployments_by_app(
        &self,
        app_id: Uuid,
    ) -> Result<Vec<Deployment>> {
        self.store.list_deployments_by_app(app_id)
    }

    pub fn get_latest_deployment(
        &self,
        app_id: Uuid,
    ) -> Result<Option<Deployment>> {
        let deployments = self.list_deployments_by_app(app_id)?;
        Ok(deployments.into_iter().next())
    }

    pub fn delete_deployment(&self, id: Uuid) -> Result<bool> {
        self.store.delete_deployment(id)
    }

    pub fn append_deployment_log(
        &self,
        deployment_id: Uuid,
        line: &str,
    ) -> Result<()> {
        self.store.append_deployment_log(deployment_id, line)
    }

    pub fn get_deployment_logs(
        &self,
        deployment_id: Uuid,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<String>> {
        self.store.get_deployment_logs(deployment_id, limit, offset)
    }

    pub fn append_http_request_log(&self, log: &HttpRequestLog) -> Result<()> {
        self.store.append_http_request_log(log)
    }

    pub fn list_http_request_logs(
        &self,
        service_id: Uuid,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<HttpRequestLog>> {
        self.store.list_http_request_logs(service_id, limit, offset)
    }

    pub fn delete_http_request_logs(&self, service_id: Uuid) -> Result<usize> {
        self.store.delete_http_request_logs(service_id)
    }

    pub fn save_certificate(&self, cert: &Certificate) -> Result<()> {
        self.store.save_certificate(cert)
    }

    pub fn get_certificate(&self, id: Uuid) -> Result<Option<Certificate>> {
        self.store.get_certificate(id)
    }

    pub fn get_certificate_by_domain(
        &self,
        domain: &str,
    ) -> Result<Option<Certificate>> {
        self.store.get_certificate_by_domain(domain)
    }

    pub fn list_certificates(&self) -> Result<Vec<Certificate>> {
        self.store.list_certificates()
    }

    pub fn delete_certificate(&self, id: Uuid) -> Result<bool> {
        self.store.delete_certificate(id)
    }

    pub fn delete_certificate_by_domain(
        &self,
        domain: &str,
    ) -> Result<bool> {
        self.store.delete_certificate_by_domain(domain)
    }

    pub fn save_managed_database(&self, db: &ManagedDatabase) -> Result<()> {
        self.store.save_managed_database(db)
    }

    pub fn get_managed_database(
        &self,
        id: Uuid,
    ) -> Result<Option<ManagedDatabase>> {
        self.store.get_managed_database(id)
    }

    pub fn list_managed_databases_by_owner(
        &self,
        owner_id: Uuid,
    ) -> Result<Vec<ManagedDatabase>> {
        self.store.list_managed_databases_by_owner(owner_id)
    }

    pub fn delete_managed_database(&self, id: Uuid) -> Result<bool> {
        self.store.delete_managed_database(id)
    }

    pub fn save_managed_queue(&self, queue: &ManagedQueue) -> Result<()> {
        self.store.save_managed_queue(queue)
    }

    pub fn get_managed_queue(&self, id: Uuid) -> Result<Option<ManagedQueue>> {
        self.store.get_managed_queue(id)
    }

    pub fn list_managed_queues_by_owner(
        &self,
        owner_id: Uuid,
    ) -> Result<Vec<ManagedQueue>> {
        self.store.list_managed_queues_by_owner(owner_id)
    }

    pub fn delete_managed_queue(&self, id: Uuid) -> Result<bool> {
        self.store.delete_managed_queue(id)
    }

    pub fn save_storage_bucket(&self, bucket: &StorageBucket) -> Result<()> {
        self.store.save_storage_bucket(bucket)
    }

    pub fn get_storage_bucket(
        &self,
        id: Uuid,
    ) -> Result<Option<StorageBucket>> {
        self.store.get_storage_bucket(id)
    }

    pub fn list_storage_buckets_by_owner(
        &self,
        owner_id: Uuid,
    ) -> Result<Vec<StorageBucket>> {
        self.store.list_storage_buckets_by_owner(owner_id)
    }

    pub fn delete_storage_bucket(&self, id: Uuid) -> Result<bool> {
        self.store.delete_storage_bucket(id)
    }

    pub fn save_github_app(&self, app: &GithubAppConfig) -> Result<()> {
        self.store.save_github_app(app)
    }

    pub fn get_github_app(
        &self,
        owner_id: Uuid,
    ) -> Result<Option<GithubAppConfig>> {
        self.store.get_github_app(owner_id)
    }

    pub fn delete_github_app(&self, owner_id: Uuid) -> Result<bool> {
        self.store.delete_github_app(owner_id)
    }

    pub fn list_service_inventory_by_owner(
        &self,
        owner_id: Uuid,
    ) -> Result<Vec<ServiceInventoryItem>> {
        self.list_service_inventory_by_owner_and_group(owner_id, None)
    }

    pub fn list_service_inventory_by_owner_and_group(
        &self,
        owner_id: Uuid,
        group_id: Option<Uuid>,
    ) -> Result<Vec<ServiceInventoryItem>> {
        let apps = self.list_apps_by_owner(owner_id)?;
        let group_names: HashMap<Uuid, String> =
            apps.iter().map(|a| (a.id, a.name.clone())).collect();
        let mut inventory = Vec::new();

        for app in &apps {
            if let Some(gid) = group_id {
                if app.id != gid {
                    continue;
                }
            }

            let deployments = self.list_deployments_by_app(app.id)?;
            for svc in &app.services {
                let runtime = summarize_app_service_runtime(svc, &deployments);
                let image = runtime.image.clone().or_else(|| {
                    if svc.image.trim().is_empty() {
                        None
                    } else {
                        Some(svc.image.clone())
                    }
                });

                inventory.push(ServiceInventoryItem {
                    id: svc.id,
                    owner_id: app.owner_id,
                    group_id: Some(app.id),
                    project_id: Some(app.id),
                    project_name: Some(app.name.clone()),
                    resource_kind: ServiceResourceKind::AppService,
                    service_type: svc.service_type,
                    name: svc.name.clone(),
                    image,
                    status: runtime.status,
                    network_name: app.network_name(),
                    internal_host: Some(svc.name.clone()),
                    port: if svc.port == 0 { None } else { Some(svc.port) },
                    external_port: None,
                    proxy_port: None,
                    proxy_external_port: None,
                    connection_string: None,
                    proxy_connection_string: None,
                    domains: svc.custom_domains(),
                    http_only_domains: svc.http_only_domains(),
                    schedule: svc.schedule.clone(),
                    public_http: svc.is_public_http(),
                    desired_instances: runtime.desired_instances,
                    running_instances: runtime.running_instances,
                    container_ids: runtime.container_ids,
                    deployment_id: runtime.deployment_id,
                    pitr_enabled: false,
                    proxy_enabled: false,
                    created_at: svc.created_at,
                    updated_at: svc.updated_at,
                });
            }
        }

        for db in self.list_managed_databases_by_owner(owner_id)? {
            if group_id.is_some() && db.group_id != group_id {
                continue;
            }
            inventory.push(ServiceInventoryItem {
                id: db.id,
                owner_id: db.owner_id,
                group_id: db.group_id,
                project_id: db.group_id,
                project_name: db
                    .group_id
                    .and_then(|gid| group_names.get(&gid).cloned()),
                resource_kind: ServiceResourceKind::ManagedDatabase,
                service_type: db.db_type.service_type(),
                name: db.name.clone(),
                image: Some(db.docker_image()),
                status: ServiceRuntimeStatus::from_managed_status(db.status),
                network_name: db.network_name(),
                internal_host: Some(db.normalized_internal_host()),
                port: Some(db.port),
                external_port: db.external_port,
                proxy_port: db.proxy_port(),
                proxy_external_port: db.proxy_external_port,
                connection_string: Some(db.connection_string()),
                proxy_connection_string: db.proxy_connection_string(),
                domains: Vec::new(),
                http_only_domains: Vec::new(),
                schedule: None,
                public_http: false,
                desired_instances: 1,
                running_instances: if matches!(
                    db.status,
                    ServiceStatus::Running
                ) {
                    1
                } else {
                    0
                },
                container_ids: db.container_id.clone().into_iter().collect(),
                deployment_id: None,
                pitr_enabled: db.pitr_enabled,
                proxy_enabled: db.proxy_enabled,
                created_at: db.created_at,
                updated_at: db.updated_at,
            });
        }

        for queue in self.list_managed_queues_by_owner(owner_id)? {
            if group_id.is_some() && queue.group_id != group_id {
                continue;
            }
            inventory.push(ServiceInventoryItem {
                id: queue.id,
                owner_id: queue.owner_id,
                group_id: queue.group_id,
                project_id: queue.group_id,
                project_name: queue
                    .group_id
                    .and_then(|gid| group_names.get(&gid).cloned()),
                resource_kind: ServiceResourceKind::ManagedQueue,
                service_type: queue.queue_type.service_type(),
                name: queue.name.clone(),
                image: Some(queue.docker_image()),
                status: ServiceRuntimeStatus::from_managed_status(queue.status),
                network_name: queue.network_name(),
                internal_host: Some(queue.normalized_internal_host()),
                port: Some(queue.port),
                external_port: queue.external_port,
                proxy_port: None,
                proxy_external_port: None,
                connection_string: Some(queue.connection_string()),
                proxy_connection_string: None,
                domains: Vec::new(),
                http_only_domains: Vec::new(),
                schedule: None,
                public_http: false,
                desired_instances: 1,
                running_instances: if matches!(
                    queue.status,
                    ServiceStatus::Running
                ) {
                    1
                } else {
                    0
                },
                container_ids: queue.container_id.clone().into_iter().collect(),
                deployment_id: None,
                pitr_enabled: false,
                proxy_enabled: false,
                created_at: queue.created_at,
                updated_at: queue.updated_at,
            });
        }

        inventory.sort_by(|l, r| {
            let lg = l.project_name.as_deref().unwrap_or("");
            let rg = r.project_name.as_deref().unwrap_or("");
            lg.cmp(rg)
                .then_with(|| l.name.cmp(&r.name))
                .then_with(|| l.created_at.cmp(&r.created_at))
        });

        Ok(inventory)
    }

    pub fn get_service_inventory_by_id(
        &self,
        owner_id: Uuid,
        service_id: Uuid,
    ) -> Result<Option<ServiceInventoryItem>> {
        Ok(self
            .list_service_inventory_by_owner(owner_id)?
            .into_iter()
            .find(|s| s.id == service_id))
    }
}

/// SQLite database implementation
struct SqliteDatabase {
    runtime: std::sync::Mutex<Option<tokio::runtime::Runtime>>,
    pool: Pool<Sqlite>,
}

impl SqliteDatabase {
    fn open(path: &Path) -> Result<Self> {
        ensure_parent_dir(path)?;
        let runtime = std::sync::Mutex::new(Some(
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .enable_all()
                .build()
                .map_err(|e| {
                    Error::Internal(format!("failed to build runtime: {}", e))
                })?,
        ));

        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(StdDuration::from_secs(5))
            .foreign_keys(true);

        let pool = Self::run_with_runtime(&runtime, async {
            SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(options)
                .await
                .map_err(Error::from)
        })?;

        let store = Self { runtime, pool };
        store.run(async {
            MIGRATOR.run(&store.pool).await.map_err(Error::from)?;
            Ok(())
        })?;

        Ok(store)
    }

    fn run<T>(
        &self,
        future: impl Future<Output = Result<T>> + Send,
    ) -> Result<T>
    where
        T: Send,
    {
        Self::run_with_runtime(&self.runtime, future)
    }

    fn run_with_runtime<T>(
        runtime: &std::sync::Mutex<Option<tokio::runtime::Runtime>>,
        future: impl Future<Output = Result<T>> + Send,
    ) -> Result<T>
    where
        T: Send,
    {
        if tokio::runtime::Handle::try_current().is_ok() {
            std::thread::scope(|scope| {
                let task = scope.spawn(|| {
                    let runtime = runtime.lock().map_err(|_| {
                        Error::Internal("runtime mutex poisoned".to_string())
                    })?;
                    let runtime = runtime.as_ref().ok_or_else(|| {
                        Error::Internal("runtime not available".to_string())
                    })?;
                    runtime.block_on(future)
                });
                task.join().map_err(|_| {
                    Error::Internal("runtime worker panicked".to_string())
                })?
            })
        } else {
            let runtime = runtime.lock().map_err(|_| {
                Error::Internal("runtime mutex poisoned".to_string())
            })?;
            let runtime = runtime.as_ref().ok_or_else(|| {
                Error::Internal("runtime not available".to_string())
            })?;
            runtime.block_on(future)
        }
    }

    fn flush(&self) -> Result<()> {
        self.run(async {
            sqlx::query("pragma wal_checkpoint(passive);")
                .execute(&self.pool)
                .await
                .map_err(Error::from)?;
            Ok(())
        })
    }

    // ==================== USER ====================
    fn save_user(&self, user: &User) -> Result<()> {
        self.run(async {
            sqlx::query(
                r#"INSERT INTO users (id, email, password_hash, github_id, github_username, github_access_token, is_admin, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET email=excluded.email, password_hash=excluded.password_hash, github_id=excluded.github_id, github_username=excluded.github_username, github_access_token=excluded.github_access_token, is_admin=excluded.is_admin, updated_at=excluded.updated_at"#
            )
            .bind(user.id.to_string())
            .bind(&user.email)
            .bind(&user.password_hash)
            .bind(user.github_id)
            .bind(&user.github_username)
            .bind(&user.github_access_token)
            .bind(if user.is_admin { 1 } else { 0 })
            .bind(user.created_at.to_rfc3339())
            .bind(user.updated_at.to_rfc3339())
            .execute(&self.pool).await.map_err(Error::from)?;
            Ok(())
        })
    }

    fn get_user(&self, id: Uuid) -> Result<Option<User>> {
        self.run(async {
            let row = sqlx::query("SELECT * FROM users WHERE id = ?")
                .bind(id.to_string())
                .fetch_optional(&self.pool)
                .await
                .map_err(Error::from)?;
            row_to_user(row.as_ref())
        })
    }

    fn list_users(&self) -> Result<Vec<User>> {
        self.run(async {
            let rows =
                sqlx::query("SELECT * FROM users ORDER BY created_at ASC")
                    .fetch_all(&self.pool)
                    .await
                    .map_err(Error::from)?;
            let mut users = Vec::new();
            for row in rows {
                if let Some(u) = row_to_user(Some(&row))? {
                    users.push(u);
                }
            }
            Ok(users)
        })
    }

    fn get_user_by_email(&self, email: &str) -> Result<Option<User>> {
        self.run(async {
            let row = sqlx::query("SELECT * FROM users WHERE email = ?")
                .bind(email)
                .fetch_optional(&self.pool)
                .await
                .map_err(Error::from)?;
            row_to_user(row.as_ref())
        })
    }

    fn get_user_by_github_id(&self, github_id: i64) -> Result<Option<User>> {
        self.run(async {
            let row = sqlx::query("SELECT * FROM users WHERE github_id = ?")
                .bind(github_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(Error::from)?;
            row_to_user(row.as_ref())
        })
    }

    // ==================== APP ====================
    fn save_app(&self, app: &App) -> Result<()> {
        self.run(async {
            let mut tx = self.pool.begin().await.map_err(Error::from)?;

            sqlx::query(
                r#"INSERT INTO apps (id, name, github_url, branch, domains, env_vars, auto_deploy_enabled, auto_deploy_watch_paths, auto_deploy_cleanup_stale_deployments, deploy_webhook_token, port, rollout_strategy, owner_id, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET name=excluded.name, github_url=excluded.github_url, branch=excluded.branch, domains=excluded.domains, env_vars=excluded.env_vars, auto_deploy_enabled=excluded.auto_deploy_enabled, auto_deploy_watch_paths=excluded.auto_deploy_watch_paths, auto_deploy_cleanup_stale_deployments=excluded.auto_deploy_cleanup_stale_deployments, deploy_webhook_token=excluded.deploy_webhook_token, port=excluded.port, rollout_strategy=excluded.rollout_strategy, owner_id=excluded.owner_id, updated_at=excluded.updated_at"#
            )
            .bind(app.id.to_string())
            .bind(&app.name)
            .bind(&app.github_url)
            .bind(&app.branch)
            .bind(serde_json::to_string(&app.domains)?)
            .bind(serde_json::to_string(&app.env_vars)?)
            .bind(if app.auto_deploy_enabled { 1 } else { 0 })
            .bind(serde_json::to_string(&app.auto_deploy_watch_paths)?)
            .bind(if app.auto_deploy_cleanup_stale_deployments { 1 } else { 0 })
            .bind(&app.deploy_webhook_token)
            .bind(app.port as i64)
            .bind(serde_json::to_string(&app.rollout_strategy)?)
            .bind(app.owner_id.to_string())
            .bind(app.created_at.to_rfc3339())
            .bind(app.updated_at.to_rfc3339())
            .execute(&mut *tx).await.map_err(Error::from)?;

            sqlx::query("DELETE FROM services WHERE app_id = ?")
                .bind(app.id.to_string())
                .execute(&mut *tx).await.map_err(Error::from)?;

            for svc in &app.services {
                insert_service(&mut tx, svc).await?;
            }

            tx.commit().await.map_err(Error::from)?;
            Ok(())
        })
    }

    fn get_app(&self, id: Uuid) -> Result<Option<App>> {
        let mut app = self.run(async {
            let row = sqlx::query("SELECT * FROM apps WHERE id = ?")
                .bind(id.to_string())
                .fetch_optional(&self.pool)
                .await
                .map_err(Error::from)?;
            row_to_app(row.as_ref())
        })?;
        if let Some(ref mut a) = app {
            a.services = self.list_services_by_app(a.id)?;
        }
        Ok(app)
    }

    fn list_apps(&self) -> Result<Vec<App>> {
        let apps = self.run(async {
            let rows =
                sqlx::query("SELECT * FROM apps ORDER BY created_at DESC")
                    .fetch_all(&self.pool)
                    .await
                    .map_err(Error::from)?;
            let mut apps = Vec::new();
            for row in rows {
                if let Some(a) = row_to_app(Some(&row))? {
                    apps.push(a);
                }
            }
            Ok(apps)
        })?;
        let mut result = Vec::new();
        for mut a in apps {
            a.services = self.list_services_by_app(a.id)?;
            result.push(a);
        }
        Ok(result)
    }

    fn list_apps_by_owner(&self, owner_id: Uuid) -> Result<Vec<App>> {
        let apps = self.run(async {
            let rows = sqlx::query("SELECT * FROM apps WHERE owner_id = ? ORDER BY created_at DESC")
                .bind(owner_id.to_string())
                .fetch_all(&self.pool).await.map_err(Error::from)?;
            let mut apps = Vec::new();
            for row in rows {
                if let Some(a) = row_to_app(Some(&row))? {
                    apps.push(a);
                }
            }
            Ok(apps)
        })?;
        let mut result = Vec::new();
        for mut a in apps {
            a.services = self.list_services_by_app(a.id)?;
            result.push(a);
        }
        Ok(result)
    }

    fn get_app_by_domain(&self, domain: &str) -> Result<Option<App>> {
        let apps = self.list_apps()?;
        Ok(apps
            .into_iter()
            .find(|a| a.custom_domains().iter().any(|d| d == domain)))
    }

    fn delete_app(&self, id: Uuid) -> Result<bool> {
        let Some(app) = self.get_app(id)? else {
            return Ok(false);
        };
        for dep in self.list_deployments_by_app(app.id)? {
            let _ = self.delete_deployment(dep.id);
        }
        for svc in &app.services {
            let _ = self.delete_http_request_logs(svc.id);
        }
        self.run(async {
            sqlx::query("DELETE FROM apps WHERE id = ?")
                .bind(id.to_string())
                .execute(&self.pool)
                .await
                .map_err(Error::from)?;
            Ok(())
        })?;
        Ok(true)
    }

    fn get_app_by_github_url(
        &self,
        github_url: &str,
        branch: &str,
    ) -> Result<Option<App>> {
        let normalized = github_url.trim_end_matches(".git");
        let apps = self.list_apps()?;
        Ok(apps.into_iter().find(|a| {
            a.github_url.trim_end_matches(".git") == normalized
                && a.branch == branch
        }))
    }

    // ==================== SERVICE ====================
    fn save_service(&self, svc: &ContainerService) -> Result<()> {
        self.run(async {
            let health_check = svc.health_check.as_ref().map(|h| serde_json::to_string(h).unwrap_or_default());
            let registry_auth = svc.registry_auth.as_ref().map(|r| serde_json::to_string(r).unwrap_or_default());
            let command = svc.command.as_ref().map(|c| serde_json::to_string(c).unwrap_or_default());
            let entrypoint = svc.entrypoint.as_ref().map(|e| serde_json::to_string(e).unwrap_or_default());

            sqlx::query(
                r#"INSERT INTO services (id, app_id, name, image, service_type, port, expose_http, additional_ports, replicas, memory_limit, cpu_limit, depends_on, health_check, restart_policy, registry_auth, env_vars, domains, http_only_domains, build_context, dockerfile_path, build_target, build_args, command, entrypoint, working_dir, schedule, mounts, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET app_id=excluded.app_id, name=excluded.name, image=excluded.image, service_type=excluded.service_type, port=excluded.port, expose_http=excluded.expose_http, additional_ports=excluded.additional_ports, replicas=excluded.replicas, memory_limit=excluded.memory_limit, cpu_limit=excluded.cpu_limit, depends_on=excluded.depends_on, health_check=excluded.health_check, restart_policy=excluded.restart_policy, registry_auth=excluded.registry_auth, env_vars=excluded.env_vars, domains=excluded.domains, http_only_domains=excluded.http_only_domains, build_context=excluded.build_context, dockerfile_path=excluded.dockerfile_path, build_target=excluded.build_target, build_args=excluded.build_args, command=excluded.command, entrypoint=excluded.entrypoint, working_dir=excluded.working_dir, schedule=excluded.schedule, mounts=excluded.mounts, created_at=excluded.created_at, updated_at=excluded.updated_at"#
            )
            .bind(svc.id.to_string())
            .bind(svc.app_id.to_string())
            .bind(&svc.name)
            .bind(&svc.image)
            .bind(serde_json::to_string(&svc.service_type)?)
            .bind(svc.port as i64)
            .bind(if svc.expose_http { 1 } else { 0 })
            .bind(serde_json::to_string(&svc.additional_ports)?)
            .bind(svc.replicas as i64)
            .bind(svc.memory_limit.map(|m| m.to_string()))
            .bind(svc.cpu_limit.map(|c| c.to_string()))
            .bind(serde_json::to_string(&svc.depends_on)?)
            .bind(health_check)
            .bind(serde_json::to_string(&svc.restart_policy)?)
            .bind(registry_auth)
            .bind(serde_json::to_string(&svc.env_vars)?)
            .bind(serde_json::to_string(&svc.domains)?)
            .bind(serde_json::to_string(&svc.http_only_domains)?)
            .bind(&svc.build_context)
            .bind(&svc.dockerfile_path)
            .bind(&svc.build_target)
            .bind(serde_json::to_string(&svc.build_args)?)
            .bind(command)
            .bind(entrypoint)
            .bind(&svc.working_dir)
            .bind(&svc.schedule)
            .bind(serde_json::to_string(&svc.mounts)?)
            .bind(svc.created_at.to_rfc3339())
            .bind(svc.updated_at.to_rfc3339())
            .execute(&self.pool).await.map_err(Error::from)?;
            Ok(())
        })
    }

    fn get_service(&self, id: Uuid) -> Result<Option<ContainerService>> {
        self.run(async {
            let row = sqlx::query("SELECT * FROM services WHERE id = ?")
                .bind(id.to_string())
                .fetch_optional(&self.pool)
                .await
                .map_err(Error::from)?;
            row_to_service(row.as_ref())
        })
    }

    fn list_services_by_app(
        &self,
        app_id: Uuid,
    ) -> Result<Vec<ContainerService>> {
        self.run(async {
            let rows = sqlx::query(
                "SELECT * FROM services WHERE app_id = ? ORDER BY name ASC",
            )
            .bind(app_id.to_string())
            .fetch_all(&self.pool)
            .await
            .map_err(Error::from)?;
            let mut services = Vec::new();
            for row in rows {
                if let Some(s) = row_to_service(Some(&row))? {
                    services.push(s);
                }
            }
            Ok(services)
        })
    }

    fn delete_service(&self, id: Uuid) -> Result<bool> {
        let deleted = self.run(async {
            let r = sqlx::query("DELETE FROM services WHERE id = ?")
                .bind(id.to_string())
                .execute(&self.pool)
                .await
                .map_err(Error::from)?;
            Ok(r.rows_affected() > 0)
        })?;
        if deleted {
            let _ = self.delete_http_request_logs(id);
        }
        Ok(deleted)
    }

    // ==================== SERVICE DEPLOYMENT ====================
    fn save_service_deployment(&self, sd: &ServiceDeployment) -> Result<()> {
        self.run(async {
            sqlx::query(
                r#"INSERT INTO service_deployments (id, service_id, deployment_id, replica_index, status, container_id, image_id, health, logs, started_at, finished_at, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET service_id=excluded.service_id, deployment_id=excluded.deployment_id, replica_index=excluded.replica_index, status=excluded.status, container_id=excluded.container_id, image_id=excluded.image_id, health=excluded.health, logs=excluded.logs, started_at=excluded.started_at, finished_at=excluded.finished_at, created_at=excluded.created_at"#
            )
            .bind(sd.id.to_string())
            .bind(sd.service_id.to_string())
            .bind(sd.deployment_id.to_string())
            .bind(sd.replica_index as i64)
            .bind(serde_json::to_string(&sd.status)?)
            .bind(&sd.container_id)
            .bind(&sd.image_id)
            .bind(serde_json::to_string(&sd.health)?)
            .bind(serde_json::to_string(&sd.logs)?)
            .bind(sd.started_at.map(|t| t.to_rfc3339()))
            .bind(sd.finished_at.map(|t| t.to_rfc3339()))
            .bind(sd.created_at.to_rfc3339())
            .execute(&self.pool).await.map_err(Error::from)?;
            Ok(())
        })
    }

    fn get_service_deployment(
        &self,
        id: Uuid,
    ) -> Result<Option<ServiceDeployment>> {
        self.run(async {
            let row =
                sqlx::query("SELECT * FROM service_deployments WHERE id = ?")
                    .bind(id.to_string())
                    .fetch_optional(&self.pool)
                    .await
                    .map_err(Error::from)?;
            row_to_service_deployment(row.as_ref())
        })
    }

    fn list_service_deployments(
        &self,
        deployment_id: Uuid,
    ) -> Result<Vec<ServiceDeployment>> {
        self.run(async {
            let rows = sqlx::query("SELECT * FROM service_deployments WHERE deployment_id = ? ORDER BY service_id, replica_index")
                .bind(deployment_id.to_string())
                .fetch_all(&self.pool).await.map_err(Error::from)?;
            let mut sds = Vec::new();
            for row in rows {
                if let Some(s) = row_to_service_deployment(Some(&row))? {
                    sds.push(s);
                }
            }
            Ok(sds)
        })
    }

    fn list_service_deployments_by_service(
        &self,
        service_id: Uuid,
    ) -> Result<Vec<ServiceDeployment>> {
        self.run(async {
            let rows = sqlx::query("SELECT * FROM service_deployments WHERE service_id = ? ORDER BY created_at DESC")
                .bind(service_id.to_string())
                .fetch_all(&self.pool).await.map_err(Error::from)?;
            let mut sds = Vec::new();
            for row in rows {
                if let Some(s) = row_to_service_deployment(Some(&row))? {
                    sds.push(s);
                }
            }
            Ok(sds)
        })
    }

    // ==================== DEPLOYMENT ====================
    fn save_deployment(&self, dep: &Deployment) -> Result<()> {
        self.run(async {
            let mut tx = self.pool.begin().await.map_err(Error::from)?;

            sqlx::query(
                r#"INSERT INTO deployments (id, app_id, commit_sha, commit_message, branch, source_url, rollout_strategy, rollback_from_deployment_id, app_snapshot, status, container_id, image_id, started_at, finished_at, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET app_id=excluded.app_id, commit_sha=excluded.commit_sha, commit_message=excluded.commit_message, branch=excluded.branch, source_url=excluded.source_url, rollout_strategy=excluded.rollout_strategy, rollback_from_deployment_id=excluded.rollback_from_deployment_id, app_snapshot=excluded.app_snapshot, status=excluded.status, container_id=excluded.container_id, image_id=excluded.image_id, started_at=excluded.started_at, finished_at=excluded.finished_at, created_at=excluded.created_at"#
            )
            .bind(dep.id.to_string())
            .bind(dep.app_id.to_string())
            .bind(&dep.commit_sha)
            .bind(&dep.commit_message)
            .bind(&dep.branch)
            .bind(&dep.source_url)
            .bind(serde_json::to_string(&dep.rollout_strategy)?)
            .bind(dep.rollback_from_deployment_id.map(|id| id.to_string()))
            .bind(dep.app_snapshot.as_ref().map(|s| serde_json::to_string(s).unwrap_or_default()))
            .bind(serde_json::to_string(&dep.status)?)
            .bind(&dep.container_id)
            .bind(&dep.image_id)
            .bind(dep.started_at.map(|t| t.to_rfc3339()))
            .bind(dep.finished_at.map(|t| t.to_rfc3339()))
            .bind(dep.created_at.to_rfc3339())
            .execute(&mut *tx).await.map_err(Error::from)?;

            sqlx::query("DELETE FROM service_deployments WHERE deployment_id = ?")
                .bind(dep.id.to_string())
                .execute(&mut *tx).await.map_err(Error::from)?;

            for sd in &dep.service_deployments {
                sqlx::query(
                    r#"INSERT INTO service_deployments (id, service_id, deployment_id, replica_index, status, container_id, image_id, health, logs, started_at, finished_at, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET service_id=excluded.service_id, deployment_id=excluded.deployment_id, replica_index=excluded.replica_index, status=excluded.status, container_id=excluded.container_id, image_id=excluded.image_id, health=excluded.health, logs=excluded.logs, started_at=excluded.started_at, finished_at=excluded.finished_at, created_at=excluded.created_at"#
                )
                .bind(sd.id.to_string())
                .bind(sd.service_id.to_string())
                .bind(sd.deployment_id.to_string())
                .bind(sd.replica_index as i64)
                .bind(serde_json::to_string(&sd.status)?)
                .bind(&sd.container_id)
                .bind(&sd.image_id)
                .bind(serde_json::to_string(&sd.health)?)
                .bind(serde_json::to_string(&sd.logs)?)
                .bind(sd.started_at.map(|t| t.to_rfc3339()))
                .bind(sd.finished_at.map(|t| t.to_rfc3339()))
                .bind(sd.created_at.to_rfc3339())
                .execute(&mut *tx).await.map_err(Error::from)?;
            }

            tx.commit().await.map_err(Error::from)?;
            Ok(())
        })
    }

    fn get_deployment(&self, id: Uuid) -> Result<Option<Deployment>> {
        let mut dep = self.run(async {
            let row = sqlx::query("SELECT * FROM deployments WHERE id = ?")
                .bind(id.to_string())
                .fetch_optional(&self.pool)
                .await
                .map_err(Error::from)?;
            row_to_deployment(row.as_ref())
        })?;
        if let Some(ref mut d) = dep {
            d.service_deployments = self.list_service_deployments(d.id)?;
            d.logs.clear();
        }
        Ok(dep)
    }

    fn list_deployments_by_app(&self, app_id: Uuid) -> Result<Vec<Deployment>> {
        let deps = self.run(async {
            let rows = sqlx::query("SELECT * FROM deployments WHERE app_id = ? ORDER BY created_at DESC")
                .bind(app_id.to_string())
                .fetch_all(&self.pool).await.map_err(Error::from)?;
            let mut deps = Vec::new();
            for row in rows {
                if let Some(d) = row_to_deployment(Some(&row))? {
                    deps.push(d);
                }
            }
            Ok(deps)
        })?;
        let mut result = Vec::new();
        for mut d in deps {
            d.service_deployments = self.list_service_deployments(d.id)?;
            d.logs.clear();
            result.push(d);
        }
        Ok(result)
    }

    fn delete_deployment(&self, id: Uuid) -> Result<bool> {
        let deleted = self.run(async {
            let r = sqlx::query("DELETE FROM deployments WHERE id = ?")
                .bind(id.to_string())
                .execute(&self.pool)
                .await
                .map_err(Error::from)?;
            Ok(r.rows_affected() > 0)
        })?;
        if !deleted {
            return Ok(false);
        }
        self.run(async {
            sqlx::query(
                "DELETE FROM service_deployments WHERE deployment_id = ?",
            )
            .bind(id.to_string())
            .execute(&self.pool)
            .await
            .map_err(Error::from)?;
            sqlx::query("DELETE FROM deployment_logs WHERE deployment_id = ?")
                .bind(id.to_string())
                .execute(&self.pool)
                .await
                .map_err(Error::from)?;
            Ok(())
        })?;
        Ok(true)
    }

    fn append_deployment_log(
        &self,
        deployment_id: Uuid,
        line: &str,
    ) -> Result<()> {
        self.run(async {
            let mut tx = self.pool.begin().await.map_err(Error::from)?;
            let next_idx: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(idx), -1) + 1 FROM deployment_logs WHERE deployment_id = ?")
                .bind(deployment_id.to_string())
                .fetch_one(&mut *tx).await.map_err(Error::from)?;
            sqlx::query("INSERT INTO deployment_logs (deployment_id, idx, line) VALUES (?, ?, ?)")
                .bind(deployment_id.to_string())
                .bind(next_idx)
                .bind(line)
                .execute(&mut *tx).await.map_err(Error::from)?;
            tx.commit().await.map_err(Error::from)?;
            Ok(())
        })
    }

    fn get_deployment_logs(
        &self,
        deployment_id: Uuid,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<String>> {
        self.run(async {
            let rows = sqlx::query("SELECT line FROM deployment_logs WHERE deployment_id = ? ORDER BY idx ASC LIMIT ? OFFSET ?")
                .bind(deployment_id.to_string())
                .bind(limit as i64)
                .bind(offset as i64)
                .fetch_all(&self.pool).await.map_err(Error::from)?;
            rows.into_iter().map(|r| r.try_get::<String, _>("line").map_err(Error::from)).collect()
        })
    }

    // ==================== HTTP REQUEST LOG ====================
    fn append_http_request_log(&self, log: &HttpRequestLog) -> Result<()> {
        self.run(async {
            let mut tx = self.pool.begin().await.map_err(Error::from)?;
            let next_idx: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(idx), -1) + 1 FROM http_request_logs WHERE service_id = ?")
                .bind(log.service_id.to_string())
                .fetch_one(&mut *tx).await.map_err(Error::from)?;
            let value = serde_json::to_string(log)?;
            sqlx::query("INSERT INTO http_request_logs (service_id, idx, value) VALUES (?, ?, ?)")
                .bind(log.service_id.to_string())
                .bind(next_idx)
                .bind(value)
                .execute(&mut *tx).await.map_err(Error::from)?;
            sqlx::query("DELETE FROM http_request_logs WHERE service_id = ? AND idx <= (SELECT COALESCE(MAX(idx), -1) - ? FROM http_request_logs WHERE service_id = ?)")
                .bind(log.service_id.to_string())
                .bind(MAX_HTTP_REQUEST_LOGS_PER_SERVICE)
                .bind(log.service_id.to_string())
                .execute(&mut *tx).await.map_err(Error::from)?;
            tx.commit().await.map_err(Error::from)?;
            Ok(())
        })
    }

    fn list_http_request_logs(
        &self,
        service_id: Uuid,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<HttpRequestLog>> {
        self.run(async {
            let rows = sqlx::query("SELECT value FROM http_request_logs WHERE service_id = ? ORDER BY idx DESC LIMIT ? OFFSET ?")
                .bind(service_id.to_string())
                .bind(limit as i64)
                .bind(offset as i64)
                .fetch_all(&self.pool).await.map_err(Error::from)?;
            rows.into_iter().map(|r| {
                let v: String = r.try_get("value").map_err(Error::from)?;
                Ok(serde_json::from_str(&v).map_err(Error::from)?)
            }).collect()
        })
    }

    fn delete_http_request_logs(&self, service_id: Uuid) -> Result<usize> {
        self.run(async {
            let r = sqlx::query(
                "DELETE FROM http_request_logs WHERE service_id = ?",
            )
            .bind(service_id.to_string())
            .execute(&self.pool)
            .await
            .map_err(Error::from)?;
            Ok(r.rows_affected() as usize)
        })
    }

    // ==================== CERTIFICATE ====================
    fn save_certificate(&self, cert: &Certificate) -> Result<()> {
        self.run(async {
            sqlx::query(
                r#"INSERT INTO certificates (id, domain, cert_pem, key_pem, expires_at, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET domain=excluded.domain, cert_pem=excluded.cert_pem, key_pem=excluded.key_pem, expires_at=excluded.expires_at, created_at=excluded.created_at"#
            )
            .bind(cert.id.to_string())
            .bind(&cert.domain)
            .bind(&cert.cert_pem)
            .bind(&cert.key_pem)
            .bind(cert.expires_at.to_rfc3339())
            .bind(cert.created_at.to_rfc3339())
            .execute(&self.pool).await.map_err(Error::from)?;
            Ok(())
        })
    }

    fn get_certificate(&self, id: Uuid) -> Result<Option<Certificate>> {
        self.run(async {
            let row = sqlx::query("SELECT * FROM certificates WHERE id = ?")
                .bind(id.to_string())
                .fetch_optional(&self.pool)
                .await
                .map_err(Error::from)?;
            row_to_certificate(row.as_ref())
        })
    }

    fn get_certificate_by_domain(
        &self,
        domain: &str,
    ) -> Result<Option<Certificate>> {
        self.run(async {
            let row = sqlx::query(
                "SELECT * FROM certificates WHERE domain = ?",
            )
            .bind(domain)
            .fetch_optional(&self.pool)
            .await
            .map_err(Error::from)?;
            row_to_certificate(row.as_ref())
        })
    }

    fn list_certificates(&self) -> Result<Vec<Certificate>> {
        self.run(async {
            let rows =
                sqlx::query("SELECT * FROM certificates ORDER BY domain")
                    .fetch_all(&self.pool)
                    .await
                    .map_err(Error::from)?;
            let mut certs = Vec::new();
            for row in rows {
                if let Some(c) = row_to_certificate(Some(&row))? {
                    certs.push(c);
                }
            }
            Ok(certs)
        })
    }

    fn delete_certificate(&self, id: Uuid) -> Result<bool> {
        self.run(async {
            let r = sqlx::query("DELETE FROM certificates WHERE id = ?")
                .bind(id.to_string())
                .execute(&self.pool)
                .await
                .map_err(Error::from)?;
            Ok(r.rows_affected() > 0)
        })
    }

    fn delete_certificate_by_domain(&self, domain: &str) -> Result<bool> {
        self.run(async {
            let r = sqlx::query("DELETE FROM certificates WHERE domain = ?")
                .bind(domain)
                .execute(&self.pool)
                .await
                .map_err(Error::from)?;
            Ok(r.rows_affected() > 0)
        })
    }

    // ==================== MANAGED DATABASE ====================
    fn save_managed_database(&self, db: &ManagedDatabase) -> Result<()> {
        self.run(async {
            sqlx::query(
                r#"INSERT INTO managed_databases (id, owner_id, group_id, name, db_type, version, container_id, volume_name, host_data_path, internal_host, port, external_port, pitr_enabled, pitr_last_base_backup_at, pitr_last_base_backup_label, proxy_enabled, proxy_external_port, credentials, memory_limit, cpu_limit, status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, group_id=excluded.group_id, name=excluded.name, db_type=excluded.db_type, version=excluded.version, container_id=excluded.container_id, volume_name=excluded.volume_name, host_data_path=excluded.host_data_path, internal_host=excluded.internal_host, port=excluded.port, external_port=excluded.external_port, pitr_enabled=excluded.pitr_enabled, pitr_last_base_backup_at=excluded.pitr_last_base_backup_at, pitr_last_base_backup_label=excluded.pitr_last_base_backup_label, proxy_enabled=excluded.proxy_enabled, proxy_external_port=excluded.proxy_external_port, credentials=excluded.credentials, memory_limit=excluded.memory_limit, cpu_limit=excluded.cpu_limit, status=excluded.status, created_at=excluded.created_at, updated_at=excluded.updated_at"#
            )
            .bind(db.id.to_string())
            .bind(db.owner_id.to_string())
            .bind(db.group_id.map(|id| id.to_string()))
            .bind(&db.name)
            .bind(serde_json::to_string(&db.db_type)?)
            .bind(&db.version)
            .bind(&db.container_id)
            .bind(&db.volume_name)
            .bind(&db.host_data_path)
            .bind(&db.internal_host)
            .bind(db.port as i64)
            .bind(db.external_port.map(|p| p as i64))
            .bind(if db.pitr_enabled { 1 } else { 0 })
            .bind(db.pitr_last_base_backup_at.map(|t| t.to_rfc3339()))
            .bind(&db.pitr_last_base_backup_label)
            .bind(if db.proxy_enabled { 1 } else { 0 })
            .bind(db.proxy_external_port.map(|p| p as i64))
            .bind(serde_json::to_string(&db.credentials)?)
            .bind(db.memory_limit.to_string())
            .bind(db.cpu_limit.to_string())
            .bind(serde_json::to_string(&db.status)?)
            .bind(db.created_at.to_rfc3339())
            .bind(db.updated_at.to_rfc3339())
            .execute(&self.pool).await.map_err(Error::from)?;
            Ok(())
        })
    }

    fn get_managed_database(
        &self,
        id: Uuid,
    ) -> Result<Option<ManagedDatabase>> {
        self.run(async {
            let row =
                sqlx::query("SELECT * FROM managed_databases WHERE id = ?")
                    .bind(id.to_string())
                    .fetch_optional(&self.pool)
                    .await
                    .map_err(Error::from)?;
            row_to_managed_database(row.as_ref())
        })
    }

    fn list_managed_databases_by_owner(
        &self,
        owner_id: Uuid,
    ) -> Result<Vec<ManagedDatabase>> {
        self.run(async {
            let rows = sqlx::query("SELECT * FROM managed_databases WHERE owner_id = ? ORDER BY created_at DESC")
                .bind(owner_id.to_string())
                .fetch_all(&self.pool).await.map_err(Error::from)?;
            let mut dbs = Vec::new();
            for row in rows {
                if let Some(d) = row_to_managed_database(Some(&row))? {
                    dbs.push(d);
                }
            }
            Ok(dbs)
        })
    }

    fn delete_managed_database(&self, id: Uuid) -> Result<bool> {
        self.run(async {
            let r = sqlx::query("DELETE FROM managed_databases WHERE id = ?")
                .bind(id.to_string())
                .execute(&self.pool)
                .await
                .map_err(Error::from)?;
            Ok(r.rows_affected() > 0)
        })
    }

    // ==================== MANAGED QUEUE ====================
    fn save_managed_queue(&self, q: &ManagedQueue) -> Result<()> {
        self.run(async {
            sqlx::query(
                r#"INSERT INTO managed_queues (id, owner_id, group_id, name, queue_type, version, container_id, volume_name, host_data_path, internal_host, port, external_port, credentials, memory_limit, cpu_limit, status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, group_id=excluded.group_id, name=excluded.name, queue_type=excluded.queue_type, version=excluded.version, container_id=excluded.container_id, volume_name=excluded.volume_name, host_data_path=excluded.host_data_path, internal_host=excluded.internal_host, port=excluded.port, external_port=excluded.external_port, credentials=excluded.credentials, memory_limit=excluded.memory_limit, cpu_limit=excluded.cpu_limit, status=excluded.status, created_at=excluded.created_at, updated_at=excluded.updated_at"#
            )
            .bind(q.id.to_string())
            .bind(q.owner_id.to_string())
            .bind(q.group_id.map(|id| id.to_string()))
            .bind(&q.name)
            .bind(serde_json::to_string(&q.queue_type)?)
            .bind(&q.version)
            .bind(&q.container_id)
            .bind(&q.volume_name)
            .bind(&q.host_data_path)
            .bind(&q.internal_host)
            .bind(q.port as i64)
            .bind(q.external_port.map(|p| p as i64))
            .bind(serde_json::to_string(&q.credentials)?)
            .bind(q.memory_limit.to_string())
            .bind(q.cpu_limit.to_string())
            .bind(serde_json::to_string(&q.status)?)
            .bind(q.created_at.to_rfc3339())
            .bind(q.updated_at.to_rfc3339())
            .execute(&self.pool).await.map_err(Error::from)?;
            Ok(())
        })
    }

    fn get_managed_queue(&self, id: Uuid) -> Result<Option<ManagedQueue>> {
        self.run(async {
            let row = sqlx::query("SELECT * FROM managed_queues WHERE id = ?")
                .bind(id.to_string())
                .fetch_optional(&self.pool)
                .await
                .map_err(Error::from)?;
            row_to_managed_queue(row.as_ref())
        })
    }

    fn list_managed_queues_by_owner(
        &self,
        owner_id: Uuid,
    ) -> Result<Vec<ManagedQueue>> {
        self.run(async {
            let rows = sqlx::query("SELECT * FROM managed_queues WHERE owner_id = ? ORDER BY created_at DESC")
                .bind(owner_id.to_string())
                .fetch_all(&self.pool).await.map_err(Error::from)?;
            let mut qs = Vec::new();
            for row in rows {
                if let Some(q) = row_to_managed_queue(Some(&row))? {
                    qs.push(q);
                }
            }
            Ok(qs)
        })
    }

    fn delete_managed_queue(&self, id: Uuid) -> Result<bool> {
        self.run(async {
            let r = sqlx::query("DELETE FROM managed_queues WHERE id = ?")
                .bind(id.to_string())
                .execute(&self.pool)
                .await
                .map_err(Error::from)?;
            Ok(r.rows_affected() > 0)
        })
    }

    // ==================== STORAGE BUCKET ====================
    fn save_storage_bucket(&self, b: &StorageBucket) -> Result<()> {
        self.run(async {
            sqlx::query(
                r#"INSERT INTO storage_buckets (id, owner_id, name, access_key, secret_key, size_bytes, endpoint, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, name=excluded.name, access_key=excluded.access_key, secret_key=excluded.secret_key, size_bytes=excluded.size_bytes, endpoint=excluded.endpoint, created_at=excluded.created_at"#
            )
            .bind(b.id.to_string())
            .bind(b.owner_id.to_string())
            .bind(&b.name)
            .bind(&b.access_key)
            .bind(&b.secret_key)
            .bind(b.size_bytes as i64)
            .bind(&b.endpoint)
            .bind(b.created_at.to_rfc3339())
            .execute(&self.pool).await.map_err(Error::from)?;
            Ok(())
        })
    }

    fn get_storage_bucket(&self, id: Uuid) -> Result<Option<StorageBucket>> {
        self.run(async {
            let row = sqlx::query("SELECT * FROM storage_buckets WHERE id = ?")
                .bind(id.to_string())
                .fetch_optional(&self.pool)
                .await
                .map_err(Error::from)?;
            row_to_storage_bucket(row.as_ref())
        })
    }

    fn list_storage_buckets_by_owner(
        &self,
        owner_id: Uuid,
    ) -> Result<Vec<StorageBucket>> {
        self.run(async {
            let rows = sqlx::query("SELECT * FROM storage_buckets WHERE owner_id = ? ORDER BY created_at DESC")
                .bind(owner_id.to_string())
                .fetch_all(&self.pool).await.map_err(Error::from)?;
            let mut bs = Vec::new();
            for row in rows {
                if let Some(b) = row_to_storage_bucket(Some(&row))? {
                    bs.push(b);
                }
            }
            Ok(bs)
        })
    }

    fn delete_storage_bucket(&self, id: Uuid) -> Result<bool> {
        self.run(async {
            let r = sqlx::query("DELETE FROM storage_buckets WHERE id = ?")
                .bind(id.to_string())
                .execute(&self.pool)
                .await
                .map_err(Error::from)?;
            Ok(r.rows_affected() > 0)
        })
    }

    // ==================== GITHUB APP ====================
    fn save_github_app(&self, app: &GithubAppConfig) -> Result<()> {
        self.run(async {
            sqlx::query(
                r#"INSERT INTO github_apps (id, app_id, app_name, client_id, client_secret, private_key, webhook_secret, html_url, owner_id, installations, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET app_id=excluded.app_id, app_name=excluded.app_name, client_id=excluded.client_id, client_secret=excluded.client_secret, private_key=excluded.private_key, webhook_secret=excluded.webhook_secret, html_url=excluded.html_url, owner_id=excluded.owner_id, installations=excluded.installations, created_at=excluded.created_at, updated_at=excluded.updated_at"#
            )
            .bind(app.id.to_string())
            .bind(app.app_id)
            .bind(&app.app_name)
            .bind(&app.client_id)
            .bind(&app.client_secret)
            .bind(&app.private_key)
            .bind(&app.webhook_secret)
            .bind(&app.html_url)
            .bind(app.owner_id.to_string())
            .bind(serde_json::to_string(&app.installations)?)
            .bind(app.created_at.to_rfc3339())
            .bind(app.updated_at.to_rfc3339())
            .execute(&self.pool).await.map_err(Error::from)?;
            Ok(())
        })
    }

    fn get_github_app(
        &self,
        owner_id: Uuid,
    ) -> Result<Option<GithubAppConfig>> {
        self.run(async {
            let row =
                sqlx::query("SELECT * FROM github_apps WHERE owner_id = ?")
                    .bind(owner_id.to_string())
                    .fetch_optional(&self.pool)
                    .await
                    .map_err(Error::from)?;
            row_to_github_app(row.as_ref())
        })
    }

    fn delete_github_app(&self, owner_id: Uuid) -> Result<bool> {
        self.run(async {
            let r = sqlx::query("DELETE FROM github_apps WHERE owner_id = ?")
                .bind(owner_id.to_string())
                .execute(&self.pool)
                .await
                .map_err(Error::from)?;
            Ok(r.rows_affected() > 0)
        })
    }
}

// ==================== ROW HELPERS ====================
fn row_to_user(row: Option<&SqliteRow>) -> Result<Option<User>> {
    let row = match row {
        Some(r) => r,
        None => return Ok(None),
    };
    let created_at: String = row.try_get("created_at").map_err(Error::from)?;
    let updated_at: String = row.try_get("updated_at").map_err(Error::from)?;
    Ok(Some(User {
        id: Uuid::parse_str(
            &row.try_get::<String, _>("id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        email: row.try_get("email").map_err(Error::from)?,
        password_hash: row.try_get("password_hash").map_err(Error::from)?,
        github_id: row.try_get("github_id").map_err(Error::from)?,
        github_username: row.try_get("github_username").map_err(Error::from)?,
        github_access_token: row
            .try_get("github_access_token")
            .map_err(Error::from)?,
        is_admin: row.try_get::<i32, _>("is_admin").map_err(Error::from)? != 0,
        created_at: DateTime::parse_from_rfc3339(&created_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
        updated_at: DateTime::parse_from_rfc3339(&updated_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
    }))
}

fn row_to_app(row: Option<&SqliteRow>) -> Result<Option<App>> {
    let row = match row {
        Some(r) => r,
        None => return Ok(None),
    };
    let created_at: String = row.try_get("created_at").map_err(Error::from)?;
    let updated_at: String = row.try_get("updated_at").map_err(Error::from)?;
    let domains: String = row.try_get("domains").map_err(Error::from)?;
    let env_vars: String = row.try_get("env_vars").map_err(Error::from)?;
    let auto_deploy_watch_paths: String = row
        .try_get("auto_deploy_watch_paths")
        .map_err(Error::from)?;
    let deploy_webhook_token: Option<String> =
        row.try_get("deploy_webhook_token").map_err(Error::from)?;
    let port: i64 = row.try_get("port").map_err(Error::from)?;
    let rollout_strategy: String =
        row.try_get("rollout_strategy").map_err(Error::from)?;
    Ok(Some(App {
        id: Uuid::parse_str(
            &row.try_get::<String, _>("id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        name: row.try_get("name").map_err(Error::from)?,
        github_url: row.try_get("github_url").map_err(Error::from)?,
        branch: row.try_get("branch").map_err(Error::from)?,
        domains: serde_json::from_str(&domains).unwrap_or_default(),
        domain: None,
        env_vars: serde_json::from_str(&env_vars).unwrap_or_default(),
        auto_deploy_enabled: row
            .try_get::<i32, _>("auto_deploy_enabled")
            .map_err(Error::from)?
            != 0,
        auto_deploy_watch_paths: serde_json::from_str(&auto_deploy_watch_paths)
            .unwrap_or_default(),
        auto_deploy_cleanup_stale_deployments: row
            .try_get::<i32, _>("auto_deploy_cleanup_stale_deployments")
            .map_err(Error::from)?
            != 0,
        deploy_webhook_token,
        port: port as u16,
        services: Vec::new(),
        rollout_strategy: serde_json::from_str(&rollout_strategy)
            .unwrap_or_default(),
        owner_id: Uuid::parse_str(
            &row.try_get::<String, _>("owner_id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        created_at: DateTime::parse_from_rfc3339(&created_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
        updated_at: DateTime::parse_from_rfc3339(&updated_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
    }))
}

fn row_to_service(row: Option<&SqliteRow>) -> Result<Option<ContainerService>> {
    let row = match row {
        Some(r) => r,
        None => return Ok(None),
    };
    let created_at: String = row.try_get("created_at").map_err(Error::from)?;
    let updated_at: String = row.try_get("updated_at").map_err(Error::from)?;
    let additional_ports: String =
        row.try_get("additional_ports").map_err(Error::from)?;
    let memory_limit: Option<String> =
        row.try_get("memory_limit").map_err(Error::from)?;
    let cpu_limit: Option<String> =
        row.try_get("cpu_limit").map_err(Error::from)?;
    let depends_on: String = row.try_get("depends_on").map_err(Error::from)?;
    let health_check: Option<String> =
        row.try_get("health_check").map_err(Error::from)?;
    let restart_policy: String =
        row.try_get("restart_policy").map_err(Error::from)?;
    let registry_auth: Option<String> =
        row.try_get("registry_auth").map_err(Error::from)?;
    let env_vars: String = row.try_get("env_vars").map_err(Error::from)?;
    let domains: String = row.try_get("domains").map_err(Error::from)?;
    let http_only_domains: String =
        row.try_get("http_only_domains").map_err(Error::from)?;
    let build_args: String = row.try_get("build_args").map_err(Error::from)?;
    let command: Option<String> =
        row.try_get("command").map_err(Error::from)?;
    let entrypoint: Option<String> =
        row.try_get("entrypoint").map_err(Error::from)?;
    let mounts: String = row.try_get("mounts").map_err(Error::from)?;
    let service_type: String =
        row.try_get("service_type").map_err(Error::from)?;
    Ok(Some(ContainerService {
        id: Uuid::parse_str(
            &row.try_get::<String, _>("id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        app_id: Uuid::parse_str(
            &row.try_get::<String, _>("app_id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        name: row.try_get("name").map_err(Error::from)?,
        image: row.try_get("image").map_err(Error::from)?,
        service_type: serde_json::from_str(&service_type).unwrap_or_default(),
        port: row.try_get::<i64, _>("port").map_err(Error::from)? as u16,
        expose_http: row
            .try_get::<i32, _>("expose_http")
            .map_err(Error::from)?
            != 0,
        additional_ports: serde_json::from_str(&additional_ports)
            .unwrap_or_default(),
        replicas: row.try_get::<i64, _>("replicas").map_err(Error::from)?
            as u32,
        memory_limit: memory_limit.and_then(|s| s.parse::<u64>().ok()),
        cpu_limit: cpu_limit.and_then(|s| s.parse::<f64>().ok()),
        depends_on: serde_json::from_str(&depends_on).unwrap_or_default(),
        health_check: health_check.and_then(|h| serde_json::from_str(&h).ok()),
        restart_policy: serde_json::from_str(&restart_policy)
            .unwrap_or_default(),
        registry_auth: registry_auth
            .and_then(|r| serde_json::from_str(&r).ok()),
        env_vars: serde_json::from_str(&env_vars).unwrap_or_default(),
        domains: serde_json::from_str(&domains).unwrap_or_default(),
        http_only_domains: serde_json::from_str(&http_only_domains)
            .unwrap_or_default(),
        build_context: row.try_get("build_context").map_err(Error::from)?,
        dockerfile_path: row.try_get("dockerfile_path").map_err(Error::from)?,
        build_target: row.try_get("build_target").map_err(Error::from)?,
        build_args: serde_json::from_str(&build_args).unwrap_or_default(),
        command: command.and_then(|c| serde_json::from_str(&c).ok()),
        entrypoint: entrypoint.and_then(|e| serde_json::from_str(&e).ok()),
        working_dir: row.try_get("working_dir").map_err(Error::from)?,
        schedule: row.try_get("schedule").map_err(Error::from)?,
        mounts: serde_json::from_str(&mounts).unwrap_or_default(),
        created_at: DateTime::parse_from_rfc3339(&created_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
        updated_at: DateTime::parse_from_rfc3339(&updated_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
    }))
}

fn row_to_service_deployment(
    row: Option<&SqliteRow>,
) -> Result<Option<ServiceDeployment>> {
    let row = match row {
        Some(r) => r,
        None => return Ok(None),
    };
    let created_at: String = row.try_get("created_at").map_err(Error::from)?;
    let started_at: Option<String> =
        row.try_get("started_at").map_err(Error::from)?;
    let finished_at: Option<String> =
        row.try_get("finished_at").map_err(Error::from)?;
    let logs: String = row.try_get("logs").map_err(Error::from)?;
    let status: String = row.try_get("status").map_err(Error::from)?;
    let health: String = row.try_get("health").map_err(Error::from)?;
    Ok(Some(ServiceDeployment {
        id: Uuid::parse_str(
            &row.try_get::<String, _>("id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        service_id: Uuid::parse_str(
            &row.try_get::<String, _>("service_id")
                .map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        deployment_id: Uuid::parse_str(
            &row.try_get::<String, _>("deployment_id")
                .map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        replica_index: row
            .try_get::<i64, _>("replica_index")
            .map_err(Error::from)? as u32,
        status: serde_json::from_str(&status)
            .unwrap_or_else(|_| DeploymentStatus::Pending),
        container_id: row.try_get("container_id").map_err(Error::from)?,
        image_id: row.try_get("image_id").map_err(Error::from)?,
        health: serde_json::from_str(&health).unwrap_or_default(),
        logs: serde_json::from_str(&logs).unwrap_or_default(),
        started_at: started_at.and_then(|t| {
            DateTime::parse_from_rfc3339(&t)
                .ok()
                .map(|t| t.with_timezone(&Utc))
        }),
        finished_at: finished_at.and_then(|t| {
            DateTime::parse_from_rfc3339(&t)
                .ok()
                .map(|t| t.with_timezone(&Utc))
        }),
        created_at: DateTime::parse_from_rfc3339(&created_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
    }))
}

fn row_to_deployment(row: Option<&SqliteRow>) -> Result<Option<Deployment>> {
    let row = match row {
        Some(r) => r,
        None => return Ok(None),
    };
    let created_at: String = row.try_get("created_at").map_err(Error::from)?;
    let started_at: Option<String> =
        row.try_get("started_at").map_err(Error::from)?;
    let finished_at: Option<String> =
        row.try_get("finished_at").map_err(Error::from)?;
    let rollback_from_deployment_id: Option<String> = row
        .try_get("rollback_from_deployment_id")
        .map_err(Error::from)?;
    let app_snapshot: Option<String> =
        row.try_get("app_snapshot").map_err(Error::from)?;
    let commit_message: Option<String> =
        row.try_get("commit_message").map_err(Error::from)?;
    let source_url: Option<String> =
        row.try_get("source_url").map_err(Error::from)?;
    let rollout_strategy: String =
        row.try_get("rollout_strategy").map_err(Error::from)?;
    let status: String = row.try_get("status").map_err(Error::from)?;
    let container_id: Option<String> =
        row.try_get("container_id").map_err(Error::from)?;
    let image_id: Option<String> =
        row.try_get("image_id").map_err(Error::from)?;
    Ok(Some(Deployment {
        id: Uuid::parse_str(
            &row.try_get::<String, _>("id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        app_id: Uuid::parse_str(
            &row.try_get::<String, _>("app_id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        commit_sha: row.try_get("commit_sha").map_err(Error::from)?,
        commit_message,
        branch: row.try_get("branch").map_err(Error::from)?,
        source_url,
        rollout_strategy: serde_json::from_str(&rollout_strategy)
            .unwrap_or_default(),
        rollback_from_deployment_id: rollback_from_deployment_id
            .and_then(|s| Uuid::parse_str(&s).ok()),
        app_snapshot: app_snapshot.and_then(|s| serde_json::from_str(&s).ok()),
        status: serde_json::from_str(&status)
            .unwrap_or_else(|_| DeploymentStatus::Pending),
        container_id,
        image_id,
        service_deployments: Vec::new(),
        logs: Vec::new(),
        started_at: started_at.and_then(|t| {
            DateTime::parse_from_rfc3339(&t)
                .ok()
                .map(|t| t.with_timezone(&Utc))
        }),
        finished_at: finished_at.and_then(|t| {
            DateTime::parse_from_rfc3339(&t)
                .ok()
                .map(|t| t.with_timezone(&Utc))
        }),
        created_at: DateTime::parse_from_rfc3339(&created_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
    }))
}

fn row_to_certificate(row: Option<&SqliteRow>) -> Result<Option<Certificate>> {
    let row = match row {
        Some(r) => r,
        None => return Ok(None),
    };
    let expires_at: String = row.try_get("expires_at").map_err(Error::from)?;
    let created_at: String = row.try_get("created_at").map_err(Error::from)?;
    Ok(Some(Certificate {
        id: Uuid::parse_str(
            &row.try_get::<String, _>("id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        domain: row.try_get("domain").map_err(Error::from)?,
        cert_pem: row.try_get("cert_pem").map_err(Error::from)?,
        key_pem: row.try_get("key_pem").map_err(Error::from)?,
        expires_at: DateTime::parse_from_rfc3339(&expires_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
        created_at: DateTime::parse_from_rfc3339(&created_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
    }))
}

fn row_to_managed_database(
    row: Option<&SqliteRow>,
) -> Result<Option<ManagedDatabase>> {
    let row = match row {
        Some(r) => r,
        None => return Ok(None),
    };
    let created_at: String = row.try_get("created_at").map_err(Error::from)?;
    let updated_at: String = row.try_get("updated_at").map_err(Error::from)?;
    let pitr_last_base_backup_at: Option<String> = row
        .try_get("pitr_last_base_backup_at")
        .map_err(Error::from)?;
    let group_id: Option<String> =
        row.try_get("group_id").map_err(Error::from)?;
    let container_id: Option<String> =
        row.try_get("container_id").map_err(Error::from)?;
    let external_port: Option<i64> =
        row.try_get("external_port").map_err(Error::from)?;
    let pitr_last_base_backup_label: Option<String> = row
        .try_get("pitr_last_base_backup_label")
        .map_err(Error::from)?;
    let proxy_external_port: Option<i64> =
        row.try_get("proxy_external_port").map_err(Error::from)?;
    let credentials: String =
        row.try_get("credentials").map_err(Error::from)?;
    let memory_limit: String =
        row.try_get("memory_limit").map_err(Error::from)?;
    let cpu_limit: String = row.try_get("cpu_limit").map_err(Error::from)?;
    let db_type: String = row.try_get("db_type").map_err(Error::from)?;
    let status: String = row.try_get("status").map_err(Error::from)?;
    Ok(Some(ManagedDatabase {
        id: Uuid::parse_str(
            &row.try_get::<String, _>("id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        owner_id: Uuid::parse_str(
            &row.try_get::<String, _>("owner_id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        group_id: group_id.and_then(|s| Uuid::parse_str(&s).ok()),
        name: row.try_get("name").map_err(Error::from)?,
        db_type: serde_json::from_str(&db_type)
            .unwrap_or_else(|_| DatabaseType::Postgresql),
        version: row.try_get("version").map_err(Error::from)?,
        container_id,
        volume_name: row.try_get("volume_name").map_err(Error::from)?,
        host_data_path: row.try_get("host_data_path").map_err(Error::from)?,
        internal_host: row.try_get("internal_host").map_err(Error::from)?,
        port: row.try_get::<i64, _>("port").map_err(Error::from)? as u16,
        external_port: external_port.map(|p| p as u16),
        pitr_enabled: row
            .try_get::<i32, _>("pitr_enabled")
            .map_err(Error::from)?
            != 0,
        pitr_last_base_backup_at: pitr_last_base_backup_at.and_then(|t| {
            DateTime::parse_from_rfc3339(&t)
                .ok()
                .map(|t| t.with_timezone(&Utc))
        }),
        pitr_last_base_backup_label,
        proxy_enabled: row
            .try_get::<i32, _>("proxy_enabled")
            .map_err(Error::from)?
            != 0,
        proxy_external_port: proxy_external_port.map(|p| p as u16),
        credentials: serde_json::from_str(&credentials).unwrap_or_else(|_| {
            DatabaseCredentials {
                username: "".to_string(),
                password: "".to_string(),
                database_name: "".to_string(),
            }
        }),
        memory_limit: memory_limit.parse().unwrap_or_default(),
        cpu_limit: cpu_limit.parse().unwrap_or_default(),
        status: serde_json::from_str(&status)
            .unwrap_or_else(|_| ServiceStatus::Pending),
        created_at: DateTime::parse_from_rfc3339(&created_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
        updated_at: DateTime::parse_from_rfc3339(&updated_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
    }))
}

fn row_to_managed_queue(
    row: Option<&SqliteRow>,
) -> Result<Option<ManagedQueue>> {
    let row = match row {
        Some(r) => r,
        None => return Ok(None),
    };
    let created_at: String = row.try_get("created_at").map_err(Error::from)?;
    let updated_at: String = row.try_get("updated_at").map_err(Error::from)?;
    let group_id: Option<String> =
        row.try_get("group_id").map_err(Error::from)?;
    let container_id: Option<String> =
        row.try_get("container_id").map_err(Error::from)?;
    let external_port: Option<i64> =
        row.try_get("external_port").map_err(Error::from)?;
    let credentials: String =
        row.try_get("credentials").map_err(Error::from)?;
    let memory_limit: String =
        row.try_get("memory_limit").map_err(Error::from)?;
    let cpu_limit: String = row.try_get("cpu_limit").map_err(Error::from)?;
    let queue_type: String = row.try_get("queue_type").map_err(Error::from)?;
    let status: String = row.try_get("status").map_err(Error::from)?;
    Ok(Some(ManagedQueue {
        id: Uuid::parse_str(
            &row.try_get::<String, _>("id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        owner_id: Uuid::parse_str(
            &row.try_get::<String, _>("owner_id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        group_id: group_id.and_then(|s| Uuid::parse_str(&s).ok()),
        name: row.try_get("name").map_err(Error::from)?,
        queue_type: serde_json::from_str(&queue_type)
            .unwrap_or_else(|_| QueueType::Rabbitmq),
        version: row.try_get("version").map_err(Error::from)?,
        container_id,
        volume_name: row.try_get("volume_name").map_err(Error::from)?,
        host_data_path: row.try_get("host_data_path").map_err(Error::from)?,
        internal_host: row.try_get("internal_host").map_err(Error::from)?,
        port: row.try_get::<i64, _>("port").map_err(Error::from)? as u16,
        external_port: external_port.map(|p| p as u16),
        credentials: serde_json::from_str(&credentials).unwrap_or_else(|_| {
            QueueCredentials {
                username: "".to_string(),
                password: "".to_string(),
            }
        }),
        memory_limit: memory_limit.parse().unwrap_or_default(),
        cpu_limit: cpu_limit.parse().unwrap_or_default(),
        status: serde_json::from_str(&status)
            .unwrap_or_else(|_| ServiceStatus::Pending),
        created_at: DateTime::parse_from_rfc3339(&created_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
        updated_at: DateTime::parse_from_rfc3339(&updated_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
    }))
}

fn row_to_storage_bucket(
    row: Option<&SqliteRow>,
) -> Result<Option<StorageBucket>> {
    let row = match row {
        Some(r) => r,
        None => return Ok(None),
    };
    let created_at: String = row.try_get("created_at").map_err(Error::from)?;
    let size_bytes: i64 = row.try_get("size_bytes").map_err(Error::from)?;
    Ok(Some(StorageBucket {
        id: Uuid::parse_str(
            &row.try_get::<String, _>("id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        owner_id: Uuid::parse_str(
            &row.try_get::<String, _>("owner_id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        name: row.try_get("name").map_err(Error::from)?,
        access_key: row.try_get("access_key").map_err(Error::from)?,
        secret_key: row.try_get("secret_key").map_err(Error::from)?,
        size_bytes: size_bytes as u64,
        endpoint: row.try_get("endpoint").map_err(Error::from)?,
        created_at: DateTime::parse_from_rfc3339(&created_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
    }))
}

fn row_to_github_app(
    row: Option<&SqliteRow>,
) -> Result<Option<GithubAppConfig>> {
    let row = match row {
        Some(r) => r,
        None => return Ok(None),
    };
    let created_at: String = row.try_get("created_at").map_err(Error::from)?;
    let updated_at: String = row.try_get("updated_at").map_err(Error::from)?;
    let installations: String =
        row.try_get("installations").map_err(Error::from)?;
    Ok(Some(GithubAppConfig {
        id: Uuid::parse_str(
            &row.try_get::<String, _>("id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        app_id: row.try_get::<i64, _>("app_id").map_err(Error::from)?,
        app_name: row.try_get("app_name").map_err(Error::from)?,
        client_id: row.try_get("client_id").map_err(Error::from)?,
        client_secret: row.try_get("client_secret").map_err(Error::from)?,
        private_key: row.try_get("private_key").map_err(Error::from)?,
        webhook_secret: row.try_get("webhook_secret").map_err(Error::from)?,
        html_url: row.try_get("html_url").map_err(Error::from)?,
        owner_id: Uuid::parse_str(
            &row.try_get::<String, _>("owner_id").map_err(Error::from)?,
        )
        .map_err(|e| Error::Internal(e.to_string()))?,
        installations: serde_json::from_str(&installations).unwrap_or_default(),
        created_at: DateTime::parse_from_rfc3339(&created_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
        updated_at: DateTime::parse_from_rfc3339(&updated_at)
            .map_err(|e| Error::Internal(e.to_string()))?
            .with_timezone(&Utc),
    }))
}

async fn insert_service(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    svc: &ContainerService,
) -> Result<()> {
    let health_check = svc
        .health_check
        .as_ref()
        .map(|h| serde_json::to_string(h).unwrap_or_default());
    let registry_auth = svc
        .registry_auth
        .as_ref()
        .map(|r| serde_json::to_string(r).unwrap_or_default());
    let command = svc
        .command
        .as_ref()
        .map(|c| serde_json::to_string(c).unwrap_or_default());
    let entrypoint = svc
        .entrypoint
        .as_ref()
        .map(|e| serde_json::to_string(e).unwrap_or_default());

    sqlx::query(
        r#"INSERT INTO services (id, app_id, name, image, service_type, port, expose_http, additional_ports, replicas, memory_limit, cpu_limit, depends_on, health_check, restart_policy, registry_auth, env_vars, domains, http_only_domains, build_context, dockerfile_path, build_target, build_args, command, entrypoint, working_dir, schedule, mounts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET app_id=excluded.app_id, name=excluded.name, image=excluded.image, service_type=excluded.service_type, port=excluded.port, expose_http=excluded.expose_http, additional_ports=excluded.additional_ports, replicas=excluded.replicas, memory_limit=excluded.memory_limit, cpu_limit=excluded.cpu_limit, depends_on=excluded.depends_on, health_check=excluded.health_check, restart_policy=excluded.restart_policy, registry_auth=excluded.registry_auth, env_vars=excluded.env_vars, domains=excluded.domains, http_only_domains=excluded.http_only_domains, build_context=excluded.build_context, dockerfile_path=excluded.dockerfile_path, build_target=excluded.build_target, build_args=excluded.build_args, command=excluded.command, entrypoint=excluded.entrypoint, working_dir=excluded.working_dir, schedule=excluded.schedule, mounts=excluded.mounts, created_at=excluded.created_at, updated_at=excluded.updated_at"#
    )
    .bind(svc.id.to_string())
    .bind(svc.app_id.to_string())
    .bind(&svc.name)
    .bind(&svc.image)
    .bind(serde_json::to_string(&svc.service_type)?)
    .bind(svc.port as i64)
    .bind(if svc.expose_http { 1 } else { 0 })
    .bind(serde_json::to_string(&svc.additional_ports)?)
    .bind(svc.replicas as i64)
    .bind(svc.memory_limit.map(|m| m.to_string()))
    .bind(svc.cpu_limit.map(|c| c.to_string()))
    .bind(serde_json::to_string(&svc.depends_on)?)
    .bind(health_check)
    .bind(serde_json::to_string(&svc.restart_policy)?)
    .bind(registry_auth)
    .bind(serde_json::to_string(&svc.env_vars)?)
    .bind(serde_json::to_string(&svc.domains)?)
    .bind(serde_json::to_string(&svc.http_only_domains)?)
    .bind(&svc.build_context)
    .bind(&svc.dockerfile_path)
    .bind(&svc.build_target)
    .bind(serde_json::to_string(&svc.build_args)?)
    .bind(command)
    .bind(entrypoint)
    .bind(&svc.working_dir)
    .bind(&svc.schedule)
    .bind(serde_json::to_string(&svc.mounts)?)
    .bind(svc.created_at.to_rfc3339())
    .bind(svc.updated_at.to_rfc3339())
    .execute(&mut **tx).await.map_err(Error::from)?;
    Ok(())
}

impl Drop for SqliteDatabase {
    fn drop(&mut self) {
        if let Ok(mut runtime) = self.runtime.lock() {
            if let Some(runtime) = runtime.take() {
                runtime.shutdown_background();
            }
        }
    }
}

fn ensure_parent_dir(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                Error::Internal(format!(
                    "failed to create database directory: {}",
                    e
                ))
            })?;
        }
    }
    Ok(())
}
