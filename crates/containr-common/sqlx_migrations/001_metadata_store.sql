create table if not exists metadata_users (
    key text primary key,
    value text not null
);

create table if not exists metadata_apps (
    key text primary key,
    value text not null
);

create table if not exists metadata_services (
    key text primary key,
    app_id text not null,
    value text not null
);

create index if not exists metadata_services_app_idx
    on metadata_services (app_id);

create table if not exists metadata_deployments (
    key text primary key,
    app_id text not null,
    value text not null
);

create index if not exists metadata_deployments_app_idx
    on metadata_deployments (app_id);

create table if not exists metadata_service_deployments (
    key text primary key,
    deployment_id text not null,
    service_id text not null,
    value text not null
);

create index if not exists metadata_service_deployments_deployment_idx
    on metadata_service_deployments (deployment_id);

create index if not exists metadata_service_deployments_service_idx
    on metadata_service_deployments (service_id);

create table if not exists metadata_deployment_logs (
    deployment_id text not null,
    idx integer not null,
    line text not null,
    created_at text not null default current_timestamp,
    primary key (deployment_id, idx)
);

create index if not exists metadata_deployment_logs_deployment_idx
    on metadata_deployment_logs (deployment_id, idx);

create table if not exists metadata_certificates (
    key text primary key,
    value text not null
);

create table if not exists metadata_managed_databases (
    key text primary key,
    owner_id text not null,
    value text not null
);

create index if not exists metadata_managed_databases_owner_idx
    on metadata_managed_databases (owner_id);

create table if not exists metadata_managed_queues (
    key text primary key,
    owner_id text not null,
    value text not null
);

create index if not exists metadata_managed_queues_owner_idx
    on metadata_managed_queues (owner_id);

create table if not exists metadata_storage_buckets (
    key text primary key,
    owner_id text not null,
    value text not null
);

create index if not exists metadata_storage_buckets_owner_idx
    on metadata_storage_buckets (owner_id);

create table if not exists metadata_github_apps (
    key text primary key,
    value text not null
);
