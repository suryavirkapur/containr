//! mcp tool catalog, built from the openapi document
//!
//! every documented endpoint becomes a tool unless it is listed in
//! `EXCLUDED`, so new endpoints show up for llms without extra work.
//! path and query parameters are top-level arguments; a json request body
//! goes under `body`.

use std::collections::{BTreeMap, BTreeSet};

use axum::http::Method;
use serde::Serialize;
use serde_json::{json, Map, Value};
use utoipa::OpenApi;

use crate::openapi::ApiDoc;

/// name of the catch-all tool that calls any api endpoint
pub const API_REQUEST_TOOL: &str = "api_request";

/// operations that make no sense for an llm or would widen its access:
/// sign-in flows, browser redirects, binary transfers and token minting
const EXCLUDED: &[&str] = &[
    "health",
    "status",
    "register",
    "login",
    "change_password",
    "github_start",
    "github_callback",
    "github_link_start",
    "github_unlink",
    "get_app_manifest",
    "github_app_callback",
    "github_install_callback",
    "download_backup",
    "upload_volume_entry",
    "deploy_upload",
    "issue_exec_token",
    "create_gate_pass",
    "list_api_tokens",
    "create_api_token",
    "delete_api_token",
];

/// friendlier tool names for a few operation ids
const RENAMED: &[(&str, &str)] = &[
    ("me", "get_current_user"),
    ("download_volume_entry", "read_volume_file"),
    ("get_certificate", "get_service_certificate"),
    ("reissue_certificate", "reissue_service_certificate"),
    ("run_cleanup", "run_docker_cleanup"),
    ("check_update", "check_for_update"),
];

/// api paths the catch-all tool refuses, by prefix
const BLOCKED_PREFIXES: &[&str] = &[
    "/api/tokens",
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/password",
    "/api/auth/github",
    "/api/gate",
    "/api/mcp",
    "/api/system/backup",
];

