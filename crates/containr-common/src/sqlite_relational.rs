use std::collections::HashSet;

use super::*;

pub(crate) struct SqliteDatabase {
    conn: Mutex<Connection>,
}

impl SqliteDatabase {
    pub(crate) fn open(path: &str) -> Result<Self> {
        ensure_parent_dir(path)?;
        let connection = Connection::open(path)?;
        connection.busy_timeout(StdDuration::from_secs(5))?;
        let legacy_tables = detect_legacy_json_tables(&connection)?;
        if !legacy_tables.is_empty() {
            return Err(Error::Database(format!(
                "unsupported legacy sqlite json tables detected: {}",
                legacy_tables.join(", ")
            )));
        }

        connection.execute_batch(
            r#"
            pragma journal_mode = wal;
            pragma synchronous = normal;
            pragma foreign_keys = on;
            pragma user_version = 8;

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
                created_at text not null,
                updated_at text not null,
                foreign key (app_id) references apps(id) on delete cascade
            );
            create unique index if not exists services_app_name_idx on services (app_id, name);
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

            create table if not exists managed_databases (
                id text primary key,
                owner_id text not null,
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
            "#,
        )?;
        ensure_column(
            &connection,
            MANAGED_DATABASES_TABLE,
            "external_port",
            "integer",
        )?;
        ensure_column(
            &connection,
            MANAGED_DATABASES_TABLE,
            "pitr_enabled",
            "integer not null default 0",
        )?;
        ensure_column(
            &connection,
            MANAGED_DATABASES_TABLE,
            "pitr_last_base_backup_at",
            "text",
        )?;
        ensure_column(
            &connection,
            USERS_TABLE,
            "is_admin",
            "integer not null default 0",
        )?;
        ensure_column(
            &connection,
            MANAGED_DATABASES_TABLE,
            "pitr_last_base_backup_label",
            "text",
        )?;
        ensure_column(
            &connection,
            MANAGED_DATABASES_TABLE,
            "proxy_enabled",
            "integer not null default 0",
        )?;
        ensure_column(
            &connection,
            MANAGED_DATABASES_TABLE,
            "proxy_external_port",
            "integer",
        )?;
        ensure_column(
            &connection,
            MANAGED_QUEUES_TABLE,
            "external_port",
            "integer",
        )?;
        ensure_column(
            &connection,
            SERVICES_TABLE,
            "expose_http",
            "integer not null default 0",
        )?;
        ensure_column(&connection, SERVICES_TABLE, "service_type", "text")?;
        ensure_column(&connection, SERVICES_TABLE, "build_context", "text")?;
        ensure_column(&connection, SERVICES_TABLE, "dockerfile_path", "text")?;
        ensure_column(&connection, SERVICES_TABLE, "build_target", "text")?;
        ensure_column(&connection, SERVICES_TABLE, "working_dir", "text")?;
        ensure_column(
            &connection,
            DEPLOYMENTS_TABLE,
            "branch",
            "text not null default 'main'",
        )?;
        ensure_column(&connection, DEPLOYMENTS_TABLE, "source_url", "text")?;
        ensure_column(
            &connection,
            DEPLOYMENTS_TABLE,
            "rollout_strategy",
            "text not null default 'stop_first'",
        )?;
        ensure_column(
            &connection,
            DEPLOYMENTS_TABLE,
            "rollback_from_deployment_id",
            "text",
        )?;
        ensure_column(&connection, SERVICE_DEPLOYMENTS_TABLE, "image_id", "text")?;

        Ok(Self {
            conn: Mutex::new(connection),
        })
    }

    fn with_conn<T>(&self, op: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.conn.lock();
        op(&conn)
    }

    fn with_tx<T>(&self, op: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let value = op(&tx)?;
        tx.commit()?;
        Ok(value)
    }

