//! cloudflare tunnel integration
//!
//! a domain marked `cloudflare` on a service is reachable only through a
//! cloudflare tunnel this module manages: containr creates a
//! remotely-configured tunnel via the api, points a proxied cname at it for
//! each domain, runs `cloudflared` locally so traffic reaches the pingora
//! proxy on loopback, and locks the host firewall down once nothing else
//! needs the public http/https ports.

mod client;
mod daemon;
mod firewall;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use chrono::{DateTime, Utc};
use containr_common::models::CloudflareSettings;
use containr_common::{Config, Database};
use rand::RngExt;
use tokio::process::Child;
use tokio::sync::{mpsc, Mutex, RwLock};
use tracing::{info, warn};
use uuid::Uuid;

use crate::security::{decrypt_value, encrypt_value};

pub use client::{CloudflareClient, Zone};

const TUNNEL_NAME: &str = "containr";
const CHILD_WATCH_SECS: u64 = 10;
const RESYNC_SECS: u64 = 15 * 60;
const RESTART_BACKOFF_SECS: u64 = 5;
const ZONE_CACHE_SECS: u64 = 300;

/// per-domain outcome of the last sync, surfaced in the status endpoint
#[derive(Debug, Clone)]
pub struct DomainStatus {
    pub domain: String,
    pub dns_ready: bool,
    pub error: Option<String>,
}

/// runtime view of the cloudflare integration for the status endpoint
#[derive(Debug, Clone, Default)]
pub struct RuntimeStatus {
    pub zones: Vec<Zone>,
    pub cloudflared_installed: bool,
    pub cloudflared_running: bool,
    /// whether the drop rule is actually installed right now
    pub firewall_active: bool,
    /// whether every public ingress is tunnel-fronted (drop rule wanted)
    pub firewall_required: bool,
    pub domains: Vec<DomainStatus>,
    pub last_sync_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
}

struct Inner {
    child: Option<Child>,
    binary: Option<PathBuf>,
    last_spawn: Option<Instant>,
    zones: Vec<Zone>,
    zones_at: Option<Instant>,
    domains: Vec<DomainStatus>,
    last_sync_at: Option<DateTime<Utc>>,
    last_error: Option<String>,
}

/// coordinates the tunnel, its dns records, the firewall and cloudflared
pub struct CloudflareManager {
    db: Database,
    config: Arc<RwLock<Config>>,
    data_dir: PathBuf,
    sync_tx: mpsc::Sender<()>,
    sync_lock: Mutex<()>,
    inner: Mutex<Inner>,
}

impl CloudflareManager {
    /// the receiver drives the supervisor loop in `run`
    pub fn new(
        db: Database,
        config: Arc<RwLock<Config>>,
        data_dir: PathBuf,
    ) -> (Self, mpsc::Receiver<()>) {
        let (sync_tx, sync_rx) = mpsc::channel(4);
        (
            Self {
                db,
                config,
                data_dir,
                sync_tx,
                sync_lock: Mutex::new(()),
                inner: Mutex::new(Inner {
                    child: None,
                    binary: None,
                    last_spawn: None,
                    zones: Vec::new(),
                    zones_at: None,
                    domains: Vec::new(),
                    last_sync_at: None,
                    last_error: None,
                }),
            },
            sync_rx,
        )
    }

    /// asks the supervisor to resync soon; cheap to call on any change
    pub fn request_sync(&self) {
        let _ = self.sync_tx.try_send(());
    }

    /// stored connection settings, if the server is connected
    pub fn settings(&self) -> Option<CloudflareSettings> {
        self.db.get_cloudflare_settings().ok().flatten()
    }

    pub fn connected(&self) -> bool {
        self.settings().is_some()
    }

    fn client_for(
        &self,
        config: &Config,
        settings: &CloudflareSettings,
    ) -> Result<CloudflareClient, String> {
        let token = decrypt_value(config, &settings.api_token)
            .map_err(|error| format!("cloudflare api token: {}", error))?;
        Ok(CloudflareClient::new(&token, &settings.account_id))
    }