/// curated descriptions; they matter more to an llm than to a human
const DESCRIPTIONS: &[(&str, &str)] = &[
    ("list_users", "List every user account on this containr server (admin only)."),
    ("create_user", "Create a local user account with an email and password (admin only)."),
    ("delete_user", "Delete a user and tear down all of their services (admin only). This cannot be undone."),
    ("me", "Return the account these credentials belong to, including whether it is an admin."),
    ("list_buckets", "List the caller's S3-compatible storage buckets."),
    ("create_bucket", "Create an S3-compatible storage bucket."),
    ("get_bucket", "Get one storage bucket by id."),
    ("delete_bucket", "Delete a storage bucket and its data. This cannot be undone."),
    ("get_bucket_connection", "Get the S3 endpoint, access key and secret key for a bucket."),
    ("list_containers", "List the containers the caller owns and the service each belongs to. Use a returned `id` with the container tools (status, logs, mounts, files, exec_command)."),
    ("get_container_status", "Get a container's state, health, restart count and live CPU and memory use."),
    ("get_container_logs", "Get the last `tail` lines of a container's stdout and stderr."),
    ("list_container_mounts", "List a container's volume and bind mounts. Use a `destination` as `mount` with the file tools."),
    ("list_volume_entries", "List files in a container mount. `mount` is a destination from list_container_mounts; `path` is relative to it."),
    ("delete_volume_entry", "Delete a file or directory inside a container mount. This cannot be undone."),
    ("download_volume_entry", "Read a file from a container mount. Text is returned inline; binary files are only summarised."),
    ("create_volume_directory", "Create a directory inside a container mount."),
    ("exec_command", "Run a shell command (`/bin/sh -c`) inside a container and return its exit code, stdout and stderr. Gives up after `timeout_secs` (default 60, max 300). Get container ids from list_containers."),
    ("get_github_app", "Show whether a GitHub App is configured and where it is installed."),
    ("delete_github_app", "Remove the GitHub App configuration from containr."),
    ("get_app_repos", "List repositories the GitHub App installations can access, for use as a service's github_url."),
    ("list_projects", "List projects. A project groups services on one private network; services in the same project reach each other by service name."),
    ("update_project", "Rename a project."),
    ("list_registries", "List saved private container registry logins (passwords are never returned)."),
    ("create_registry", "Save login details for a private container registry such as ghcr.io so image deploys can pull from it."),
    ("delete_registry", "Delete saved registry login details."),
    ("list_services", "List every service the caller owns (apps, databases, queues and one-click apps) with its status, project and domains. Filter by project with `group_id`. Start here to find service ids."),
    ("create_service", "Create a service. `body.source` picks the kind: `git_repository` builds from a repo, `template` creates a database, queue or one-click app from a template, and image-based variants deploy a Docker image. Set `deploy: false` to create without deploying."),
    ("get_service", "Get one service: status, image or repo, domains, replicas and runtime details."),
    ("update_service", "Change a service: image, env vars, domains, port, replicas, resources, health check, volumes and more. Only the fields you send change."),
    ("delete_service", "Delete a service, its containers and its deployments. This cannot be undone."),
    ("get_service_settings", "Get a service's full editable settings, including env vars (secrets masked), domains, basic auth, port mappings, mounts, files and auto-deploy."),
    ("update_service_settings", "Replace a service's settings in one go. Read them with get_service_settings first and send back the edited version."),
    ("reveal_env_var", "Reveal the plaintext value of one of a service's environment variables."),
    ("run_service_action", "Start, stop or restart a service. `action` is `start`, `stop` or `restart`."),
    ("move_service", "Move a service to another project (network group), or to a new one of its own."),
    ("get_service_logs", "Get recent runtime logs for all of a service's containers. `tail` sets the number of lines."),
    ("list_service_http_logs", "List recent HTTP requests the proxy served for a service, newest first."),
    ("get_service_metrics", "Get CPU, memory and network use for a service's containers."),
    ("list_service_deployments", "List a service's deployments, newest first, with status and commit."),
    ("trigger_service_deployment", "Queue a new deployment of a service (a redeploy), optionally for a given branch or commit."),
    ("get_service_deployment", "Get one deployment's status, timings and per-container results."),
    ("get_service_deployment_logs", "Read a deployment's build and rollout log. Page with `limit` and `offset`."),
    ("rollback_service_deployment", "Redeploy a previous successful deployment of a service."),
    ("deploy_dockerfile", "Build a service from an inline Dockerfile and deploy it."),
    ("get_certificate", "Get the TLS certificate status for a service's domains."),
    ("reissue_certificate", "Request a fresh Let's Encrypt certificate for a service's domain."),
    ("get_settings", "Get server settings such as the base domain, dashboard domain and Let's Encrypt email (admin)."),
    ("update_settings", "Change server settings (admin). Only the fields you send change."),
    ("issue_dashboard_certificate", "Request a TLS certificate for the dashboard domain (admin)."),
    ("get_system_stats", "Get host CPU, memory, disk and load figures."),
    ("get_system_info", "Get host and Docker engine details: OS, kernel, Docker version, container and image counts."),
    ("get_disk_usage", "Get Docker disk usage by images, containers, volumes and build cache (admin)."),
    ("run_cleanup", "Prune unused Docker images, stopped containers, networks and build cache to free disk space (admin)."),
    ("check_update", "Check GitHub for a newer containr release (admin)."),
    ("install_update", "Download and install a containr release, then restart the server (admin). Running services keep running."),
];

/// one tool and the endpoint it calls
#[derive(Debug, Clone)]
pub struct Tool {
    pub name: String,
    pub title: String,
    pub description: String,
    pub tag: String,
    pub method: Method,
    pub path: String,
    pub path_params: Vec<String>,
    pub query_params: Vec<String>,
    pub has_body: bool,
    pub read_only: bool,
    pub destructive: bool,
    pub input_schema: Value,
}

/// tool summary for the dashboard's mcp page
#[derive(Debug, Clone, Serialize)]
pub struct ToolSummary {
    pub name: String,
    pub title: String,
    pub description: String,
    pub tag: String,
    pub method: String,
    pub path: String,
    pub read_only: bool,
    pub destructive: bool,
}

