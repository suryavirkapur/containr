//! model context protocol server
//!
//! speaks the streamable http transport on `POST /mcp` with plain json
//! responses (no server-initiated messages, so no sse stream). tools are
//! generated from the openapi document and each call is dispatched into
//! the api router with the caller's credentials, so an llm can do exactly
//! what its token allows and nothing more.

pub mod tools;

use std::sync::Arc;

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::State,
    http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tower::ServiceExt;

use crate::handlers::api_tokens::RequestScope;
use crate::handlers::auth::require_authenticated_user;
use crate::state::AppState;
use containr_common::models::ApiTokenScope;
use tools::{path_allowed, Tool, ToolCatalog, ToolSummary, API_REQUEST_TOOL};

/// where the mcp endpoint is served
pub const MCP_PATH: &str = "/mcp";
/// protocol revisions this server speaks, newest first
const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
/// largest api response read back for a tool call
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
/// longest tool result text handed to the model
const MAX_RESULT_CHARS: usize = 100_000;
/// request headers passed through to the api so it sees the same origin
const FORWARDED_HEADERS: &[&str] = &[
    "host",
    "user-agent",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-for",
];

const INSTRUCTIONS: &str = "containr is a self-hosted platform that runs \
apps, databases, queues and one-click apps as services on Docker. Start with \
list_services to find service ids, and list_containers for container ids \
used by the container, file and exec tools. Services in the same project \
share a private network. Deployments are asynchronous: pass timeout_secs \
when triggering one, or call wait_for_service_deployment. Read-only state \
is also available as containr:// resources (services, deployments, \
settings, metrics). Use api_request only for endpoints without a \
dedicated tool. Confirm with the user before destructive actions such \
as deleting services or running cleanup.";

#[derive(Clone)]
pub struct McpState {
    app: AppState,
    api: Router,
    catalog: Arc<ToolCatalog>,
}

/// routes for the mcp endpoint and the dashboard's tool listing. `api` is
/// the full api router tool calls are dispatched into.
pub fn router(app: AppState, api: Router) -> Router {
    let state = McpState {
        app,
        api,
        catalog: Arc::new(ToolCatalog::from_openapi()),
    };
    Router::new()
        .route(
            MCP_PATH,
            get(method_not_allowed)
                .post(handle_post)
                .delete(method_not_allowed),
        )
        .route("/api/mcp", get(get_mcp_info))
        .with_state(state)
}

/// what the dashboard needs to show the mcp portal
#[derive(Debug, Serialize)]
pub struct McpInfoResponse {
    pub path: String,
    pub server_name: String,
    pub server_version: String,
    pub protocol_version: String,
    pub tools: Vec<ToolSummary>,
}

async fn get_mcp_info(
    State(state): State<McpState>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = require_authenticated_user(&state.app, &headers).await {
        return error.into_response();
    }
    Json(McpInfoResponse {
        path: MCP_PATH.to_string(),
        server_name: "containr".to_string(),
        server_version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_version: PROTOCOL_VERSIONS[0].to_string(),
        tools: state.catalog.summaries(),
    })
    .into_response()
}

async fn method_not_allowed() -> Response {
    let mut response = StatusCode::METHOD_NOT_ALLOWED.into_response();
    response
        .headers_mut()
        .insert(header::ALLOW, HeaderValue::from_static("POST"));
    response
}

