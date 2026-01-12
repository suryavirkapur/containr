//! WebSocket handlers for live log streaming

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    response::IntoResponse,
};
use futures::FutureExt;
use serde::Deserialize;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tracing::info;
use uuid::Uuid;

use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct LogsQuery {
    #[serde(default = "default_tail")]
    pub tail: usize,
}

fn default_tail() -> usize {
    100
}

/// WebSocket endpoint for container logs
pub async fn container_logs_ws(
    ws: WebSocketUpgrade,
    Path(app_id): Path<Uuid>,
    Query(query): Query<LogsQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_container_logs(socket, app_id, query, state))
}

/// Handle WebSocket connection for container logs
async fn handle_container_logs(
    mut socket: WebSocket,
    app_id: Uuid,
    query: LogsQuery,
    _state: AppState,
) {
    info!(app_id = %app_id, "container logs WebSocket connected");

    // Send welcome message
    if socket
        .send(Message::Text(
            format!("[connected to container logs for {}]", app_id).into(),
        ))
        .await
        .is_err()
    {
        return;
    }

    // Get the container ID
    let container_name = format!("znskr-{}", app_id);

    // Spawn docker logs -f process
    let child = Command::new("docker")
        .args([
            "logs",
            "-f",
            "--tail",
            &query.tail.to_string(),
            &container_name,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            let _ = socket
                .send(Message::Text(
                    format!("[error: failed to start docker logs: {}]", e).into(),
                ))
                .await;
            return;
        }
    };

    // Stream stdout
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Create readers for both stdout and stderr
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(100);

    // Stream stdout lines
    if let Some(stdout) = stdout {
        let tx = tx.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if tx.send(line).await.is_err() {
                    break;
                }
            }
        });
    }

    // Stream stderr lines
    if let Some(stderr) = stderr {
        let tx = tx.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if tx.send(format!("[stderr] {}", line)).await.is_err() {
                    break;
                }
            }
        });
    }

    // Drop extra tx so the channel can close when readers are done
    drop(tx);

    // Forward logs to WebSocket
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
            line = rx.recv() => {
                match line {
                    Some(line) => {
                        if socket.send(Message::Text(line.into())).await.is_err() {
                            break;
                        }
                    }
                    None => {
                        // Channel closed, docker logs exited
                        let _ = socket.send(Message::Text("[container logs stream ended]".into())).await;
                        break;
                    }
                }
            }
        }
    }

    // Kill docker logs process
    let _ = child.kill().await;
    info!(app_id = %app_id, "container logs WebSocket disconnected");
}

/// WebSocket endpoint for deployment build logs
pub async fn deployment_logs_ws(
    ws: WebSocketUpgrade,
    Path((app_id, deployment_id)): Path<(Uuid, Uuid)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_deployment_logs(socket, app_id, deployment_id, state))
}

/// Handle WebSocket connection for deployment build logs
async fn handle_deployment_logs(
    mut socket: WebSocket,
    app_id: Uuid,
    deployment_id: Uuid,
    state: AppState,
) {
    info!(app_id = %app_id, deployment_id = %deployment_id, "build logs WebSocket connected");

    // Get deployment from database
    let deployment = match state.db.get_deployment(deployment_id) {
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

    // Send existing logs
    for log in &deployment.logs {
        if socket
            .send(Message::Text(log.clone().into()))
            .await
            .is_err()
        {
            return;
        }
    }

    // Poll for new logs (simple polling approach)
    let mut last_log_count = deployment.logs.len();
    loop {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        // Check for client disconnect
        match socket.recv().now_or_never() {
            Some(Some(Ok(Message::Close(_)))) => break,
            Some(Some(Err(_))) => break,
            Some(None) => break,
            _ => {}
        }

        // Get updated deployment
        let deployment = match state.db.get_deployment(deployment_id) {
            Ok(Some(d)) => d,
            _ => continue,
        };

        // Send new logs
        if deployment.logs.len() > last_log_count {
            for log in &deployment.logs[last_log_count..] {
                if socket
                    .send(Message::Text(log.clone().into()))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            last_log_count = deployment.logs.len();
        }

        // Check if deployment is complete
        let status = deployment.status;
        if status == znskr_common::models::DeploymentStatus::Running
            || status == znskr_common::models::DeploymentStatus::Failed
            || status == znskr_common::models::DeploymentStatus::Stopped
        {
            let _ = socket
                .send(Message::Text(
                    format!("[deployment {}]", format!("{:?}", status).to_lowercase()).into(),
                ))
                .await;
            break;
        }
    }

    info!(app_id = %app_id, deployment_id = %deployment_id, "build logs WebSocket disconnected");
}