    /// verifies the token, creates (or reuses) the tunnel and stores the
    /// credentials; cloudflared starts on the next sync
    pub async fn connect(
        &self,
        api_token: &str,
        account_id: &str,
    ) -> Result<(), String> {
        // no /user/tokens/verify call: account-owned api tokens get
        // "Invalid API Token (1000)" there even though they work on the
        // account endpoints, so real calls double as the credential check
        let client = CloudflareClient::new(api_token, account_id);
        let zones = client.list_zones().await?;

        let tunnel = match client.find_tunnel(TUNNEL_NAME).await? {
            Some(tunnel) => tunnel,
            None => client.create_tunnel(TUNNEL_NAME, &tunnel_secret()).await?,
        };
        let tunnel_token = client.tunnel_token(&tunnel.id).await?;

        let config = self.config.read().await.clone();
        let now = Utc::now();
        let settings = CloudflareSettings {
            api_token: encrypt_value(&config, api_token).map_err(|error| {
                format!("cannot store api token: {}", error)
            })?,
            account_id: account_id.trim().to_string(),
            tunnel_id: Some(tunnel.id),
            tunnel_name: Some(tunnel.name),
            tunnel_token: Some(encrypt_value(&config, &tunnel_token).map_err(
                |error| format!("cannot store tunnel token: {}", error),
            )?),
            created_at: self
                .settings()
                .map(|existing| existing.created_at)
                .unwrap_or(now),
            updated_at: now,
        };
        self.db
            .save_cloudflare_settings(&settings)
            .map_err(|error| error.to_string())?;

        {
            let mut inner = self.inner.lock().await;
            inner.zones = zones;
            inner.zones_at = Some(Instant::now());
            inner.last_error = None;
        }

        self.sync().await;
        Ok(())
    }

    /// removes the tunnel and its dns records, stops cloudflared, clears
    /// every service's cloudflare flag and restores direct routing.
    /// returns the app ids whose proxy routes need a refresh
    pub async fn disconnect(&self) -> Result<Vec<Uuid>, String> {
        self.stop_cloudflared().await;

        let mut affected_apps = Vec::new();
        if let Some(settings) = self.settings() {
            let config = self.config.read().await.clone();
            if let Ok(client) = self.client_for(&config, &settings) {
                // zones may be cold after a restart; refresh before cleaning
                let _ = self.zones(&client).await;
                let target = settings
                    .tunnel_id
                    .as_deref()
                    .map(tunnel_target)
                    .unwrap_or_default();
                if !target.is_empty() {
                    let _ = self
                        .remove_tunnel_dns(&client, &target, &HashSet::new())
                        .await;
                }
                if let Some(tunnel_id) = settings.tunnel_id.as_deref() {
                    if let Err(error) = client.delete_tunnel(tunnel_id).await {
                        warn!(error = %error, "failed to delete cloudflare tunnel");
                    }
                }
            }
        }

        self.db
            .delete_cloudflare_settings()
            .map_err(|error| error.to_string())?;

        // services keep working: clearing the flag makes their domains
        // direct routes again so nothing goes dark
        for mut app in self.db.list_apps().map_err(|e| e.to_string())? {
            let mut changed = false;
            for service in &mut app.services {
                if !service.cloudflare_domains.is_empty() {
                    service.cloudflare_domains.clear();
                    service.updated_at = Utc::now();
                    changed = true;
                }
            }
            if changed {
                app.updated_at = Utc::now();
                self.db.save_app(&app).map_err(|error| error.to_string())?;
                affected_apps.push(app.id);
            }
        }

        if let Err(error) = firewall::remove().await {
            warn!(error = %error, "failed to remove cloudflare firewall rules");
        }

        {
            let mut inner = self.inner.lock().await;
            inner.zones.clear();
            inner.zones_at = None;
            inner.domains.clear();
            inner.last_error = None;
        }
        Ok(affected_apps)
    }