async fn handle_post(
    State(state): State<McpState>,
    headers: HeaderMap,
    scope: Option<Extension<RequestScope>>,
    body: Bytes,
) -> Response {
    if let Err((status, body)) =
        require_authenticated_user(&state.app, &headers).await
    {
        let mut response = (status, body).into_response();
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Bearer realm=\"containr\""),
        );
        return response;
    }
    let scope = scope.map(|Extension(scope)| scope).unwrap_or(RequestScope {
        scope: ApiTokenScope::Full,
        via_api_token: false,
        via_mcp: false,
    });
    let caller = Caller { headers, scope };

    let message: Value = match serde_json::from_slice(&body) {
        Ok(message) => message,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(rpc_error(Value::Null, -32700, &error.to_string())),
            )
                .into_response();
        }
    };

    match message {
        Value::Array(batch) => {
            let mut replies = Vec::new();
            for message in batch {
                if let Some(reply) =
                    handle_message(&state, &caller, message).await
                {
                    replies.push(reply);
                }
            }
            if replies.is_empty() {
                StatusCode::ACCEPTED.into_response()
            } else {
                Json(Value::Array(replies)).into_response()
            }
        }
        message => match handle_message(&state, &caller, message).await {
            Some(reply) => Json(reply).into_response(),
            None => StatusCode::ACCEPTED.into_response(),
        },
    }
}

struct Caller {
    headers: HeaderMap,
    scope: RequestScope,
}

/// handles one json-rpc message; notifications and responses get no reply
async fn handle_message(
    state: &McpState,
    caller: &Caller,
    message: Value,
) -> Option<Value> {
    let id = message.get("id").cloned();
    let method = message.get("method").and_then(Value::as_str);
    let (Some(id), Some(method)) = (id, method) else {
        if message.get("method").is_none() && message.get("id").is_none() {
            return Some(rpc_error(Value::Null, -32600, "invalid request"));
        }
        return None;
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);

    let result = match method {
        "initialize" => Ok(initialize(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({
            "tools": state
                .catalog
                .list_json(caller.scope.scope == ApiTokenScope::Read),
        })),
        "tools/call" => call_tool(state, caller, &params).await,
        "resources/list" => list_resources(state, caller).await,
        "resources/read" => read_resource(state, caller, &params).await,
        "resources/templates/list" => {
            Ok(json!({ "resourceTemplates": resource_templates() }))
        }
        "prompts/list" => Ok(json!({ "prompts": [] })),
        _ => Err((-32601, format!("method not found: {}", method))),
    };

    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => rpc_error(id, code, &message),
    })
}

fn initialize(params: &Value) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let version = PROTOCOL_VERSIONS
        .iter()
        .find(|v| **v == requested)
        .copied()
        .unwrap_or(PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": {
            "tools": { "listChanged": false },
            "resources": { "listChanged": false },
        },
        "serverInfo": {
            "name": "containr",
            "title": "containr",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": INSTRUCTIONS,
    })
}

async fn call_tool(
    state: &McpState,
    caller: &Caller,
    params: &Value,
) -> Result<Value, (i64, String)> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((-32602, "missing tool name".to_string()))?;
    let tool = state
        .catalog
        .get(name)
        .ok_or_else(|| (-32602, format!("unknown tool: {}", name)))?;
    let empty = Map::new();
    let args = params
        .get("arguments")
        .and_then(Value::as_object)
        .unwrap_or(&empty);

    let request = match build_request(tool, args) {
        Ok(request) => request,
        Err(message) => return Ok(tool_error(&message)),
    };
    let read_only_call = request.method == Method::GET;
    if caller.scope.scope == ApiTokenScope::Read && !read_only_call {
        return Ok(tool_error(
            "this api token is read-only; create a full-access token to \
             make changes",
        ));
    }

    let (status, content_type, body) =
        match dispatch(state, caller, request).await {
            Ok(response) => response,
            Err(message) => return Ok(tool_error(&message)),
        };
    let text = render_body(&content_type, &body);
    if status.is_success() {
        Ok(json!({
            "content": [{ "type": "text", "text": text }],
            "isError": false,
        }))
    } else {
        Ok(tool_error(&format!("HTTP {}: {}", status.as_u16(), text)))
    }
}

/// uri scheme for containr state resources
const RESOURCE_SCHEME: &str = "containr://";