    fn load_user_by_id_text(&self, conn: &Connection, id: &str) -> Result<Option<User>> {
        let record = conn
            .query_row(
                &format!(
                    "select id, email, password_hash, github_id, github_username,
                        github_access_token, is_admin, created_at, updated_at
                     from {USERS_TABLE}
                     where id = ?1"
                ),
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                    ))
                },
            )
            .optional()?;

        let Some(record) = record else {
            return Ok(None);
        };

        Ok(Some(User {
            id: parse_uuid(record.0)?,
            email: record.1,
            password_hash: record.2,
            github_id: record.3,
            github_username: record.4,
            github_access_token: record.5,
            is_admin: int_to_bool(record.6),
            created_at: parse_datetime(record.7)?,
            updated_at: parse_datetime(record.8)?,
        }))
    }

    fn load_app_domains(&self, conn: &Connection, app_id: &str) -> Result<Vec<String>> {
        let mut statement = conn.prepare(&format!(
            "select domain from {APP_DOMAINS_TABLE}
             where app_id = ?1
             order by position asc"
        ))?;
        let mut rows = statement.query(params![app_id])?;
        let mut domains = Vec::new();

        while let Some(row) = rows.next()? {
            domains.push(row.get(0)?);
        }

        Ok(domains)
    }

    fn load_app_env_vars(&self, conn: &Connection, app_id: &str) -> Result<Vec<EnvVar>> {
        let mut statement = conn.prepare(&format!(
            "select key, value, secret from {APP_ENV_VARS_TABLE}
             where app_id = ?1
             order by position asc"
        ))?;
        let mut rows = statement.query(params![app_id])?;
        let mut env_vars = Vec::new();

        while let Some(row) = rows.next()? {
            env_vars.push(EnvVar {
                key: row.get(0)?,
                value: row.get(1)?,
                secret: int_to_bool(row.get::<_, i64>(2)?),
            });
        }

        Ok(env_vars)
    }

    fn load_service_dependencies(
        &self,
        conn: &Connection,
        service_id: &str,
    ) -> Result<Vec<String>> {
        let mut statement = conn.prepare(&format!(
            "select dependency_name from {SERVICE_DEPENDENCIES_TABLE}
             where service_id = ?1
             order by position asc"
        ))?;
        let mut rows = statement.query(params![service_id])?;
        let mut depends_on = Vec::new();

        while let Some(row) = rows.next()? {
            depends_on.push(row.get(0)?);
        }

        Ok(depends_on)
    }

    fn load_service_mounts(
        &self,
        conn: &Connection,
        service_id: &str,
    ) -> Result<Vec<ServiceMount>> {
        let mut statement = conn.prepare(&format!(
            "select name, target, read_only from {SERVICE_MOUNTS_TABLE}
             where service_id = ?1
             order by position asc"
        ))?;
        let mut rows = statement.query(params![service_id])?;
        let mut mounts = Vec::new();

        while let Some(row) = rows.next()? {
            mounts.push(ServiceMount {
                name: row.get(0)?,
                target: row.get(1)?,
                read_only: int_to_bool(row.get::<_, i64>(2)?),
            });
        }

        Ok(mounts)
    }

    fn load_service_env_vars(&self, conn: &Connection, service_id: &str) -> Result<Vec<EnvVar>> {
        let mut statement = conn.prepare(&format!(
            "select key, value, secret from {SERVICE_ENV_VARS_TABLE}
             where service_id = ?1
             order by position asc"
        ))?;
        let mut rows = statement.query(params![service_id])?;
        let mut env_vars = Vec::new();

        while let Some(row) = rows.next()? {
            env_vars.push(EnvVar {
                key: row.get(0)?,
                value: row.get(1)?,
                secret: int_to_bool(row.get::<_, i64>(2)?),
            });
        }

        Ok(env_vars)
    }

    fn load_service_domains(&self, conn: &Connection, service_id: &str) -> Result<Vec<String>> {
        let mut statement = conn.prepare(&format!(
            "select domain from {SERVICE_DOMAINS_TABLE}
             where service_id = ?1
             order by position asc"
        ))?;
        let mut rows = statement.query(params![service_id])?;
        let mut domains = Vec::new();

        while let Some(row) = rows.next()? {
            domains.push(row.get(0)?);
        }

        Ok(domains)
    }

    fn load_service_build_args(
        &self,
        conn: &Connection,
        service_id: &str,
    ) -> Result<Vec<BuildArg>> {
        let mut statement = conn.prepare(&format!(
            "select key, value, secret from {SERVICE_BUILD_ARGS_TABLE}
             where service_id = ?1
             order by position asc"
        ))?;
        let mut rows = statement.query(params![service_id])?;
        let mut build_args = Vec::new();

        while let Some(row) = rows.next()? {
            build_args.push(BuildArg {
                key: row.get(0)?,
                value: row.get(1)?,
                secret: int_to_bool(row.get::<_, i64>(2)?),
            });
        }

        Ok(build_args)
    }

    fn load_service_additional_ports(
        &self,
        conn: &Connection,
        service_id: &str,
    ) -> Result<Vec<u16>> {
        let mut statement = conn.prepare(&format!(
            "select port from {SERVICE_ADDITIONAL_PORTS_TABLE}
             where service_id = ?1
             order by position asc"
        ))?;
        let mut rows = statement.query(params![service_id])?;
        let mut ports = Vec::new();

        while let Some(row) = rows.next()? {
            ports.push(parse_u16(row.get::<_, i64>(0)?, "service additional port")?);
        }

        Ok(ports)
    }

    fn load_service_args(
        &self,
        conn: &Connection,
        table: &str,
        service_id: &str,
    ) -> Result<Option<Vec<String>>> {
        let mut statement = conn.prepare(&format!(
            "select value from {table}
             where service_id = ?1
             order by position asc"
        ))?;
        let mut rows = statement.query(params![service_id])?;
        let mut values = Vec::new();

        while let Some(row) = rows.next()? {
            values.push(row.get(0)?);
        }

        if values.is_empty() {
            Ok(None)
        } else {
            Ok(Some(values))
        }
    }

    fn load_service_registry_auth(
        &self,
        conn: &Connection,
        service_id: &str,
    ) -> Result<Option<ServiceRegistryAuth>> {
        conn.query_row(
            &format!(
                "select server, username, password from {SERVICE_REGISTRY_AUTH_TABLE}
                 where service_id = ?1"
            ),
            params![service_id],
            |row| {
                Ok(ServiceRegistryAuth {
                    server: row.get(0)?,
                    username: row.get(1)?,
                    password: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }

    fn load_service_by_id_text(
        &self,
        conn: &Connection,
        service_id: &str,
    ) -> Result<Option<ContainerService>> {
        let record = conn
            .query_row(
                &format!(
                    "select id, app_id, name, image, service_type, port, expose_http, replicas,
                        memory_limit, cpu_limit,
                        health_check_path, health_check_interval_secs,
                        health_check_timeout_secs, health_check_retries, restart_policy,
                        build_context, dockerfile_path, build_target, working_dir, created_at,
                        updated_at
                     from {SERVICES_TABLE}
                     where id = ?1"
                ),
                params![service_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, Option<i64>>(8)?,
                        row.get::<_, Option<f64>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, Option<i64>>(11)?,
                        row.get::<_, Option<i64>>(12)?,
                        row.get::<_, Option<i64>>(13)?,
                        row.get::<_, String>(14)?,
                        row.get::<_, Option<String>>(15)?,
                        row.get::<_, Option<String>>(16)?,
                        row.get::<_, Option<String>>(17)?,
                        row.get::<_, Option<String>>(18)?,
                        row.get::<_, String>(19)?,
                        row.get::<_, String>(20)?,
                    ))
                },
            )
            .optional()?;

        let Some(record) = record else {
            return Ok(None);
        };

        let health_check = match (record.10, record.11, record.12, record.13) {
            (Some(path), Some(interval), Some(timeout), Some(retries)) => Some(HealthCheck {
                path,
                interval_secs: parse_u32(interval, "health_check_interval_secs")?,
                timeout_secs: parse_u32(timeout, "health_check_timeout_secs")?,
                retries: parse_u32(retries, "health_check_retries")?,
            }),
            _ => None,
        };

        Ok(Some(ContainerService {
            id: parse_uuid(record.0)?,
            app_id: parse_uuid(record.1)?,
            name: record.2,
            image: record.3,
            service_type: record.4.map(decode_enum).transpose()?.unwrap_or_else(|| {
                ContainerService::infer_service_type(int_to_bool(record.6), record.5 as u16)
            }),
            port: parse_u16(record.5, "service port")?,
            expose_http: int_to_bool(record.6),
            additional_ports: self.load_service_additional_ports(conn, service_id)?,
            replicas: parse_u32(record.7, "service replicas")?,
            memory_limit: transpose_i64_to_u64(record.8, "service memory_limit")?,
            cpu_limit: record.9,
            depends_on: self.load_service_dependencies(conn, service_id)?,
            env_vars: self.load_service_env_vars(conn, service_id)?,
            build_context: record.15,
            dockerfile_path: record.16,
            build_target: record.17,
            build_args: self.load_service_build_args(conn, service_id)?,
            command: self.load_service_args(conn, SERVICE_COMMAND_ARGS_TABLE, service_id)?,
            entrypoint: self.load_service_args(conn, SERVICE_ENTRYPOINT_ARGS_TABLE, service_id)?,
            working_dir: record.18,
            registry_auth: self.load_service_registry_auth(conn, service_id)?,
            mounts: self.load_service_mounts(conn, service_id)?,
            health_check,
            restart_policy: decode_enum(record.14)?,
            created_at: parse_datetime(record.19)?,
            updated_at: parse_datetime(record.20)?,
            domains: self.load_service_domains(conn, service_id)?,
        }))
    }

    fn load_services_by_app_id(
        &self,
        conn: &Connection,
        app_id: &str,
    ) -> Result<Vec<ContainerService>> {
        let mut statement = conn.prepare(&format!(
            "select id from {SERVICES_TABLE}
             where app_id = ?1
             order by name asc"
        ))?;
        let mut rows = statement.query(params![app_id])?;
        let mut service_ids = Vec::new();

        while let Some(row) = rows.next()? {
            service_ids.push(row.get::<_, String>(0)?);
        }

        let mut services = Vec::new();
        for service_id in service_ids {
            if let Some(service) = self.load_service_by_id_text(conn, &service_id)? {
                services.push(service);
            }
        }

        Ok(services)
    }

    fn load_app_by_id_text(&self, conn: &Connection, app_id: &str) -> Result<Option<App>> {
        let record = conn
            .query_row(
                &format!(
                    "select id, name, github_url, branch, domain, port, rollout_strategy,
                        owner_id, created_at, updated_at
                     from {APPS_TABLE}
                     where id = ?1"
                ),
                params![app_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                    ))
                },
            )
            .optional()?;

        let Some(record) = record else {
            return Ok(None);
        };

        Ok(Some(App {
            id: parse_uuid(record.0)?,
            name: record.1,
            github_url: record.2,
            branch: record.3,
            domains: self.load_app_domains(conn, app_id)?,
            domain: record.4,
            env_vars: self.load_app_env_vars(conn, app_id)?,
            port: parse_u16(record.5, "app port")?,
            services: self.load_services_by_app_id(conn, app_id)?,
            rollout_strategy: decode_enum(record.6)?,
            owner_id: parse_uuid(record.7)?,
            created_at: parse_datetime(record.8)?,
            updated_at: parse_datetime(record.9)?,
        }))
    }

    fn load_service_deployment_logs(
        &self,
        conn: &Connection,
        service_deployment_id: &str,
    ) -> Result<Vec<String>> {
        let mut statement = conn.prepare(&format!(
            "select line from {SERVICE_DEPLOYMENT_LOGS_TABLE}
             where service_deployment_id = ?1
             order by idx asc"
        ))?;
        let mut rows = statement.query(params![service_deployment_id])?;
        let mut logs = Vec::new();

        while let Some(row) = rows.next()? {
            logs.push(row.get(0)?);
        }

        Ok(logs)
    }

    fn load_service_deployment_by_id_text(
        &self,
        conn: &Connection,
        service_deployment_id: &str,
    ) -> Result<Option<ServiceDeployment>> {
        let record = conn
            .query_row(
                &format!(
                    "select id, service_id, deployment_id, replica_index, status, container_id,
                        image_id, health, started_at, finished_at, created_at
                     from {SERVICE_DEPLOYMENTS_TABLE}
                     where id = ?1"
                ),
                params![service_deployment_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, String>(10)?,
                    ))
                },
            )
            .optional()?;

        let Some(record) = record else {
            return Ok(None);
        };

        Ok(Some(ServiceDeployment {
            id: parse_uuid(record.0)?,
            service_id: parse_uuid(record.1)?,
            deployment_id: parse_uuid(record.2)?,
            replica_index: parse_u32(record.3, "service deployment replica_index")?,
            status: decode_enum(record.4)?,
            container_id: record.5,
            image_id: record.6,
            health: decode_enum(record.7)?,
            logs: self.load_service_deployment_logs(conn, service_deployment_id)?,
            started_at: parse_optional_datetime(record.8)?,
            finished_at: parse_optional_datetime(record.9)?,
            created_at: parse_datetime(record.10)?,
        }))
    }

    fn load_service_deployments_for_deployment(
        &self,
        conn: &Connection,
        deployment_id: &str,
    ) -> Result<Vec<ServiceDeployment>> {
        let mut statement = conn.prepare(&format!(
            "select id from {SERVICE_DEPLOYMENTS_TABLE}
             where deployment_id = ?1
             order by service_id asc, replica_index asc"
        ))?;
        let mut rows = statement.query(params![deployment_id])?;
        let mut ids = Vec::new();

        while let Some(row) = rows.next()? {
            ids.push(row.get::<_, String>(0)?);
        }

        let mut deployments = Vec::new();
        for id in ids {
            if let Some(deployment) = self.load_service_deployment_by_id_text(conn, &id)? {
                deployments.push(deployment);
            }
        }

        Ok(deployments)
    }

    fn load_service_deployments_for_service(
        &self,
        conn: &Connection,
        service_id: &str,
    ) -> Result<Vec<ServiceDeployment>> {
        let mut statement = conn.prepare(&format!(
            "select id from {SERVICE_DEPLOYMENTS_TABLE}
             where service_id = ?1
             order by created_at desc"
        ))?;
        let mut rows = statement.query(params![service_id])?;
        let mut ids = Vec::new();

        while let Some(row) = rows.next()? {
            ids.push(row.get::<_, String>(0)?);
        }

        let mut deployments = Vec::new();
        for id in ids {
            if let Some(deployment) = self.load_service_deployment_by_id_text(conn, &id)? {
                deployments.push(deployment);
            }
        }

        Ok(deployments)
    }

    fn load_deployment_by_id_text(
        &self,
        conn: &Connection,
        deployment_id: &str,
    ) -> Result<Option<Deployment>> {
        let record = conn
            .query_row(
                &format!(
                    "select id, app_id, commit_sha, commit_message, branch, source_url,
                        rollout_strategy, rollback_from_deployment_id, status, container_id,
                        image_id, started_at, finished_at, created_at
                     from {DEPLOYMENTS_TABLE}
                     where id = ?1"
                ),
                params![deployment_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, Option<String>>(11)?,
                        row.get::<_, Option<String>>(12)?,
                        row.get::<_, String>(13)?,
                    ))
                },
            )
            .optional()?;

        let Some(record) = record else {
            return Ok(None);
        };

        Ok(Some(Deployment {
            id: parse_uuid(record.0)?,
            app_id: parse_uuid(record.1)?,
            commit_sha: record.2,
            commit_message: record.3,
            branch: record.4,
            source_url: record.5,
            rollout_strategy: decode_enum(record.6)?,
            rollback_from_deployment_id: transpose_string_to_uuid(record.7)?,
            status: decode_enum(record.8)?,
            container_id: record.9,
            image_id: record.10,
            service_deployments: self
                .load_service_deployments_for_deployment(conn, deployment_id)?,
            logs: Vec::new(),
            started_at: parse_optional_datetime(record.11)?,
            finished_at: parse_optional_datetime(record.12)?,
            created_at: parse_datetime(record.13)?,
        }))
    }

    fn load_certificate_by_domain(
        &self,
        conn: &Connection,
        domain: &str,
    ) -> Result<Option<Certificate>> {
        let record = conn
            .query_row(
                &format!(
                    "select domain, id, cert_pem, key_pem, expires_at, created_at
                     from {CERTIFICATES_TABLE}
                     where domain = ?1"
                ),
                params![domain],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()?;

        let Some(record) = record else {
            return Ok(None);
        };

        Ok(Some(Certificate {
            id: parse_uuid(record.1)?,
            domain: record.0,
            cert_pem: record.2,
            key_pem: record.3,
            expires_at: parse_datetime(record.4)?,
            created_at: parse_datetime(record.5)?,
        }))
    }

    fn load_managed_database_by_id_text(
        &self,
        conn: &Connection,
        id: &str,
    ) -> Result<Option<ManagedDatabase>> {
        let record = conn
            .query_row(
                &format!(
                    "select id, owner_id, name, db_type, version, container_id, volume_name,
                        host_data_path, internal_host, port, external_port, pitr_enabled,
                        pitr_last_base_backup_at, pitr_last_base_backup_label, proxy_enabled,
                        proxy_external_port, username, password, database_name, memory_limit,
                        cpu_limit, status, created_at, updated_at
                     from {MANAGED_DATABASES_TABLE}
                     where id = ?1"
                ),
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, Option<i64>>(10)?,
                        row.get::<_, i64>(11)?,
                        row.get::<_, Option<String>>(12)?,
                        row.get::<_, Option<String>>(13)?,
                        row.get::<_, i64>(14)?,
                        row.get::<_, Option<i64>>(15)?,
                        row.get::<_, String>(16)?,
                        row.get::<_, String>(17)?,
                        row.get::<_, String>(18)?,
                        row.get::<_, i64>(19)?,
                        row.get::<_, f64>(20)?,
                        row.get::<_, String>(21)?,
                        row.get::<_, String>(22)?,
                        row.get::<_, String>(23)?,
                    ))
                },
            )
            .optional()?;

        let Some(record) = record else {
            return Ok(None);
        };

        Ok(Some(ManagedDatabase {
            id: parse_uuid(record.0)?,
            owner_id: parse_uuid(record.1)?,
            name: record.2,
            db_type: decode_enum(record.3)?,
            version: record.4,
            container_id: record.5,
            volume_name: record.6,
            host_data_path: record.7,
            internal_host: record.8,
            port: parse_u16(record.9, "managed database port")?,
            external_port: transpose_i64_to_u16(record.10, "managed database external_port")?,
            pitr_enabled: int_to_bool(record.11),
            pitr_last_base_backup_at: parse_optional_datetime(record.12)?,
            pitr_last_base_backup_label: record.13,
            proxy_enabled: int_to_bool(record.14),
            proxy_external_port: transpose_i64_to_u16(
                record.15,
                "managed database proxy_external_port",
            )?,
            credentials: crate::managed_services::DatabaseCredentials {
                username: record.16,
                password: record.17,
                database_name: record.18,
            },
            memory_limit: parse_u64(record.19, "managed database memory_limit")?,
            cpu_limit: record.20,
            status: decode_enum(record.21)?,
            created_at: parse_datetime(record.22)?,
            updated_at: parse_datetime(record.23)?,
        }))
    }

    fn load_managed_queue_by_id_text(
        &self,
        conn: &Connection,
        id: &str,
    ) -> Result<Option<ManagedQueue>> {
        let record = conn
            .query_row(
                &format!(
                    "select id, owner_id, name, queue_type, version, container_id, volume_name,
                        host_data_path, internal_host, port, external_port, username, password,
                        memory_limit, cpu_limit, status, created_at, updated_at
                     from {MANAGED_QUEUES_TABLE}
                     where id = ?1"
                ),
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, Option<i64>>(10)?,
                        row.get::<_, String>(11)?,
                        row.get::<_, String>(12)?,
                        row.get::<_, i64>(13)?,
                        row.get::<_, f64>(14)?,
                        row.get::<_, String>(15)?,
                        row.get::<_, String>(16)?,
                        row.get::<_, String>(17)?,
                    ))
                },
            )
            .optional()?;

        let Some(record) = record else {
            return Ok(None);
        };

        Ok(Some(ManagedQueue {
            id: parse_uuid(record.0)?,
            owner_id: parse_uuid(record.1)?,
            name: record.2,
            queue_type: decode_enum(record.3)?,
            version: record.4,
            container_id: record.5,
            volume_name: record.6,
            host_data_path: record.7,
            internal_host: record.8,
            port: parse_u16(record.9, "managed queue port")?,
            external_port: transpose_i64_to_u16(record.10, "managed queue external_port")?,
            credentials: crate::managed_services::QueueCredentials {
                username: record.11,
                password: record.12,
            },
            memory_limit: parse_u64(record.13, "managed queue memory_limit")?,
            cpu_limit: record.14,
            status: decode_enum(record.15)?,
            created_at: parse_datetime(record.16)?,
            updated_at: parse_datetime(record.17)?,
        }))
    }

    fn load_storage_bucket_by_id_text(
        &self,
        conn: &Connection,
        id: &str,
    ) -> Result<Option<StorageBucket>> {
        let record = conn
            .query_row(
                &format!(
                    "select id, owner_id, name, access_key, secret_key, size_bytes, endpoint,
                        created_at
                     from {STORAGE_BUCKETS_TABLE}
                     where id = ?1"
                ),
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                    ))
                },
            )
            .optional()?;

        let Some(record) = record else {
            return Ok(None);
        };

        Ok(Some(StorageBucket {
            id: parse_uuid(record.0)?,
            owner_id: parse_uuid(record.1)?,
            name: record.2,
            access_key: record.3,
            secret_key: record.4,
            size_bytes: parse_u64(record.5, "storage bucket size_bytes")?,
            endpoint: record.6,
            created_at: parse_datetime(record.7)?,
        }))
    }

    fn load_github_installations(
        &self,
        conn: &Connection,
        owner_id: &str,
    ) -> Result<Vec<GithubInstallation>> {
        let mut statement = conn.prepare(&format!(
            "select installation_id, account_login, account_type, repository_count, created_at
             from {GITHUB_APP_INSTALLATIONS_TABLE}
             where owner_id = ?1
             order by created_at asc"
        ))?;
        let mut rows = statement.query(params![owner_id])?;
        let mut installations = Vec::new();

        while let Some(row) = rows.next()? {
            installations.push(GithubInstallation {
                id: row.get(0)?,
                account_login: row.get(1)?,
                account_type: row.get(2)?,
                repository_count: row.get(3)?,
                created_at: parse_datetime(row.get::<_, String>(4)?)?,
            });
        }

        Ok(installations)
    }

    fn load_github_app_by_owner_text(
        &self,
        conn: &Connection,
        owner_id: &str,
    ) -> Result<Option<GithubAppConfig>> {
        let record = conn
            .query_row(
                &format!(
                    "select owner_id, id, app_id, app_name, client_id, client_secret,
                        private_key, webhook_secret, html_url, created_at, updated_at
                     from {GITHUB_APPS_TABLE}
                     where owner_id = ?1"
                ),
                params![owner_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, String>(10)?,
                    ))
                },
            )
            .optional()?;

        let Some(record) = record else {
            return Ok(None);
        };

        Ok(Some(GithubAppConfig {
            id: parse_uuid(record.1)?,
            app_id: record.2,
            app_name: record.3,
            client_id: record.4,
            client_secret: record.5,
            private_key: record.6,
            webhook_secret: record.7,
            html_url: record.8,
            owner_id: parse_uuid(record.0)?,
            installations: self.load_github_installations(conn, owner_id)?,
            created_at: parse_datetime(record.9)?,
            updated_at: parse_datetime(record.10)?,
        }))
    }

    fn upsert_service_tx(&self, tx: &Transaction<'_>, service: &ContainerService) -> Result<()> {
        let (health_path, health_interval, health_timeout, health_retries) =
            match &service.health_check {
                Some(health_check) => (
                    Some(health_check.path.clone()),
                    Some(i64::from(health_check.interval_secs)),
                    Some(i64::from(health_check.timeout_secs)),
                    Some(i64::from(health_check.retries)),
                ),
                None => (None, None, None, None),
            };

        tx.execute(
            &format!(
                "insert into {SERVICES_TABLE} (
                    id, app_id, name, image, service_type, port, expose_http, replicas, memory_limit,
                    cpu_limit, health_check_path, health_check_interval_secs,
                    health_check_timeout_secs, health_check_retries, restart_policy,
                    build_context, dockerfile_path, build_target, working_dir, created_at,
                    updated_at
                ) values (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                    ?17, ?18, ?19, ?20, ?21
                )
                on conflict(id) do update set
                    app_id = excluded.app_id,
                    name = excluded.name,
                    image = excluded.image,
                    service_type = excluded.service_type,
                    port = excluded.port,
                    expose_http = excluded.expose_http,
                    replicas = excluded.replicas,
                    memory_limit = excluded.memory_limit,
                    cpu_limit = excluded.cpu_limit,
                    health_check_path = excluded.health_check_path,
                    health_check_interval_secs = excluded.health_check_interval_secs,
                    health_check_timeout_secs = excluded.health_check_timeout_secs,
                    health_check_retries = excluded.health_check_retries,
                    restart_policy = excluded.restart_policy,
                    build_context = excluded.build_context,
                    dockerfile_path = excluded.dockerfile_path,
                    build_target = excluded.build_target,
                    working_dir = excluded.working_dir,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at"
            ),
            params![
                service.id.to_string(),
                service.app_id.to_string(),
                &service.name,
                &service.image,
                encode_enum(&service.service_type)?,
                i64::from(service.port),
                bool_to_int(service.expose_http),
                i64::from(service.replicas),
                transpose_u64_to_i64(service.memory_limit, "service memory_limit")?,
                service.cpu_limit,
                health_path,
                health_interval,
                health_timeout,
                health_retries,
                encode_enum(&service.restart_policy)?,
                service.build_context.as_deref(),
                service.dockerfile_path.as_deref(),
                service.build_target.as_deref(),
                service.working_dir.as_deref(),
                service.created_at.to_rfc3339(),
                service.updated_at.to_rfc3339(),
            ],
        )?;

        self.replace_service_dependencies(tx, service.id, &service.depends_on)?;
        self.replace_service_additional_ports(tx, service.id, &service.additional_ports)?;
        self.replace_service_env_vars(tx, service.id, &service.env_vars)?;
        self.replace_service_domains(tx, service.id, &service.domains)?;
        self.replace_service_build_args(tx, service.id, &service.build_args)?;
        self.replace_service_args(
            tx,
            SERVICE_COMMAND_ARGS_TABLE,
            service.id,
            service.command.as_deref(),
        )?;
        self.replace_service_args(
            tx,
            SERVICE_ENTRYPOINT_ARGS_TABLE,
            service.id,
            service.entrypoint.as_deref(),
        )?;
        self.replace_service_registry_auth(tx, service.id, service.registry_auth.as_ref())?;
        self.replace_service_mounts(tx, service.id, &service.mounts)
    }

    fn replace_service_env_vars(
        &self,
        tx: &Transaction<'_>,
        service_id: Uuid,
        env_vars: &[EnvVar],
    ) -> Result<()> {
        let service_id = service_id.to_string();
        tx.execute(
            &format!("delete from {SERVICE_ENV_VARS_TABLE} where service_id = ?1"),
            params![&service_id],
        )?;

        for (position, env_var) in env_vars.iter().enumerate() {
            tx.execute(
                &format!(
                    "insert into {SERVICE_ENV_VARS_TABLE} (
                        service_id, position, key, value, secret
                    ) values (?1, ?2, ?3, ?4, ?5)"
                ),
                params![
                    &service_id,
                    position as i64,
                    &env_var.key,
                    &env_var.value,
                    bool_to_int(env_var.secret),
                ],
            )?;
        }

        Ok(())
    }

    fn replace_service_build_args(
        &self,
        tx: &Transaction<'_>,
        service_id: Uuid,
        build_args: &[BuildArg],
    ) -> Result<()> {
        let service_id = service_id.to_string();
        tx.execute(
            &format!("delete from {SERVICE_BUILD_ARGS_TABLE} where service_id = ?1"),
            params![&service_id],
        )?;

        for (position, build_arg) in build_args.iter().enumerate() {
            tx.execute(
                &format!(
                    "insert into {SERVICE_BUILD_ARGS_TABLE} (
                        service_id, position, key, value, secret
                    ) values (?1, ?2, ?3, ?4, ?5)"
                ),
                params![
                    &service_id,
                    position as i64,
                    &build_arg.key,
                    &build_arg.value,
                    bool_to_int(build_arg.secret),
                ],
            )?;
        }

        Ok(())
    }

    fn replace_service_domains(
        &self,
        tx: &Transaction<'_>,
        service_id: Uuid,
        domains: &[String],
    ) -> Result<()> {
        let service_id = service_id.to_string();
        tx.execute(
            &format!("delete from {SERVICE_DOMAINS_TABLE} where service_id = ?1"),
            params![&service_id],
        )?;

        for (position, domain) in domains.iter().enumerate() {
            tx.execute(
                &format!(
                    "insert into {SERVICE_DOMAINS_TABLE} (service_id, domain, position)
                     values (?1, ?2, ?3)"
                ),
                params![&service_id, domain, position as i64],
            )?;
        }

        Ok(())
    }

    fn replace_service_dependencies(
        &self,
        tx: &Transaction<'_>,
        service_id: Uuid,
        depends_on: &[String],
    ) -> Result<()> {
        let service_id = service_id.to_string();
        tx.execute(
            &format!("delete from {SERVICE_DEPENDENCIES_TABLE} where service_id = ?1"),
            params![&service_id],
        )?;

        for (position, dependency_name) in depends_on.iter().enumerate() {
            tx.execute(
                &format!(
                    "insert into {SERVICE_DEPENDENCIES_TABLE} (
                        service_id, position, dependency_name
                    ) values (?1, ?2, ?3)"
                ),
                params![&service_id, position as i64, dependency_name],
            )?;
        }

        Ok(())
    }

    fn replace_service_additional_ports(
        &self,
        tx: &Transaction<'_>,
        service_id: Uuid,
        additional_ports: &[u16],
    ) -> Result<()> {
        let service_id = service_id.to_string();
        tx.execute(
            &format!("delete from {SERVICE_ADDITIONAL_PORTS_TABLE} where service_id = ?1"),
            params![&service_id],
        )?;

        for (position, port) in additional_ports.iter().enumerate() {
            tx.execute(
                &format!(
                    "insert into {SERVICE_ADDITIONAL_PORTS_TABLE} (
                        service_id, position, port
                    ) values (?1, ?2, ?3)"
                ),
                params![&service_id, position as i64, i64::from(*port)],
            )?;
        }

        Ok(())
    }

    fn replace_service_mounts(
        &self,
        tx: &Transaction<'_>,
        service_id: Uuid,
        mounts: &[ServiceMount],
    ) -> Result<()> {
        let service_id = service_id.to_string();
        tx.execute(
            &format!("delete from {SERVICE_MOUNTS_TABLE} where service_id = ?1"),
            params![&service_id],
        )?;

        for (position, mount) in mounts.iter().enumerate() {
            tx.execute(
                &format!(
                    "insert into {SERVICE_MOUNTS_TABLE} (
                        service_id, position, name, target, read_only
                    ) values (?1, ?2, ?3, ?4, ?5)"
                ),
                params![
                    &service_id,
                    position as i64,
                    &mount.name,
                    &mount.target,
                    bool_to_int(mount.read_only),
                ],
            )?;
        }

        Ok(())
    }

    fn replace_service_args(
        &self,
        tx: &Transaction<'_>,
        table: &str,
        service_id: Uuid,
        values: Option<&[String]>,
    ) -> Result<()> {
        let service_id = service_id.to_string();
        tx.execute(
            &format!("delete from {table} where service_id = ?1"),
            params![&service_id],
        )?;

        if let Some(values) = values {
            for (position, value) in values.iter().enumerate() {
                tx.execute(
                    &format!(
                        "insert into {table} (service_id, position, value)
                         values (?1, ?2, ?3)"
                    ),
                    params![&service_id, position as i64, value],
                )?;
            }
        }

        Ok(())
    }

    fn replace_service_registry_auth(
        &self,
        tx: &Transaction<'_>,
        service_id: Uuid,
        registry_auth: Option<&ServiceRegistryAuth>,
    ) -> Result<()> {
        let service_id = service_id.to_string();
        tx.execute(
            &format!("delete from {SERVICE_REGISTRY_AUTH_TABLE} where service_id = ?1"),
            params![&service_id],
        )?;

        if let Some(registry_auth) = registry_auth {
            tx.execute(
                &format!(
                    "insert into {SERVICE_REGISTRY_AUTH_TABLE} (
                        service_id, server, username, password
                    ) values (?1, ?2, ?3, ?4)"
                ),
                params![
                    &service_id,
                    registry_auth.server.as_deref(),
                    &registry_auth.username,
                    &registry_auth.password,
                ],
            )?;
        }

        Ok(())
    }

    fn replace_app_services(&self, tx: &Transaction<'_>, app: &App) -> Result<()> {
        let mut statement = tx.prepare(&format!(
            "select id from {SERVICES_TABLE} where app_id = ?1"
        ))?;
        let mut rows = statement.query(params![app.id.to_string()])?;
        let mut existing_ids = Vec::new();

        while let Some(row) = rows.next()? {
            existing_ids.push(row.get::<_, String>(0)?);
        }

        let desired_ids = app
            .services
            .iter()
            .map(|service| service.id.to_string())
            .collect::<HashSet<_>>();

        for service in &app.services {
            self.upsert_service_tx(tx, service)?;
        }

        for service_id in existing_ids {
            if !desired_ids.contains(&service_id) {
                tx.execute(
                    &format!("delete from {SERVICES_TABLE} where id = ?1"),
                    params![service_id],
                )?;
            }
        }

        Ok(())
    }

    fn upsert_service_deployment_tx(
        &self,
        tx: &Transaction<'_>,
        deployment: &ServiceDeployment,
    ) -> Result<()> {
        tx.execute(
            &format!(
                "insert into {SERVICE_DEPLOYMENTS_TABLE} (
                    id, service_id, deployment_id, replica_index, status, container_id, image_id,
                    health, started_at, finished_at, created_at
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                on conflict(id) do update set
                    service_id = excluded.service_id,
                    deployment_id = excluded.deployment_id,
                    replica_index = excluded.replica_index,
                    status = excluded.status,
                    container_id = excluded.container_id,
                    image_id = excluded.image_id,
                    health = excluded.health,
                    started_at = excluded.started_at,
                    finished_at = excluded.finished_at,
                    created_at = excluded.created_at"
            ),
            params![
                deployment.id.to_string(),
                deployment.service_id.to_string(),
                deployment.deployment_id.to_string(),
                i64::from(deployment.replica_index),
                encode_enum(&deployment.status)?,
                &deployment.container_id,
                &deployment.image_id,
                encode_enum(&deployment.health)?,
                deployment.started_at.map(|value| value.to_rfc3339()),
                deployment.finished_at.map(|value| value.to_rfc3339()),
                deployment.created_at.to_rfc3339(),
            ],
        )?;

        tx.execute(
            &format!(
                "delete from {SERVICE_DEPLOYMENT_LOGS_TABLE} where service_deployment_id = ?1"
            ),
            params![deployment.id.to_string()],
        )?;

        for (idx, line) in deployment.logs.iter().enumerate() {
            tx.execute(
                &format!(
                    "insert into {SERVICE_DEPLOYMENT_LOGS_TABLE} (
                        service_deployment_id, idx, line
                    ) values (?1, ?2, ?3)"
                ),
                params![deployment.id.to_string(), idx as i64, line],
            )?;
        }

        Ok(())
    }
}

