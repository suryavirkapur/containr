use uuid::Uuid;

use super::{first_app_service_id, supported_template_message, TemplateKind};
use crate::handlers::apps::{AppResponse, EnvVarResponse, ServiceResponse};

fn build_app_response(service_id: &str) -> AppResponse {
    AppResponse {
        id: Uuid::new_v4(),
        name: "demo".to_string(),
        github_url: "https://github.com/example/demo".to_string(),
        branch: "main".to_string(),
        domain: None,
        domains: Vec::new(),
        port: 8080,
        env_vars: Vec::<EnvVarResponse>::new(),
        services: vec![ServiceResponse {
            id: service_id.to_string(),
            name: "web".to_string(),
            image: String::new(),
            service_type: "web_service".to_string(),
            port: 8080,
            expose_http: true,
            domain: None,
            domains: Vec::new(),
            additional_ports: Vec::new(),
            replicas: 1,
            memory_limit_mb: None,
            cpu_limit: None,
            depends_on: Vec::new(),
            health_check: None,
            restart_policy: "always".to_string(),
            registry_auth: None,
            env_vars: Vec::new(),
            build_context: None,
            dockerfile_path: None,
            build_target: None,
            build_args: Vec::new(),
            command: Vec::new(),
            entrypoint: Vec::new(),
            working_dir: None,
            schedule: None,
            mounts: Vec::new(),
        }],
        rollout_strategy: "stop_first".to_string(),
        created_at: "2026-03-10T00:00:00Z".to_string(),
    }
}

#[test]
fn template_kind_accepts_current_service_templates() {
    assert_eq!(
        TemplateKind::parse("postgresql"),
        Some(TemplateKind::Postgresql)
    );
    assert_eq!(TemplateKind::parse("valkey"), Some(TemplateKind::Redis));
    assert_eq!(TemplateKind::parse("mariadb"), Some(TemplateKind::Mariadb));
    assert_eq!(TemplateKind::parse("qdrant"), Some(TemplateKind::Qdrant));
    assert_eq!(
        TemplateKind::parse("rabbitmq"),
        Some(TemplateKind::Rabbitmq)
    );
    assert_eq!(TemplateKind::parse("unknown"), None);
}

#[test]
fn template_kind_reports_queue_template_only_for_rabbitmq() {
    assert!(TemplateKind::Rabbitmq.is_queue());
    assert!(!TemplateKind::Postgresql.is_queue());
}

#[test]
fn first_app_service_id_returns_the_first_created_service() {
    let service_id = Uuid::new_v4();
    let app = build_app_response(&service_id.to_string());

    let resolved_id = match first_app_service_id(&app) {
        Ok(id) => id,
        Err(error) => panic!("expected service id to parse: {:?}", error),
    };

    assert_eq!(resolved_id, service_id);
}

#[test]
fn first_app_service_id_rejects_missing_services() {
    let mut app = build_app_response(&Uuid::new_v4().to_string());
    app.services.clear();

    let error = match first_app_service_id(&app) {
        Ok(_) => panic!("expected missing services to fail"),
        Err(error) => error,
    };

    assert_eq!(error.0.as_u16(), 500);
}

#[test]
fn first_app_service_id_rejects_invalid_service_ids() {
    let app = build_app_response("not-a-uuid");

    let error = match first_app_service_id(&app) {
        Ok(_) => panic!("expected invalid service id to fail"),
        Err(error) => error,
    };

    assert_eq!(error.0.as_u16(), 500);
}

#[test]
fn supported_template_message_lists_current_templates() {
    assert_eq!(
        supported_template_message(),
        "invalid template. supported: postgresql, redis, mariadb, qdrant, rabbitmq"
    );
}
