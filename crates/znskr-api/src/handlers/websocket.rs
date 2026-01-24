//! websocket handlers for live log streaming

use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    response::IntoResponse,
};
use bollard::query_parameters::LogsOptions;
use bollard::Docker;
use futures::{FutureExt, StreamExt};
use serde::Deserialize;
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

/// websocket endpoint for container logs
pub async fn container_logs_ws(
    ws: WebSocketUpgrade,
    Path(app_id): Path<Uuid>,
    Query(query): Query<LogsQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_container_logs(socket, app_id, query, state))
}

/// handle websocket connection for container logs
async fn handle_container_logs(
    mut socket: WebSocket,
    app_id: Uuid,
    query: LogsQuery,
    _state: AppState,
) {
    info!(app_id = %app_id, "container logs websocket connected");

    // send welcome message
    if socket
        .send(Message::Text(
            format!("[connected to container logs for {}]", app_id).into(),
        ))
        .await
        .is_err()
    {
        return;
    }

    // connect to docker
    let docker = match Docker::connect_with_socket_defaults() {
        Ok(d) => Arc::new(d),
        Err(e) => {
            let _ = socket
                .send(Message::Text(
                    format!("[error: failed to connect to docker: {}]", e).into(),
                ))
                .await;
            return;
        }
    };

    // get the container name
    let container_name = format!("znskr-{}", app_id);

    // set up log streaming options
    let options = LogsOptions {
        stdout: true,
        stderr: true,
        follow: true,
        tail: query.tail.to_string(),
        ..Default::default()
    };

    let mut log_stream = docker.logs(&container_name, Some(options));

    // stream logs to websocket
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
            log_entry = log_stream.next() => {
                match log_entry {
                    Some(Ok(output)) => {
                        let text = output.to_string();
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        let _ = socket.send(Message::Text(
                            format!("[error reading logs: {}]", e).into()
                        )).await;
                        break;
                    }
                    None => {
                        // stream ended
                        let _ = socket.send(Message::Text("[container logs stream ended]".into())).await;
                        break;
                    }
                }
            }
        }
    }

    info!(app_id = %app_id, "container logs websocket disconnected");
}

/// websocket endpoint for deployment build logs
pub async fn deployment_logs_ws(
    ws: WebSocketUpgrade,
    Path((app_id, deployment_id)): Path<(Uuid, Uuid)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_deployment_logs(socket, app_id, deployment_id, state))
}

/// handle websocket connection for deployment build logs
async fn handle_deployment_logs(
    mut socket: WebSocket,
    app_id: Uuid,
    deployment_id: Uuid,
    state: AppState,
) {
    info!(app_id = %app_id, deployment_id = %deployment_id, "build logs websocket connected");

    // initial offset
    let mut current_offset = 0;

    // get deployment from database to verify existence and check for legacy logs
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

    // check if we have legacy logs in the deployment struct
    if !deployment.logs.is_empty() {
        for log in &deployment.logs {
            if socket
                .send(Message::Text(log.clone().into()))
                .await
                .is_err()
            {
                return;
            }
        }
        // if legacy logs exist, we assume no new logs in DB for simplicity, 
        // or we could check DB too, but usually it's one or the other.
        // Assuming migration happened or new deployment.
        // If it's a new deployment, deployment.logs is empty.
    }

    // poll for new logs from DB
    loop {
        // get new logs from DB starting at current_offset
        // fetch in batches
        match state.db.get_deployment_logs(deployment_id, 100, current_offset) {
            Ok(logs) => {
                if !logs.is_empty() {
                    for log in logs {
                        if socket
                            .send(Message::Text(log.into()))
                            .await
                            .is_err()
                        {
                            return;
                        }
                        current_offset += 1;
                    }
                }
            }
            Err(e) => {
                let _ = socket
                    .send(Message::Text(format!("error reading logs: {}", e).into()))
                    .await;
                break;
            }
        }

        // check deployment status to see if we should stop polling
        // we check this AFTER sending logs to ensure we send everything
        let deployment = match state.db.get_deployment(deployment_id) {
            Ok(Some(d)) => d,
            _ => break,
        };

        let status = deployment.status;
        let is_finished = status == znskr_common::models::DeploymentStatus::Running
            || status == znskr_common::models::DeploymentStatus::Failed
            || status == znskr_common::models::DeploymentStatus::Stopped;

        // if finished and we didn't get any new logs in this iteration, we are done
        // (we rely on the previous get_deployment_logs call returning empty)
        // actually, we should only break if finished AND we are caught up.
        // but get_deployment_logs returning empty means we are caught up for now.
        if is_finished {
             // double check if there are more logs just in case race condition
             if let Ok(logs) = state.db.get_deployment_logs(deployment_id, 1, current_offset) {
                 if logs.is_empty() {
                    let _ = socket
                        .send(Message::Text(
                            format!("[deployment {}]", format!("{:?}", status).to_lowercase()).into(),
                        ))
                        .await;
                    break;
                 }
             } else {
                 break;
             }
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        // check for client disconnect
        match socket.recv().now_or_never() {
            Some(Some(Ok(Message::Close(_)))) => break,
            Some(Some(Err(_))) => break,
            Some(None) => break, // stream closed
            _ => {}
        }
    }

    info!(app_id = %app_id, deployment_id = %deployment_id, "build logs websocket disconnected");
}
