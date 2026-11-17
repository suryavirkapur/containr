//! thin client for the cloudflare v4 api

use reqwest::{Client, RequestBuilder};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

const API_BASE: &str = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE: u32 = 50;
const MAX_PAGES: u32 = 20;

#[derive(Debug, Clone)]
pub struct CloudflareClient {
    http: Client,
    token: String,
    pub account_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Zone {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Tunnel {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DnsRecord {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub record_type: String,
    pub content: String,
    #[serde(default)]
    pub proxied: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct IngressRule {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    pub service: String,
}

#[derive(Debug, Deserialize)]
struct Envelope<T> {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    errors: Vec<EnvelopeError>,
    result: Option<T>,
}

#[derive(Debug, Deserialize)]
struct EnvelopeError {
    code: i64,
    message: String,
}

impl CloudflareClient {
    pub fn new(api_token: &str, account_id: &str) -> Self {
        Self {
            http: Client::new(),
            token: api_token.trim().to_string(),
            account_id: account_id.trim().to_string(),
        }
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}/accounts/{}{}", API_BASE, self.account_id, path)
    }

    async fn send<T: DeserializeOwned>(
        &self,
        request: RequestBuilder,
        what: &str,
    ) -> Result<T, String> {
        let response = request
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|error| format!("{}: request failed: {}", what, error))?;
        let status = response.status();
        let body = response.text().await.map_err(|error| {
            format!("{}: failed to read response: {}", what, error)
        })?;

        let envelope: Envelope<T> =
            serde_json::from_str(&body).map_err(|_| {
                format!("{}: unexpected response (status {})", what, status)
            })?;
        if !status.is_success() || !envelope.success {
            let details = envelope
                .errors
                .iter()
                .map(|error| format!("{} ({})", error.message, error.code))
                .collect::<Vec<_>>()
                .join("; ");
            return Err(format!(
                "{}: {}",
                what,
                if details.is_empty() {
                    format!("cloudflare api returned status {}", status)
                } else {
                    details
                }
            ));
        }
        envelope
            .result
            .ok_or_else(|| format!("{}: cloudflare returned no result", what))
    }

    pub async fn list_zones(&self) -> Result<Vec<Zone>, String> {
        let mut zones = Vec::new();
        let mut page = 1;
        loop {
            let mut url = url::Url::parse(&format!("{}/zones", API_BASE))
                .map_err(|error| error.to_string())?;
            url.query_pairs_mut()
                .append_pair("per_page", &PAGE_SIZE.to_string())
                .append_pair("page", &page.to_string());
            let batch: Vec<Zone> =
                self.send(self.http.get(url), "list zones").await?;
            let done = batch.len() < PAGE_SIZE as usize;
            zones.extend(batch);
            if done || page >= MAX_PAGES {
                return Ok(zones);
            }
            page += 1;
        }
    }

    /// finds a live tunnel by name, ignoring soft-deleted ones
    pub async fn find_tunnel(
        &self,
        name: &str,
    ) -> Result<Option<Tunnel>, String> {
        let mut url = url::Url::parse(&self.endpoint("/cfd_tunnel"))
            .map_err(|error| error.to_string())?;
        url.query_pairs_mut()
            .append_pair("name", name)
            .append_pair("is_deleted", "false");
        let tunnels: Vec<Tunnel> =
            self.send(self.http.get(url), "find tunnel").await?;
        Ok(tunnels.into_iter().next())
    }

    /// creates a remotely-managed tunnel; `secret` is base64 encoded 32
    /// bytes as the cloudflare api expects
    pub async fn create_tunnel(
        &self,
        name: &str,
        secret: &str,
    ) -> Result<Tunnel, String> {
        #[derive(Serialize)]
        struct CreateTunnel<'a> {
            name: &'a str,
            tunnel_secret: &'a str,
            config_src: &'a str,
        }
        self.send(
            self.http
                .post(self.endpoint("/cfd_tunnel"))
                .json(&CreateTunnel {
                    name,
                    tunnel_secret: secret,
                    config_src: "cloudflare",
                }),
            "create tunnel",
        )
        .await
    }

    /// deletes active connections first so the tunnel can be removed
    pub async fn delete_tunnel(&self, tunnel_id: &str) -> Result<(), String> {
        let _: serde_json::Value = self
            .send(
                self.http.delete(self.endpoint(&format!(
                    "/cfd_tunnel/{}/connections",
                    tunnel_id
                ))),
                "disconnect tunnel",
            )
            .await
            .unwrap_or(serde_json::Value::Null);
        self.send::<serde_json::Value>(
            self.http
                .delete(self.endpoint(&format!("/cfd_tunnel/{}", tunnel_id))),
            "delete tunnel",
        )
        .await?;
        Ok(())
    }

    /// token that cloudflared uses to run the tunnel
    pub async fn tunnel_token(
        &self,
        tunnel_id: &str,
    ) -> Result<String, String> {
        self.send(
            self.http.get(
                self.endpoint(&format!("/cfd_tunnel/{}/token", tunnel_id)),
            ),
            "get tunnel token",
        )
        .await
    }

    /// replaces the tunnel's ingress rules; every hostname rule forwards to
    /// the containr proxy and the catch-all returns 404
    pub async fn set_ingress(
        &self,
        tunnel_id: &str,
        hostnames: &[String],
        origin: &str,
    ) -> Result<(), String> {
        let mut ingress: Vec<IngressRule> = hostnames
            .iter()
            .map(|hostname| IngressRule {
                hostname: Some(hostname.clone()),
                service: origin.to_string(),
            })
            .collect();
        ingress.push(IngressRule {
            hostname: None,
            service: "http_status:404".to_string(),
        });
        #[derive(Serialize)]
        struct Config {
            ingress: Vec<IngressRule>,
        }
        #[derive(Serialize)]
        struct Body {
            config: Config,
        }
        self.send::<serde_json::Value>(
            self.http
                .put(self.endpoint(&format!(
                    "/cfd_tunnel/{}/configurations",
                    tunnel_id
                )))
                .json(&Body {
                    config: Config { ingress },
                }),
            "update tunnel ingress",
        )
        .await?;
        Ok(())
    }

    pub async fn list_dns_records(
        &self,
        zone_id: &str,
    ) -> Result<Vec<DnsRecord>, String> {
        let mut records = Vec::new();
        let mut page = 1;
        loop {
            let mut url = url::Url::parse(&format!(
                "{}/zones/{}/dns_records",
                API_BASE, zone_id
            ))
            .map_err(|error| error.to_string())?;
            url.query_pairs_mut()
                .append_pair("per_page", &PAGE_SIZE.to_string())
                .append_pair("page", &page.to_string());
            let batch: Vec<DnsRecord> =
                self.send(self.http.get(url), "list dns records").await?;
            let done = batch.len() < PAGE_SIZE as usize;
            records.extend(batch);
            if done || page >= MAX_PAGES {
                return Ok(records);
            }
            page += 1;
        }
    }

    /// creates a proxied cname for `name` pointing at `content`
    pub async fn create_dns_cname(
        &self,
        zone_id: &str,
        name: &str,
        content: &str,
    ) -> Result<(), String> {
        #[derive(Serialize)]
        struct Record<'a> {
            #[serde(rename = "type")]
            record_type: &'a str,
            name: &'a str,
            content: &'a str,
            proxied: bool,
            ttl: u32,
            comment: &'a str,
        }
        self.send::<serde_json::Value>(
            self.http
                .post(format!("{}/zones/{}/dns_records", API_BASE, zone_id))
                .json(&Record {
                    record_type: "CNAME",
                    name,
                    content,
                    proxied: true,
                    ttl: 1,
                    comment: "managed by containr",
                }),
            "create dns record",
        )
        .await?;
        Ok(())
    }

    pub async fn delete_dns_record(
        &self,
        zone_id: &str,
        record_id: &str,
    ) -> Result<(), String> {
        self.send::<serde_json::Value>(
            self.http.delete(format!(
                "{}/zones/{}/dns_records/{}",
                API_BASE, zone_id, record_id
            )),
            "delete dns record",
        )
        .await?;
        Ok(())
    }
}
