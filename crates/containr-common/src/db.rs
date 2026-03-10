//! metadata database access for containr

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration as StdDuration;

use serde::{de::DeserializeOwned, Serialize};
use sqlx::migrate::Migrator;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions,
    SqliteSynchronous,
};
use sqlx::{Pool, Row, Sqlite};
use uuid::Uuid;

use crate::config::DatabaseConfig;
use crate::error::{Error, Result};
use crate::managed_services::{
    ManagedDatabase, ManagedQueue, ServiceStatus, StorageBucket,
};
use crate::models::{
    App, Certificate, ContainerService, Deployment, GithubAppConfig, Project,
    ServiceDeployment,
};
use crate::service_inventory::{
    summarize_app_service_runtime, ServiceInventoryItem, ServiceResourceKind,
    ServiceRuntimeStatus,
};

const USERS_TABLE: &str = "metadata_users";
const APPS_TABLE: &str = "metadata_apps";
const SERVICES_TABLE: &str = "metadata_services";
const SERVICE_DEPLOYMENTS_TABLE: &str = "metadata_service_deployments";
const DEPLOYMENTS_TABLE: &str = "metadata_deployments";
const DEPLOYMENT_LOGS_TABLE: &str = "metadata_deployment_logs";
const CERTIFICATES_TABLE: &str = "metadata_certificates";
const MANAGED_DATABASES_TABLE: &str = "metadata_managed_databases";
const MANAGED_QUEUES_TABLE: &str = "metadata_managed_queues";
const STORAGE_BUCKETS_TABLE: &str = "metadata_storage_buckets";
const GITHUB_APPS_TABLE: &str = "metadata_github_apps";

const MIGRATOR: Migrator = sqlx::migrate!("./sqlx_migrations");

fn safe_sql(statement: String) -> sqlx::AssertSqlSafe<String> {
    sqlx::AssertSqlSafe(statement)
}

/// database wrapper providing typed access through a sqlite/sqlx store
#[derive(Clone)]
pub struct Database {
    store: Arc<SqliteJsonDatabase>,
}

impl Database {
    pub fn open(config: &DatabaseConfig) -> Result<Self> {
        let store = SqliteJsonDatabase::open(&config.sqlite_path())?;
        Ok(Self {
            store: Arc::new(store),
        })
    }

    pub fn flush(&self) -> Result<()> {
        self.store.flush()
    }

    pub fn save_user(&self, user: &crate::models::User) -> Result<()> {
        self.store.save_user(user)
    }

    pub fn get_user(&self, id: Uuid) -> Result<Option<crate::models::User>> {
        self.store.get_user(id)
    }

    pub fn list_users(&self) -> Result<Vec<crate::models::User>> {
        self.store.list_users()
    }

    pub fn has_admin_user(&self) -> Result<bool> {
        Ok(self.list_users()?.into_iter().any(|user| user.is_admin))
    }

    pub fn get_user_by_email(
        &self,
        email: &str,
    ) -> Result<Option<crate::models::User>> {
        self.store.get_user_by_email(email)
    }

    pub fn get_user_by_github_id(
        &self,
        github_id: i64,
    ) -> Result<Option<crate::models::User>> {
        self.store.get_user_by_github_id(github_id)
    }

    pub fn save_app(&self, app: &App) -> Result<()> {
        self.store.save_app(&app.normalized_for_service_model())
    }

    pub fn save_project(&self, project: &Project) -> Result<()> {
        self.save_app(project)
    }

    pub fn get_app(&self, id: Uuid) -> Result<Option<App>> {
        Ok(self
            .store
            .get_app(id)?
            .map(|app| app.normalized_for_service_model()))
    }

    pub fn get_project(&self, id: Uuid) -> Result<Option<Project>> {
        self.get_app(id)
    }

    pub fn list_apps(&self) -> Result<Vec<App>> {
        Ok(self
            .store
            .list_apps()?
            .into_iter()
            .map(|app| app.normalized_for_service_model())
            .collect())
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        self.list_apps()
    }

    pub fn list_apps_by_owner(&self, owner_id: Uuid) -> Result<Vec<App>> {
        Ok(self
            .store
            .list_apps_by_owner(owner_id)?
            .into_iter()
            .map(|app| app.normalized_for_service_model())
            .collect())
    }

    pub fn list_projects_by_owner(
        &self,
        owner_id: Uuid,
    ) -> Result<Vec<Project>> {
        self.list_apps_by_owner(owner_id)
    }

