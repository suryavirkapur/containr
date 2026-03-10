use chrono::Utc;
use uuid::Uuid;

use crate::models::{
    ContainerService, Deployment, DeploymentStatus, ServiceDeployment,
    ServiceType,
};
use crate::service_inventory::{
    summarize_app_service_runtime, ServiceRuntimeStatus,
};

fn make_service() -> ContainerService {
    let app_id = Uuid::new_v4();
    let mut service =
        ContainerService::new(app_id, "api".to_string(), "".to_string(), 8080);
    service.replicas = 2;
    service.service_type = ServiceType::PrivateService;
    service
}

fn make_deployment(service: &ContainerService) -> Deployment {
    let mut deployment =
        Deployment::new(service.app_id, "deadbeef".to_string());
    deployment.created_at = Utc::now();
    deployment
}

#[test]
fn summarize_app_service_runtime_marks_partial_replica_state() {
    let service = make_service();
    let mut deployment = make_deployment(&service);
    deployment.status = DeploymentStatus::Running;

    let mut first = ServiceDeployment::new(service.id, deployment.id, 0);
    first.status = DeploymentStatus::Running;
    first.container_id = Some("containr-app-api-0".to_string());
    first.image_id = Some("ghcr.io/example/api:latest".to_string());

    let mut second = ServiceDeployment::new(service.id, deployment.id, 1);
    second.status = DeploymentStatus::Stopped;
    second.image_id = Some("ghcr.io/example/api:latest".to_string());

    deployment.service_deployments = vec![first, second];

    let summary = summarize_app_service_runtime(&service, &[deployment]);

    assert_eq!(summary.status, ServiceRuntimeStatus::Partial);
    assert_eq!(summary.desired_instances, 2);
    assert_eq!(summary.running_instances, 1);
    assert_eq!(summary.container_ids.len(), 1);
    assert_eq!(summary.image.as_deref(), Some("ghcr.io/example/api:latest"));
}

#[test]
fn summarize_app_service_runtime_uses_latest_failed_deployment() {
    let service = make_service();
    let mut deployment = make_deployment(&service);
    deployment.status = DeploymentStatus::Failed;

    let mut service_deployment =
        ServiceDeployment::new(service.id, deployment.id, 0);
    service_deployment.status = DeploymentStatus::Failed;
    deployment.service_deployments = vec![service_deployment];

    let summary = summarize_app_service_runtime(&service, &[deployment]);

    assert_eq!(summary.status, ServiceRuntimeStatus::Failed);
    assert_eq!(summary.running_instances, 0);
}

#[test]
fn summarize_app_service_runtime_marks_cron_as_stopped_without_run() {
    let mut service = ContainerService::new(
        Uuid::new_v4(),
        "cron".to_string(),
        "".to_string(),
        0,
    );
    service.service_type = ServiceType::CronJob;
    service.schedule = Some("*/5 * * * *".to_string());

    let mut deployment =
        Deployment::new(service.app_id, "deadbeef".to_string());
    deployment.status = DeploymentStatus::Running;

    let mut service_deployment =
        ServiceDeployment::new(service.id, deployment.id, 0);
    service_deployment.status = DeploymentStatus::Stopped;
    deployment.service_deployments = vec![service_deployment];

    let summary = summarize_app_service_runtime(&service, &[deployment]);

    assert_eq!(summary.status, ServiceRuntimeStatus::Stopped);
    assert_eq!(summary.desired_instances, 1);
    assert_eq!(summary.running_instances, 0);
}
