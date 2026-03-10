create table if not exists managed_databases (
    id text primary key,
    owner_id text not null,
    group_id text,
    name text not null,
    db_type text not null,
    version text not null,
    container_id text,
    volume_name text not null,
    host_data_path text not null,
    internal_host text not null,
    port integer not null,
    external_port integer,
    pitr_enabled integer not null default 0,
    pitr_last_base_backup_at text,
    pitr_last_base_backup_label text,
    proxy_enabled integer not null default 0,
    proxy_external_port integer,
    username text not null,
    password text not null,
    database_name text not null,
    memory_limit integer not null,
    cpu_limit real not null,
    status text not null,
    created_at text not null,
    updated_at text not null
);
create index if not exists managed_databases_owner_created_idx
    on managed_databases (owner_id, created_at desc);

create table if not exists managed_queues (
    id text primary key,
    owner_id text not null,
    group_id text,
    name text not null,
    queue_type text not null,
    version text not null,
    container_id text,
    volume_name text not null,
    host_data_path text not null,
    internal_host text not null,
    port integer not null,
    external_port integer,
    username text not null,
    password text not null,
    memory_limit integer not null,
    cpu_limit real not null,
    status text not null,
    created_at text not null,
    updated_at text not null
);
create index if not exists managed_queues_owner_created_idx
    on managed_queues (owner_id, created_at desc);

create table if not exists storage_buckets (
    id text primary key,
    owner_id text not null,
    name text not null,
    access_key text not null,
    secret_key text not null,
    size_bytes integer not null,
    endpoint text not null,
    created_at text not null
);
create index if not exists storage_buckets_owner_created_idx
    on storage_buckets (owner_id, created_at desc);

create table if not exists github_apps (
    owner_id text primary key,
    id text not null unique,
    app_id integer not null,
    app_name text not null,
    client_id text not null,
    client_secret text not null,
    private_key text not null,
    webhook_secret text not null,
    html_url text not null,
    created_at text not null,
    updated_at text not null
);
create index if not exists github_apps_app_id_idx on github_apps (app_id);

create table if not exists github_app_installations (
    owner_id text not null,
    installation_id integer not null,
    account_login text not null,
    account_type text not null,
    repository_count integer,
    created_at text not null,
    primary key (owner_id, installation_id),
    foreign key (owner_id) references github_apps(owner_id) on delete cascade
);
