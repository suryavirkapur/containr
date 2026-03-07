//! metadata database backends for containr

use std::path::Path;
use std::sync::Arc;
use std::time::Duration as StdDuration;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{de::DeserializeOwned, Serialize};
use uuid::Uuid;

use crate::config::{DatabaseBackendKind, DatabaseConfig};
use crate::error::{Error, Result};
#[allow(unused_imports)]
use crate::managed_services::{
    DatabaseType, ManagedDatabase, ManagedQueue, QueueType, ServiceStatus, StorageBucket,
};
#[allow(unused_imports)]
use crate::models::{
    App, Certificate, ContainerService, Deployment, DeploymentStatus, EnvVar, GithubAppConfig,
    GithubInstallation, HealthCheck, RestartPolicy, RolloutStrategy, ServiceDeployment,
    ServiceHealth, ServiceMount, ServiceRegistryAuth, User,
};

const USERS_TABLE: &str = "users";
const APPS_TABLE: &str = "apps";
const APP_DOMAINS_TABLE: &str = "app_domains";
const APP_ENV_VARS_TABLE: &str = "app_env_vars";
const SERVICES_TABLE: &str = "services";
const SERVICE_DEPENDENCIES_TABLE: &str = "service_dependencies";
const SERVICE_ADDITIONAL_PORTS_TABLE: &str = "service_additional_ports";
const SERVICE_COMMAND_ARGS_TABLE: &str = "service_command_args";
const SERVICE_ENTRYPOINT_ARGS_TABLE: &str = "service_entrypoint_args";
const SERVICE_REGISTRY_AUTH_TABLE: &str = "service_registry_auth";
const SERVICE_MOUNTS_TABLE: &str = "service_mounts";
const SERVICE_DEPLOYMENTS_TABLE: &str = "service_deployments";
const SERVICE_DEPLOYMENT_LOGS_TABLE: &str = "service_deployment_logs";
const DEPLOYMENTS_TABLE: &str = "deployments";
const DEPLOYMENT_LOGS_TABLE: &str = "deployment_logs";
const CERTIFICATES_TABLE: &str = "certificates";
const MANAGED_DATABASES_TABLE: &str = "managed_databases";
const MANAGED_QUEUES_TABLE: &str = "managed_queues";
const STORAGE_BUCKETS_TABLE: &str = "storage_buckets";
const GITHUB_APPS_TABLE: &str = "github_apps";
const GITHUB_APP_INSTALLATIONS_TABLE: &str = "github_app_installations";

#[path = "sqlite_relational.rs"]
mod sqlite_relational;

use sqlite_relational::SqliteDatabase;

fn parse_log_counter(bytes: &[u8]) -> u64 {
    if bytes.len() != 8 {
        return 0;
    }
    let mut buffer = [0u8; 8];
    buffer.copy_from_slice(bytes);
    u64::from_be_bytes(buffer)
}

fn build_log_key(deployment_id: Uuid, index: u64) -> Vec<u8> {
    let mut key = Vec::with_capacity(24);
    key.extend_from_slice(deployment_id.as_bytes());
    key.extend_from_slice(&index.to_be_bytes());
    key
}

pub trait DatabaseBackend: Send + Sync {
    fn flush(&self) -> Result<()>;
    fn save_user(&self, user: &User) -> Result<()>;
    fn get_user(&self, id: Uuid) -> Result<Option<User>>;
    fn get_user_by_email(&self, email: &str) -> Result<Option<User>>;
    fn get_user_by_github_id(&self, github_id: i64) -> Result<Option<User>>;
    fn save_app(&self, app: &App) -> Result<()>;
    fn get_app(&self, id: Uuid) -> Result<Option<App>>;
    fn list_apps(&self) -> Result<Vec<App>>;
    fn list_apps_by_owner(&self, owner_id: Uuid) -> Result<Vec<App>>;
    fn get_app_by_domain(&self, domain: &str) -> Result<Option<App>>;
    fn delete_app(&self, id: Uuid) -> Result<bool>;
    fn get_app_by_github_url(&self, github_url: &str, branch: &str) -> Result<Option<App>>;
    fn save_service(&self, service: &ContainerService) -> Result<()>;
    fn get_service(&self, id: Uuid) -> Result<Option<ContainerService>>;
    fn list_services_by_app(&self, app_id: Uuid) -> Result<Vec<ContainerService>>;
    fn delete_service(&self, id: Uuid) -> Result<bool>;
    fn save_service_deployment(&self, deployment: &ServiceDeployment) -> Result<()>;
    fn get_service_deployment(&self, id: Uuid) -> Result<Option<ServiceDeployment>>;
    fn list_service_deployments(&self, deployment_id: Uuid) -> Result<Vec<ServiceDeployment>>;
    fn list_service_deployments_by_service(
        &self,
        service_id: Uuid,
    ) -> Result<Vec<ServiceDeployment>>;
    fn save_deployment(&self, deployment: &Deployment) -> Result<()>;
    fn get_deployment(&self, id: Uuid) -> Result<Option<Deployment>>;
    fn list_deployments_by_app(&self, app_id: Uuid) -> Result<Vec<Deployment>>;
    fn delete_deployment(&self, id: Uuid) -> Result<bool>;
    fn append_deployment_log(&self, deployment_id: Uuid, log_line: &str) -> Result<()>;
    fn get_deployment_logs(
        &self,
        deployment_id: Uuid,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<String>>;
    fn save_certificate(&self, cert: &Certificate) -> Result<()>;
    fn get_certificate(&self, domain: &str) -> Result<Option<Certificate>>;
    fn list_certificates(&self) -> Result<Vec<Certificate>>;
    fn delete_certificate(&self, domain: &str) -> Result<bool>;
    fn save_managed_database(&self, db: &ManagedDatabase) -> Result<()>;
    fn get_managed_database(&self, id: Uuid) -> Result<Option<ManagedDatabase>>;
    fn list_managed_databases_by_owner(&self, owner_id: Uuid) -> Result<Vec<ManagedDatabase>>;
    fn delete_managed_database(&self, id: Uuid) -> Result<bool>;
    fn save_managed_queue(&self, queue: &ManagedQueue) -> Result<()>;
    fn get_managed_queue(&self, id: Uuid) -> Result<Option<ManagedQueue>>;
    fn list_managed_queues_by_owner(&self, owner_id: Uuid) -> Result<Vec<ManagedQueue>>;
    fn delete_managed_queue(&self, id: Uuid) -> Result<bool>;
    fn save_storage_bucket(&self, bucket: &StorageBucket) -> Result<()>;
    fn get_storage_bucket(&self, id: Uuid) -> Result<Option<StorageBucket>>;
    fn list_storage_buckets_by_owner(&self, owner_id: Uuid) -> Result<Vec<StorageBucket>>;
    fn delete_storage_bucket(&self, id: Uuid) -> Result<bool>;
    fn save_github_app(&self, app: &GithubAppConfig) -> Result<()>;
    fn get_github_app(&self, owner_id: Uuid) -> Result<Option<GithubAppConfig>>;
    fn delete_github_app(&self, owner_id: Uuid) -> Result<bool>;
}

/// database wrapper providing typed access through a configured backend
#[derive(Clone)]
pub struct Database {
    backend: Arc<dyn DatabaseBackend>,
}

impl Database {
    pub fn open(config: &DatabaseConfig) -> Result<Self> {
        let backend: Arc<dyn DatabaseBackend> = match config.backend {
            DatabaseBackendKind::Sled => Arc::new(SledDatabase::open(&config.path)?),
            DatabaseBackendKind::Sqlite => Arc::new(SqliteDatabase::open(&config.path)?),
        };

        Ok(Self { backend })
    }