    pub fn get_app_by_domain(&self, domain: &str) -> Result<Option<App>> {
        Ok(self
            .store
            .get_app_by_domain(domain)?
            .map(|app| app.normalized_for_service_model()))
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
        Ok(self
            .store
            .get_app_by_github_url(github_url, branch)?
            .map(|app| app.normalized_for_service_model()))
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
        for service in services {
            self.delete_service(service.id)?;
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
        log_line: &str,
    ) -> Result<()> {
        self.store.append_deployment_log(deployment_id, log_line)
    }

    pub fn get_deployment_logs(
        &self,
        deployment_id: Uuid,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<String>> {
        self.store.get_deployment_logs(deployment_id, limit, offset)
    }

    pub fn save_certificate(&self, cert: &Certificate) -> Result<()> {
        self.store.save_certificate(cert)
    }

    pub fn get_certificate(&self, domain: &str) -> Result<Option<Certificate>> {
        self.store.get_certificate(domain)
    }

    pub fn list_certificates(&self) -> Result<Vec<Certificate>> {
        self.store.list_certificates()
    }

    pub fn delete_certificate(&self, domain: &str) -> Result<bool> {
        self.store.delete_certificate(domain)
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
        let group_names = apps
            .iter()
            .map(|app| (app.id, app.name.clone()))
            .collect::<HashMap<_, _>>();
        let mut inventory = Vec::new();

        for app in &apps {
            if let Some(filter_group_id) = group_id {
                if app.id != filter_group_id {
                    continue;
                }
            }

            let deployments = self.list_deployments_by_app(app.id)?;
            for service in &app.services {
                let runtime =
                    summarize_app_service_runtime(service, &deployments);
                let image = runtime.image.clone().or_else(|| {
                    if service.image.trim().is_empty() {
                        None
                    } else {
                        Some(service.image.clone())
                    }
                });

                inventory.push(ServiceInventoryItem {
                    id: service.id,
                    owner_id: app.owner_id,
                    group_id: Some(app.id),
                    project_id: Some(app.id),
                    project_name: Some(app.name.clone()),
                    resource_kind: ServiceResourceKind::AppService,
                    service_type: service.service_type,
                    name: service.name.clone(),
                    image,
                    status: runtime.status,
                    network_name: app.network_name(),
                    internal_host: Some(service.name.clone()),
                    port: if service.port == 0 {
                        None
                    } else {
                        Some(service.port)
                    },
                    external_port: None,
                    proxy_port: None,
                    proxy_external_port: None,
                    connection_string: None,
                    proxy_connection_string: None,
                    domains: service.custom_domains(),
                    schedule: service.schedule.clone(),
                    public_http: service.is_public_http(),
                    desired_instances: runtime.desired_instances,
                    running_instances: runtime.running_instances,
                    container_ids: runtime.container_ids,
                    deployment_id: runtime.deployment_id,
                    pitr_enabled: false,
                    proxy_enabled: false,
                    created_at: service.created_at,
                    updated_at: service.updated_at,
                });
            }
        }

        for database in self.list_managed_databases_by_owner(owner_id)? {
            if group_id.is_some() && database.group_id != group_id {
                continue;
            }

            inventory.push(ServiceInventoryItem {
                id: database.id,
                owner_id: database.owner_id,
                group_id: database.group_id,
                project_id: database.group_id,
                project_name: database
                    .group_id
                    .and_then(|value| group_names.get(&value).cloned()),
                resource_kind: ServiceResourceKind::ManagedDatabase,
                service_type: database.db_type.service_type(),
                name: database.name.clone(),
                image: Some(database.docker_image()),
                status: ServiceRuntimeStatus::from_managed_status(
                    database.status,
                ),
                network_name: database.network_name(),
                internal_host: Some(database.normalized_internal_host()),
                port: Some(database.port),
                external_port: database.external_port,
                proxy_port: database.proxy_port(),
                proxy_external_port: database.proxy_external_port,
                connection_string: Some(database.connection_string()),
                proxy_connection_string: database.proxy_connection_string(),
                domains: Vec::new(),
                schedule: None,
                public_http: false,
                desired_instances: 1,
                running_instances: if matches!(
                    database.status,
                    ServiceStatus::Running
                ) {
                    1
                } else {
                    0
                },
                container_ids: database
                    .container_id
                    .clone()
                    .into_iter()
                    .collect(),
                deployment_id: None,
                pitr_enabled: database.pitr_enabled,
                proxy_enabled: database.proxy_enabled,
                created_at: database.created_at,
                updated_at: database.updated_at,
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
                    .and_then(|value| group_names.get(&value).cloned()),
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

        inventory.sort_by(|left, right| {
            let left_group = left.project_name.as_deref().unwrap_or("");
            let right_group = right.project_name.as_deref().unwrap_or("");

            left_group
                .cmp(right_group)
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.created_at.cmp(&right.created_at))
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
            .find(|service| service.id == service_id))
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
}

struct SqliteJsonDatabase {
    runtime: std::sync::Mutex<Option<tokio::runtime::Runtime>>,
    pool: Pool<Sqlite>,
}

impl SqliteJsonDatabase {
    fn open(path: &Path) -> Result<Self> {
        ensure_parent_dir(path)?;
        let runtime = std::sync::Mutex::new(Some(
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .enable_all()
                .build()
                .map_err(|error| {
                    Error::Internal(format!(
                        "failed to build sqlite runtime: {}",
                        error
                    ))
                })?,
        ));

        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .map_err(Error::from)?
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(StdDuration::from_secs(5))
            .foreign_keys(true);

        let pool = run_with_runtime(&runtime, async {
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
        run_with_runtime(&self.runtime, future)
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

    fn save_user(&self, user: &crate::models::User) -> Result<()> {
        self.put_json(USERS_TABLE, &user.id.to_string(), user)
    }

    fn get_user(&self, id: Uuid) -> Result<Option<crate::models::User>> {
        self.get_json(USERS_TABLE, &id.to_string())
    }

    fn list_users(&self) -> Result<Vec<crate::models::User>> {
        let mut users: Vec<crate::models::User> =
            self.list_json(USERS_TABLE)?;
        users.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        Ok(users)
    }

    fn get_user_by_email(
        &self,
        email: &str,
    ) -> Result<Option<crate::models::User>> {
        Ok(self
            .list_users()?
            .into_iter()
            .find(|user| user.email == email))
    }

    fn get_user_by_github_id(
        &self,
        github_id: i64,
    ) -> Result<Option<crate::models::User>> {
        Ok(self
            .list_users()?
            .into_iter()
            .find(|user| user.github_id == Some(github_id)))
    }

    fn save_app(&self, app: &App) -> Result<()> {
        self.run(async {
            let mut tx = self.pool.begin().await.map_err(Error::from)?;
            let mut app_record = app.clone();
            app_record.services.clear();
            let value = serde_json::to_string(&app_record)?;

            sqlx::query(safe_sql(format!(
                "insert into {APPS_TABLE} (key, value) values (?1, ?2)
                 on conflict(key) do update set value = excluded.value"
            )))
            .bind(app.id.to_string())
            .bind(value)
            .execute(&mut *tx)
            .await
            .map_err(Error::from)?;

            sqlx::query(safe_sql(format!(
                "delete from {SERVICES_TABLE} where app_id = ?1"
            )))
            .bind(app.id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(Error::from)?;

            for service in &app.services {
                let service_value = serde_json::to_string(service)?;
                sqlx::query(safe_sql(format!(
                    "insert into {SERVICES_TABLE} (key, app_id, value)
                     values (?1, ?2, ?3)"
                )))
                .bind(service.id.to_string())
                .bind(app.id.to_string())
                .bind(service_value)
                .execute(&mut *tx)
                .await
                .map_err(Error::from)?;
            }

            tx.commit().await.map_err(Error::from)?;
            Ok(())
        })
    }

    fn get_app(&self, id: Uuid) -> Result<Option<App>> {
        let Some(mut app) =
            self.get_json::<App>(APPS_TABLE, &id.to_string())?
        else {
            return Ok(None);
        };
        app.services = self.list_services_by_app(app.id)?;
        Ok(Some(app))
    }

    fn list_apps(&self) -> Result<Vec<App>> {
        let apps = self.list_json::<App>(APPS_TABLE)?;
        self.populate_app_services(apps)
    }

    fn list_apps_by_owner(&self, owner_id: Uuid) -> Result<Vec<App>> {
        let apps = self
            .list_apps()?
            .into_iter()
            .filter(|app| app.owner_id == owner_id)
            .collect::<Vec<_>>();
        Ok(apps)
    }

    fn get_app_by_domain(&self, domain: &str) -> Result<Option<App>> {
        Ok(self
            .list_apps()?
            .into_iter()
            .find(|app| app.custom_domains().iter().any(|item| item == domain)))
    }

    fn delete_app(&self, id: Uuid) -> Result<bool> {
        let Some(app) = self.get_app(id)? else {
            return Ok(false);
        };

        for deployment in self.list_deployments_by_app(app.id)? {
            let _ = self.delete_deployment(deployment.id)?;
        }

        self.run(async {
            let mut tx = self.pool.begin().await.map_err(Error::from)?;
            sqlx::query(safe_sql(format!(
                "delete from {SERVICES_TABLE} where app_id = ?1"
            )))
            .bind(id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(Error::from)?;
            sqlx::query(safe_sql(format!(
                "delete from {APPS_TABLE} where key = ?1"
            )))
            .bind(id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(Error::from)?;
            tx.commit().await.map_err(Error::from)?;
            Ok(())
        })?;

        Ok(true)
    }

    fn get_app_by_github_url(
        &self,
        github_url: &str,
        branch: &str,
    ) -> Result<Option<App>> {
        let normalized_url = github_url.trim_end_matches(".git");
        Ok(self.list_apps()?.into_iter().find(|app| {
            app.github_url.trim_end_matches(".git") == normalized_url
                && app.branch == branch
        }))
    }

    fn save_service(&self, service: &ContainerService) -> Result<()> {
        self.put_service_json(service)
    }

    fn get_service(&self, id: Uuid) -> Result<Option<ContainerService>> {
        self.get_json(SERVICES_TABLE, &id.to_string())
    }

    fn list_services_by_app(
        &self,
        app_id: Uuid,
    ) -> Result<Vec<ContainerService>> {
        let mut services = self
            .list_json::<ContainerService>(SERVICES_TABLE)?
            .into_iter()
            .filter(|service| service.app_id == app_id)
            .collect::<Vec<_>>();
        services.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(services)
    }

    fn delete_service(&self, id: Uuid) -> Result<bool> {
        self.delete_key(SERVICES_TABLE, &id.to_string())
    }

    fn save_service_deployment(
        &self,
        deployment: &ServiceDeployment,
    ) -> Result<()> {
        self.put_service_deployment_json(deployment)
    }

    fn get_service_deployment(
        &self,
        id: Uuid,
    ) -> Result<Option<ServiceDeployment>> {
        self.get_json(SERVICE_DEPLOYMENTS_TABLE, &id.to_string())
    }

    fn list_service_deployments(
        &self,
        deployment_id: Uuid,
    ) -> Result<Vec<ServiceDeployment>> {
        let mut deployments = self
            .list_json::<ServiceDeployment>(SERVICE_DEPLOYMENTS_TABLE)?
            .into_iter()
            .filter(|deployment| deployment.deployment_id == deployment_id)
            .collect::<Vec<_>>();
        deployments.sort_by(|left, right| {
            left.service_id
                .cmp(&right.service_id)
                .then(left.replica_index.cmp(&right.replica_index))
        });
        Ok(deployments)
    }

    fn list_service_deployments_by_service(
        &self,
        service_id: Uuid,
    ) -> Result<Vec<ServiceDeployment>> {
        let mut deployments = self
            .list_json::<ServiceDeployment>(SERVICE_DEPLOYMENTS_TABLE)?
            .into_iter()
            .filter(|deployment| deployment.service_id == service_id)
            .collect::<Vec<_>>();
        deployments
            .sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(deployments)
    }

    fn save_deployment(&self, deployment: &Deployment) -> Result<()> {
        self.run(async {
            let mut tx = self.pool.begin().await.map_err(Error::from)?;
            let mut deployment_record = deployment.clone();
            deployment_record.service_deployments.clear();
            deployment_record.logs.clear();
            let value = serde_json::to_string(&deployment_record)?;

            sqlx::query(safe_sql(format!(
                "insert into {DEPLOYMENTS_TABLE} (key, app_id, value)
                 values (?1, ?2, ?3)
                 on conflict(key) do update set
                     app_id = excluded.app_id,
                     value = excluded.value"
            )))
            .bind(deployment.id.to_string())
            .bind(deployment.app_id.to_string())
            .bind(value)
            .execute(&mut *tx)
            .await
            .map_err(Error::from)?;

            sqlx::query(safe_sql(format!(
                "delete from {SERVICE_DEPLOYMENTS_TABLE}
                 where deployment_id = ?1"
            )))
            .bind(deployment.id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(Error::from)?;

            for service_deployment in &deployment.service_deployments {
                let service_value = serde_json::to_string(service_deployment)?;
                sqlx::query(safe_sql(format!(
                    "insert into {SERVICE_DEPLOYMENTS_TABLE}
                     (key, deployment_id, service_id, value)
                     values (?1, ?2, ?3, ?4)"
                )))
                .bind(service_deployment.id.to_string())
                .bind(deployment.id.to_string())
                .bind(service_deployment.service_id.to_string())
                .bind(service_value)
                .execute(&mut *tx)
                .await
                .map_err(Error::from)?;
            }

            tx.commit().await.map_err(Error::from)?;
            Ok(())
        })
    }

    fn get_deployment(&self, id: Uuid) -> Result<Option<Deployment>> {
        let Some(mut deployment) =
            self.get_json::<Deployment>(DEPLOYMENTS_TABLE, &id.to_string())?
        else {
            return Ok(None);
        };

        deployment.service_deployments =
            self.list_service_deployments(deployment.id)?;
        deployment.logs.clear();
        Ok(Some(deployment))
    }

    fn list_deployments_by_app(&self, app_id: Uuid) -> Result<Vec<Deployment>> {
        let mut deployments = self
            .list_json::<Deployment>(DEPLOYMENTS_TABLE)?
            .into_iter()
            .filter(|deployment| deployment.app_id == app_id)
            .collect::<Vec<_>>();

        for deployment in &mut deployments {
            deployment.service_deployments =
                self.list_service_deployments(deployment.id)?;
            deployment.logs.clear();
        }

        deployments
            .sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(deployments)
    }

    fn delete_deployment(&self, id: Uuid) -> Result<bool> {
        let deleted = self.delete_key(DEPLOYMENTS_TABLE, &id.to_string())?;
        if !deleted {
            return Ok(false);
        }

        self.run(async {
            let mut tx = self.pool.begin().await.map_err(Error::from)?;
            sqlx::query(safe_sql(format!(
                "delete from {SERVICE_DEPLOYMENTS_TABLE}
                 where deployment_id = ?1"
            )))
            .bind(id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(Error::from)?;
            sqlx::query(safe_sql(format!(
                "delete from {DEPLOYMENT_LOGS_TABLE}
                 where deployment_id = ?1"
            )))
            .bind(id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(Error::from)?;
            tx.commit().await.map_err(Error::from)?;
            Ok(())
        })?;

        Ok(true)
    }

    fn append_deployment_log(
        &self,
        deployment_id: Uuid,
        log_line: &str,
    ) -> Result<()> {
        self.run(async {
            let mut tx = self.pool.begin().await.map_err(Error::from)?;
            let next_index = sqlx::query_scalar::<_, i64>(safe_sql(format!(
                "select coalesce(max(idx), -1) + 1
                 from {DEPLOYMENT_LOGS_TABLE}
                 where deployment_id = ?1"
            )))
            .bind(deployment_id.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(Error::from)?;

            sqlx::query(safe_sql(format!(
                "insert into {DEPLOYMENT_LOGS_TABLE}
                 (deployment_id, idx, line)
                 values (?1, ?2, ?3)"
            )))
            .bind(deployment_id.to_string())
            .bind(next_index)
            .bind(log_line)
            .execute(&mut *tx)
            .await
            .map_err(Error::from)?;

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
            let rows = sqlx::query(safe_sql(format!(
                "select line from {DEPLOYMENT_LOGS_TABLE}
                 where deployment_id = ?1
                 order by idx asc
                 limit ?2 offset ?3"
            )))
            .bind(deployment_id.to_string())
            .bind(limit as i64)
            .bind(offset as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(Error::from)?;

            rows.into_iter()
                .map(|row| {
                    row.try_get::<String, _>("line").map_err(Error::from)
                })
                .collect()
        })
    }

    fn save_certificate(&self, cert: &Certificate) -> Result<()> {
        self.put_json(CERTIFICATES_TABLE, &cert.domain, cert)
    }

    fn get_certificate(&self, domain: &str) -> Result<Option<Certificate>> {
        self.get_json(CERTIFICATES_TABLE, domain)
    }

    fn list_certificates(&self) -> Result<Vec<Certificate>> {
        let mut certificates: Vec<Certificate> =
            self.list_json(CERTIFICATES_TABLE)?;
        certificates.sort_by(|left, right| left.domain.cmp(&right.domain));
        Ok(certificates)
    }

    fn delete_certificate(&self, domain: &str) -> Result<bool> {
        self.delete_key(CERTIFICATES_TABLE, domain)
    }

    fn save_managed_database(&self, db: &ManagedDatabase) -> Result<()> {
        self.put_owned_json(
            MANAGED_DATABASES_TABLE,
            &db.id.to_string(),
            &db.owner_id.to_string(),
            db,
        )
    }

    fn get_managed_database(
        &self,
        id: Uuid,
    ) -> Result<Option<ManagedDatabase>> {
        self.get_json(MANAGED_DATABASES_TABLE, &id.to_string())
    }

    fn list_managed_databases_by_owner(
        &self,
        owner_id: Uuid,
    ) -> Result<Vec<ManagedDatabase>> {
        let mut databases = self
            .list_json::<ManagedDatabase>(MANAGED_DATABASES_TABLE)?
            .into_iter()
            .filter(|database| database.owner_id == owner_id)
            .collect::<Vec<_>>();
        databases.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(databases)
    }

    fn delete_managed_database(&self, id: Uuid) -> Result<bool> {
        self.delete_key(MANAGED_DATABASES_TABLE, &id.to_string())
    }

    fn save_managed_queue(&self, queue: &ManagedQueue) -> Result<()> {
        self.put_owned_json(
            MANAGED_QUEUES_TABLE,
            &queue.id.to_string(),
            &queue.owner_id.to_string(),
            queue,
        )
    }

    fn get_managed_queue(&self, id: Uuid) -> Result<Option<ManagedQueue>> {
        self.get_json(MANAGED_QUEUES_TABLE, &id.to_string())
    }

    fn list_managed_queues_by_owner(
        &self,
        owner_id: Uuid,
    ) -> Result<Vec<ManagedQueue>> {
        let mut queues = self
            .list_json::<ManagedQueue>(MANAGED_QUEUES_TABLE)?
            .into_iter()
            .filter(|queue| queue.owner_id == owner_id)
            .collect::<Vec<_>>();
        queues.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(queues)
    }

    fn delete_managed_queue(&self, id: Uuid) -> Result<bool> {
        self.delete_key(MANAGED_QUEUES_TABLE, &id.to_string())
    }

    fn save_storage_bucket(&self, bucket: &StorageBucket) -> Result<()> {
        self.put_owned_json(
            STORAGE_BUCKETS_TABLE,
            &bucket.id.to_string(),
            &bucket.owner_id.to_string(),
            bucket,
        )
    }

    fn get_storage_bucket(&self, id: Uuid) -> Result<Option<StorageBucket>> {
        self.get_json(STORAGE_BUCKETS_TABLE, &id.to_string())
    }

    fn list_storage_buckets_by_owner(
        &self,
        owner_id: Uuid,
    ) -> Result<Vec<StorageBucket>> {
        let mut buckets = self
            .list_json::<StorageBucket>(STORAGE_BUCKETS_TABLE)?
            .into_iter()
            .filter(|bucket| bucket.owner_id == owner_id)
            .collect::<Vec<_>>();
        buckets.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(buckets)
    }

    fn delete_storage_bucket(&self, id: Uuid) -> Result<bool> {
        self.delete_key(STORAGE_BUCKETS_TABLE, &id.to_string())
    }

    fn save_github_app(&self, app: &GithubAppConfig) -> Result<()> {
        self.put_json(GITHUB_APPS_TABLE, &app.owner_id.to_string(), app)
    }

    fn get_github_app(
        &self,
        owner_id: Uuid,
    ) -> Result<Option<GithubAppConfig>> {
        self.get_json(GITHUB_APPS_TABLE, &owner_id.to_string())
    }

    fn delete_github_app(&self, owner_id: Uuid) -> Result<bool> {
        self.delete_key(GITHUB_APPS_TABLE, &owner_id.to_string())
    }

    fn populate_app_services(&self, mut apps: Vec<App>) -> Result<Vec<App>> {
        let services = self.list_json::<ContainerService>(SERVICES_TABLE)?;
        let mut grouped = HashMap::<Uuid, Vec<ContainerService>>::new();
        for service in services {
            grouped.entry(service.app_id).or_default().push(service);
        }

        for app in &mut apps {
            let mut app_services = grouped.remove(&app.id).unwrap_or_default();
            app_services.sort_by(|left, right| left.name.cmp(&right.name));
            app.services = app_services;
        }

        apps.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(apps)
    }

    fn put_service_json(&self, service: &ContainerService) -> Result<()> {
        self.run(async {
            let value = serde_json::to_string(service)?;
            sqlx::query(safe_sql(format!(
                "insert into {SERVICES_TABLE} (key, app_id, value)
                 values (?1, ?2, ?3)
                 on conflict(key) do update set
                     app_id = excluded.app_id,
                     value = excluded.value"
            )))
            .bind(service.id.to_string())
            .bind(service.app_id.to_string())
            .bind(value)
            .execute(&self.pool)
            .await
            .map_err(Error::from)?;
            Ok(())
        })
    }

    fn put_service_deployment_json(
        &self,
        deployment: &ServiceDeployment,
    ) -> Result<()> {
        self.run(async {
            let value = serde_json::to_string(deployment)?;
            sqlx::query(safe_sql(format!(
                "insert into {SERVICE_DEPLOYMENTS_TABLE}
                 (key, deployment_id, service_id, value)
                 values (?1, ?2, ?3, ?4)
                 on conflict(key) do update set
                     deployment_id = excluded.deployment_id,
                     service_id = excluded.service_id,
                     value = excluded.value"
            )))
            .bind(deployment.id.to_string())
            .bind(deployment.deployment_id.to_string())
            .bind(deployment.service_id.to_string())
            .bind(value)
            .execute(&self.pool)
            .await
            .map_err(Error::from)?;
            Ok(())
        })
    }

    fn put_json<T: Serialize + Sync>(
        &self,
        table: &str,
        key: &str,
        value: &T,
    ) -> Result<()> {
        self.run(async {
            let value = serde_json::to_string(value)?;
            sqlx::query(safe_sql(format!(
                "insert into {table} (key, value) values (?1, ?2)
                 on conflict(key) do update set value = excluded.value"
            )))
            .bind(key)
            .bind(value)
            .execute(&self.pool)
            .await
            .map_err(Error::from)?;
            Ok(())
        })
    }

    fn put_owned_json<T: Serialize + Sync>(
        &self,
        table: &str,
        key: &str,
        owner_id: &str,
        value: &T,
    ) -> Result<()> {
        self.run(async {
            let value = serde_json::to_string(value)?;
            sqlx::query(safe_sql(format!(
                "insert into {table} (key, owner_id, value)
                 values (?1, ?2, ?3)
                 on conflict(key) do update set
                     owner_id = excluded.owner_id,
                     value = excluded.value"
            )))
            .bind(key)
            .bind(owner_id)
            .bind(value)
            .execute(&self.pool)
            .await
            .map_err(Error::from)?;
            Ok(())
        })
    }

    fn get_json<T: DeserializeOwned + Send>(
        &self,
        table: &str,
        key: &str,
    ) -> Result<Option<T>> {
        self.run(async {
            let row = sqlx::query(safe_sql(format!(
                "select value from {table} where key = ?1"
            )))
            .bind(key)
            .fetch_optional(&self.pool)
            .await
            .map_err(Error::from)?;

            match row {
                Some(row) => {
                    let value = row
                        .try_get::<String, _>("value")
                        .map_err(Error::from)?;
                    serde_json::from_str(&value).map(Some).map_err(Error::from)
                }
                None => Ok(None),
            }
        })
    }

    fn delete_key(&self, table: &str, key: &str) -> Result<bool> {
        self.run(async {
            let result = sqlx::query(safe_sql(format!(
                "delete from {table} where key = ?1"
            )))
            .bind(key)
            .execute(&self.pool)
            .await
            .map_err(Error::from)?;
            Ok(result.rows_affected() > 0)
        })
    }

    fn list_json<T: DeserializeOwned + Send>(
        &self,
        table: &str,
    ) -> Result<Vec<T>> {
        self.run(async {
            let rows =
                sqlx::query(safe_sql(format!("select value from {table}")))
                    .fetch_all(&self.pool)
                    .await
                    .map_err(Error::from)?;

            rows.into_iter()
                .map(|row| {
                    let value = row
                        .try_get::<String, _>("value")
                        .map_err(Error::from)?;
                    serde_json::from_str(&value).map_err(Error::from)
                })
                .collect()
        })
    }
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
                    Error::Internal("sqlite runtime mutex poisoned".to_string())
                })?;
                let runtime = runtime.as_ref().ok_or_else(|| {
                    Error::Internal("sqlite runtime not available".to_string())
                })?;
                runtime.block_on(future)
            });

            task.join().map_err(|_| {
                Error::Internal("sqlite runtime worker panicked".to_string())
            })?
        })
    } else {
        let runtime = runtime.lock().map_err(|_| {
            Error::Internal("sqlite runtime mutex poisoned".to_string())
        })?;
        let runtime = runtime.as_ref().ok_or_else(|| {
            Error::Internal("sqlite runtime not available".to_string())
        })?;
        runtime.block_on(future)
    }
}

impl Drop for SqliteJsonDatabase {
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
            std::fs::create_dir_all(parent).map_err(|error| {
                Error::Internal(format!(
                    "failed to create database directory: {}",
                    error
                ))
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managed_services::{DatabaseType, QueueType};
    use crate::models::{
        BuildArg, DeploymentStatus, EnvVar, GithubInstallation, HealthCheck,
        RestartPolicy, RolloutStrategy, ServiceHealth, ServiceMount,
        ServiceRegistryAuth, ServiceType, User,
    };

    fn temp_config(name: &str) -> DatabaseConfig {
        let root = std::env::temp_dir().join(format!(
            "containr-db-test-{}-{}",
            name,
            Uuid::new_v4()
        ));
        DatabaseConfig {
            path: root.join("state.sqlite3").to_string_lossy().to_string(),
        }
    }

    #[test]
    fn sqlite_store_roundtrips_core_entities() {
        let db = Database::open(&temp_config("roundtrip"))
            .expect("database should open");

        let mut owner = User::new_with_password(
            "owner@example.com".to_string(),
            "argon2:test-hash".to_string(),
        );
        owner.is_admin = true;
        db.save_user(&owner).expect("user save should work");
        let loaded_owner = db
            .get_user(owner.id)
            .expect("user lookup should work")
            .expect("user should exist");
        assert!(loaded_owner.is_admin);
        assert!(db.has_admin_user().expect("admin lookup should work"));

        let mut app = App::new(
            "demo".to_string(),
            "https://example.com/repo".to_string(),
            owner.id,
        );
        app.branch = "main".to_string();
        app.env_vars = vec![
            EnvVar {
                key: "PORT".to_string(),
                value: "8080".to_string(),
                secret: false,
            },
            EnvVar {
                key: "TOKEN".to_string(),
                value: "secret".to_string(),
                secret: true,
            },
        ];
        let mut web = ContainerService::new(
            app.id,
            "web".to_string(),
            "".to_string(),
            8080,
        );
        web.service_type = ServiceType::WebService;
        web.expose_http = true;
        web.domains = vec!["demo.example.com".to_string()];
        web.additional_ports = vec![9000];
        web.registry_auth = Some(ServiceRegistryAuth {
            server: Some("ghcr.io".to_string()),
            username: "demo".to_string(),
            password: "encrypted".to_string(),
        });
        web.build_args = vec![BuildArg {
            key: "RUSTFLAGS".to_string(),
            value: "-C target-cpu=native".to_string(),
            secret: false,
        }];
        web.mounts = vec![ServiceMount {
            name: "data".to_string(),
            target: "/data".to_string(),
            read_only: false,
        }];
        web.health_check = Some(HealthCheck {
            path: "/health".to_string(),
            interval_secs: 15,
            timeout_secs: 3,
            retries: 2,
        });

        let mut worker = ContainerService::new(
            app.id,
            "worker".to_string(),
            "".to_string(),
            0,
        );
        worker.service_type = ServiceType::BackgroundWorker;
        worker.depends_on = vec!["web".to_string()];
        worker.restart_policy = RestartPolicy::OnFailure;

        app.services = vec![worker.clone(), web.clone()];
        db.save_app(&app).expect("app save should work");

        let loaded_app = db
            .get_app(app.id)
            .expect("app lookup should work")
            .expect("app should exist");
        assert_eq!(loaded_app.services.len(), 2);
        assert_eq!(
            db.get_service(web.id)
                .expect("service lookup should work")
                .expect("service should exist")
                .domains,
            vec!["demo.example.com".to_string()]
        );

        let mut deployment = Deployment::new(app.id, "abc123".to_string());
        deployment.status = DeploymentStatus::Running;
        deployment.rollout_strategy = RolloutStrategy::StartFirst;
        let mut service_deployment =
            ServiceDeployment::new(web.id, deployment.id, 0);
        service_deployment.status = DeploymentStatus::Running;
        service_deployment.health = ServiceHealth::Healthy;
        service_deployment.logs = vec!["service ready".to_string()];
        deployment.service_deployments = vec![service_deployment.clone()];

        db.save_deployment(&deployment)
            .expect("deployment save should work");
        db.append_deployment_log(deployment.id, "first line")
            .expect("first deployment log should append");
        db.append_deployment_log(deployment.id, "second line")
            .expect("second deployment log should append");
        db.save_service_deployment(&service_deployment)
            .expect("service deployment save should work");

        let loaded_deployment = db
            .get_deployment(deployment.id)
            .expect("deployment lookup should work")
            .expect("deployment should exist");
        assert_eq!(loaded_deployment.service_deployments.len(), 1);
        assert!(loaded_deployment.logs.is_empty());
        assert_eq!(
            db.get_deployment_logs(deployment.id, 10, 0)
                .expect("deployment logs should load"),
            vec!["first line".to_string(), "second line".to_string()]
        );

        let mut managed_db = ManagedDatabase::new(
            owner.id,
            "primary".to_string(),
            DatabaseType::Postgresql,
        );
        managed_db.status = ServiceStatus::Running;
        db.save_managed_database(&managed_db)
            .expect("managed database save should work");
        assert_eq!(
            db.list_managed_databases_by_owner(owner.id)
                .expect("managed databases should load")
                .len(),
            1
        );

        let managed_queue = ManagedQueue::new(
            owner.id,
            "events".to_string(),
            QueueType::Rabbitmq,
        );
        db.save_managed_queue(&managed_queue)
            .expect("managed queue save should work");

        let bucket = StorageBucket::new(
            owner.id,
            "backups".to_string(),
            "http://localhost:9000".to_string(),
        );
        db.save_storage_bucket(&bucket)
            .expect("bucket save should work");

        let mut github_app =
            GithubAppConfig::builder(12345, "demo-app", owner.id)
                .client_id("client-id")
                .client_secret("client-secret")
                .private_key("private-key")
                .webhook_secret("webhook-secret")
                .build();
        github_app.installations.push(GithubInstallation::new(
            67890,
            "demo-org".to_string(),
            "Organization".to_string(),
        ));
        db.save_github_app(&github_app)
            .expect("github app save should work");

        assert!(db
            .get_github_app(owner.id)
            .expect("github app lookup should work")
            .is_some());
    }

    #[test]
    fn legacy_apps_are_promoted_to_default_service_model() {
        let db = Database::open(&temp_config("legacy-service"))
            .expect("database should open");

        let owner_id = Uuid::new_v4();
        let mut app = App::new(
            "legacy-app".to_string(),
            "https://example.com/repo".to_string(),
            owner_id,
        );
        app.port = 4567;

        db.save_app(&app).expect("app save should work");

        let loaded = db
            .get_app(app.id)
            .expect("app lookup should work")
            .expect("app should exist");
        assert_eq!(loaded.services.len(), 1);
        assert_eq!(loaded.services[0].id, loaded.default_service_id());
        assert_eq!(loaded.services[0].name, "web");
        assert_eq!(loaded.services[0].port, 4567);
        assert!(loaded.services[0].expose_http);
    }
}