impl DatabaseBackend for SqliteDatabase {
    fn flush(&self) -> Result<()> {
        self.conn
            .lock()
            .execute_batch("pragma wal_checkpoint(passive);")?;
        Ok(())
    }

    fn save_user(&self, user: &User) -> Result<()> {
        self.with_tx(|tx| {
            tx.execute(
                &format!(
                    "insert into {USERS_TABLE} (
                        id, email, password_hash, github_id, github_username,
                        github_access_token, is_admin, created_at, updated_at
                    ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                    on conflict(id) do update set
                        email = excluded.email,
                        password_hash = excluded.password_hash,
                        github_id = excluded.github_id,
                        github_username = excluded.github_username,
                        github_access_token = excluded.github_access_token,
                        is_admin = excluded.is_admin,
                        created_at = excluded.created_at,
                        updated_at = excluded.updated_at"
                ),
                params![
                    user.id.to_string(),
                    &user.email,
                    &user.password_hash,
                    user.github_id,
                    &user.github_username,
                    &user.github_access_token,
                    bool_to_int(user.is_admin),
                    user.created_at.to_rfc3339(),
                    user.updated_at.to_rfc3339(),
                ],
            )?;
            Ok(())
        })
    }

    fn get_user(&self, id: Uuid) -> Result<Option<User>> {
        self.with_conn(|conn| self.load_user_by_id_text(conn, &id.to_string()))
    }