    /// reconciles tunnel ingress, dns records, the firewall and cloudflared
    /// with the currently configured cloudflare domains
    pub async fn sync(&self) {
        let _guard = self.sync_lock.lock().await;

        let Some(settings) = self.settings() else {
            self.stop_cloudflared().await;
            let _ = firewall::remove().await;
            return;
        };

        let config = self.config.read().await.clone();
        let client = match self.client_for(&config, &settings) {
            Ok(client) => client,
            Err(error) => {
                self.set_error(error).await;
                return;
            }
        };
        let Some(tunnel_id) = settings.tunnel_id.clone() else {
            self.set_error("cloudflare tunnel is not provisioned".to_string())
                .await;
            return;
        };

        let desired = self.cloudflare_domains();
        let target = tunnel_target(&tunnel_id);
        let mut errors = Vec::new();

        let origin = format!("http://127.0.0.1:{}", config.proxy.http_port);
        if let Err(error) =
            client.set_ingress(&tunnel_id, &desired, &origin).await
        {
            warn!(error = %error, "failed to push tunnel ingress rules");
            errors.push(error);
        }

        let zones = self.zones(&client).await;
        let mut domain_status = Vec::new();
        for domain in &desired {
            match zone_for(&zones, domain) {
                Some(zone) => {
                    match self
                        .ensure_dns_record(&client, &zone.id, domain, &target)
                        .await
                    {
                        Ok(()) => domain_status.push(DomainStatus {
                            domain: domain.clone(),
                            dns_ready: true,
                            error: None,
                        }),
                        Err(error) => {
                            warn!(domain = %domain, error = %error, "dns record sync failed");
                            domain_status.push(DomainStatus {
                                domain: domain.clone(),
                                dns_ready: false,
                                error: Some(error.clone()),
                            });
                            errors.push(error);
                        }
                    }
                }
                None => {
                    let error =
                        "no cloudflare zone covers this domain".to_string();
                    domain_status.push(DomainStatus {
                        domain: domain.clone(),
                        dns_ready: false,
                        error: Some(error),
                    });
                }
            }
        }

        if let Err(error) = self
            .remove_tunnel_dns(&client, &target, &desired_set(&desired))
            .await
        {
            warn!(error = %error, "failed to clean up tunnel dns records");
        }

        // ports only close once the tunnel carries every public hostname;
        // the dashboard and any direct domains keep them open
        let firewall_required =
            !desired.is_empty() && !self.any_direct_ingress(&config);
        let firewall_active = if firewall_required {
            match firewall::apply(&[
                config.proxy.http_port,
                config.proxy.https_port,
            ])
            .await
            {
                Ok(()) => true,
                Err(error) => {
                    warn!(error = %error, "failed to apply cloudflare firewall rules");
                    errors.push(error);
                    false
                }
            }
        } else {
            let _ = firewall::remove().await;
            false
        };

        self.ensure_cloudflared(&config, &settings).await;

        let mut inner = self.inner.lock().await;
        inner.domains = domain_status;
        inner.last_sync_at = Some(Utc::now());
        inner.last_error = errors.first().cloned();
        if !errors.is_empty() {
            warn!(errors = ?errors, "cloudflare sync finished with errors");
        }
        info!(
            domains = desired.len(),
            firewall = firewall_active,
            "cloudflare sync complete"
        );
    }

    /// every custom domain marked for cloudflare routing across all apps
    pub fn cloudflare_domains(&self) -> Vec<String> {
        let mut domains = Vec::new();
        if let Ok(apps) = self.db.list_apps() {
            for app in apps {
                for service in &app.services {
                    for domain in service.cloudflare_domains() {
                        if !domains.iter().any(|existing| existing == &domain) {
                            domains.push(domain);
                        }
                    }
                }
            }
        }
        domains.sort();
        domains
    }

    /// zone names the connected account can manage, from the last sync
    pub async fn zone_names(&self) -> Vec<String> {
        self.inner
            .lock()
            .await
            .zones
            .iter()
            .map(|zone| zone.name.clone())
            .collect()
    }