/// every tool the mcp endpoint offers
#[derive(Debug, Clone)]
pub struct ToolCatalog {
    pub tools: Vec<Tool>,
}

impl ToolCatalog {
    /// builds the catalog from the api's openapi document
    pub fn from_openapi() -> Self {
        match serde_json::to_value(ApiDoc::openapi()) {
            Ok(doc) => Self::from_document(&doc),
            Err(error) => {
                tracing::error!(%error, "failed to serialise openapi doc");
                Self {
                    tools: vec![api_request_tool()],
                }
            }
        }
    }

    pub fn from_document(doc: &Value) -> Self {
        let empty = Map::new();
        let components = doc
            .pointer("/components/schemas")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let mut tools = Vec::new();

        if let Some(paths) = doc.get("paths").and_then(Value::as_object) {
            for (path, item) in paths {
                let Some(item) = item.as_object() else {
                    continue;
                };
                for (method, operation) in item {
                    if let Some(tool) =
                        build_tool(path, method, operation, components)
                    {
                        tools.push(tool);
                    }
                }
            }
        }
        tools.sort_by(|a, b| {
            a.tag.cmp(&b.tag).then_with(|| a.name.cmp(&b.name))
        });
        tools.push(api_request_tool());
        Self { tools }
    }

    pub fn get(&self, name: &str) -> Option<&Tool> {
        self.tools.iter().find(|tool| tool.name == name)
    }

    /// tools in the shape `tools/list` returns
    pub fn list_json(&self, read_only_only: bool) -> Vec<Value> {
        self.tools
            .iter()
            .filter(|tool| !read_only_only || tool.read_only)
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "title": tool.title,
                    "description": tool.description,
                    "inputSchema": tool.input_schema,
                    "annotations": {
                        "title": tool.title,
                        "readOnlyHint": tool.read_only,
                        "destructiveHint": tool.destructive,
                        "idempotentHint": tool.method == Method::GET
                            || tool.method == Method::PUT
                            || tool.method == Method::DELETE,
                        "openWorldHint": false,
                    },
                })
            })
            .collect()
    }

    pub fn summaries(&self) -> Vec<ToolSummary> {
        self.tools
            .iter()
            .map(|tool| ToolSummary {
                name: tool.name.clone(),
                title: tool.title.clone(),
                description: tool.description.clone(),
                tag: tool.tag.clone(),
                method: tool.method.to_string(),
                path: tool.path.clone(),
                read_only: tool.read_only,
                destructive: tool.destructive,
            })
            .collect()
    }
}