    pub fn flush(&self) -> Result<()> {
        self.backend.flush()
    }

    pub fn save_user(&self, user: &User) -> Result<()> {
        self.backend.save_user(user)
    }

    pub fn get_user(&self, id: Uuid) -> Result<Option<User>> {
        self.backend.get_user(id)
    }

    pub fn get_user_by_email(&self, email: &str) -> Result<Option<User>> {
        self.backend.get_user_by_email(email)
    }

    pub fn get_user_by_github_id(&self, github_id: i64) -> Result<Option<User>> {
        self.backend.get_user_by_github_id(github_id)
    }

    pub fn save_app(&self, app: &App) -> Result<()> {
        self.backend.save_app(app)
    }

    pub fn get_app(&self, id: Uuid) -> Result<Option<App>> {
        self.backend.get_app(id)
    }

    pub fn list_apps(&self) -> Result<Vec<App>> {
        self.backend.list_apps()
    }

    pub fn list_apps_by_owner(&self, owner_id: Uuid) -> Result<Vec<App>> {
        self.backend.list_apps_by_owner(owner_id)
    }

    pub fn get_app_by_domain(&self, domain: &str) -> Result<Option<App>> {
        self.backend.get_app_by_domain(domain)
    }

    pub fn delete_app(&self, id: Uuid) -> Result<bool> {
        self.backend.delete_app(id)
    }

    pub fn get_app_by_github_url(&self, github_url: &str, branch: &str) -> Result<Option<App>> {
        self.backend.get_app_by_github_url(github_url, branch)
    }

    pub fn save_service(&self, service: &ContainerService) -> Result<()> {
        self.backend.save_service(service)
    }

    pub fn get_service(&self, id: Uuid) -> Result<Option<ContainerService>> {
        self.backend.get_service(id)
    }

    pub fn list_services_by_app(&self, app_id: Uuid) -> Result<Vec<ContainerService>> {
        self.backend.list_services_by_app(app_id)
    }

    pub fn delete_service(&self, id: Uuid) -> Result<bool> {
        self.backend.delete_service(id)
    }

    pub fn delete_services_by_app(&self, app_id: Uuid) -> Result<usize> {
        let services = self.list_services_by_app(app_id)?;
        let count = services.len();
        for service in services {
            self.delete_service(service.id)?;
        }
        Ok(count)
    }

    pub fn save_service_deployment(&self, deployment: &ServiceDeployment) -> Result<()> {
        self.backend.save_service_deployment(deployment)
    }

    pub fn get_service_deployment(&self, id: Uuid) -> Result<Option<ServiceDeployment>> {
        self.backend.get_service_deployment(id)
    }

    pub fn list_service_deployments(&self, deployment_id: Uuid) -> Result<Vec<ServiceDeployment>> {
        self.backend.list_service_deployments(deployment_id)
    }

    pub fn list_service_deployments_by_service(
        &self,
        service_id: Uuid,
    ) -> Result<Vec<ServiceDeployment>> {
        self.backend.list_service_deployments_by_service(service_id)
    }

    pub fn save_deployment(&self, deployment: &Deployment) -> Result<()> {
        self.backend.save_deployment(deployment)
    }

    pub fn get_deployment(&self, id: Uuid) -> Result<Option<Deployment>> {
        self.backend.get_deployment(id)
    }

    pub fn list_deployments_by_app(&self, app_id: Uuid) -> Result<Vec<Deployment>> {
        self.backend.list_deployments_by_app(app_id)
    }

    pub fn get_latest_deployment(&self, app_id: Uuid) -> Result<Option<Deployment>> {
        let deployments = self.list_deployments_by_app(app_id)?;
        Ok(deployments.into_iter().next())
    }

    pub fn delete_deployment(&self, id: Uuid) -> Result<bool> {
        self.backend.delete_deployment(id)
    }

    pub fn append_deployment_log(&self, deployment_id: Uuid, log_line: &str) -> Result<()> {
        self.backend.append_deployment_log(deployment_id, log_line)
    }