    /// refetches zones from cloudflare and updates the cache
    pub async fn refresh_zones(&self) -> Result<Vec<Zone>, String> {
        let settings = self
            .settings()
            .ok_or_else(|| "cloudflare is not connected".to_string())?;
        let config = self.config.read().await.clone();
        let client = self.client_for(&config, &settings)?;
        let zones = client.list_zones().await?;
        let mut inner = self.inner.lock().await;
        inner.zones = zones.clone();
        inner.zones_at = Some(Instant::now());
        Ok(zones)
    }

    pub async fn status(&self) -> RuntimeStatus {
        let inner = self.inner.lock().await;
        let running = inner.child.is_some();
        let config = self.config.read().await.clone();
        RuntimeStatus {
            zones: inner.zones.clone(),
            cloudflared_installed: inner.binary.is_some(),
            cloudflared_running: running,
            firewall_active: firewall::is_active().await,
            firewall_required: !self.cloudflare_domains().is_empty()
                && !self.any_direct_ingress(&config),
            domains: inner.domains.clone(),
            last_sync_at: inner.last_sync_at,
            last_error: inner.last_error.clone(),
        }
    }

    /// keeps cloudflared alive and resyncs when asked or on the timer
    pub async fn run(&self, mut sync_rx: mpsc::Receiver<()>) {
        // an initial pass restores the tunnel after a restart
        self.sync().await;

        let mut child_watch =
            tokio::time::interval(Duration::from_secs(CHILD_WATCH_SECS));
        let mut resync =
            tokio::time::interval(Duration::from_secs(RESYNC_SECS));
        resync.reset();

        loop {
            tokio::select! {
                _ = child_watch.tick() => {
                    self.supervise_child().await;
                }
                _ = resync.tick() => {
                    self.sync().await;
                }
                request = sync_rx.recv() => {
                    match request {
                        Some(()) => self.sync().await,
                        None => break,
                    }
                }
            }
        }
    }

    async fn zones(&self, client: &CloudflareClient) -> Vec<Zone> {
        {
            let inner = self.inner.lock().await;
            if inner.zones_at.is_some_and(|at| {
                at.elapsed() < Duration::from_secs(ZONE_CACHE_SECS)
            }) {
                return inner.zones.clone();
            }
        }
        match client.list_zones().await {
            Ok(zones) => {
                let mut inner = self.inner.lock().await;
                inner.zones = zones.clone();
                inner.zones_at = Some(Instant::now());
                zones
            }
            Err(error) => {
                warn!(error = %error, "failed to list cloudflare zones");
                self.inner.lock().await.zones.clone()
            }
        }
    }

    /// creates the proxied cname when the zone does not already point the
    /// domain at this tunnel
    async fn ensure_dns_record(
        &self,
        client: &CloudflareClient,
        zone_id: &str,
        domain: &str,
        target: &str,
    ) -> Result<(), String> {
        let records = client.list_dns_records(zone_id).await?;
        let already = records.iter().any(|record| {
            record.name.eq_ignore_ascii_case(domain)
                && record.content.eq_ignore_ascii_case(target)
        });
        if already {
            return Ok(());
        }
        client.create_dns_cname(zone_id, domain, target).await
    }

    /// deletes cnames that point at this tunnel but are no longer wanted
    async fn remove_tunnel_dns(
        &self,
        client: &CloudflareClient,
        target: &str,
        keep: &HashSet<String>,
    ) -> Result<(), String> {
        let zones = self.inner.lock().await.zones.clone();
        for zone in zones {
            let records = client.list_dns_records(&zone.id).await?;
            for record in records {
                if record.record_type != "CNAME"
                    || !record.content.eq_ignore_ascii_case(target)
                    || keep.contains(&record.name.to_lowercase())
                {
                    continue;
                }
                info!(domain = %record.name, "removing stale tunnel dns record");
                if let Err(error) =
                    client.delete_dns_record(&zone.id, &record.id).await
                {
                    warn!(domain = %record.name, error = %error, "failed to delete tunnel dns record");
                }
            }
        }
        Ok(())
    }

