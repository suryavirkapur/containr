use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use reqwest::{Client, Method, RequestBuilder};
use serde::Serialize;
use serde_json::Value;

use crate::client_config::ClientInstanceConfig;

pub struct ApiClient {
    base_url: String,
    client: Client,
    auth_token: Option<String>,
}

impl ApiClient {
    pub fn new(instance: &ClientInstanceConfig) -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(instance.timeout_secs))
            .danger_accept_invalid_certs(!instance.tls_verify)
            .build()
            .context("failed to build http client")?;

        let auth_token = first_non_empty(instance.api_key.as_deref())
            .or_else(|| first_non_empty(instance.token.as_deref()))
            .map(ToOwned::to_owned);

        Ok(Self {
            base_url: instance.url.trim_end_matches('/').to_string(),
            client,
            auth_token,
        })
    }

    pub fn has_auth(&self) -> bool {
        self.auth_token.is_some()
    }

    pub async fn get_json(&self, path: &str) -> Result<Value> {
        let request = self.request(Method::GET, path);
        self.send_json(request).await
    }

    pub async fn post_json<T: Serialize + ?Sized>(
        &self,
        path: &str,
        body: &T,
    ) -> Result<Value> {
        let request = self.request(Method::POST, path).json(body);
        self.send_json(request).await
    }

    pub async fn put_json<T: Serialize + ?Sized>(
        &self,
        path: &str,
        body: &T,
    ) -> Result<Value> {
        let request = self.request(Method::PUT, path).json(body);
        self.send_json(request).await
    }

    pub async fn post_empty(&self, path: &str) -> Result<Value> {
        let request = self.request(Method::POST, path);
        self.send_json(request).await
    }

    pub async fn delete(&self, path: &str) -> Result<Value> {
        let request = self.request(Method::DELETE, path);
        self.send_json(request).await
    }

    pub async fn get_text(&self, path: &str) -> Result<String> {
        let request = self.request(Method::GET, path);
        self.send_text(request).await
    }

    fn request(&self, method: Method, path: &str) -> RequestBuilder {
        let normalized_path = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{}", path)
        };
        let url = format!("{}{}", self.base_url, normalized_path);
        let request = self.client.request(method, url);

        match &self.auth_token {
            Some(token) => request.bearer_auth(token),
            None => request,
        }
    }

    async fn send_json(&self, request: RequestBuilder) -> Result<Value> {
        let text = self.send_text(request).await?;
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }

        serde_json::from_str(&text).context("failed to decode json response")
    }

    async fn send_text(&self, request: RequestBuilder) -> Result<String> {
        let response =
            request.send().await.context("failed to send request")?;
        let status = response.status();
        let text = response
            .text()
            .await
            .context("failed to read response body")?;

        if status.is_success() {
            return Ok(text);
        }

        if text.trim().is_empty() {
            return Err(anyhow!("request failed with status {}", status));
        }

        Err(anyhow!(
            "request failed with status {}: {}",
            status,
            text.trim()
        ))
    }
}

fn first_non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.trim().is_empty())
}