/// resources that don't depend on a service id
fn static_resources() -> Vec<Value> {
    vec![
        json!({
            "uri": "containr://services",
            "name": "services",
            "title": "All services",
            "description": "every app, database, queue and one-click \
                            service with its status",
            "mimeType": "application/json",
        }),
        json!({
            "uri": "containr://projects",
            "name": "projects",
            "title": "All projects",
            "description": "projects group services onto a shared \
                            private network",
            "mimeType": "application/json",
        }),
        json!({
            "uri": "containr://system",
            "name": "system",
            "title": "Server info",
            "description": "containr version, host and runtime \
                            information",
            "mimeType": "application/json",
        }),
    ]
}

/// uri templates advertised to clients that don't enumerate resources
fn resource_templates() -> Vec<Value> {
    [
        (
            "containr://services/{service_id}",
            "service",
            "one service: status, type, image and project",
        ),
        (
            "containr://services/{service_id}/settings",
            "service settings",
            "full editable settings; env var secrets are masked",
        ),
        (
            "containr://services/{service_id}/deployments",
            "service deployments",
            "deployment history with status and triggered_via",
        ),
        (
            "containr://services/{service_id}/deployments/{deployment_id}",
            "service deployment",
            "one deployment's status and result",
        ),
        (
            "containr://services/{service_id}/metrics",
            "service metrics",
            "recent cpu, memory and network usage",
        ),
    ]
    .iter()
    .map(|(uri_template, name, description)| {
        json!({
            "uriTemplate": uri_template,
            "name": name,
            "mimeType": "application/json",
            "description": description,
        })
    })
    .collect()
}

/// maps a containr:// resource uri onto a read-only api path; ids are
/// restricted to identifier characters so a uri can't reach other paths
fn resource_api_path(uri: &str) -> Option<String> {
    let path = uri.strip_prefix(RESOURCE_SCHEME)?;
    match path {
        "services" => Some("/api/services".to_string()),
        "projects" => Some("/api/projects".to_string()),
        "system" => Some("/api/system/info".to_string()),
        _ => {
            let mut parts = path.split('/');
            if parts.next() != Some("services") {
                return None;
            }
            let id = parts.next()?;
            let tail: Vec<&str> = parts.collect();
            let api = match tail.as_slice() {
                [] => format!("/api/services/{}", id),
                ["settings"] => format!("/api/services/{}/settings", id),
                ["deployments"] => {
                    format!("/api/services/{}/deployments", id)
                }
                ["deployments", deployment_id]
                    if is_resource_id(deployment_id) =>
                {
                    format!(
                        "/api/services/{}/deployments/{}",
                        id, deployment_id
                    )
                }
                ["metrics"] => format!("/api/services/{}/metrics", id),
                _ => return None,
            };
            is_resource_id(id).then_some(api)
        }
    }
}

fn is_resource_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// resources/list: the fixed resources plus one per service
async fn list_resources(
    state: &McpState,
    caller: &Caller,
) -> Result<Value, (i64, String)> {
    let mut resources = static_resources();
    let call = ApiCall {
        method: Method::GET,
        uri: "/api/services".to_string(),
        body: None,
    };
    if let Ok((status, _, body)) = dispatch(state, caller, call).await {
        if status.is_success() {
            if let Ok(Value::Array(services)) =
                serde_json::from_slice::<Value>(&body)
            {
                for service in services {
                    let id = service.get("id").and_then(Value::as_str);
                    let name = service
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("service");
                    let status = service
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    if let Some(id) = id.filter(|id| is_resource_id(id)) {
                        resources.push(json!({
                            "uri": format!("containr://services/{}", id),
                            "name": name,
                            "title": format!("Service {}", name),
                            "description": format!("status: {}", status),
                            "mimeType": "application/json",
                        }));
                    }
                }
            }
        }
    }
    Ok(json!({ "resources": resources }))
}