/// true when the catch-all tool may call this path
pub fn path_allowed(path: &str) -> bool {
    if !path.starts_with("/api/") || path.contains("..") {
        return false;
    }
    if path.ends_with("/ws") || path.contains("/exec/token") {
        return false;
    }
    !BLOCKED_PREFIXES
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

fn build_tool(
    path: &str,
    method: &str,
    operation: &Value,
    components: &Map<String, Value>,
) -> Option<Tool> {
    let method = match method {
        "get" => Method::GET,
        "post" => Method::POST,
        "put" => Method::PUT,
        "patch" => Method::PATCH,
        "delete" => Method::DELETE,
        _ => return None,
    };
    let operation_id = operation.get("operationId")?.as_str()?;
    if EXCLUDED.contains(&operation_id) || !path.starts_with("/api/") {
        return None;
    }

    let mut properties = Map::new();
    let mut required = Vec::new();
    let mut path_params = Vec::new();
    let mut query_params = Vec::new();

    for param in operation
        .get("parameters")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(name) = param.get("name").and_then(Value::as_str) else {
            continue;
        };
        let location = param.get("in").and_then(Value::as_str);
        match location {
            Some("path") => path_params.push(name.to_string()),
            Some("query") => query_params.push(name.to_string()),
            _ => continue,
        }
        let mut schema = param
            .get("schema")
            .cloned()
            .unwrap_or_else(|| json!({ "type": "string" }));
        if let (Some(description), Some(object)) = (
            param.get("description").and_then(Value::as_str),
            schema.as_object_mut(),
        ) {
            object.insert("description".into(), json!(description));
        }
        properties.insert(name.to_string(), schema);
        let is_required = location == Some("path")
            || param.get("required").and_then(Value::as_bool) == Some(true);
        if is_required {
            required.push(json!(name));
        }
    }

    let body_schema = operation
        .pointer("/requestBody/content/application~1json/schema")
        .cloned();
    // multipart and other bodies can't be sent as json arguments
    if body_schema.is_none() && operation.get("requestBody").is_some() {
        return None;
    }
    let has_body = body_schema.is_some();
    if let Some(mut schema) = body_schema {
        if let Some(object) = schema.as_object_mut() {
            object.insert("description".into(), json!("json request body"));
        }
        properties.insert("body".to_string(), schema);
        let body_required = operation
            .pointer("/requestBody/required")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if body_required {
            required.push(json!("body"));
        }
    }

    let mut input_schema = json!({
        "type": "object",
        "properties": properties,
        "additionalProperties": false,
    });
    if !required.is_empty() {
        input_schema["required"] = Value::Array(required);
    }
    let defs = collect_defs(&input_schema, components);
    if !defs.is_empty() {
        input_schema["$defs"] = Value::Object(defs);
    }
    rewrite_refs(&mut input_schema);

    let name = RENAMED
        .iter()
        .find(|(from, _)| *from == operation_id)
        .map(|(_, to)| to.to_string())
        .unwrap_or_else(|| operation_id.to_string());
    let summary = DESCRIPTIONS
        .iter()
        .find(|(id, _)| *id == operation_id)
        .map(|(_, text)| text.to_string())
        .or_else(|| {
            operation
                .get("summary")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(sentence)
        })
        .unwrap_or_else(|| sentence(&operation_id.replace('_', " ")));
    let description = format!("{}\n\nCalls {} {}.", summary, method, path);
    let tag = operation
        .pointer("/tags/0")
        .and_then(Value::as_str)
        .unwrap_or("other")
        .to_string();
    let read_only = method == Method::GET;
    let destructive = method == Method::DELETE
        || matches!(
            operation_id,
            "run_cleanup"
                | "install_update"
                | "rollback_service_deployment"
                | "update_service_settings"
                | "exec_command"
                | "delete_github_app"
        );

    Some(Tool {
        title: sentence(&name.replace('_', " ")),
        name,
        description,
        tag,
        method,
        path: path.to_string(),
        path_params,
        query_params,
        has_body,
        read_only,
        destructive,
        input_schema,
    })
}

fn api_request_tool() -> Tool {
    Tool {
        name: API_REQUEST_TOOL.to_string(),
        title: "Api request".to_string(),
        description: "Call any containr REST endpoint that has no dedicated \
tool, with the caller's permissions. `path` must start with /api/ (full \
reference: /api/docs). Prefer the dedicated tools when one exists."
            .to_string(),
        tag: "api".to_string(),
        method: Method::POST,
        path: "/api/*".to_string(),
        path_params: Vec::new(),
        query_params: Vec::new(),
        has_body: true,
        read_only: false,
        destructive: true,
        input_schema: json!({
            "type": "object",
            "properties": {
                "method": {
                    "type": "string",
                    "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"],
                },
                "path": {
                    "type": "string",
                    "description": "e.g. /api/services/{id}/settings",
                },
                "query": {
                    "type": "object",
                    "description": "query string parameters",
                    "additionalProperties": true,
                },
                "body": {
                    "description": "json request body",
                },
            },
            "required": ["method", "path"],
            "additionalProperties": false,
        }),
    }
}

