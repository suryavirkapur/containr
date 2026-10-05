//! containr login gate: gives a logged-in user a short-lived pass for a
//! gated service domain. the proxy on that domain trades the pass for a
//! session cookie.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use url::Url;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use containr_common::access_gate::{
    issue_gate_token, GateTokenKind, GATE_CALLBACK_PATH,
};
use containr_common::config::ProxyConfig;
use containr_common::models::{default_service_domain, App, LoginGateScope};

type ApiError = (StatusCode, Json<ErrorResponse>);

#[derive(Debug, Deserialize, ToSchema)]
pub struct GatePassRequest {
    /// the gated domain the user wants to open
    pub host: String,
    /// path to land on after the gate, e.g. `/?pgsql=pg`
    pub return_to: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GatePassResponse {
    /// where to send the browser next
    pub redirect_url: String,
}

/// a gated domain and who may open it
#[derive(Debug, PartialEq, Eq)]
struct GatedTarget {
    owner_id: Uuid,
    scope: LoginGateScope,
    /// scheme, host and port, without a trailing slash
    origin: String,
}

#[utoipa::path(
    post,
    path = "/api/gate/pass",
    tag = "auth",
    request_body = GatePassRequest,
    security(("bearer" = [])),
    responses(
        (status = 200, description = "pass issued", body = GatePassResponse),
        (status = 401, description = "not logged in", body = ErrorResponse),
        (status = 403, description = "not allowed to open this service", body = ErrorResponse),
        (status = 404, description = "no login gate on this domain", body = ErrorResponse)
    )
)]
pub async fn create_gate_pass(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<GatePassRequest>,
) -> Result<Json<GatePassResponse>, ApiError> {
    let user_id = get_user_id(&state, &headers).await?;
    let config = state.config.read().await.clone();
    let host = normalize_host(&req.host);

    let apps = state.db.list_apps().map_err(internal_error)?;
    let target =
        find_gated_target(&apps, &config.proxy, &host).ok_or_else(|| {
            error(StatusCode::NOT_FOUND, "this domain has no containr login")
        })?;
    let allowed = match target.scope {
        LoginGateScope::Owner => target.owner_id == user_id,
        LoginGateScope::AllUsers => state
            .db
            .get_user(user_id)
            .map_err(internal_error)?
            .is_some(),
    };
    if !allowed {
        return Err(error(
            StatusCode::FORBIDDEN,
            "only the owner of this service can open it",
        ));
    }

    let pass = issue_gate_token(
        &config.auth.jwt_secret,
        user_id,
        &host,
        GateTokenKind::Pass,
    )
    .ok_or_else(|| internal_error("failed to sign pass"))?;
    let mut url =
        Url::parse(&format!("{}{}", target.origin, GATE_CALLBACK_PATH))
            .map_err(internal_error)?;
    url.query_pairs_mut()
        .append_pair("pass", &pass)
        .append_pair("return", &safe_return_path(req.return_to.as_deref()));
    Ok(Json(GatePassResponse {
        redirect_url: url.to_string(),
    }))
}

fn normalize_host(host: &str) -> String {
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

/// finds the gated web service serving `host`, on a custom domain or its
/// generated `service-xxxxx` domain
fn find_gated_target(
    apps: &[App],
    proxy: &ProxyConfig,
    host: &str,
) -> Option<GatedTarget> {
    for app in apps {
        for service in &app.services {
            let Some(gate) = service.login_gate else {
                continue;
            };
            if !service.is_public_http() {
                continue;
            }
            let custom = service
                .custom_domains()
                .into_iter()
                .find(|domain| normalize_host(domain) == host);
            let https = match &custom {
                Some(domain) => service.domain_https_enabled(domain),
                // generated domains never get certificates
                None if default_service_domain(
                    service.id,
                    &proxy.base_domain,
                )
                .is_some_and(|domain| normalize_host(&domain) == host) =>
                {
                    false
                }
                None => continue,
            };
            let port = match (https, proxy.https_port, proxy.http_port) {
                (true, 443, _) | (false, _, 80) => String::new(),
                (true, port, _) | (false, _, port) => format!(":{}", port),
            };
            let scheme = if https { "https" } else { "http" };
            return Some(GatedTarget {
                owner_id: app.owner_id,
                scope: gate.scope,
                origin: format!("{}://{}{}", scheme, host, port),
            });
        }
    }
    None
}

/// only same-site paths, so the gate can't be used as an open redirect
fn safe_return_path(path: Option<&str>) -> String {
    match path.map(str::trim) {
        Some(path)
            if path.starts_with('/')
                && !path.starts_with("//")
                && !path.starts_with("/\\")
                && path.len() <= 2048
                && !path.chars().any(char::is_control) =>
        {
            path.to_string()
        }
        _ => "/".to_string(),
    }
}

fn error(status: StatusCode, message: &str) -> ApiError {
    (
        status,
        Json(ErrorResponse {
            error: message.to_string(),
        }),
    )
}

fn internal_error<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!("internal error: {}", e);
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
}

async fn get_user_id(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Uuid, ApiError> {
    let config = state.config.read().await.clone();
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(extract_bearer_token)
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "not logged in"))?;
    validate_token(token, &config.auth.jwt_secret)
        .map(|claims| claims.sub)
        .map_err(|e| error(StatusCode::UNAUTHORIZED, &e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use containr_common::models::{ContainerService, LoginGate, ServiceType};

    fn gated_app(scope: LoginGateScope) -> App {
        let mut app =
            App::new("tools".to_string(), String::new(), Uuid::new_v4());
        let mut service = ContainerService::new(
            app.id,
            "adminer".to_string(),
            "adminer".to_string(),
            8080,
        );
        service.service_type = ServiceType::WebService;
        service.domains = vec!["adminer.example.com".to_string()];
        service.login_gate = Some(LoginGate { scope });
        app.services.push(service);
        app
    }

    fn proxy() -> ProxyConfig {
        ProxyConfig {
            base_domain: "adm.example.com".to_string(),
            ..ProxyConfig::default()
        }
    }

    #[test]
    fn finds_gated_custom_and_generated_domains() {
        let app = gated_app(LoginGateScope::Owner);
        let apps = vec![app.clone()];

        let custom = find_gated_target(&apps, &proxy(), "adminer.example.com")
            .expect("custom domain");
        assert_eq!(custom.origin, "https://adminer.example.com");
        assert_eq!(custom.owner_id, app.owner_id);

        let generated =
            default_service_domain(app.services[0].id, "adm.example.com")
                .expect("generated domain");
        let target = find_gated_target(&apps, &proxy(), &generated)
            .expect("generated domain");
        assert_eq!(target.origin, format!("http://{}", generated));

        assert!(
            find_gated_target(&apps, &proxy(), "other.example.com").is_none()
        );
    }

    #[test]
    fn ungated_services_have_no_target() {
        let mut app = gated_app(LoginGateScope::Owner);
        app.services[0].login_gate = None;
        assert!(find_gated_target(&[app], &proxy(), "adminer.example.com")
            .is_none());
    }

    #[test]
    fn return_paths_stay_on_the_site() {
        assert_eq!(safe_return_path(Some("/?pgsql=pg")), "/?pgsql=pg");
        assert_eq!(safe_return_path(Some("//evil.example")), "/");
        assert_eq!(safe_return_path(Some("/\\evil.example")), "/");
        assert_eq!(safe_return_path(Some("https://evil.example")), "/");
        assert_eq!(safe_return_path(None), "/");
    }
}