    pub fn get_deployment_logs(
        &self,
        deployment_id: Uuid,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<String>> {
        self.backend
            .get_deployment_logs(deployment_id, limit, offset)
    }

    pub fn save_certificate(&self, cert: &Certificate) -> Result<()> {
        self.backend.save_certificate(cert)
    }

    pub fn get_certificate(&self, domain: &str) -> Result<Option<Certificate>> {
        self.backend.get_certificate(domain)
    }

    pub fn list_certificates(&self) -> Result<Vec<Certificate>> {
        self.backend.list_certificates()
    }

    pub fn delete_certificate(&self, domain: &str) -> Result<bool> {
        self.backend.delete_certificate(domain)
    }

    pub fn save_managed_database(&self, db: &ManagedDatabase) -> Result<()> {
        self.backend.save_managed_database(db)
    }

    pub fn get_managed_database(&self, id: Uuid) -> Result<Option<ManagedDatabase>> {
        self.backend.get_managed_database(id)
    }

    pub fn list_managed_databases_by_owner(&self, owner_id: Uuid) -> Result<Vec<ManagedDatabase>> {
        self.backend.list_managed_databases_by_owner(owner_id)
    }

    pub fn delete_managed_database(&self, id: Uuid) -> Result<bool> {
        self.backend.delete_managed_database(id)
    }

    pub fn save_managed_queue(&self, queue: &ManagedQueue) -> Result<()> {
        self.backend.save_managed_queue(queue)
    }

    pub fn get_managed_queue(&self, id: Uuid) -> Result<Option<ManagedQueue>> {
        self.backend.get_managed_queue(id)
    }

    pub fn list_managed_queues_by_owner(&self, owner_id: Uuid) -> Result<Vec<ManagedQueue>> {
        self.backend.list_managed_queues_by_owner(owner_id)
    }

    pub fn delete_managed_queue(&self, id: Uuid) -> Result<bool> {
        self.backend.delete_managed_queue(id)
    }

    pub fn save_storage_bucket(&self, bucket: &StorageBucket) -> Result<()> {
        self.backend.save_storage_bucket(bucket)
    }

    pub fn get_storage_bucket(&self, id: Uuid) -> Result<Option<StorageBucket>> {
        self.backend.get_storage_bucket(id)
    }

    pub fn list_storage_buckets_by_owner(&self, owner_id: Uuid) -> Result<Vec<StorageBucket>> {
        self.backend.list_storage_buckets_by_owner(owner_id)
    }

    pub fn delete_storage_bucket(&self, id: Uuid) -> Result<bool> {
        self.backend.delete_storage_bucket(id)
    }

    pub fn save_github_app(&self, app: &GithubAppConfig) -> Result<()> {
        self.backend.save_github_app(app)
    }

    pub fn get_github_app(&self, owner_id: Uuid) -> Result<Option<GithubAppConfig>> {
        self.backend.get_github_app(owner_id)
    }

    pub fn delete_github_app(&self, owner_id: Uuid) -> Result<bool> {
        self.backend.delete_github_app(owner_id)
    }
}

struct SledDatabase {
    db: sled::Db,
}

impl SledDatabase {
    fn open(path: &str) -> Result<Self> {
        ensure_parent_dir(path)?;
        let db = sled::open(path)?;
        Ok(Self { db })
    }

    fn get_tree(&self, name: &str) -> Result<sled::Tree> {
        Ok(self.db.open_tree(name)?)
    }

    fn insert<T: Serialize>(&self, tree: &sled::Tree, key: &str, value: &T) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        tree.insert(key, bytes)?;
        Ok(())
    }

    fn get<T: DeserializeOwned>(&self, tree: &sled::Tree, key: &str) -> Result<Option<T>> {
        match tree.get(key)? {
            Some(bytes) => {
                let value: T = serde_json::from_slice(&bytes)?;
                Ok(Some(value))
            }
            None => Ok(None),
        }
    }

    fn delete(&self, tree: &sled::Tree, key: &str) -> Result<bool> {
        Ok(tree.remove(key)?.is_some())
    }

    fn list<T: DeserializeOwned>(&self, tree: &sled::Tree) -> Result<Vec<T>> {
        let mut items = Vec::new();
        for result in tree.iter() {
            let (_, value) = result?;
            let item: T = serde_json::from_slice(&value)?;
            items.push(item);
        }
        Ok(items)
    }
}

impl DatabaseBackend for SledDatabase {
    fn flush(&self) -> Result<()> {
        self.db.flush()?;
        Ok(())
    }

    fn save_user(&self, user: &User) -> Result<()> {
        let tree = self.get_tree(USERS_TABLE)?;
        self.insert(&tree, &user.id.to_string(), user)
    }

    fn get_user(&self, id: Uuid) -> Result<Option<User>> {
        let tree = self.get_tree(USERS_TABLE)?;
        self.get(&tree, &id.to_string())
    }

    fn get_user_by_email(&self, email: &str) -> Result<Option<User>> {
        let tree = self.get_tree(USERS_TABLE)?;
        for result in tree.iter() {
            let (_, value) = result?;
            let user: User = serde_json::from_slice(&value)?;
            if user.email == email {
                return Ok(Some(user));
            }
        }
        Ok(None)
    }

    fn get_user_by_github_id(&self, github_id: i64) -> Result<Option<User>> {
        let tree = self.get_tree(USERS_TABLE)?;
        for result in tree.iter() {
            let (_, value) = result?;
            let user: User = serde_json::from_slice(&value)?;
            if user.github_id == Some(github_id) {
                return Ok(Some(user));
            }
        }
        Ok(None)
    }

    fn save_app(&self, app: &App) -> Result<()> {
        let tree = self.get_tree(APPS_TABLE)?;
        self.insert(&tree, &app.id.to_string(), app)
    }

    fn get_app(&self, id: Uuid) -> Result<Option<App>> {
        let tree = self.get_tree(APPS_TABLE)?;
        self.get(&tree, &id.to_string())
    }

    fn list_apps(&self) -> Result<Vec<App>> {
        let tree = self.get_tree(APPS_TABLE)?;
        self.list(&tree)
    }

    fn list_apps_by_owner(&self, owner_id: Uuid) -> Result<Vec<App>> {
        let tree = self.get_tree(APPS_TABLE)?;
        let mut apps = Vec::new();
        for result in tree.iter() {
            let (_, value) = result?;
            let app: App = serde_json::from_slice(&value)?;
            if app.owner_id == owner_id {
                apps.push(app);
            }
        }
        Ok(apps)
    }

    fn get_app_by_domain(&self, domain: &str) -> Result<Option<App>> {
        let tree = self.get_tree(APPS_TABLE)?;
        for result in tree.iter() {
            let (_, value) = result?;
            let app: App = serde_json::from_slice(&value)?;
            if app.domain.as_deref() == Some(domain) || app.domains.iter().any(|d| d == domain) {
                return Ok(Some(app));
            }
        }
        Ok(None)
    }

    fn delete_app(&self, id: Uuid) -> Result<bool> {
        let tree = self.get_tree(APPS_TABLE)?;
        self.delete(&tree, &id.to_string())
    }

    fn get_app_by_github_url(&self, github_url: &str, branch: &str) -> Result<Option<App>> {
        let tree = self.get_tree(APPS_TABLE)?;
        let normalized_url = github_url.trim_end_matches(".git");
        for result in tree.iter() {
            let (_, value) = result?;
            let app: App = serde_json::from_slice(&value)?;
            let app_url = app.github_url.trim_end_matches(".git");
            if app_url == normalized_url && app.branch == branch {
                return Ok(Some(app));
            }
        }
        Ok(None)
    }

    fn save_service(&self, service: &ContainerService) -> Result<()> {
        let tree = self.get_tree(SERVICES_TABLE)?;
        self.insert(&tree, &service.id.to_string(), service)
    }

    fn get_service(&self, id: Uuid) -> Result<Option<ContainerService>> {
        let tree = self.get_tree(SERVICES_TABLE)?;
        self.get(&tree, &id.to_string())
    }

