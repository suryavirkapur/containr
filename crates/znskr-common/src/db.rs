//! sled database wrapper for znskr

use serde::{de::DeserializeOwned, Serialize};
use sled::Db;
use uuid::Uuid;

use crate::error::Result;
use crate::managed_services::{ManagedDatabase, StorageBucket};
use crate::models::{App, Certificate, ContainerService, Deployment, ServiceDeployment, User};

/// database wrapper providing typed access to sled trees
#[derive(Clone)]
pub struct Database {
    db: Db,
}

impl Database {
    // opens or creates a new database at the given path
    pub fn open(path: &str) -> Result<Self> {
        let db = sled::open(path)?;
        Ok(Self { db })
    }

    // flushes all pending writes to disk
    pub fn flush(&self) -> Result<()> {
        self.db.flush()?;
        Ok(())
    }

    // --- generic helpers ---

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

    // --- users ---

    // inserts or updates a user
    pub fn save_user(&self, user: &User) -> Result<()> {
        let tree = self.get_tree("users")?;
        self.insert(&tree, &user.id.to_string(), user)
    }

    // gets a user by id
    pub fn get_user(&self, id: Uuid) -> Result<Option<User>> {
        let tree = self.get_tree("users")?;
        self.get(&tree, &id.to_string())
    }

    // gets a user by email
    pub fn get_user_by_email(&self, email: &str) -> Result<Option<User>> {
        let tree = self.get_tree("users")?;
        for result in tree.iter() {
            let (_, value) = result?;
            let user: User = serde_json::from_slice(&value)?;
            if user.email == email {
                return Ok(Some(user));
            }
        }
        Ok(None)
    }

    // gets a user by github id
    pub fn get_user_by_github_id(&self, github_id: i64) -> Result<Option<User>> {
        let tree = self.get_tree("users")?;
        for result in tree.iter() {
            let (_, value) = result?;
            let user: User = serde_json::from_slice(&value)?;
            if user.github_id == Some(github_id) {
                return Ok(Some(user));
            }
        }
        Ok(None)
    }

    // --- apps ---

    // inserts or updates an app
    pub fn save_app(&self, app: &App) -> Result<()> {
        let tree = self.get_tree("apps")?;
        self.insert(&tree, &app.id.to_string(), app)
    }

    // gets an app by id
    pub fn get_app(&self, id: Uuid) -> Result<Option<App>> {
        let tree = self.get_tree("apps")?;
        self.get(&tree, &id.to_string())
    }

