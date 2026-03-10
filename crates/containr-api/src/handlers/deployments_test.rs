use uuid::Uuid;

use super::can_rollback_to_deployment;
use containr_common::models::{
    ContainerService, Deployment, Project, ServiceDeployment,
};

#[test]
fn rollback_accepts_multi_service_deployment_with_service_images() {
    let owner_id = Uuid::new_v4();
    let mut app = Project::new("demo".to_string(), String::new(), owner_id);

    let web = ContainerService::new(
        app.id,
        "web".to_string(),
        "nginx:alpine".to_string(),
        80,
    );
    let worker = ContainerService::new(
        app.id,
        "worker".to_string(),
        "alpine:3.22".to_string(),
        0,
    );
    app.services = vec![web.clone(), worker.clone()];

    let mut deployment = Deployment::new(app.id, "initial".to_string());
    let mut web_sd = ServiceDeployment::new(web.id, deployment.id, 0);
    web_sd.image_id = Some("nginx:alpine".to_string());
    let mut worker_sd = ServiceDeployment::new(worker.id, deployment.id, 0);
    worker_sd.image_id = Some("alpine:3.22".to_string());
    deployment.service_deployments = vec![web_sd, worker_sd];

    assert!(can_rollback_to_deployment(&app, &deployment));
}

#[test]
fn rollback_rejects_built_service_without_saved_image() {
    let owner_id = Uuid::new_v4();
    let mut app = Project::new(
        "demo".to_string(),
        "https://github.com/example/repo.git".to_string(),
        owner_id,
    );

    let web =
        ContainerService::new(app.id, "web".to_string(), String::new(), 80);
    app.services = vec![web];

    let deployment = Deployment::new(app.id, "initial".to_string());

    assert!(!can_rollback_to_deployment(&app, &deployment));
}