    fn list_users(&self) -> Result<Vec<User>> {
        self.with_conn(|conn| {
            let mut statement = conn.prepare(&format!(
                "select id from {USERS_TABLE} order by created_at asc"
            ))?;
            let mut rows = statement.query([])?;
            let mut user_ids = Vec::new();

            while let Some(row) = rows.next()? {
                user_ids.push(row.get::<_, String>(0)?);
            }

            let mut users = Vec::new();
            for user_id in user_ids {
                if let Some(user) = self.load_user_by_id_text(conn, &user_id)? {
                    users.push(user);
                }
            }

            Ok(users)
        })
    }

    fn get_user_by_email(&self, email: &str) -> Result<Option<User>> {
        self.with_conn(|conn| {
            let user_id = conn
                .query_row(
                    &format!("select id from {USERS_TABLE} where email = ?1"),
                    params![email],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;

            match user_id {
                Some(user_id) => self.load_user_by_id_text(conn, &user_id),
                None => Ok(None),
            }
        })
    }

    fn get_user_by_github_id(&self, github_id: i64) -> Result<Option<User>> {
        self.with_conn(|conn| {
            let user_id = conn
                .query_row(
                    &format!("select id from {USERS_TABLE} where github_id = ?1"),
                    params![github_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;

            match user_id {
                Some(user_id) => self.load_user_by_id_text(conn, &user_id),
                None => Ok(None),
            }
        })
    }

    fn save_app(&self, app: &App) -> Result<()> {
        self.with_tx(|tx| {
            tx.execute(
                &format!(
                    "insert into {APPS_TABLE} (
                        id, owner_id, name, github_url, branch, domain, port, rollout_strategy,
                        created_at, updated_at
                    ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                    on conflict(id) do update set
                        owner_id = excluded.owner_id,
                        name = excluded.name,
                        github_url = excluded.github_url,
                        branch = excluded.branch,
                        domain = excluded.domain,
                        port = excluded.port,
                        rollout_strategy = excluded.rollout_strategy,
                        created_at = excluded.created_at,
                        updated_at = excluded.updated_at"
                ),
                params![
                    app.id.to_string(),
                    app.owner_id.to_string(),
                    &app.name,
                    &app.github_url,
                    &app.branch,
                    &app.domain,
                    i64::from(app.port),
                    encode_enum(&app.rollout_strategy)?,
                    app.created_at.to_rfc3339(),
                    app.updated_at.to_rfc3339(),
                ],
            )?;

            tx.execute(
                &format!("delete from {APP_DOMAINS_TABLE} where app_id = ?1"),
                params![app.id.to_string()],
            )?;
            for (position, domain) in app.legacy_custom_domains().into_iter().enumerate() {
                tx.execute(
                    &format!(
                        "insert into {APP_DOMAINS_TABLE} (app_id, domain, position)
                         values (?1, ?2, ?3)"
                    ),
                    params![app.id.to_string(), domain, position as i64],
                )?;
            }

            tx.execute(
                &format!("delete from {APP_ENV_VARS_TABLE} where app_id = ?1"),
                params![app.id.to_string()],
            )?;
            for (position, env_var) in app.env_vars.iter().enumerate() {
                tx.execute(
                    &format!(
                        "insert into {APP_ENV_VARS_TABLE} (app_id, position, key, value, secret)
                         values (?1, ?2, ?3, ?4, ?5)"
                    ),
                    params![
                        app.id.to_string(),
                        position as i64,
                        &env_var.key,
                        &env_var.value,
                        bool_to_int(env_var.secret),
                    ],
                )?;
            }

            self.replace_app_services(tx, app)?;
            Ok(())
        })
    }

    fn get_app(&self, id: Uuid) -> Result<Option<App>> {
        self.with_conn(|conn| self.load_app_by_id_text(conn, &id.to_string()))
    }

    fn list_apps(&self) -> Result<Vec<App>> {
        self.with_conn(|conn| {
            let mut statement = conn.prepare(&format!("select id from {APPS_TABLE}"))?;
            let mut rows = statement.query([])?;
            let mut ids = Vec::new();

            while let Some(row) = rows.next()? {
                ids.push(row.get::<_, String>(0)?);
            }

            let mut apps = Vec::new();
            for id in ids {
                if let Some(app) = self.load_app_by_id_text(conn, &id)? {
                    apps.push(app);
                }
            }

            Ok(apps)
        })
    }

    fn list_apps_by_owner(&self, owner_id: Uuid) -> Result<Vec<App>> {
        self.with_conn(|conn| {
            let mut statement =
                conn.prepare(&format!("select id from {APPS_TABLE} where owner_id = ?1"))?;
            let mut rows = statement.query(params![owner_id.to_string()])?;
            let mut ids = Vec::new();

            while let Some(row) = rows.next()? {
                ids.push(row.get::<_, String>(0)?);
            }

            let mut apps = Vec::new();
            for id in ids {
                if let Some(app) = self.load_app_by_id_text(conn, &id)? {
                    apps.push(app);
                }
            }

            Ok(apps)
        })
    }

    fn get_app_by_domain(&self, domain: &str) -> Result<Option<App>> {
        self.with_conn(|conn| {
            let app_id = conn
                .query_row(
                    &format!(
                        "select id from {APPS_TABLE} where domain = ?1
                         union
                         select app_id as id from {APP_DOMAINS_TABLE} where domain = ?1
                         union
                         select services.app_id as id
                         from {SERVICE_DOMAINS_TABLE}
                         inner join {SERVICES_TABLE} on services.id = service_domains.service_id
                         where service_domains.domain = ?1
                         limit 1"
                    ),
                    params![domain],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;

            match app_id {
                Some(app_id) => self.load_app_by_id_text(conn, &app_id),
                None => Ok(None),
            }
        })
    }

    fn delete_app(&self, id: Uuid) -> Result<bool> {
        self.with_tx(|tx| {
            let rows = tx.execute(
                &format!("delete from {APPS_TABLE} where id = ?1"),
                params![id.to_string()],
            )?;
            Ok(rows > 0)
        })
    }

    fn get_app_by_github_url(&self, github_url: &str, branch: &str) -> Result<Option<App>> {
        self.with_conn(|conn| {
            let normalized_url = github_url.trim_end_matches(".git");
            let git_url = format!("{}.git", normalized_url);
            let app_id = conn
                .query_row(
                    &format!(
                        "select id from {APPS_TABLE}
                         where branch = ?1 and (github_url = ?2 or github_url = ?3)
                         limit 1"
                    ),
                    params![branch, normalized_url, git_url],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;

            match app_id {
                Some(app_id) => self.load_app_by_id_text(conn, &app_id),
                None => Ok(None),
            }
        })
    }

    fn save_service(&self, service: &ContainerService) -> Result<()> {
        self.with_tx(|tx| self.upsert_service_tx(tx, service))
    }

    fn get_service(&self, id: Uuid) -> Result<Option<ContainerService>> {
        self.with_conn(|conn| self.load_service_by_id_text(conn, &id.to_string()))
    }

    fn list_services_by_app(&self, app_id: Uuid) -> Result<Vec<ContainerService>> {
        self.with_conn(|conn| self.load_services_by_app_id(conn, &app_id.to_string()))
    }

    fn delete_service(&self, id: Uuid) -> Result<bool> {
        self.with_tx(|tx| {
            let rows = tx.execute(
                &format!("delete from {SERVICES_TABLE} where id = ?1"),
                params![id.to_string()],
            )?;
            Ok(rows > 0)
        })
    }

    fn save_service_deployment(&self, deployment: &ServiceDeployment) -> Result<()> {
        self.with_tx(|tx| self.upsert_service_deployment_tx(tx, deployment))
    }

    fn get_service_deployment(&self, id: Uuid) -> Result<Option<ServiceDeployment>> {
        self.with_conn(|conn| self.load_service_deployment_by_id_text(conn, &id.to_string()))
    }

    fn list_service_deployments(&self, deployment_id: Uuid) -> Result<Vec<ServiceDeployment>> {
        self.with_conn(|conn| {
            self.load_service_deployments_for_deployment(conn, &deployment_id.to_string())
        })
    }

    fn list_service_deployments_by_service(
        &self,
        service_id: Uuid,
    ) -> Result<Vec<ServiceDeployment>> {
        self.with_conn(|conn| {
            self.load_service_deployments_for_service(conn, &service_id.to_string())
        })
    }

    fn save_deployment(&self, deployment: &Deployment) -> Result<()> {
        self.with_tx(|tx| {
            tx.execute(
                &format!(
                    "insert into {DEPLOYMENTS_TABLE} (
                        id, app_id, commit_sha, commit_message, branch, source_url,
                        rollout_strategy, rollback_from_deployment_id, status, container_id,
                        image_id, started_at, finished_at, created_at
                    ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                    on conflict(id) do update set
                        app_id = excluded.app_id,
                        commit_sha = excluded.commit_sha,
                        commit_message = excluded.commit_message,
                        branch = excluded.branch,
                        source_url = excluded.source_url,
                        rollout_strategy = excluded.rollout_strategy,
                        rollback_from_deployment_id =
                            excluded.rollback_from_deployment_id,
                        status = excluded.status,
                        container_id = excluded.container_id,
                        image_id = excluded.image_id,
                        started_at = excluded.started_at,
                        finished_at = excluded.finished_at,
                        created_at = excluded.created_at"
                ),
                params![
                    deployment.id.to_string(),
                    deployment.app_id.to_string(),
                    &deployment.commit_sha,
                    &deployment.commit_message,
                    &deployment.branch,
                    &deployment.source_url,
                    encode_enum(&deployment.rollout_strategy)?,
                    deployment
                        .rollback_from_deployment_id
                        .map(|value| value.to_string()),
                    encode_enum(&deployment.status)?,
                    &deployment.container_id,
                    &deployment.image_id,
                    deployment.started_at.map(|value| value.to_rfc3339()),
                    deployment.finished_at.map(|value| value.to_rfc3339()),
                    deployment.created_at.to_rfc3339(),
                ],
            )?;

            if !deployment.service_deployments.is_empty() {
                tx.execute(
                    &format!("delete from {SERVICE_DEPLOYMENTS_TABLE} where deployment_id = ?1"),
                    params![deployment.id.to_string()],
                )?;

                for service_deployment in &deployment.service_deployments {
                    self.upsert_service_deployment_tx(tx, service_deployment)?;
                }
            }

            if !deployment.logs.is_empty() {
                tx.execute(
                    &format!("delete from {DEPLOYMENT_LOGS_TABLE} where deployment_id = ?1"),
                    params![deployment.id.to_string()],
                )?;
                for (idx, line) in deployment.logs.iter().enumerate() {
                    tx.execute(
                        &format!(
                            "insert into {DEPLOYMENT_LOGS_TABLE} (deployment_id, idx, line)
                             values (?1, ?2, ?3)"
                        ),
                        params![deployment.id.to_string(), idx as i64, line],
                    )?;
                }
            }

            Ok(())
        })
    }

    fn get_deployment(&self, id: Uuid) -> Result<Option<Deployment>> {
        self.with_conn(|conn| self.load_deployment_by_id_text(conn, &id.to_string()))
    }

    fn list_deployments_by_app(&self, app_id: Uuid) -> Result<Vec<Deployment>> {
        self.with_conn(|conn| {
            let mut statement = conn.prepare(&format!(
                "select id from {DEPLOYMENTS_TABLE}
                 where app_id = ?1
                 order by created_at desc"
            ))?;
            let mut rows = statement.query(params![app_id.to_string()])?;
            let mut ids = Vec::new();

            while let Some(row) = rows.next()? {
                ids.push(row.get::<_, String>(0)?);
            }

            let mut deployments = Vec::new();
            for id in ids {
                if let Some(deployment) = self.load_deployment_by_id_text(conn, &id)? {
                    deployments.push(deployment);
                }
            }

            Ok(deployments)
        })
    }

    fn delete_deployment(&self, id: Uuid) -> Result<bool> {
        self.with_tx(|tx| {
            let rows = tx.execute(
                &format!("delete from {DEPLOYMENTS_TABLE} where id = ?1"),
                params![id.to_string()],
            )?;
            Ok(rows > 0)
        })
    }

    fn append_deployment_log(&self, deployment_id: Uuid, log_line: &str) -> Result<()> {
        self.with_tx(|tx| {
            let deployment_id = deployment_id.to_string();
            let next_index: i64 = tx.query_row(
                &format!(
                    "select coalesce(max(idx), -1) + 1 from {DEPLOYMENT_LOGS_TABLE}
                     where deployment_id = ?1"
                ),
                params![&deployment_id],
                |row| row.get(0),
            )?;
            tx.execute(
                &format!(
                    "insert into {DEPLOYMENT_LOGS_TABLE} (deployment_id, idx, line)
                     values (?1, ?2, ?3)"
                ),
                params![deployment_id, next_index, log_line],
            )?;
            Ok(())
        })
    }

    fn get_deployment_logs(
        &self,
        deployment_id: Uuid,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<String>> {
        self.with_conn(|conn| {
            let mut statement = conn.prepare(&format!(
                "select line from {DEPLOYMENT_LOGS_TABLE}
                 where deployment_id = ?1
                 order by idx asc
                 limit ?2 offset ?3"
            ))?;
            let mut rows = statement.query(params![
                deployment_id.to_string(),
                limit as i64,
                offset as i64
            ])?;
            let mut logs = Vec::new();

            while let Some(row) = rows.next()? {
                logs.push(row.get(0)?);
            }

            Ok(logs)
        })
    }

    fn save_certificate(&self, cert: &Certificate) -> Result<()> {
        self.with_tx(|tx| {
            tx.execute(
                &format!(
                    "insert into {CERTIFICATES_TABLE} (
                        domain, id, cert_pem, key_pem, expires_at, created_at
                    ) values (?1, ?2, ?3, ?4, ?5, ?6)
                    on conflict(domain) do update set
                        id = excluded.id,
                        cert_pem = excluded.cert_pem,
                        key_pem = excluded.key_pem,
                        expires_at = excluded.expires_at,
                        created_at = excluded.created_at"
                ),
                params![
                    &cert.domain,
                    cert.id.to_string(),
                    &cert.cert_pem,
                    &cert.key_pem,
                    cert.expires_at.to_rfc3339(),
                    cert.created_at.to_rfc3339(),
                ],
            )?;
            Ok(())
        })
    }

    fn get_certificate(&self, domain: &str) -> Result<Option<Certificate>> {
        self.with_conn(|conn| self.load_certificate_by_domain(conn, domain))
    }

    fn list_certificates(&self) -> Result<Vec<Certificate>> {
        self.with_conn(|conn| {
            let mut statement = conn.prepare(&format!(
                "select domain from {CERTIFICATES_TABLE} order by domain asc"
            ))?;
            let mut rows = statement.query([])?;
            let mut domains = Vec::new();

            while let Some(row) = rows.next()? {
                domains.push(row.get::<_, String>(0)?);
            }

            let mut certificates = Vec::new();
            for domain in domains {
                if let Some(certificate) = self.load_certificate_by_domain(conn, &domain)? {
                    certificates.push(certificate);
                }
            }

            Ok(certificates)
        })
    }

    fn delete_certificate(&self, domain: &str) -> Result<bool> {
        self.with_tx(|tx| {
            let rows = tx.execute(
                &format!("delete from {CERTIFICATES_TABLE} where domain = ?1"),
                params![domain],
            )?;
            Ok(rows > 0)
        })
    }

    fn save_managed_database(&self, db: &ManagedDatabase) -> Result<()> {
        self.with_tx(|tx| {
            tx.execute(
                &format!(
                    "insert into {MANAGED_DATABASES_TABLE} (
                        id, owner_id, name, db_type, version, container_id, volume_name,
                        host_data_path, internal_host, port, external_port, pitr_enabled,
                        pitr_last_base_backup_at, pitr_last_base_backup_label, proxy_enabled,
                        proxy_external_port, username, password, database_name, memory_limit,
                        cpu_limit, status, created_at, updated_at
                    ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                        ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)
                    on conflict(id) do update set
                        owner_id = excluded.owner_id,
                        name = excluded.name,
                        db_type = excluded.db_type,
                        version = excluded.version,
                        container_id = excluded.container_id,
                        volume_name = excluded.volume_name,
                        host_data_path = excluded.host_data_path,
                        internal_host = excluded.internal_host,
                        port = excluded.port,
                        external_port = excluded.external_port,
                        pitr_enabled = excluded.pitr_enabled,
                        pitr_last_base_backup_at = excluded.pitr_last_base_backup_at,
                        pitr_last_base_backup_label = excluded.pitr_last_base_backup_label,
                        proxy_enabled = excluded.proxy_enabled,
                        proxy_external_port = excluded.proxy_external_port,
                        username = excluded.username,
                        password = excluded.password,
                        database_name = excluded.database_name,
                        memory_limit = excluded.memory_limit,
                        cpu_limit = excluded.cpu_limit,
                        status = excluded.status,
                        created_at = excluded.created_at,
                        updated_at = excluded.updated_at"
                ),
                params![
                    db.id.to_string(),
                    db.owner_id.to_string(),
                    &db.name,
                    encode_enum(&db.db_type)?,
                    &db.version,
                    &db.container_id,
                    &db.volume_name,
                    &db.host_data_path,
                    &db.internal_host,
                    i64::from(db.port),
                    db.external_port.map(i64::from),
                    bool_to_int(db.pitr_enabled),
                    db.pitr_last_base_backup_at.map(|value| value.to_rfc3339()),
                    &db.pitr_last_base_backup_label,
                    bool_to_int(db.proxy_enabled),
                    db.proxy_external_port.map(i64::from),
                    &db.credentials.username,
                    &db.credentials.password,
                    &db.credentials.database_name,
                    u64_to_i64(db.memory_limit, "managed database memory_limit")?,
                    db.cpu_limit,
                    encode_enum(&db.status)?,
                    db.created_at.to_rfc3339(),
                    db.updated_at.to_rfc3339(),
                ],
            )?;
            Ok(())
        })
    }

    fn get_managed_database(&self, id: Uuid) -> Result<Option<ManagedDatabase>> {
        self.with_conn(|conn| self.load_managed_database_by_id_text(conn, &id.to_string()))
    }

    fn list_managed_databases_by_owner(&self, owner_id: Uuid) -> Result<Vec<ManagedDatabase>> {
        self.with_conn(|conn| {
            let mut statement = conn.prepare(&format!(
                "select id from {MANAGED_DATABASES_TABLE}
                 where owner_id = ?1
                 order by created_at desc"
            ))?;
            let mut rows = statement.query(params![owner_id.to_string()])?;
            let mut ids = Vec::new();

            while let Some(row) = rows.next()? {
                ids.push(row.get::<_, String>(0)?);
            }

            let mut databases = Vec::new();
            for id in ids {
                if let Some(database) = self.load_managed_database_by_id_text(conn, &id)? {
                    databases.push(database);
                }
            }

            Ok(databases)
        })
    }

    fn delete_managed_database(&self, id: Uuid) -> Result<bool> {
        self.with_tx(|tx| {
            let rows = tx.execute(
                &format!("delete from {MANAGED_DATABASES_TABLE} where id = ?1"),
                params![id.to_string()],
            )?;
            Ok(rows > 0)
        })
    }

    fn save_managed_queue(&self, queue: &ManagedQueue) -> Result<()> {
        self.with_tx(|tx| {
            tx.execute(
                &format!(
                    "insert into {MANAGED_QUEUES_TABLE} (
                        id, owner_id, name, queue_type, version, container_id, volume_name,
                        host_data_path, internal_host, port, external_port, username, password,
                        memory_limit, cpu_limit, status, created_at, updated_at
                    ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                        ?15, ?16, ?17, ?18)
                    on conflict(id) do update set
                        owner_id = excluded.owner_id,
                        name = excluded.name,
                        queue_type = excluded.queue_type,
                        version = excluded.version,
                        container_id = excluded.container_id,
                        volume_name = excluded.volume_name,
                        host_data_path = excluded.host_data_path,
                        internal_host = excluded.internal_host,
                        port = excluded.port,
                        external_port = excluded.external_port,
                        username = excluded.username,
                        password = excluded.password,
                        memory_limit = excluded.memory_limit,
                        cpu_limit = excluded.cpu_limit,
                        status = excluded.status,
                        created_at = excluded.created_at,
                        updated_at = excluded.updated_at"
                ),
                params![
                    queue.id.to_string(),
                    queue.owner_id.to_string(),
                    &queue.name,
                    encode_enum(&queue.queue_type)?,
                    &queue.version,
                    &queue.container_id,
                    &queue.volume_name,
                    &queue.host_data_path,
                    &queue.internal_host,
                    i64::from(queue.port),
                    queue.external_port.map(i64::from),
                    &queue.credentials.username,
                    &queue.credentials.password,
                    u64_to_i64(queue.memory_limit, "managed queue memory_limit")?,
                    queue.cpu_limit,
                    encode_enum(&queue.status)?,
                    queue.created_at.to_rfc3339(),
                    queue.updated_at.to_rfc3339(),
                ],
            )?;
            Ok(())
        })
    }

    fn get_managed_queue(&self, id: Uuid) -> Result<Option<ManagedQueue>> {
        self.with_conn(|conn| self.load_managed_queue_by_id_text(conn, &id.to_string()))
    }

    fn list_managed_queues_by_owner(&self, owner_id: Uuid) -> Result<Vec<ManagedQueue>> {
        self.with_conn(|conn| {
            let mut statement = conn.prepare(&format!(
                "select id from {MANAGED_QUEUES_TABLE}
                 where owner_id = ?1
                 order by created_at desc"
            ))?;
            let mut rows = statement.query(params![owner_id.to_string()])?;
            let mut ids = Vec::new();

            while let Some(row) = rows.next()? {
                ids.push(row.get::<_, String>(0)?);
            }

            let mut queues = Vec::new();
            for id in ids {
                if let Some(queue) = self.load_managed_queue_by_id_text(conn, &id)? {
                    queues.push(queue);
                }
            }

            Ok(queues)
        })
    }

    fn delete_managed_queue(&self, id: Uuid) -> Result<bool> {
        self.with_tx(|tx| {
            let rows = tx.execute(
                &format!("delete from {MANAGED_QUEUES_TABLE} where id = ?1"),
                params![id.to_string()],
            )?;
            Ok(rows > 0)
        })
    }

    fn save_storage_bucket(&self, bucket: &StorageBucket) -> Result<()> {
        self.with_tx(|tx| {
            tx.execute(
                &format!(
                    "insert into {STORAGE_BUCKETS_TABLE} (
                        id, owner_id, name, access_key, secret_key, size_bytes, endpoint,
                        created_at
                    ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                    on conflict(id) do update set
                        owner_id = excluded.owner_id,
                        name = excluded.name,
                        access_key = excluded.access_key,
                        secret_key = excluded.secret_key,
                        size_bytes = excluded.size_bytes,
                        endpoint = excluded.endpoint,
                        created_at = excluded.created_at"
                ),
                params![
                    bucket.id.to_string(),
                    bucket.owner_id.to_string(),
                    &bucket.name,
                    &bucket.access_key,
                    &bucket.secret_key,
                    u64_to_i64(bucket.size_bytes, "storage bucket size_bytes")?,
                    &bucket.endpoint,
                    bucket.created_at.to_rfc3339(),
                ],
            )?;
            Ok(())
        })
    }

    fn get_storage_bucket(&self, id: Uuid) -> Result<Option<StorageBucket>> {
        self.with_conn(|conn| self.load_storage_bucket_by_id_text(conn, &id.to_string()))
    }

    fn list_storage_buckets_by_owner(&self, owner_id: Uuid) -> Result<Vec<StorageBucket>> {
        self.with_conn(|conn| {
            let mut statement = conn.prepare(&format!(
                "select id from {STORAGE_BUCKETS_TABLE}
                 where owner_id = ?1
                 order by created_at desc"
            ))?;
            let mut rows = statement.query(params![owner_id.to_string()])?;
            let mut ids = Vec::new();

            while let Some(row) = rows.next()? {
                ids.push(row.get::<_, String>(0)?);
            }

            let mut buckets = Vec::new();
            for id in ids {
                if let Some(bucket) = self.load_storage_bucket_by_id_text(conn, &id)? {
                    buckets.push(bucket);
                }
            }

            Ok(buckets)
        })
    }

    fn delete_storage_bucket(&self, id: Uuid) -> Result<bool> {
        self.with_tx(|tx| {
            let rows = tx.execute(
                &format!("delete from {STORAGE_BUCKETS_TABLE} where id = ?1"),
                params![id.to_string()],
            )?;
            Ok(rows > 0)
        })
    }

    fn save_github_app(&self, app: &GithubAppConfig) -> Result<()> {
        self.with_tx(|tx| {
            tx.execute(
                &format!(
                    "insert into {GITHUB_APPS_TABLE} (
                        owner_id, id, app_id, app_name, client_id, client_secret, private_key,
                        webhook_secret, html_url, created_at, updated_at
                    ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                    on conflict(owner_id) do update set
                        id = excluded.id,
                        app_id = excluded.app_id,
                        app_name = excluded.app_name,
                        client_id = excluded.client_id,
                        client_secret = excluded.client_secret,
                        private_key = excluded.private_key,
                        webhook_secret = excluded.webhook_secret,
                        html_url = excluded.html_url,
                        created_at = excluded.created_at,
                        updated_at = excluded.updated_at"
                ),
                params![
                    app.owner_id.to_string(),
                    app.id.to_string(),
                    app.app_id,
                    &app.app_name,
                    &app.client_id,
                    &app.client_secret,
                    &app.private_key,
                    &app.webhook_secret,
                    &app.html_url,
                    app.created_at.to_rfc3339(),
                    app.updated_at.to_rfc3339(),
                ],
            )?;

            tx.execute(
                &format!("delete from {GITHUB_APP_INSTALLATIONS_TABLE} where owner_id = ?1"),
                params![app.owner_id.to_string()],
            )?;

            for installation in &app.installations {
                tx.execute(
                    &format!(
                        "insert into {GITHUB_APP_INSTALLATIONS_TABLE} (
                            owner_id, installation_id, account_login, account_type,
                            repository_count, created_at
                        ) values (?1, ?2, ?3, ?4, ?5, ?6)"
                    ),
                    params![
                        app.owner_id.to_string(),
                        installation.id,
                        &installation.account_login,
                        &installation.account_type,
                        installation.repository_count,
                        installation.created_at.to_rfc3339(),
                    ],
                )?;
            }

            Ok(())
        })
    }

    fn get_github_app(&self, owner_id: Uuid) -> Result<Option<GithubAppConfig>> {
        self.with_conn(|conn| self.load_github_app_by_owner_text(conn, &owner_id.to_string()))
    }

    fn delete_github_app(&self, owner_id: Uuid) -> Result<bool> {
        self.with_tx(|tx| {
            let rows = tx.execute(
                &format!("delete from {GITHUB_APPS_TABLE} where owner_id = ?1"),
                params![owner_id.to_string()],
            )?;
            Ok(rows > 0)
        })
    }
}

fn encode_enum<T: Serialize>(value: &T) -> Result<String> {
    match serde_json::to_value(value)? {
        serde_json::Value::String(value) => Ok(value),
        _ => Err(Error::Internal(
            "expected enum to serialize as a string".to_string(),
        )),
    }
}

fn decode_enum<T: DeserializeOwned>(value: String) -> Result<T> {
    Ok(serde_json::from_value(serde_json::Value::String(value))?)
}

fn parse_uuid(value: String) -> Result<Uuid> {
    Uuid::parse_str(&value)
        .map_err(|error| Error::Database(format!("invalid uuid '{}': {}", value, error)))
}

fn parse_datetime(value: String) -> Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|error| Error::Database(format!("invalid datetime '{}': {}", value, error)))
}

