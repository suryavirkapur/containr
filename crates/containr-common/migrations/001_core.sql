create table if not exists users (
    id text primary key,
    email text not null unique,
    password_hash text,
    github_id integer unique,
    github_username text,
    github_access_token text,
    is_admin integer not null default 0,
    created_at text not null,
    updated_at text not null
);
create index if not exists users_github_id_idx on users (github_id);

create table if not exists apps (
    id text primary key,
    owner_id text not null,
    name text not null,
    github_url text not null,
    branch text not null,
    domain text,
    port integer not null,
    rollout_strategy text not null,
    created_at text not null,
    updated_at text not null
);
create index if not exists apps_owner_idx on apps (owner_id);
create index if not exists apps_source_idx on apps (github_url, branch);

create table if not exists app_domains (
    app_id text not null,
    domain text not null unique,
    position integer not null,
    primary key (app_id, domain),
    foreign key (app_id) references apps(id) on delete cascade
);
create index if not exists app_domains_app_idx
    on app_domains (app_id, position);

create table if not exists app_env_vars (
    app_id text not null,
    position integer not null,
    key text not null,
    value text not null,
    secret integer not null,
    primary key (app_id, position),
    foreign key (app_id) references apps(id) on delete cascade
);

create table if not exists services (
    id text primary key,
    app_id text not null,
    name text not null,
    image text not null,
    service_type text,
    port integer not null,
    expose_http integer not null default 0,
    replicas integer not null,
    memory_limit integer,
    cpu_limit real,
    health_check_path text,
    health_check_interval_secs integer,
    health_check_timeout_secs integer,
    health_check_retries integer,
    restart_policy text not null,
    build_context text,
    dockerfile_path text,
    build_target text,
    working_dir text,
    schedule text,
    created_at text not null,
    updated_at text not null,
    foreign key (app_id) references apps(id) on delete cascade
);
create unique index if not exists services_app_name_idx
    on services (app_id, name);
create index if not exists services_app_idx on services (app_id, name);

create table if not exists service_dependencies (
    service_id text not null,
    position integer not null,
    dependency_name text not null,
    primary key (service_id, position),
    foreign key (service_id) references services(id) on delete cascade
);

create table if not exists service_additional_ports (
    service_id text not null,
    position integer not null,
    port integer not null,
    primary key (service_id, position),
    foreign key (service_id) references services(id) on delete cascade
);

create table if not exists service_command_args (
    service_id text not null,
    position integer not null,
    value text not null,
    primary key (service_id, position),
    foreign key (service_id) references services(id) on delete cascade
);

create table if not exists service_entrypoint_args (
    service_id text not null,
    position integer not null,
    value text not null,
    primary key (service_id, position),
    foreign key (service_id) references services(id) on delete cascade
);

create table if not exists service_registry_auth (
    service_id text primary key,
    server text,
    username text not null,
    password text not null,
    foreign key (service_id) references services(id) on delete cascade
);

create table if not exists service_env_vars (
    service_id text not null,
    position integer not null,
    key text not null,
    value text not null,
    secret integer not null,
    primary key (service_id, position),
    foreign key (service_id) references services(id) on delete cascade
);

create table if not exists service_domains (
    service_id text not null,
    domain text not null unique,
    position integer not null,
    primary key (service_id, domain),
    foreign key (service_id) references services(id) on delete cascade
);
create index if not exists service_domains_service_idx
    on service_domains (service_id, position);

create table if not exists service_build_args (
    service_id text not null,
    position integer not null,
    key text not null,
    value text not null,
    secret integer not null,
    primary key (service_id, position),
    foreign key (service_id) references services(id) on delete cascade
);

create table if not exists service_mounts (
    service_id text not null,
    position integer not null,
    name text not null,
    target text not null,
    read_only integer not null,
    primary key (service_id, position),
    foreign key (service_id) references services(id) on delete cascade
);

create table if not exists deployments (
    id text primary key,
    app_id text not null,
    commit_sha text not null,
    commit_message text,
    branch text not null default 'main',
    source_url text,
    rollout_strategy text not null default 'stop_first',
    rollback_from_deployment_id text,
    status text not null,
    container_id text,
    image_id text,
    started_at text,
    finished_at text,
    created_at text not null
);
create index if not exists deployments_app_created_idx
    on deployments (app_id, created_at desc);

create table if not exists deployment_logs (
    deployment_id text not null,
    idx integer not null,
    line text not null,
    primary key (deployment_id, idx),
    foreign key (deployment_id) references deployments(id) on delete cascade
);
create index if not exists deployment_logs_deployment_idx
    on deployment_logs (deployment_id, idx);

create table if not exists service_deployments (
    id text primary key,
    service_id text not null,
    deployment_id text not null,
    replica_index integer not null,
    status text not null,
    container_id text,
    image_id text,
    health text not null,
    started_at text,
    finished_at text,
    created_at text not null,
    foreign key (deployment_id) references deployments(id) on delete cascade
);
create index if not exists service_deployments_deployment_idx
    on service_deployments (deployment_id, service_id, replica_index);
create index if not exists service_deployments_service_idx
    on service_deployments (service_id, created_at desc);

create table if not exists service_deployment_logs (
    service_deployment_id text not null,
    idx integer not null,
    line text not null,
    primary key (service_deployment_id, idx),
    foreign key (service_deployment_id) references service_deployments(id)
        on delete cascade
);

create table if not exists certificates (
    domain text primary key,
    id text not null unique,
    cert_pem text not null,
    key_pem text not null,
    expires_at text not null,
    created_at text not null
);
