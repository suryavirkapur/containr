//! sled database wrapper for znskr

use serde::{de::DeserializeOwned, Serialize};
use sled::Db;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::models::{App, Certificate, Deployment, User};

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
}