fn parse_optional_datetime(value: Option<String>) -> Result<Option<DateTime<Utc>>> {
    value.map(parse_datetime).transpose()
}

fn parse_u16(value: i64, field: &str) -> Result<u16> {
    u16::try_from(value).map_err(|_| Error::Database(format!("invalid {} value: {}", field, value)))
}

fn parse_u32(value: i64, field: &str) -> Result<u32> {
    u32::try_from(value).map_err(|_| Error::Database(format!("invalid {} value: {}", field, value)))
}

fn parse_u64(value: i64, field: &str) -> Result<u64> {
    u64::try_from(value).map_err(|_| Error::Database(format!("invalid {} value: {}", field, value)))
}

fn transpose_i64_to_u16(value: Option<i64>, field: &str) -> Result<Option<u16>> {
    value.map(|value| parse_u16(value, field)).transpose()
}

fn transpose_i64_to_u64(value: Option<i64>, field: &str) -> Result<Option<u64>> {
    value.map(|value| parse_u64(value, field)).transpose()
}

fn transpose_u64_to_i64(value: Option<u64>, field: &str) -> Result<Option<i64>> {
    value.map(|value| u64_to_i64(value, field)).transpose()
}

fn transpose_string_to_uuid(value: Option<String>) -> Result<Option<Uuid>> {
    value.map(parse_uuid).transpose()
}

