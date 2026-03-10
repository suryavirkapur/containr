use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::managed_services::ServiceStatus as ManagedServiceStatus;
use crate::models::{
    ContainerService, Deployment, DeploymentStatus, ServiceType,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceResourceKind {
    AppService,
    ManagedDatabase,
    ManagedQueue,
}

impl ServiceResourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ServiceResourceKind::AppService => "app_service",
            ServiceResourceKind::ManagedDatabase => "managed_database",
            ServiceResourceKind::ManagedQueue => "managed_queue",
        }
    }
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default,
)]
#[serde(rename_all = "snake_case")]
pub enum ServiceRuntimeStatus {
    #[default]
    Pending,
    Starting,
    Running,
    Partial,
    Stopped,
    Failed,
}

impl ServiceRuntimeStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ServiceRuntimeStatus::Pending => "pending",
            ServiceRuntimeStatus::Starting => "starting",
            ServiceRuntimeStatus::Running => "running",
            ServiceRuntimeStatus::Partial => "partial",
            ServiceRuntimeStatus::Stopped => "stopped",
            ServiceRuntimeStatus::Failed => "failed",
        }
    }

    pub fn from_managed_status(status: ManagedServiceStatus) -> Self {
        match status {
            ManagedServiceStatus::Pending => Self::Pending,
            ManagedServiceStatus::Starting => Self::Starting,
            ManagedServiceStatus::Running => Self::Running,
            ManagedServiceStatus::Stopped => Self::Stopped,
            ManagedServiceStatus::Failed => Self::Failed,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceInventoryItem {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub group_id: Option<Uuid>,
    pub project_id: Option<Uuid>,
    pub project_name: Option<String>,
    pub resource_kind: ServiceResourceKind,
    pub service_type: ServiceType,
    pub name: String,
    pub image: Option<String>,
    pub status: ServiceRuntimeStatus,
    pub network_name: String,
    pub internal_host: Option<String>,
    pub port: Option<u16>,
    pub external_port: Option<u16>,
    pub proxy_port: Option<u16>,
    pub proxy_external_port: Option<u16>,
    pub connection_string: Option<String>,
    pub proxy_connection_string: Option<String>,
    pub domains: Vec<String>,
    pub schedule: Option<String>,
    pub public_http: bool,
    pub desired_instances: u32,
    pub running_instances: u32,
    pub container_ids: Vec<String>,
    pub deployment_id: Option<Uuid>,
    pub pitr_enabled: bool,
    pub proxy_enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl ServiceInventoryItem {
    pub fn service_type_name(&self) -> &'static str {
        ContainerService::service_type_name(self.service_type)
    }
}

#[derive(Debug, Clone, Default)]
pub struct AppServiceRuntimeSummary {
    pub deployment_id: Option<Uuid>,
    pub image: Option<String>,
    pub status: ServiceRuntimeStatus,
    pub desired_instances: u32,
    pub running_instances: u32,
    pub container_ids: Vec<String>,
}

pub fn summarize_app_service_runtime(
    service: &ContainerService,
    deployments: &[Deployment],
) -> AppServiceRuntimeSummary {
    let mut deployments = deployments.to_vec();
    deployments.sort_by(|left, right| right.created_at.cmp(&left.created_at));

    let desired_instances = if service.is_cron_job() {
        1
    } else {
        service.replicas.max(1)
    };
    let mut summary = AppServiceRuntimeSummary {
        deployment_id: None,
        image: None,
        status: ServiceRuntimeStatus::Pending,
        desired_instances,
        running_instances: 0,
        container_ids: Vec::new(),
    };

    let deployment = deployments
        .iter()
        .find(|deployment| deployment.status == DeploymentStatus::Running)
        .or_else(|| deployments.first());
    let Some(deployment) = deployment else {
        if !service.image.trim().is_empty() {
            summary.image = Some(service.image.clone());
        }
        return summary;
    };

    summary.deployment_id = Some(deployment.id);
    summary.image = deployment
        .service_deployments
        .iter()
        .find(|service_deployment| service_deployment.service_id == service.id)
        .and_then(|service_deployment| service_deployment.image_id.clone())
        .or_else(|| {
            if service.image.trim().is_empty() {
                deployment.image_id.clone()
            } else {
                Some(service.image.clone())
            }
        });

    let service_deployments = deployment
        .service_deployments
        .iter()
        .filter(|service_deployment| {
            service_deployment.service_id == service.id
        })
        .collect::<Vec<_>>();

    if service_deployments.is_empty() {
        summary.status = match deployment.status {
            DeploymentStatus::Failed => ServiceRuntimeStatus::Failed,
            DeploymentStatus::Stopped => ServiceRuntimeStatus::Stopped,
            DeploymentStatus::Running => ServiceRuntimeStatus::Stopped,
            DeploymentStatus::Pending => ServiceRuntimeStatus::Pending,
            DeploymentStatus::Cloning
            | DeploymentStatus::Building
            | DeploymentStatus::Pushing
            | DeploymentStatus::Starting => ServiceRuntimeStatus::Starting,
        };
        return summary;
    }

    summary.running_instances = service_deployments
        .iter()
        .filter(|service_deployment| {
            service_deployment.status == DeploymentStatus::Running
        })
        .count() as u32;
    summary.container_ids = service_deployments
        .iter()
        .filter_map(|service_deployment| {
            service_deployment.container_id.clone()
        })
        .collect();

    summary.status = if summary.running_instances == desired_instances
        && desired_instances > 0
    {
        ServiceRuntimeStatus::Running
    } else if summary.running_instances > 0 {
        ServiceRuntimeStatus::Partial
    } else if service_deployments.iter().any(|service_deployment| {
        matches!(
            service_deployment.status,
            DeploymentStatus::Pending
                | DeploymentStatus::Cloning
                | DeploymentStatus::Building
                | DeploymentStatus::Pushing
                | DeploymentStatus::Starting
        )
    }) {
        ServiceRuntimeStatus::Starting
    } else if service_deployments.iter().any(|service_deployment| {
        service_deployment.status == DeploymentStatus::Failed
    }) {
        ServiceRuntimeStatus::Failed
    } else if service_deployments.iter().all(|service_deployment| {
        service_deployment.status == DeploymentStatus::Stopped
    }) {
        ServiceRuntimeStatus::Stopped
    } else {
        ServiceRuntimeStatus::Pending
    };

    summary
}

#[cfg(test)]
#[path = "service_inventory_test.rs"]
mod service_inventory_test;