    fn list_services_by_app(&self, app_id: Uuid) -> Result<Vec<ContainerService>> {
        let tree = self.get_tree(SERVICES_TABLE)?;
        let mut services = Vec::new();
        for result in tree.iter() {
            let (_, value) = result?;
            let service: ContainerService = serde_json::from_slice(&value)?;
            if service.app_id == app_id {
                services.push(service);
            }
        }
        services.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(services)
    }

    fn delete_service(&self, id: Uuid) -> Result<bool> {
        let tree = self.get_tree(SERVICES_TABLE)?;
        self.delete(&tree, &id.to_string())
    }

    fn save_service_deployment(&self, deployment: &ServiceDeployment) -> Result<()> {
        let tree = self.get_tree(SERVICE_DEPLOYMENTS_TABLE)?;
        self.insert(&tree, &deployment.id.to_string(), deployment)
    }

    fn get_service_deployment(&self, id: Uuid) -> Result<Option<ServiceDeployment>> {
        let tree = self.get_tree(SERVICE_DEPLOYMENTS_TABLE)?;
        self.get(&tree, &id.to_string())
    }

    fn list_service_deployments(&self, deployment_id: Uuid) -> Result<Vec<ServiceDeployment>> {
        let tree = self.get_tree(SERVICE_DEPLOYMENTS_TABLE)?;
        let mut deployments = Vec::new();
        for result in tree.iter() {
            let (_, value) = result?;
            let deployment: ServiceDeployment = serde_json::from_slice(&value)?;
            if deployment.deployment_id == deployment_id {
                deployments.push(deployment);
            }
        }
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
        let tree = self.get_tree(SERVICE_DEPLOYMENTS_TABLE)?;
        let mut deployments = Vec::new();
        for result in tree.iter() {
            let (_, value) = result?;
            let deployment: ServiceDeployment = serde_json::from_slice(&value)?;
            if deployment.service_id == service_id {
                deployments.push(deployment);
            }
        }
        deployments.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(deployments)
    }

    fn save_deployment(&self, deployment: &Deployment) -> Result<()> {
        let tree = self.get_tree(DEPLOYMENTS_TABLE)?;
        self.insert(&tree, &deployment.id.to_string(), deployment)
    }

    fn get_deployment(&self, id: Uuid) -> Result<Option<Deployment>> {
        let tree = self.get_tree(DEPLOYMENTS_TABLE)?;
        self.get(&tree, &id.to_string())
    }

    fn list_deployments_by_app(&self, app_id: Uuid) -> Result<Vec<Deployment>> {
        let tree = self.get_tree(DEPLOYMENTS_TABLE)?;
        let mut deployments = Vec::new();
        for result in tree.iter() {
            let (_, value) = result?;
            let deployment: Deployment = serde_json::from_slice(&value)?;
            if deployment.app_id == app_id {
                deployments.push(deployment);
            }
        }
        deployments.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(deployments)
    }

    fn delete_deployment(&self, id: Uuid) -> Result<bool> {
        let tree = self.get_tree(DEPLOYMENTS_TABLE)?;
        self.delete(&tree, &id.to_string())
    }

    fn append_deployment_log(&self, deployment_id: Uuid, log_line: &str) -> Result<()> {
        let tree = self.get_tree("deployment_logs_v2")?;
        let counters = self.get_tree("deployment_log_counters")?;
        let counter_key = deployment_id.as_bytes();

        let next_counter = counters
            .update_and_fetch(counter_key, |prev| {
                let next = prev.map(parse_log_counter).unwrap_or(0).saturating_add(1);
                Some(next.to_be_bytes().to_vec())
            })?
            .map(|bytes| parse_log_counter(bytes.as_ref()))
            .unwrap_or(0);

        let index = next_counter.saturating_sub(1);
        let key = build_log_key(deployment_id, index);

        tree.insert(key, log_line.as_bytes())?;
        Ok(())
    }