fn u64_to_i64(value: u64, field: &str) -> Result<i64> {
    i64::try_from(value).map_err(|_| Error::Database(format!("invalid {} value: {}", field, value)))
}

fn bool_to_int(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn int_to_bool(value: i64) -> bool {
    value != 0
}

fn detect_legacy_json_tables(conn: &Connection) -> Result<Vec<&'static str>> {
    let mut legacy_tables = Vec::new();
    for table in [
        USERS_TABLE,
        APPS_TABLE,
        SERVICES_TABLE,
        SERVICE_DEPLOYMENTS_TABLE,
        DEPLOYMENTS_TABLE,
        CERTIFICATES_TABLE,
        MANAGED_DATABASES_TABLE,
        MANAGED_QUEUES_TABLE,
        STORAGE_BUCKETS_TABLE,
        GITHUB_APPS_TABLE,
    ] {
        if is_legacy_json_table(conn, table)? {
            legacy_tables.push(table);
        }
    }
    Ok(legacy_tables)
}

fn is_legacy_json_table(conn: &Connection, table: &str) -> Result<bool> {
    let mut statement = conn.prepare(&format!("pragma table_info({table})"))?;
    let mut rows = statement.query([])?;
    let mut columns = Vec::new();

    while let Some(row) = rows.next()? {
        columns.push(row.get::<_, String>(1)?);
    }

    Ok(columns == vec!["key".to_string(), "value".to_string()])
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    if has_column(conn, table, column)? {
        return Ok(());
    }

    conn.execute(
        &format!("alter table {table} add column {column} {definition}"),
        [],
    )?;
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut statement = conn.prepare(&format!("pragma table_info({table})"))?;
    let mut rows = statement.query([])?;

    while let Some(row) = rows.next()? {
        if row.get::<_, String>(1)? == column {
            return Ok(true);
        }
    }

    Ok(false)
}