/// component schemas the input schema refers to, followed transitively
fn collect_defs(
    schema: &Value,
    components: &Map<String, Value>,
) -> Map<String, Value> {
    let mut seen = BTreeSet::new();
    let mut pending = Vec::new();
    find_refs(schema, &mut pending);
    let mut defs = BTreeMap::new();
    while let Some(name) = pending.pop() {
        if !seen.insert(name.clone()) {
            continue;
        }
        if let Some(def) = components.get(&name) {
            find_refs(def, &mut pending);
            defs.insert(name, def.clone());
        }
    }
    defs.into_iter().collect()
}

fn find_refs(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            if let Some(name) = object
                .get("$ref")
                .and_then(Value::as_str)
                .and_then(|r| r.strip_prefix("#/components/schemas/"))
            {
                out.push(name.to_string());
            }
            object.values().for_each(|v| find_refs(v, out));
        }
        Value::Array(items) => items.iter().for_each(|v| find_refs(v, out)),
        _ => {}
    }
}

fn rewrite_refs(value: &mut Value) {
    match value {
        Value::Object(object) => {
            if let Some(Value::String(reference)) = object.get_mut("$ref") {
                if let Some(name) =
                    reference.strip_prefix("#/components/schemas/")
                {
                    *reference = format!("#/$defs/{}", name);
                }
            }
            object.values_mut().for_each(rewrite_refs);
        }
        Value::Array(items) => items.iter_mut().for_each(rewrite_refs),
        _ => {}
    }
}

/// first letter upper case, the rest left alone
fn sentence(text: &str) -> String {
    let mut chars = text.trim().chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> ToolCatalog {
        ToolCatalog::from_openapi()
    }

    #[test]
    fn covers_the_main_endpoints() {
        let catalog = catalog();
        for name in [
            "list_services",
            "create_service",
            "update_service",
            "get_service_logs",
            "trigger_service_deployment",
            "exec_command",
            "list_buckets",
            "get_current_user",
            API_REQUEST_TOOL,
        ] {
            assert!(catalog.get(name).is_some(), "missing tool {}", name);
        }
    }

    #[test]
    fn leaves_out_sign_in_and_token_endpoints() {
        let catalog = catalog();
        for name in ["login", "create_api_token", "deploy_upload", "health"] {
            assert!(catalog.get(name).is_none(), "unexpected tool {}", name);
        }
    }

    #[test]
    fn tool_names_are_valid_and_unique() {
        let catalog = catalog();
        let mut names = BTreeSet::new();
        for tool in &catalog.tools {
            assert!(tool.name.len() <= 64);
            assert!(tool
                .name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
            assert!(names.insert(tool.name.clone()), "dup {}", tool.name);
        }
    }

    #[test]
    fn schemas_have_no_dangling_component_refs() {
        for tool in catalog().tools {
            let text = tool.input_schema.to_string();
            assert!(!text.contains("#/components/"), "{}", tool.name);
            let mut refs = Vec::new();
            find_refs(&tool.input_schema, &mut refs);
            assert!(refs.is_empty());
        }
    }

    #[test]
    fn path_params_are_required_and_bodies_nest() {
        let catalog = catalog();
        let tool = catalog.get("update_service").expect("tool");
        assert_eq!(tool.path_params, vec!["id".to_string()]);
        assert!(tool.has_body);
        let required = tool.input_schema["required"].to_string();
        assert!(required.contains("\"id\""));
        assert!(required.contains("\"body\""));
        assert!(tool.input_schema["$defs"]
            .get("UpdateServiceRequest")
            .is_some());
    }

    #[test]
    fn read_only_tools_are_gets() {
        for tool in catalog().tools {
            assert_eq!(tool.read_only, tool.method == Method::GET);
        }
    }

    #[test]
    fn the_catch_all_tool_refuses_sensitive_paths() {
        assert!(path_allowed("/api/services"));
        assert!(path_allowed("/api/github/repos"));
        assert!(!path_allowed("/api/tokens"));
        assert!(!path_allowed("/api/auth/password"));
        assert!(!path_allowed("/api/services/../tokens"));
        assert!(!path_allowed("/webhooks/github"));
        assert!(!path_allowed("/api/services/x/logs/ws"));
        assert!(!path_allowed("/api/system/backup"));
    }
}