    /// true when anything public still needs :80/:443 reachable: the
    /// dashboard, external routes, storage, or any service domain that is
    /// not tunnel-fronted
    fn any_direct_ingress(&self, config: &Config) -> bool {
        if !config.proxy.base_domain.trim().is_empty() {
            return true;
        }
        if config
            .storage
            .rustfs_public_hostname
            .as_deref()
            .is_some_and(|hostname| !hostname.trim().is_empty())
        {
            return true;
        }
        if !config.proxy.external_routes.is_empty() {
            return true;
        }

        let apps = self.db.list_apps().unwrap_or_default();
        apps.iter().any(|app| {
            app.services.iter().any(|service| {
                if !service.is_public_http() {
                    return false;
                }
                let cloudflare = service.cloudflare_domains();
                if cloudflare.is_empty() {
                    // the default service url is public ingress
                    return true;
                }
                service
                    .custom_domains()
                    .iter()
                    .any(|domain| !cloudflare.contains(domain))
            })
        })
    }

    async fn ensure_cloudflared(
        &self,
        config: &Config,
        settings: &CloudflareSettings,
    ) {
        let mut inner = self.inner.lock().await;
        if let Some(child) = inner.child.as_mut() {
            match child.try_wait() {
                Ok(None) => return,
                Ok(Some(status)) => {
                    warn!(status = %status, "cloudflared exited");
                    inner.child = None;
                }
                Err(error) => {
                    warn!(error = %error, "failed to check cloudflared");
                    inner.child = None;
                }
            }
        }

        if inner.last_spawn.is_some_and(|at| {
            at.elapsed() < Duration::from_secs(RESTART_BACKOFF_SECS)
        }) {
            return;
        }

        let token = match settings.tunnel_token.as_deref() {
            Some(token) => match decrypt_value(config, token) {
                Ok(token) => token,
                Err(error) => {
                    warn!(error = %error, "cannot read tunnel token");
                    inner.last_error =
                        Some(format!("cannot read tunnel token: {}", error));
                    return;
                }
            },
            None => {
                warn!(
                    "cloudflare tunnel token missing; cloudflared cannot start"
                );
                inner.last_error = Some("tunnel token missing".to_string());
                return;
            }
        };

        let binary = match daemon::ensure_binary(&self.data_dir).await {
            Ok(binary) => binary,
            Err(error) => {
                warn!(error = %error, "cloudflared is not available");
                inner.last_error =
                    Some(format!("cloudflared unavailable: {}", error));
                return;
            }
        };

        match daemon::spawn(&binary, &token) {
            Ok(child) => {
                info!(binary = %binary.display(), "cloudflared started");
                inner.binary = Some(binary);
                inner.child = Some(child);
                inner.last_spawn = Some(Instant::now());
                inner.last_error = None;
            }
            Err(error) => {
                warn!(error = %error, "failed to spawn cloudflared");
                inner.last_error =
                    Some(format!("cloudflared failed to start: {}", error));
                inner.last_spawn = Some(Instant::now());
            }
        }
    }

    /// restarts the connector if it died since the last sync
    async fn supervise_child(&self) {
        let Some(settings) = self.settings() else {
            return;
        };
        let config = self.config.read().await.clone();
        self.ensure_cloudflared(&config, &settings).await;
    }

    async fn stop_cloudflared(&self) {
        let mut inner = self.inner.lock().await;
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill().await;
        }
    }

    async fn set_error(&self, error: String) {
        self.inner.lock().await.last_error = Some(error);
    }
}

fn tunnel_target(tunnel_id: &str) -> String {
    format!("{}.cfargotunnel.com", tunnel_id)
}

fn desired_set(domains: &[String]) -> HashSet<String> {
    domains.iter().map(|domain| domain.to_lowercase()).collect()
}

fn zone_for<'a>(zones: &'a [Zone], domain: &str) -> Option<&'a Zone> {
    zones
        .iter()
        .filter(|zone| {
            domain == zone.name || domain.ends_with(&format!(".{}", zone.name))
        })
        .max_by_key(|zone| zone.name.len())
}

fn tunnel_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