    fn get_deployment_logs(
        &self,
        deployment_id: Uuid,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<String>> {
        let v2_tree = self.get_tree("deployment_logs_v2")?;
        let prefix = deployment_id.as_bytes();

        let has_v2_logs = match v2_tree.scan_prefix(prefix).next() {
            Some(Ok(_)) => true,
            Some(Err(error)) => return Err(error.into()),
            None => false,
        };

        if has_v2_logs {
            let logs = v2_tree
                .scan_prefix(prefix)
                .skip(offset)
                .take(limit)
                .filter_map(|result| {
                    if let Ok((_, value)) = result {
                        String::from_utf8(value.to_vec()).ok()
                    } else {
                        None
                    }
                })
                .collect();

            return Ok(logs);
        }

        let legacy_tree = self.get_tree("deployment_logs")?;
        let legacy_prefix = format!("{}:", deployment_id);

        let logs = legacy_tree
            .scan_prefix(legacy_prefix.as_bytes())
            .skip(offset)
            .take(limit)
            .filter_map(|result| {
                if let Ok((_, value)) = result {
                    String::from_utf8(value.to_vec()).ok()
                } else {
                    None
                }
            })
            .collect();

        Ok(logs)
    }

    fn save_certificate(&self, cert: &Certificate) -> Result<()> {
        let tree = self.get_tree(CERTIFICATES_TABLE)?;
        self.insert(&tree, &cert.domain, cert)
    }

    fn get_certificate(&self, domain: &str) -> Result<Option<Certificate>> {
        let tree = self.get_tree(CERTIFICATES_TABLE)?;
        self.get(&tree, domain)
    }

    fn list_certificates(&self) -> Result<Vec<Certificate>> {
        let tree = self.get_tree(CERTIFICATES_TABLE)?;
        self.list(&tree)
    }

    fn delete_certificate(&self, domain: &str) -> Result<bool> {
        let tree = self.get_tree(CERTIFICATES_TABLE)?;
        self.delete(&tree, domain)
    }

    fn save_managed_database(&self, db: &ManagedDatabase) -> Result<()> {
        let tree = self.get_tree(MANAGED_DATABASES_TABLE)?;
        self.insert(&tree, &db.id.to_string(), db)
    }

    fn get_managed_database(&self, id: Uuid) -> Result<Option<ManagedDatabase>> {
        let tree = self.get_tree(MANAGED_DATABASES_TABLE)?;
        self.get(&tree, &id.to_string())
    }

    fn list_managed_databases_by_owner(&self, owner_id: Uuid) -> Result<Vec<ManagedDatabase>> {
        let tree = self.get_tree(MANAGED_DATABASES_TABLE)?;
        let mut databases = Vec::new();
        for result in tree.iter() {
            let (_, value) = result?;
            let database: ManagedDatabase = serde_json::from_slice(&value)?;
            if database.owner_id == owner_id {
                databases.push(database);
            }
        }
        databases.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(databases)
    }

    fn delete_managed_database(&self, id: Uuid) -> Result<bool> {
        let tree = self.get_tree(MANAGED_DATABASES_TABLE)?;
        self.delete(&tree, &id.to_string())
    }

    fn save_managed_queue(&self, queue: &ManagedQueue) -> Result<()> {
        let tree = self.get_tree(MANAGED_QUEUES_TABLE)?;
        self.insert(&tree, &queue.id.to_string(), queue)
    }

    fn get_managed_queue(&self, id: Uuid) -> Result<Option<ManagedQueue>> {
        let tree = self.get_tree(MANAGED_QUEUES_TABLE)?;
        self.get(&tree, &id.to_string())
    }

    fn list_managed_queues_by_owner(&self, owner_id: Uuid) -> Result<Vec<ManagedQueue>> {
        let tree = self.get_tree(MANAGED_QUEUES_TABLE)?;
        let mut queues = Vec::new();
        for result in tree.iter() {
            let (_, value) = result?;
            let queue: ManagedQueue = serde_json::from_slice(&value)?;
            if queue.owner_id == owner_id {
                queues.push(queue);
            }
        }
        queues.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(queues)
    }

    fn delete_managed_queue(&self, id: Uuid) -> Result<bool> {
        let tree = self.get_tree(MANAGED_QUEUES_TABLE)?;
        self.delete(&tree, &id.to_string())
    }

    fn save_storage_bucket(&self, bucket: &StorageBucket) -> Result<()> {
        let tree = self.get_tree(STORAGE_BUCKETS_TABLE)?;
        self.insert(&tree, &bucket.id.to_string(), bucket)
    }

    fn get_storage_bucket(&self, id: Uuid) -> Result<Option<StorageBucket>> {
        let tree = self.get_tree(STORAGE_BUCKETS_TABLE)?;
        self.get(&tree, &id.to_string())
    }

    fn list_storage_buckets_by_owner(&self, owner_id: Uuid) -> Result<Vec<StorageBucket>> {
        let tree = self.get_tree(STORAGE_BUCKETS_TABLE)?;
        let mut buckets = Vec::new();
        for result in tree.iter() {
            let (_, value) = result?;
            let bucket: StorageBucket = serde_json::from_slice(&value)?;
            if bucket.owner_id == owner_id {
                buckets.push(bucket);
            }
        }
        buckets.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(buckets)
    }

    fn delete_storage_bucket(&self, id: Uuid) -> Result<bool> {
        let tree = self.get_tree(STORAGE_BUCKETS_TABLE)?;
        self.delete(&tree, &id.to_string())
    }

    fn save_github_app(&self, app: &GithubAppConfig) -> Result<()> {
        let tree = self.get_tree(GITHUB_APPS_TABLE)?;
        self.insert(&tree, &app.owner_id.to_string(), app)
    }

    fn get_github_app(&self, owner_id: Uuid) -> Result<Option<GithubAppConfig>> {
        let tree = self.get_tree(GITHUB_APPS_TABLE)?;
        self.get(&tree, &owner_id.to_string())
    }

    fn delete_github_app(&self, owner_id: Uuid) -> Result<bool> {
        let tree = self.get_tree(GITHUB_APPS_TABLE)?;
        self.delete(&tree, &owner_id.to_string())
    }
}

#[allow(dead_code)]
struct LegacySqliteDatabase {
    conn: Mutex<Connection>,
}

#[allow(dead_code)]
impl LegacySqliteDatabase {
    fn open(path: &str) -> Result<Self> {
        ensure_parent_dir(path)?;
        let connection = Connection::open(path)?;
        connection.busy_timeout(StdDuration::from_secs(5))?;
        connection.execute_batch(
            r#"
            pragma journal_mode = wal;
            pragma synchronous = normal;
            pragma foreign_keys = on;

            create table if not exists users (
                key text primary key,
                value text not null
            );
            create table if not exists apps (
                key text primary key,
                value text not null
            );
            create table if not exists services (
                key text primary key,
                value text not null
            );
            create table if not exists service_deployments (
                key text primary key,
                value text not null
            );
            create table if not exists deployments (
                key text primary key,
                value text not null
            );
            create table if not exists deployment_logs (
                deployment_id text not null,
                idx integer not null,
                line text not null,
                primary key (deployment_id, idx)
            );
            create index if not exists deployment_logs_deployment_idx
                on deployment_logs (deployment_id, idx);
            create table if not exists certificates (
                key text primary key,
                value text not null
            );
            create table if not exists managed_databases (
                key text primary key,
                value text not null
            );
            create table if not exists managed_queues (
                key text primary key,
                value text not null
            );
            create table if not exists storage_buckets (
                key text primary key,
                value text not null
            );
            create table if not exists github_apps (
                key text primary key,
                value text not null
            );
            "#,
        )?;

        Ok(Self {
            conn: Mutex::new(connection),
        })
    }

    fn put_json<T: Serialize>(&self, table: &str, key: &str, value: &T) -> Result<()> {
        let value = serde_json::to_string(value)?;
        self.conn.lock().execute(
            &format!(
                "insert into {table} (key, value) values (?1, ?2)
                 on conflict(key) do update set value = excluded.value"
            ),
            params![key, value],
        )?;
        Ok(())
    }

    fn get_json<T: DeserializeOwned>(&self, table: &str, key: &str) -> Result<Option<T>> {
        let value: Option<String> = self
            .conn
            .lock()
            .query_row(
                &format!("select value from {table} where key = ?1"),
                params![key],
                |row| row.get(0),
            )
            .optional()?;

        value
            .map(|entry| serde_json::from_str(&entry))
            .transpose()
            .map_err(Into::into)
    }

    fn delete_key(&self, table: &str, key: &str) -> Result<bool> {
        let rows = self
            .conn
            .lock()
            .execute(&format!("delete from {table} where key = ?1"), params![key])?;
        Ok(rows > 0)
    }

    fn list_json<T: DeserializeOwned>(&self, table: &str) -> Result<Vec<T>> {
        let conn = self.conn.lock();
        let mut statement = conn.prepare(&format!("select value from {table}"))?;
        let mut rows = statement.query([])?;
        let mut items = Vec::new();

        while let Some(row) = rows.next()? {
            let value: String = row.get(0)?;
            let item = serde_json::from_str(&value)?;
            items.push(item);
        }

        Ok(items)
    }
}

#[allow(dead_code)]
impl DatabaseBackend for LegacySqliteDatabase {
    fn flush(&self) -> Result<()> {
        self.conn
            .lock()
            .execute_batch("pragma wal_checkpoint(passive);")?;
        Ok(())
    }