/// resources/read: serves the mapped api response as resource contents
async fn read_resource(
    state: &McpState,
    caller: &Caller,
    params: &Value,
) -> Result<Value, (i64, String)> {
    let uri = params
        .get("uri")
        .and_then(Value::as_str)
        .ok_or((-32602, "missing resource uri".to_string()))?;
    let path = resource_api_path(uri).ok_or_else(|| {
        (
            -32602,
            format!(
                "unknown resource: {}. expected a containr:// uri from \
                 resources/list or a uri template",
                uri
            ),
        )
    })?;
    let call = ApiCall {
        method: Method::GET,
        uri: path,
        body: None,
    };
    let (status, content_type, body) = dispatch(state, caller, call)
        .await
        .map_err(|error| (-32603, error))?;
    let text = render_body(&content_type, &body);
    if !status.is_success() {
        return Err((-32602, format!("HTTP {}: {}", status.as_u16(), text)));
    }
    Ok(json!({
        "contents": [{
            "uri": uri,
            "mimeType": "application/json",
            "text": text,
        }]
    }))
}

/// a resolved api call
#[derive(Debug, PartialEq)]
struct ApiCall {
    method: Method,
    uri: String,
    body: Option<Value>,
}

fn build_request(
    tool: &Tool,
    args: &Map<String, Value>,
) -> Result<ApiCall, String> {
    if tool.name == API_REQUEST_TOOL {
        return build_generic_request(args);
    }

    let mut path = tool.path.clone();
    for name in &tool.path_params {
        let value = args
            .get(name)
            .map(scalar_to_string)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("missing required argument `{}`", name))?;
        path = path
            .replace(&format!("{{{}}}", name), &encode_path_segment(&value));
    }

    let mut query = url::form_urlencoded::Serializer::new(String::new());
    let mut has_query = false;
    for name in &tool.query_params {
        if let Some(value) = args.get(name).filter(|v| !v.is_null()) {
            query.append_pair(name, &scalar_to_string(value));
            has_query = true;
        }
    }
    let uri = if has_query {
        format!("{}?{}", path, query.finish())
    } else {
        path
    };

    let body = if tool.has_body {
        Some(args.get("body").cloned().unwrap_or_else(|| json!({})))
    } else {
        None
    };

    Ok(ApiCall {
        method: tool.method.clone(),
        uri,
        body,
    })
}

fn build_generic_request(args: &Map<String, Value>) -> Result<ApiCall, String> {
    let method = args
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_ascii_uppercase)
        .ok_or("missing required argument `method`")?;
    let method = match method.as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        "PUT" => Method::PUT,
        "PATCH" => Method::PATCH,
        "DELETE" => Method::DELETE,
        other => return Err(format!("unsupported method {}", other)),
    };
    let raw_path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or("missing required argument `path`")?
        .trim();
    let (path, inline_query) = match raw_path.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (raw_path, None),
    };
    if !path_allowed(path) {
        return Err(format!(
            "{} is not available through mcp; paths must start with /api/ \
             and may not manage tokens or sign-in",
            path
        ));
    }

    let mut query = url::form_urlencoded::Serializer::new(String::new());
    let mut has_query = false;
    if let Some(inline) = inline_query.filter(|q| !q.is_empty()) {
        for (key, value) in url::form_urlencoded::parse(inline.as_bytes()) {
            query.append_pair(&key, &value);
            has_query = true;
        }
    }
    if let Some(params) = args.get("query").and_then(Value::as_object) {
        for (key, value) in params.iter().filter(|(_, v)| !v.is_null()) {
            query.append_pair(key, &scalar_to_string(value));
            has_query = true;
        }
    }
    let uri = if has_query {
        format!("{}?{}", path, query.finish())
    } else {
        path.to_string()
    };

    let body = match args.get("body") {
        Some(Value::Null) | None if method == Method::GET => None,
        Some(Value::Null) | None => {
            matches!(method, Method::POST | Method::PUT | Method::PATCH)
                .then(|| json!({}))
        }
        Some(body) => Some(body.clone()),
    };

    Ok(ApiCall { method, uri, body })
}

