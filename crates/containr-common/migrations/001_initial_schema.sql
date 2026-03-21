-- Users table
create table if not exists users (
    id text primary key,
    email text not null unique,
    password_hash text,
    github_id integer,
    github_username text,
    github_access_token text,
    is_admin integer not null default 0,
    created_at text not null,
    updated_at text not null
);

-- Apps/Projects table
create table if not exists apps (
    id text primary key,
    name text not null,
    github_url text,
    branch text not null default 'main',
    domains text not null default '[]',
    env_vars text not null default '[]',
    auto_deploy_enabled integer not null default 1,
    auto_deploy_watch_paths text not null default '[]',
    auto_deploy_cleanup_stale_deployments integer not null default 1,
    deploy_webhook_token text not null,
    port integer not null default 8080,
    rollout_strategy text not null default 'stop_first',
    owner_id text not null,
    created_at text not null,
    updated_at text not null,
    foreign key (owner_id) references users(id) on delete cascade
);

create index if not exists apps_owner_idx on apps (owner_id);
create index if not exists apps_domain_idx on apps (domains);

-- Services table
create table if not exists services (
    id text primary key,
    app_id text not null,
    name text not null,
    image text not null default '',
    service_type text not null default 'web_service',
    port integer,
    expose_http integer not null default 0,
    additional_ports text not null default '[]',
    replicas integer not null default 1,
    memory_limit text,
    cpu_limit text,
    depends_on text not null default '[]',
    health_check text,
    restart_policy text not null default 'always',
    registry_auth text,
    env_vars text not null default '[]',
    domains text not null default '[]',
    http_only_domains text not null default '[]',
    build_context text,
    dockerfile_path text,
    build_target text,
    build_args text not null default '[]',
    command text,
    entrypoint text,
    working_dir text,
    schedule text,
    mounts text not null default '[]',
    created_at text not null,
    updated_at text not null,
    foreign key (app_id) references apps(id) on delete cascade
);

create index if not exists services_app_idx on services (app_id);

-- Deployments table
create table if not exists deployments (
    id text primary key,
    app_id text not null,
    commit_sha text not null,
    commit_message text not null default '',
    branch text not null,
    source_url text,
    rollout_strategy text not null default 'stop_first',
    rollback_from_deployment_id text,
    app_snapshot text,
    status text not null default 'pending',
    container_id text,
    image_id text,
    started_at text,
    finished_at text,
    created_at text not null,
    foreign key (app_id) references apps(id) on delete cascade,
    foreign key (rollback_from_deployment_id) references deployments(id) on delete set null
);

create index if not exists deployments_app_idx on deployments (app_id);
create index if not exists deployments_status_idx on deployments (status);

-- Service deployments table
create table if not exists service_deployments (
    id text primary key,
    service_id text not null,
    deployment_id text not null,
    replica_index integer not null default 0,
    status text not null default 'pending',
    container_id text,
    image_id text,
    health text not null default 'unknown',
    logs text not null default '[]',
    started_at text,
    finished_at text,
    created_at text not null,
    foreign key (service_id) references services(id) on delete cascade,
    foreign key (deployment_id) references deployments(id) on delete cascade
);

create index if not exists service_deployments_deployment_idx on service_deployments (deployment_id);
create index if not exists service_deployments_service_idx on service_deployments (service_id);

-- Deployment logs table
create table if not exists deployment_logs (
    deployment_id text not null,
    idx integer not null,
    line text not null,
    created_at text not null default (datetime('now')),
    primary key (deployment_id, idx),
    foreign key (deployment_id) references deployments(id) on delete cascade
);

create index if not exists deployment_logs_deployment_idx on deployment_logs (deployment_id, idx);

-- Certificates table
create table if not exists certificates (
    id text primary key,
    domain text not null unique,
    cert_pem text not null,
    key_pem text not null,
    expires_at text not null,
    created_at text not null
);

create index if not exists certificates_domain_idx on certificates (domain);

-- Managed databases table
create table if not exists managed_databases (
    id text primary key,
    owner_id text not null,
    group_id text,
    name text not null,
    db_type text not null,
    version text not null,
    container_id text,
    volume_name text,
    host_data_path text,
    internal_host text not null,
    port integer not null,
    external_port integer,
    pitr_enabled integer not null default 0,
    pitr_last_base_backup_at text,
    pitr_last_base_backup_label text,
    proxy_enabled integer not null default 0,
    proxy_external_port integer,
    credentials text not null,
    memory_limit text,
    cpu_limit text,
    status text not null default 'pending',
    created_at text not null,
    updated_at text not null,
    foreign key (owner_id) references users(id) on delete cascade
);

create index if not exists managed_databases_owner_idx on managed_databases (owner_id);
create index if not exists managed_databases_group_idx on managed_databases (group_id);

-- Managed queues table
create table if not exists managed_queues (
    id text primary key,
    owner_id text not null,
    group_id text,
    name text not null,
    queue_type text not null,
    version text not null,
    container_id text,
    volume_name text,
    host_data_path text,
    internal_host text not null,
    port integer not null,
    external_port integer,
    credentials text not null,
    memory_limit text,
    cpu_limit text,
    status text not null default 'pending',
    created_at text not null,
    updated_at text not null,
    foreign key (owner_id) references users(id) on delete cascade
);

create index if not exists managed_queues_owner_idx on managed_queues (owner_id);
create index if not exists managed_queues_group_idx on managed_queues (group_id);

-- Storage buckets table
create table if not exists storage_buckets (
    id text primary key,
    owner_id text not null,
    name text not null,
    access_key text not null,
    secret_key text not null,
    size_bytes integer,
    endpoint text,
    created_at text not null,
    foreign key (owner_id) references users(id) on delete cascade
);

create index if not exists storage_buckets_owner_idx on storage_buckets (owner_id);

-- GitHub Apps table
create table if not exists github_apps (
    id text primary key,
    app_id integer not null,
    app_name text not null,
    client_id text not null,
    client_secret text not null,
    private_key text not null,
    webhook_secret text not null,
    html_url text not null,
    owner_id text not null,
    installations text not null default '[]',
    created_at text not null,
    updated_at text not null,
    foreign key (owner_id) references users(id) on delete cascade
);

create index if not exists github_apps_owner_idx on github_apps (owner_id);

-- HTTP request logs table
create table if not exists http_request_logs (
    service_id text not null,
    idx integer not null,
    value text not null,
    created_at text not null default (datetime('now')),
    primary key (service_id, idx)
);

create index if not exists http_request_logs_service_idx on http_request_logs (service_id, idx desc);