    // lists all apps for a user
    pub fn list_apps_by_owner(&self, owner_id: Uuid) -> Result<Vec<App>> {
        let tree = self.get_tree("apps")?;
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

    // gets an app by domain
    pub fn get_app_by_domain(&self, domain: &str) -> Result<Option<App>> {
        let tree = self.get_tree("apps")?;
        for result in tree.iter() {
            let (_, value) = result?;
            let app: App = serde_json::from_slice(&value)?;
            if app.domain.as_deref() == Some(domain) {
                return Ok(Some(app));
            }
        }
        Ok(None)
    }

    // deletes an app by id
    pub fn delete_app(&self, id: Uuid) -> Result<bool> {
        let tree = self.get_tree("apps")?;
        self.delete(&tree, &id.to_string())
    }

    // finds an app by github url and branch
    pub fn get_app_by_github_url(&self, github_url: &str, branch: &str) -> Result<Option<App>> {
        let tree = self.get_tree("apps")?;
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

    // --- services ---

    /// inserts or updates a container service
    pub fn save_service(&self, service: &ContainerService) -> Result<()> {
        let tree = self.get_tree("services")?;
        self.insert(&tree, &service.id.to_string(), service)
    }

    /// gets a service by id
    pub fn get_service(&self, id: Uuid) -> Result<Option<ContainerService>> {
        let tree = self.get_tree("services")?;
        self.get(&tree, &id.to_string())
    }

    /// lists all services for an app
    pub fn list_services_by_app(&self, app_id: Uuid) -> Result<Vec<ContainerService>> {
        let tree = self.get_tree("services")?;
        let mut services = Vec::new();
        for result in tree.iter() {
            let (_, value) = result?;
            let service: ContainerService = serde_json::from_slice(&value)?;
            if service.app_id == app_id {
                services.push(service);
            }
        }
        // sort by name for consistent ordering
        services.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(services)
    }

    /// deletes a service by id
    pub fn delete_service(&self, id: Uuid) -> Result<bool> {
        let tree = self.get_tree("services")?;
        self.delete(&tree, &id.to_string())
    }

    /// deletes all services for an app
    pub fn delete_services_by_app(&self, app_id: Uuid) -> Result<usize> {
        let services = self.list_services_by_app(app_id)?;
        let count = services.len();
        for service in services {
            self.delete_service(service.id)?;
        }
        Ok(count)
    }

    // --- service deployments ---

    /// inserts or updates a service deployment
    pub fn save_service_deployment(&self, deployment: &ServiceDeployment) -> Result<()> {
        let tree = self.get_tree("service_deployments")?;
        self.insert(&tree, &deployment.id.to_string(), deployment)
    }

    /// gets a service deployment by id
    pub fn get_service_deployment(&self, id: Uuid) -> Result<Option<ServiceDeployment>> {
        let tree = self.get_tree("service_deployments")?;
        self.get(&tree, &id.to_string())
    }

    /// lists all service deployments for a deployment
    pub fn list_service_deployments(&self, deployment_id: Uuid) -> Result<Vec<ServiceDeployment>> {
        let tree = self.get_tree("service_deployments")?;
        let mut deployments = Vec::new();
        for result in tree.iter() {
            let (_, value) = result?;
            let sd: ServiceDeployment = serde_json::from_slice(&value)?;
            if sd.deployment_id == deployment_id {
                deployments.push(sd);
            }
        }
        // sort by service_id then replica_index
        deployments.sort_by(|a, b| {
            a.service_id.cmp(&b.service_id).then(a.replica_index.cmp(&b.replica_index))
        });
        Ok(deployments)
    }

    /// lists service deployments for a specific service
    pub fn list_service_deployments_by_service(&self, service_id: Uuid) -> Result<Vec<ServiceDeployment>> {
        let tree = self.get_tree("service_deployments")?;
        let mut deployments = Vec::new();
        for result in tree.iter() {
            let (_, value) = result?;
            let sd: ServiceDeployment = serde_json::from_slice(&value)?;
            if sd.service_id == service_id {
                deployments.push(sd);
            }
        }
        deployments.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(deployments)
    }

    // --- deployments ---

    // inserts or updates a deployment
    pub fn save_deployment(&self, deployment: &Deployment) -> Result<()> {
        let tree = self.get_tree("deployments")?;
        self.insert(&tree, &deployment.id.to_string(), deployment)
    }

    // gets a deployment by id
    pub fn get_deployment(&self, id: Uuid) -> Result<Option<Deployment>> {
        let tree = self.get_tree("deployments")?;
        self.get(&tree, &id.to_string())
    }

    // lists all deployments for an app, newest first
    pub fn list_deployments_by_app(&self, app_id: Uuid) -> Result<Vec<Deployment>> {
        let tree = self.get_tree("deployments")?;
        let mut deployments = Vec::new();
        for result in tree.iter() {
            let (_, value) = result?;
            let deployment: Deployment = serde_json::from_slice(&value)?;
            if deployment.app_id == app_id {
                deployments.push(deployment);
            }
        }
        // sort by created_at descending
        deployments.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(deployments)
    }

    // gets the latest deployment for an app
    pub fn get_latest_deployment(&self, app_id: Uuid) -> Result<Option<Deployment>> {
        let deployments = self.list_deployments_by_app(app_id)?;
        Ok(deployments.into_iter().next())
    }

    // --- certificates ---

    // inserts or updates a certificate
    pub fn save_certificate(&self, cert: &Certificate) -> Result<()> {
        let tree = self.get_tree("certificates")?;
        self.insert(&tree, &cert.domain, cert)
    }

    // gets a certificate by domain
    pub fn get_certificate(&self, domain: &str) -> Result<Option<Certificate>> {
        let tree = self.get_tree("certificates")?;
        self.get(&tree, domain)
    }

    // lists all certificates
    pub fn list_certificates(&self) -> Result<Vec<Certificate>> {
        let tree = self.get_tree("certificates")?;
        self.list(&tree)
    }

    // deletes a certificate by domain
    pub fn delete_certificate(&self, domain: &str) -> Result<bool> {
        let tree = self.get_tree("certificates")?;
        self.delete(&tree, domain)
    }

    // --- managed databases ---

    /// inserts or updates a managed database
    pub fn save_managed_database(&self, db: &ManagedDatabase) -> Result<()> {
        let tree = self.get_tree("managed_databases")?;
        self.insert(&tree, &db.id.to_string(), db)
    }

    /// gets a managed database by id
    pub fn get_managed_database(&self, id: Uuid) -> Result<Option<ManagedDatabase>> {
        let tree = self.get_tree("managed_databases")?;
        self.get(&tree, &id.to_string())
    }

    /// lists all managed databases for an owner
    pub fn list_managed_databases_by_owner(&self, owner_id: Uuid) -> Result<Vec<ManagedDatabase>> {
        let tree = self.get_tree("managed_databases")?;
        let mut databases = Vec::new();
        for result in tree.iter() {
            let (_, value) = result?;
            let db: ManagedDatabase = serde_json::from_slice(&value)?;
            if db.owner_id == owner_id {
                databases.push(db);
            }
        }
        databases.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(databases)
    }

    /// deletes a managed database by id
    pub fn delete_managed_database(&self, id: Uuid) -> Result<bool> {
        let tree = self.get_tree("managed_databases")?;
        self.delete(&tree, &id.to_string())
    }

    // --- storage buckets ---

    /// inserts or updates a storage bucket
    pub fn save_storage_bucket(&self, bucket: &StorageBucket) -> Result<()> {
        let tree = self.get_tree("storage_buckets")?;
        self.insert(&tree, &bucket.id.to_string(), bucket)
    }

    /// gets a storage bucket by id
    pub fn get_storage_bucket(&self, id: Uuid) -> Result<Option<StorageBucket>> {
        let tree = self.get_tree("storage_buckets")?;
        self.get(&tree, &id.to_string())
    }

    /// lists all storage buckets for an owner
    pub fn list_storage_buckets_by_owner(&self, owner_id: Uuid) -> Result<Vec<StorageBucket>> {
        let tree = self.get_tree("storage_buckets")?;
        let mut buckets = Vec::new();
        for result in tree.iter() {
            let (_, value) = result?;
            let bucket: StorageBucket = serde_json::from_slice(&value)?;
            if bucket.owner_id == owner_id {
                buckets.push(bucket);
            }
        }
        buckets.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(buckets)
    }

    /// deletes a storage bucket by id
    pub fn delete_storage_bucket(&self, id: Uuid) -> Result<bool> {
        let tree = self.get_tree("storage_buckets")?;
        self.delete(&tree, &id.to_string())
    }
}