    fn save_user(&self, user: &User) -> Result<()> {
        self.put_json(USERS_TABLE, &user.id.to_string(), user)
    }

    fn get_user(&self, id: Uuid) -> Result<Option<User>> {
        self.get_json(USERS_TABLE, &id.to_string())
    }

    fn get_user_by_email(&self, email: &str) -> Result<Option<User>> {
        for user in self.list_json::<User>(USERS_TABLE)? {
            if user.email == email {
                return Ok(Some(user));
            }
        }
        Ok(None)
    }

    fn get_user_by_github_id(&self, github_id: i64) -> Result<Option<User>> {
        for user in self.list_json::<User>(USERS_TABLE)? {
            if user.github_id == Some(github_id) {
                return Ok(Some(user));
            }
        }
        Ok(None)
    }

    fn save_app(&self, app: &App) -> Result<()> {
        self.put_json(APPS_TABLE, &app.id.to_string(), app)
    }

    fn get_app(&self, id: Uuid) -> Result<Option<App>> {
        self.get_json(APPS_TABLE, &id.to_string())
    }

    fn list_apps(&self) -> Result<Vec<App>> {
        self.list_json(APPS_TABLE)
    }

    fn list_apps_by_owner(&self, owner_id: Uuid) -> Result<Vec<App>> {
        let mut apps = Vec::new();
        for app in self.list_json::<App>(APPS_TABLE)? {
            if app.owner_id == owner_id {
                apps.push(app);
            }
        }
        Ok(apps)
    }

    fn get_app_by_domain(&self, domain: &str) -> Result<Option<App>> {
        for app in self.list_json::<App>(APPS_TABLE)? {
            if app.domain.as_deref() == Some(domain)
                || app.domains.iter().any(|item| item == domain)
            {
                return Ok(Some(app));
            }
        }
        Ok(None)
    }

    fn delete_app(&self, id: Uuid) -> Result<bool> {
        self.delete_key(APPS_TABLE, &id.to_string())
    }

    fn get_app_by_github_url(&self, github_url: &str, branch: &str) -> Result<Option<App>> {
        let normalized_url = github_url.trim_end_matches(".git");
        for app in self.list_json::<App>(APPS_TABLE)? {
            let app_url = app.github_url.trim_end_matches(".git");
            if app_url == normalized_url && app.branch == branch {
                return Ok(Some(app));
            }
        }
        Ok(None)
    }

    fn save_service(&self, service: &ContainerService) -> Result<()> {
        self.put_json(SERVICES_TABLE, &service.id.to_string(), service)
    }

    fn get_service(&self, id: Uuid) -> Result<Option<ContainerService>> {
        self.get_json(SERVICES_TABLE, &id.to_string())
    }

    fn list_services_by_app(&self, app_id: Uuid) -> Result<Vec<ContainerService>> {
        let mut services = Vec::new();
        for service in self.list_json::<ContainerService>(SERVICES_TABLE)? {
            if service.app_id == app_id {
                services.push(service);
            }
        }
        services.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(services)
    }

    fn delete_service(&self, id: Uuid) -> Result<bool> {
        self.delete_key(SERVICES_TABLE, &id.to_string())
    }

    fn save_service_deployment(&self, deployment: &ServiceDeployment) -> Result<()> {
        self.put_json(
            SERVICE_DEPLOYMENTS_TABLE,
            &deployment.id.to_string(),
            deployment,
        )
    }

    fn get_service_deployment(&self, id: Uuid) -> Result<Option<ServiceDeployment>> {
        self.get_json(SERVICE_DEPLOYMENTS_TABLE, &id.to_string())
    }

    fn list_service_deployments(&self, deployment_id: Uuid) -> Result<Vec<ServiceDeployment>> {
        let mut deployments = Vec::new();
        for deployment in self.list_json::<ServiceDeployment>(SERVICE_DEPLOYMENTS_TABLE)? {
            if deployment.deployment_id == deployment_id {
                deployments.push(deployment);
            }
        }
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
        let mut deployments = Vec::new();
        for deployment in self.list_json::<ServiceDeployment>(SERVICE_DEPLOYMENTS_TABLE)? {
            if deployment.service_id == service_id {
                deployments.push(deployment);
            }
        }
        deployments.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(deployments)
    }

    fn save_deployment(&self, deployment: &Deployment) -> Result<()> {
        self.put_json(DEPLOYMENTS_TABLE, &deployment.id.to_string(), deployment)
    }

    fn get_deployment(&self, id: Uuid) -> Result<Option<Deployment>> {
        self.get_json(DEPLOYMENTS_TABLE, &id.to_string())
    }

    fn list_deployments_by_app(&self, app_id: Uuid) -> Result<Vec<Deployment>> {
        let mut deployments = Vec::new();
        for deployment in self.list_json::<Deployment>(DEPLOYMENTS_TABLE)? {
            if deployment.app_id == app_id {
                deployments.push(deployment);
            }
        }
        deployments.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(deployments)
    }

    fn delete_deployment(&self, id: Uuid) -> Result<bool> {
        self.delete_key(DEPLOYMENTS_TABLE, &id.to_string())
    }

