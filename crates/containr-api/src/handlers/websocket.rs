//! websocket handlers for live log streaming

use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use bollard::query_parameters::LogsOptions;
use bollard::Docker;
use futures::{FutureExt, StreamExt};
use serde::Deserialize;
use tracing::info;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::domain::services::ServiceSvc;
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct LogsQuery {
    #[serde(default = "default_tail")]
    pub tail: usize,
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct DeploymentLogsQuery {
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub token: Option<String>,
}

fn default_tail() -> usize {
    100
}

/// websocket endpoint for container logs
pub async fn container_logs_ws(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    Path(service_id): Path<Uuid>,
    Query(query): Query<LogsQuery>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    let user_id =
        get_ws_user_id(&state, &headers, query.token.as_deref()).await?;
    let service = ServiceSvc::new(state.clone())
        .get_service(user_id, service_id)
        .await?;
    let service_name = service.name.clone();
    let container_ids = service.container_ids.clone();

    Ok(ws.on_upgrade(move |socket| {
        handle_container_logs(
            socket,
            service_id,
            service_name,
            container_ids,
            query.tail,
        )
    }))
}

/// handle websocket connection for container logs
async fn handle_container_logs(
    mut socket: WebSocket,
    service_id: Uuid,
    service_name: String,
    container_ids: Vec<String>,
    tail: usize,
) {
    info!(
        service_id = %service_id,
        service_name = %service_name,
        "container logs websocket connected"
    );

    if socket
        .send(Message::Text(
            format!("[connected to container logs for {}]", service_id).into(),
        ))
        .await
        .is_err()
    {
        return;
    }

    if container_ids.is_empty() {
        let _ = socket
            .send(Message::Text("[service has no running instances]".into()))
            .await;
        return;
    }

    let multi_container = container_ids.len() > 1;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let mut tasks = Vec::new();

    for container_id in container_ids {
        let tx = tx.clone();
        let label = container_id.clone();
        let docker = match Docker::connect_with_socket_defaults() {
            Ok(client) => Arc::new(client),
            Err(error) => {
                let _ = socket
                    .send(Message::Text(
                        format!(
                            "[error: failed to connect to docker: {}]",
                            error
                        )
                        .into(),
                    ))
                    .await;
                return;
            }
        };

        tasks.push(tokio::spawn(async move {
            let options = LogsOptions {
                stdout: true,
                stderr: true,
                follow: true,
                tail: tail.to_string(),
                ..Default::default()
            };
            let mut log_stream = docker.logs(&label, Some(options));

            while let Some(log_entry) = log_stream.next().await {
                match log_entry {
                    Ok(output) => {
                        let text = format_log_chunk(
                            &label,
                            &output.to_string(),
                            multi_container,
                        );
                        if text.is_empty() || tx.send(text).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = tx.send(format!(
                            "[error reading logs for {}: {}]",
                            label, error
                        ));
                        break;
                    }
                }
            }
        }));
    }
    drop(tx);

    loop {
        tokio::select! {
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) => break,
                    Some(Err(_)) => break,
                    None => break,
                    _ => {}
                }
            }
            log_entry = rx.recv() => {
                match log_entry {
                    Some(text) => {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    for task in tasks {
        task.abort();
    }

    info!(
        service_id = %service_id,
        service_name = %service_name,
        "container logs websocket disconnected"
    );
}

/// websocket endpoint for deployment build logs
pub async fn deployment_logs_ws(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    Path((service_id, deployment_id)): Path<(Uuid, Uuid)>,
    Query(query): Query<DeploymentLogsQuery>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    let user_id =
        get_ws_user_id(&state, &headers, query.token.as_deref()).await?;
    ServiceSvc::new(state.clone())
        .get_service(user_id, service_id)
        .await?;

    Ok(ws.on_upgrade(move |socket| {
        handle_deployment_logs(
            socket,
            service_id,
            deployment_id,
            query.offset,
            state,
        )
    }))
}

/// handle websocket connection for deployment build logs
async fn handle_deployment_logs(
    mut socket: WebSocket,
    service_id: Uuid,
    deployment_id: Uuid,
    initial_offset: usize,
    state: AppState,
) {
    info!(service_id = %service_id, deployment_id = %deployment_id, "build logs websocket connected");

    let mut current_offset = initial_offset;

    let _deployment = match state.db.get_deployment(deployment_id) {
        Ok(Some(d)) => d,
        Ok(None) => {
            let _ = socket
                .send(Message::Text("error: deployment not found".into()))
                .await;
            return;
        }
        Err(e) => {
            let _ = socket
                .send(Message::Text(format!("error: {}", e).into()))
                .await;
            return;
        }
    };

    loop {
        match state
            .db
            .get_deployment_logs(deployment_id, 100, current_offset)
        {
            Ok(logs) => {
                if !logs.is_empty() {
                    for log in logs {
                        if socket.send(Message::Text(log.into())).await.is_err()
                        {
                            return;
                        }
                        current_offset += 1;
                    }
                }
            }
            Err(e) => {
                let _ = socket
                    .send(Message::Text(
                        format!("error reading logs: {}", e).into(),
                    ))
                    .await;
                break;
            }
        }

        let deployment = match state.db.get_deployment(deployment_id) {
            Ok(Some(d)) => d,
            _ => break,
        };

        let status = deployment.status;
        let is_finished = status
            == containr_common::models::DeploymentStatus::Running
            || status == containr_common::models::DeploymentStatus::Failed
            || status == containr_common::models::DeploymentStatus::Stopped;

        if is_finished {
            if let Ok(logs) =
                state
                    .db
                    .get_deployment_logs(deployment_id, 1, current_offset)
            {
                if logs.is_empty() {
                    let _ = socket
                        .send(Message::Text(
                            format!(
                                "[deployment {}]",
                                format!("{:?}", status).to_lowercase()
                            )
                            .into(),
                        ))
                        .await;
                    break;
                }
            } else {
                break;
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        match socket.recv().now_or_never() {
            Some(Some(Ok(Message::Close(_)))) => break,
            Some(Some(Err(_))) => break,
            Some(None) => break,
            _ => {}
        }
    }

    info!(service_id = %service_id, deployment_id = %deployment_id, "build logs websocket disconnected");
}

async fn get_ws_user_id(
    state: &AppState,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> Result<Uuid, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let header_token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(extract_bearer_token);
    let token = query_token.or(header_token).ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "missing authentication token".to_string(),
            }),
        )
    })?;
    let claims =
        validate_token(token, &config.auth.jwt_secret).map_err(|error| {
            (
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: error.to_string(),
                }),
            )
        })?;

    Ok(claims.sub)
}

fn format_log_chunk(
    container_id: &str,
    text: &str,
    multi_container: bool,
) -> String {
    let trimmed = text.trim_end();
    if trimmed.is_empty() {
        return String::new();
    }
    if !multi_container {
        return trimmed.to_string();
    }

    trimmed
        .lines()
        .map(|line| format!("[{}] {}", container_id, line))
        .collect::<Vec<_>>()
        .join("\n")
}