/// runs the call through the api router as the caller
async fn dispatch(
    state: &McpState,
    caller: &Caller,
    call: ApiCall,
) -> Result<(StatusCode, String, Bytes), String> {
    let mut builder = Request::builder().method(call.method).uri(&call.uri);
    if let Some(auth) = caller.headers.get(header::AUTHORIZATION) {
        builder = builder.header(header::AUTHORIZATION, auth);
    }
    for name in FORWARDED_HEADERS {
        if let Some(value) = caller.headers.get(*name) {
            builder = builder.header(*name, value);
        }
    }
    let body = match call.body {
        Some(body) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let mut request = builder.body(body).map_err(|e| e.to_string())?;
    // keep the caller's scope so the api applies the same limits, and
    // mark the call as mcp-originated for the deployment audit trail
    request.extensions_mut().insert(RequestScope {
        via_mcp: true,
        ..caller.scope
    });

    let response = match state.api.clone().oneshot(request).await {
        Ok(response) => response,
        Err(never) => match never {},
    };
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let body = to_bytes(response.into_body(), MAX_RESPONSE_BYTES)
        .await
        .map_err(|e| format!("failed to read api response: {}", e))?;
    Ok((status, content_type, body))
}

/// turns an api response into text for the model
fn render_body(content_type: &str, body: &[u8]) -> String {
    if body.is_empty() {
        return "ok".to_string();
    }
    if content_type.starts_with("text/html") {
        return "the api returned an html page; check the path".to_string();
    }
    if let Ok(value) = serde_json::from_slice::<Value>(body) {
        return truncate(value.to_string());
    }
    match std::str::from_utf8(body) {
        Ok(text) => truncate(text.to_string()),
        Err(_) => format!(
            "binary content ({} bytes, {}); not shown",
            body.len(),
            if content_type.is_empty() {
                "unknown type"
            } else {
                content_type
            }
        ),
    }
}

fn truncate(mut text: String) -> String {
    if text.len() <= MAX_RESULT_CHARS {
        return text;
    }
    let mut cut = MAX_RESULT_CHARS;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    let total = text.len();
    text.truncate(cut);
    text.push_str(&format!(
        "\n…[truncated: showing {} of {} bytes; narrow the request with \
         tail, limit or offset]",
        cut, total
    ));
    text
}

fn scalar_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn encode_path_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

fn tool_error(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true,
    })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> ToolCatalog {
        ToolCatalog::from_openapi()
    }

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn negotiates_known_versions_and_falls_back_to_latest() {
        let reply = initialize(&json!({ "protocolVersion": "2025-03-26" }));
        assert_eq!(reply["protocolVersion"], "2025-03-26");
        let reply = initialize(&json!({ "protocolVersion": "1999-01-01" }));
        assert_eq!(reply["protocolVersion"], PROTOCOL_VERSIONS[0]);
        assert!(reply["capabilities"]["tools"].is_object());
    }

    #[test]
    fn fills_path_and_query_parameters() {
        let catalog = catalog();
        let tool = catalog.get("get_service_logs").expect("tool");
        let call =
            build_request(tool, &args(json!({ "id": "abc 1", "tail": 50 })))
                .expect("request");
        assert_eq!(call.method, Method::GET);
        assert_eq!(call.uri, "/api/services/abc%201/logs?tail=50");
        assert_eq!(call.body, None);
    }

    #[test]
    fn missing_path_parameters_are_reported() {
        let catalog = catalog();
        let tool = catalog.get("get_service").expect("tool");
        let error = build_request(tool, &Map::new()).expect_err("error");
        assert!(error.contains("`id`"));
    }

    #[test]
    fn sends_the_body_argument_as_json() {
        let catalog = catalog();
        let tool = catalog.get("run_service_action").expect("tool");
        let call = build_request(
            tool,
            &args(json!({ "id": "s1", "action": "restart" })),
        )
        .expect("request");
        assert_eq!(call.method, Method::POST);
        assert_eq!(call.uri, "/api/services/s1/actions/restart");

        let tool = catalog.get("update_project").expect("tool");
        let call = build_request(
            tool,
            &args(json!({ "id": "p1", "body": { "name": "shop" } })),
        )
        .expect("request");
        assert_eq!(call.body, Some(json!({ "name": "shop" })));
    }

    #[test]
    fn generic_requests_merge_queries_and_refuse_blocked_paths() {
        let call = build_generic_request(&args(json!({
            "method": "get",
            "path": "/api/services?group_id=1",
            "query": { "x": true },
        })))
        .expect("request");
        assert_eq!(call.uri, "/api/services?group_id=1&x=true");
        assert_eq!(call.body, None);

        assert!(build_generic_request(&args(json!({
            "method": "POST",
            "path": "/api/tokens",
        })))
        .is_err());
    }

    #[test]
    fn resource_uris_map_to_read_only_api_paths() {
        assert_eq!(
            resource_api_path("containr://services").as_deref(),
            Some("/api/services")
        );
        assert_eq!(
            resource_api_path("containr://services/abc-123").as_deref(),
            Some("/api/services/abc-123")
        );
        assert_eq!(
            resource_api_path("containr://services/abc/settings").as_deref(),
            Some("/api/services/abc/settings")
        );
        assert_eq!(
            resource_api_path("containr://services/abc/deployments/d1")
                .as_deref(),
            Some("/api/services/abc/deployments/d1")
        );
        // ids can't escape into other paths
        assert_eq!(resource_api_path("containr://services/../tokens"), None);
        assert_eq!(resource_api_path("containr://tokens"), None);
        assert_eq!(resource_api_path("https://x/services"), None);
    }

    #[test]
    fn renders_json_text_and_binary_bodies() {
        assert_eq!(
            render_body("application/json", b"{ \"a\": 1 }"),
            "{\"a\":1}"
        );
        assert_eq!(render_body("text/plain", b"hello"), "hello");
        assert_eq!(render_body("", b""), "ok");
        assert!(render_body("image/png", &[0xff, 0xfe, 0x00])
            .starts_with("binary content (3 bytes"));
        let long = "x".repeat(MAX_RESULT_CHARS + 10);
        assert!(
            render_body("text/plain", long.as_bytes()).contains("[truncated")
        );
    }

    #[tokio::test]
    async fn notifications_get_no_reply_and_unknown_methods_fail() {
        let state = test_state();
        let caller = Caller {
            headers: HeaderMap::new(),
            scope: RequestScope {
                scope: ApiTokenScope::Read,
                via_api_token: true,
                via_mcp: false,
            },
        };
        let reply = handle_message(
            &state,
            &caller,
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        )
        .await;
        assert!(reply.is_none());

        let reply = handle_message(
            &state,
            &caller,
            json!({ "jsonrpc": "2.0", "id": 1, "method": "nope" }),
        )
        .await
        .expect("reply");
        assert_eq!(reply["error"]["code"], -32601);

        // read-only callers only see read-only tools
        let reply = handle_message(
            &state,
            &caller,
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        )
        .await
        .expect("reply");
        let tools = reply["result"]["tools"].as_array().expect("tools");
        assert!(!tools.is_empty());
        assert!(tools
            .iter()
            .all(|tool| tool["annotations"]["readOnlyHint"] == true));
    }

    fn test_state() -> McpState {
        let dir = std::env::temp_dir()
            .join(format!("containr-mcp-test-{}", uuid::Uuid::new_v4()));
        let mut config = containr_common::Config::default();
        config.database.path = dir.join("db.sqlite").display().to_string();
        let db = containr_common::Database::open(&config.database)
            .expect("test database");
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let app = AppState::new(
            Arc::new(tokio::sync::RwLock::new(config)),
            dir.join("containr.toml"),
            dir,
            db,
            tx,
            None,
            None,
            None,
        )
        .expect("state");
        McpState {
            app,
            api: Router::new(),
            catalog: Arc::new(ToolCatalog::from_openapi()),
        }
    }
}