    fn append_deployment_log(&self, deployment_id: Uuid, log_line: &str) -> Result<()> {
        let deployment_key = deployment_id.to_string();
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let next_index: i64 = tx.query_row(
            &format!(
                "select coalesce(max(idx), -1) + 1 from {DEPLOYMENT_LOGS_TABLE}
                 where deployment_id = ?1"
            ),
            params![deployment_key],
            |row| row.get(0),
        )?;
        tx.execute(
            &format!(
                "insert into {DEPLOYMENT_LOGS_TABLE} (deployment_id, idx, line)
                 values (?1, ?2, ?3)"
            ),
            params![deployment_id.to_string(), next_index, log_line],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn get_deployment_logs(
        &self,
        deployment_id: Uuid,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut statement = conn.prepare(&format!(
            "select line from {DEPLOYMENT_LOGS_TABLE}
             where deployment_id = ?1
             order by idx asc
             limit ?2 offset ?3"
        ))?;
        let mut rows = statement.query(params![
            deployment_id.to_string(),
            limit as i64,
            offset as i64
        ])?;
        let mut logs = Vec::new();

        while let Some(row) = rows.next()? {
            logs.push(row.get(0)?);
        }

        Ok(logs)
    }

    fn save_certificate(&self, cert: &Certificate) -> Result<()> {
        self.put_json(CERTIFICATES_TABLE, &cert.domain, cert)
    }

    fn get_certificate(&self, domain: &str) -> Result<Option<Certificate>> {
        self.get_json(CERTIFICATES_TABLE, domain)
    }

    fn list_certificates(&self) -> Result<Vec<Certificate>> {
        self.list_json(CERTIFICATES_TABLE)
    }

    fn delete_certificate(&self, domain: &str) -> Result<bool> {
        self.delete_key(CERTIFICATES_TABLE, domain)
    }

    fn save_managed_database(&self, db: &ManagedDatabase) -> Result<()> {
        self.put_json(MANAGED_DATABASES_TABLE, &db.id.to_string(), db)
    }

    fn get_managed_database(&self, id: Uuid) -> Result<Option<ManagedDatabase>> {
        self.get_json(MANAGED_DATABASES_TABLE, &id.to_string())
    }

    fn list_managed_databases_by_owner(&self, owner_id: Uuid) -> Result<Vec<ManagedDatabase>> {
        let mut databases = Vec::new();
        for database in self.list_json::<ManagedDatabase>(MANAGED_DATABASES_TABLE)? {
            if database.owner_id == owner_id {
                databases.push(database);
            }
        }
        databases.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(databases)
    }

    fn delete_managed_database(&self, id: Uuid) -> Result<bool> {
        self.delete_key(MANAGED_DATABASES_TABLE, &id.to_string())
    }

    fn save_managed_queue(&self, queue: &ManagedQueue) -> Result<()> {
        self.put_json(MANAGED_QUEUES_TABLE, &queue.id.to_string(), queue)
    }

    fn get_managed_queue(&self, id: Uuid) -> Result<Option<ManagedQueue>> {
        self.get_json(MANAGED_QUEUES_TABLE, &id.to_string())
    }

    fn list_managed_queues_by_owner(&self, owner_id: Uuid) -> Result<Vec<ManagedQueue>> {
        let mut queues = Vec::new();
        for queue in self.list_json::<ManagedQueue>(MANAGED_QUEUES_TABLE)? {
            if queue.owner_id == owner_id {
                queues.push(queue);
            }
        }
        queues.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(queues)
    }

    fn delete_managed_queue(&self, id: Uuid) -> Result<bool> {
        self.delete_key(MANAGED_QUEUES_TABLE, &id.to_string())
    }

    fn save_storage_bucket(&self, bucket: &StorageBucket) -> Result<()> {
        self.put_json(STORAGE_BUCKETS_TABLE, &bucket.id.to_string(), bucket)
    }

    fn get_storage_bucket(&self, id: Uuid) -> Result<Option<StorageBucket>> {
        self.get_json(STORAGE_BUCKETS_TABLE, &id.to_string())
    }

    fn list_storage_buckets_by_owner(&self, owner_id: Uuid) -> Result<Vec<StorageBucket>> {
        let mut buckets = Vec::new();
        for bucket in self.list_json::<StorageBucket>(STORAGE_BUCKETS_TABLE)? {
            if bucket.owner_id == owner_id {
                buckets.push(bucket);
            }
        }
        buckets.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(buckets)
    }

    fn delete_storage_bucket(&self, id: Uuid) -> Result<bool> {
        self.delete_key(STORAGE_BUCKETS_TABLE, &id.to_string())
    }

    fn save_github_app(&self, app: &GithubAppConfig) -> Result<()> {
        self.put_json(GITHUB_APPS_TABLE, &app.owner_id.to_string(), app)
    }

    fn get_github_app(&self, owner_id: Uuid) -> Result<Option<GithubAppConfig>> {
        self.get_json(GITHUB_APPS_TABLE, &owner_id.to_string())
    }

    fn delete_github_app(&self, owner_id: Uuid) -> Result<bool> {
        self.delete_key(GITHUB_APPS_TABLE, &owner_id.to_string())
    }
}

fn ensure_parent_dir(path: &str) -> Result<()> {
    if let Some(parent) = Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|error| {
                crate::error::Error::Internal(format!(
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
    use crate::models::DeploymentStatus;

    fn temp_config(backend: DatabaseBackendKind, name: &str) -> DatabaseConfig {
        let root =
            std::env::temp_dir().join(format!("containr-db-test-{}-{}", name, Uuid::new_v4()));
        let path = match backend {
            DatabaseBackendKind::Sled => root.join("state"),
            DatabaseBackendKind::Sqlite => root.join("state.sqlite3"),
        };

        DatabaseConfig {
            backend,
            path: path.to_string_lossy().to_string(),
        }
    }

    fn roundtrip_backend(backend: DatabaseBackendKind) {
        let db = Database::open(&temp_config(backend, "roundtrip")).unwrap();

        let owner_id = Uuid::new_v4();
        let mut app = App::new(
            "demo".to_string(),
            "https://example.com/repo".to_string(),
            owner_id,
        );
        app.branch = "main".to_string();
        app.set_domains(vec![
            "demo.example.com".to_string(),
            "www.demo.example.com".to_string(),
        ]);
        app.env_vars = vec![
            crate::models::EnvVar {
                key: "PORT".to_string(),
                value: "8080".to_string(),
                secret: false,
            },
            crate::models::EnvVar {
                key: "API_TOKEN".to_string(),
                value: "secret-value".to_string(),
                secret: true,
            },
        ];

        let mut web = ContainerService::new(app.id, "web".to_string(), "".to_string(), 8080);
        web.additional_ports = vec![8081, 9000];
        web.replicas = 2;
        web.registry_auth = Some(ServiceRegistryAuth {
            server: Some("ghcr.io".to_string()),
            username: "demo-user".to_string(),
            password: "enc:test-registry-password".to_string(),
        });
        web.command = Some(vec![
            "npm".to_string(),
            "run".to_string(),
            "start".to_string(),
        ]);
        web.entrypoint = Some(vec!["/usr/bin/env".to_string()]);
        web.working_dir = Some("/workspace".to_string());
        web.mounts = vec![ServiceMount {
            name: "data".to_string(),
            target: "/data".to_string(),
            read_only: false,
        }];
        web.health_check = Some(crate::models::HealthCheck {
            path: "/health".to_string(),
            interval_secs: 15,
            timeout_secs: 3,
            retries: 2,
        });

        let mut worker = ContainerService::new(app.id, "worker".to_string(), "".to_string(), 9000);
        worker.depends_on = vec!["web".to_string()];
        worker.restart_policy = crate::models::RestartPolicy::OnFailure;

        app.services = vec![worker.clone(), web.clone()];
        db.save_app(&app).unwrap();

        let loaded = db.get_app(app.id).unwrap().unwrap();
        assert_eq!(loaded.name, "demo");
        assert_eq!(loaded.custom_domains(), app.custom_domains());
        assert_eq!(loaded.env_vars.len(), 2);
        assert_eq!(loaded.services.len(), 2);
        let loaded_web = loaded
            .services
            .iter()
            .find(|service| service.name == "web")
            .unwrap();
        assert_eq!(loaded_web.replicas, 2);
        assert_eq!(loaded_web.additional_ports, vec![8081, 9000]);
        assert!(loaded_web.registry_auth.is_some());
        assert_eq!(
            loaded_web
                .registry_auth
                .as_ref()
                .and_then(|auth| auth.server.clone()),
            Some("ghcr.io".to_string())
        );
        assert_eq!(
            loaded_web.command,
            Some(vec![
                "npm".to_string(),
                "run".to_string(),
                "start".to_string()
            ])
        );
        assert_eq!(
            loaded_web.entrypoint,
            Some(vec!["/usr/bin/env".to_string()])
        );
        assert_eq!(loaded_web.working_dir, Some("/workspace".to_string()));
        assert_eq!(loaded_web.mounts.len(), 1);
        assert_eq!(loaded_web.mounts[0].target, "/data");
        assert_eq!(loaded_web.health_check.as_ref().unwrap().path, "/health");
        let loaded_worker = loaded
            .services
            .iter()
            .find(|service| service.name == "worker")
            .unwrap();
        assert_eq!(loaded_worker.depends_on, vec!["web".to_string()]);

        let mut deployment = Deployment::new(app.id, "abc123".to_string());
        deployment.status = DeploymentStatus::Building;
        db.save_deployment(&deployment).unwrap();
        db.append_deployment_log(deployment.id, "first line")
            .unwrap();
        db.append_deployment_log(deployment.id, "second line")
            .unwrap();

        let mut service_deployment =
            crate::models::ServiceDeployment::new(loaded_web.id, deployment.id, 0);
        service_deployment.status = crate::models::DeploymentStatus::Running;
        service_deployment.health = crate::models::ServiceHealth::Healthy;
        service_deployment.logs = vec!["service ready".to_string()];
        db.save_service_deployment(&service_deployment).unwrap();

        let service_deployments = db.list_service_deployments(deployment.id).unwrap();
        assert_eq!(service_deployments.len(), 1);
        assert_eq!(
            service_deployments[0].logs,
            vec!["service ready".to_string()]
        );

        let logs = db.get_deployment_logs(deployment.id, 10, 0).unwrap();
        assert_eq!(
            logs,
            vec!["first line".to_string(), "second line".to_string()]
        );

        let mut managed_db =
            ManagedDatabase::new(owner_id, "primary".to_string(), DatabaseType::Postgresql);
        managed_db.external_port = Some(32101);
        managed_db.pitr_enabled = true;
        managed_db.pitr_last_base_backup_at = Some(Utc::now());
        managed_db.pitr_last_base_backup_label = Some("base-1".to_string());
        managed_db.proxy_enabled = true;
        managed_db.proxy_external_port = Some(32103);
        managed_db.status = ServiceStatus::Running;
        db.save_managed_database(&managed_db).unwrap();
        let loaded_managed_db = db.get_managed_database(managed_db.id).unwrap().unwrap();
        assert_eq!(loaded_managed_db.external_port, Some(32101));
        assert!(loaded_managed_db.pitr_enabled);
        assert_eq!(
            loaded_managed_db.pitr_last_base_backup_label.as_deref(),
            Some("base-1")
        );
        assert!(loaded_managed_db.proxy_enabled);
        assert_eq!(loaded_managed_db.proxy_external_port, Some(32103));

        let mut managed_queue = ManagedQueue::new(owner_id, "events".to_string(), QueueType::Nats);
        managed_queue.external_port = Some(32102);
        managed_queue.status = ServiceStatus::Stopped;
        db.save_managed_queue(&managed_queue).unwrap();
        let loaded_managed_queue = db.get_managed_queue(managed_queue.id).unwrap().unwrap();
        assert_eq!(loaded_managed_queue.external_port, Some(32102));

        let bucket = StorageBucket::new(
            owner_id,
            "backups".to_string(),
            "http://localhost:9000".to_string(),
        );
        db.save_storage_bucket(&bucket).unwrap();
        let loaded_bucket = db.get_storage_bucket(bucket.id).unwrap().unwrap();
        assert!(loaded_bucket.access_key.is_empty());
        assert!(loaded_bucket.secret_key.is_empty());

        let mut github_app = crate::models::GithubAppConfig::builder(12345, "demo-app", owner_id)
            .client_id("client-id")
            .client_secret("client-secret")
            .private_key("private-key")
            .webhook_secret("webhook-secret")
            .html_url("https://github.com/apps/demo-app")
            .build();
        let mut installation = crate::models::GithubInstallation::new(
            67890,
            "demo-org".to_string(),
            "Organization".to_string(),
        );
        installation.repository_count = Some(24);
        github_app.installations.push(installation);
        db.save_github_app(&github_app).unwrap();

        let loaded_github_app = db.get_github_app(owner_id).unwrap().unwrap();
        assert_eq!(loaded_github_app.app_id, 12345);
        assert_eq!(loaded_github_app.installations.len(), 1);
        assert_eq!(
            loaded_github_app.installations[0].repository_count,
            Some(24)
        );
    }

    #[test]
    fn sled_backend_roundtrips() {
        roundtrip_backend(DatabaseBackendKind::Sled);
    }

    #[test]
    fn sqlite_backend_roundtrips() {
        roundtrip_backend(DatabaseBackendKind::Sqlite);
    }

    #[test]
    fn sqlite_backend_rejects_legacy_json_tables() {
        let config = temp_config(DatabaseBackendKind::Sqlite, "legacy-migration");
        std::fs::create_dir_all(std::path::Path::new(&config.path).parent().unwrap()).unwrap();
        let conn = rusqlite::Connection::open(&config.path).unwrap();
        conn.execute_batch(
            r#"
            create table apps (
                key text primary key,
                value text not null
            );
            "#,
        )
        .unwrap();
        drop(conn);

        match Database::open(&config) {
            Ok(_) => panic!("expected sqlite open to reject legacy json tables"),
            Err(error) => {
                assert!(error
                    .to_string()
                    .contains("unsupported legacy sqlite json tables detected: apps"));
            }
        }
    }
}
