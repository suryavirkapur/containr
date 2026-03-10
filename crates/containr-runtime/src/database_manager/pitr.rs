use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};

use super::*;

impl DatabaseManager {
    /// creates a local postgres base backup for pitr
    pub async fn create_postgres_base_backup(
        &self,
        db: &mut ManagedDatabase,
        requested_label: Option<&str>,
    ) -> Result<(String, String)> {
        self.ensure_postgres_pitr_supported(db)?;

        if !self.is_running(db).await {
            return Err(ClientError::Operation(
                "database must be running to create a base backup".to_string(),
            ));
        }

        self.prepare_postgres_pitr_dirs(db)?;

        let label = Self::resolve_pitr_label(requested_label, "base");
        let backup_dir = db.pitr_backups_path().join(&label);

        if backup_dir.exists() {
            fs::remove_dir_all(&backup_dir).map_err(|e| {
                ClientError::Operation(format!(
                    "remove backup dir failed: {}",
                    e
                ))
            })?;
        }

        self.exec_command_output(
            &Self::database_container_name(db),
            Self::build_base_backup_command(db, &label),
            Some(vec![format!("PGPASSWORD={}", db.credentials.password)]),
        )
        .await?;
        self.normalize_postgres_backup_permissions(db, &label)
            .await?;

        db.pitr_last_base_backup_at = Some(Utc::now());
        db.pitr_last_base_backup_label = Some(label.clone());
        db.updated_at = Utc::now();

        Ok((label, backup_dir.to_string_lossy().to_string()))
    }

    /// creates a named postgres restore point
    pub async fn create_postgres_restore_point(
        &self,
        db: &ManagedDatabase,
        requested_name: Option<&str>,
    ) -> Result<(String, String)> {
        self.ensure_postgres_pitr_supported(db)?;

        if !self.is_running(db).await {
            return Err(ClientError::Operation(
                "database must be running to create a restore point"
                    .to_string(),
            ));
        }

        let restore_point = Self::resolve_pitr_label(requested_name, "restore");
        let lsn = self
            .exec_postgres_query(
                db,
                &format!(
                    "select pg_create_restore_point('{}');",
                    restore_point
                ),
            )
            .await?;
        self.switch_postgres_wal(db).await?;
        self.sync_postgres_wal_archive(db).await?;

        Ok((restore_point, lsn))
    }

    /// restores a postgres database to a restore point or timestamp
    pub async fn recover_postgres_to_target(
        &self,
        db: &mut ManagedDatabase,
        restore_point: Option<&str>,
        target_time: Option<DateTime<Utc>>,
    ) -> Result<()> {
        self.ensure_postgres_pitr_supported(db)?;

        if restore_point.is_some() == target_time.is_some() {
            return Err(ClientError::Operation(
                "provide exactly one recovery target".to_string(),
            ));
        }

        let backup_dir = self.latest_base_backup_dir(db)?;

        if self.is_running(db).await {
            self.switch_postgres_wal(db).await?;
            self.sync_postgres_wal_archive(db).await?;
        }

        self.stop_database(db).await?;

        let data_dir = db.host_runtime_data_path();
        Self::archive_existing_data_dir(db, &data_dir)?;
        Self::copy_dir_recursive(&backup_dir, &data_dir)?;
        Self::write_recovery_config(&data_dir, restore_point, target_time)?;

        self.start_database(db).await?;
        Ok(())
    }

    fn ensure_postgres_pitr_supported(
        &self,
        db: &ManagedDatabase,
    ) -> Result<()> {
        if db.db_type != DatabaseType::Postgresql {
            return Err(ClientError::Operation(
                "point in time recovery is only supported for postgresql"
                    .to_string(),
            ));
        }
        if !db.pitr_enabled {
            return Err(ClientError::Operation(
                "point in time recovery is not enabled for this database"
                    .to_string(),
            ));
        }
        Ok(())
    }

    pub(super) fn prepare_postgres_pitr_dirs(
        &self,
        db: &ManagedDatabase,
    ) -> Result<()> {
        Self::ensure_host_dir(&db.pitr_root_path())?;
        Self::ensure_host_dir(&db.pitr_archive_path())?;
        Self::ensure_host_dir(&db.pitr_backups_path())?;
        Ok(())
    }

    pub(super) fn build_postgres_pitr_command() -> Vec<String> {
        vec![
            "postgres".to_string(),
            "-c".to_string(),
            "wal_level=replica".to_string(),
            "-c".to_string(),
            "archive_mode=on".to_string(),
            "-c".to_string(),
            "archive_timeout=60".to_string(),
            "-c".to_string(),
            format!(
                "archive_command=test ! -f {0}/%f && cp %p {0}/%f",
                POSTGRES_PITR_WAL_PATH
            ),
        ]
    }

    async fn exec_postgres_query(
        &self,
        db: &ManagedDatabase,
        sql: &str,
    ) -> Result<String> {
        let output = self
            .exec_command_output(
                &Self::database_container_name(db),
                vec![
                    "psql".to_string(),
                    "-v".to_string(),
                    "ON_ERROR_STOP=1".to_string(),
                    "-U".to_string(),
                    db.credentials.username.clone(),
                    "-d".to_string(),
                    db.credentials.database_name.clone(),
                    "-tAc".to_string(),
                    sql.to_string(),
                ],
                Some(vec![format!("PGPASSWORD={}", db.credentials.password)]),
            )
            .await?;

        Ok(String::from_utf8_lossy(&output).trim().to_string())
    }

    async fn switch_postgres_wal(&self, db: &ManagedDatabase) -> Result<()> {
        self.exec_postgres_query(db, "select pg_switch_wal();")
            .await
            .map(|_| ())
    }

    async fn sync_postgres_wal_archive(
        &self,
        db: &ManagedDatabase,
    ) -> Result<()> {
        self.prepare_postgres_pitr_dirs(db)?;
        let wal_path = format!("{}/pg_wal", db.container_data_dir());
        self.exec_command_output(
            &Self::database_container_name(db),
            vec![
                "sh".to_string(),
                "-lc".to_string(),
                format!(
                    "cp -f {1}/000000* {0}/ 2>/dev/null || true; \
                     cp -f {1}/*.history {0}/ \
                     2>/dev/null || true; \
                     chmod -R a+rX {0}",
                    POSTGRES_PITR_WAL_PATH, wal_path
                ),
            ],
            None,
        )
        .await
        .map(|_| ())
    }

    async fn normalize_postgres_backup_permissions(
        &self,
        db: &ManagedDatabase,
        label: &str,
    ) -> Result<()> {
        self.exec_command_output(
            &Self::database_container_name(db),
            vec![
                "sh".to_string(),
                "-lc".to_string(),
                format!(
                    "chmod -R a+rX '{}/{}'",
                    POSTGRES_PITR_BACKUPS_PATH, label
                ),
            ],
            None,
        )
        .await
        .map(|_| ())
    }

    fn resolve_pitr_label(
        requested_value: Option<&str>,
        prefix: &str,
    ) -> String {
        requested_value
            .map(|value| Self::sanitize_name(value, prefix))
            .unwrap_or_else(|| {
                format!("{}-{}", prefix, Utc::now().format("%Y%m%d%H%M%S"))
            })
    }

    fn build_base_backup_command(
        db: &ManagedDatabase,
        label: &str,
    ) -> Vec<String> {
        vec![
            "pg_basebackup".to_string(),
            "-h".to_string(),
            "127.0.0.1".to_string(),
            "-p".to_string(),
            db.port.to_string(),
            "-U".to_string(),
            db.credentials.username.clone(),
            "-D".to_string(),
            format!("{}/{}", POSTGRES_PITR_BACKUPS_PATH, label),
            "-Fp".to_string(),
            "-Xs".to_string(),
            "-P".to_string(),
            "-l".to_string(),
            label.to_string(),
        ]
    }

    fn latest_base_backup_dir(
        &self,
        db: &ManagedDatabase,
    ) -> Result<std::path::PathBuf> {
        let backup_label =
            db.pitr_last_base_backup_label.clone().ok_or_else(|| {
                ClientError::Operation("no base backup available".to_string())
            })?;
        let backup_dir = db.pitr_backups_path().join(backup_label);
        if !backup_dir.exists() {
            return Err(ClientError::Operation(
                "latest base backup directory is missing".to_string(),
            ));
        }
        Ok(backup_dir)
    }

    fn archive_existing_data_dir(
        db: &ManagedDatabase,
        data_dir: &Path,
    ) -> Result<()> {
        if !data_dir.exists() {
            return Ok(());
        }

        let archived_data_dir = db.root_path().join(format!(
            "data-pre-recovery-{}",
            Utc::now().format("%Y%m%d_%H%M%S")
        ));
        fs::rename(data_dir, &archived_data_dir).map_err(|e| {
            ClientError::Operation(format!(
                "archive current data directory failed: {}",
                e
            ))
        })?;
        Ok(())
    }

    fn write_recovery_config(
        data_dir: &Path,
        restore_point: Option<&str>,
        target_time: Option<DateTime<Utc>>,
    ) -> Result<()> {
        let recovery_signal = data_dir.join("recovery.signal");
        fs::write(&recovery_signal, "").map_err(|e| {
            ClientError::Operation(format!(
                "write recovery.signal failed: {}",
                e
            ))
        })?;

        let auto_conf_path = data_dir.join("postgresql.auto.conf");
        let existing = if auto_conf_path.exists() {
            fs::read_to_string(&auto_conf_path).map_err(|e| {
                ClientError::Operation(format!(
                    "read postgresql.auto.conf failed: {}",
                    e
                ))
            })?
        } else {
            String::new()
        };

        let mut managed = Vec::new();
        for line in existing.lines() {
            let trimmed = line.trim_start();
            if RECOVERY_MANAGED_KEYS
                .iter()
                .any(|key| trimmed.starts_with(key))
            {
                continue;
            }
            managed.push(line.to_string());
        }

        managed.push(format!(
            "restore_command = 'cp {}/%f %p'",
            POSTGRES_PITR_WAL_PATH
        ));
        managed.push("recovery_target_action = 'promote'".to_string());
        if let Some(value) = restore_point {
            managed.push(format!("recovery_target_name = '{}'", value));
        }
        if let Some(value) = target_time {
            managed.push(format!(
                "recovery_target_time = '{}'",
                value.to_rfc3339()
            ));
        }

        let mut contents = managed.join("\n");
        contents.push('\n');

        fs::write(&auto_conf_path, contents).map_err(|e| {
            ClientError::Operation(format!(
                "write postgresql.auto.conf failed: {}",
                e
            ))
        })?;

        let standby_signal = data_dir.join("standby.signal");
        if standby_signal.exists() {
            let _ = fs::remove_file(standby_signal);
        }

        Ok(())
    }

    fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<()> {
        let metadata = fs::metadata(source).map_err(|e| {
            ClientError::Operation(format!(
                "stat backup directory failed: {}",
                e
            ))
        })?;
        if !metadata.is_dir() {
            return Err(ClientError::Operation(
                "base backup directory is not a directory".to_string(),
            ));
        }

        fs::create_dir_all(destination).map_err(|e| {
            ClientError::Operation(format!(
                "create data directory failed: {}",
                e
            ))
        })?;

        for entry in fs::read_dir(source).map_err(|e| {
            ClientError::Operation(format!(
                "read backup directory failed: {}",
                e
            ))
        })? {
            let entry = entry.map_err(|e| {
                ClientError::Operation(format!("read entry failed: {}", e))
            })?;
            let source_path = entry.path();
            let destination_path = destination.join(entry.file_name());
            let file_type = entry.file_type().map_err(|e| {
                ClientError::Operation(format!("stat entry failed: {}", e))
            })?;

            if file_type.is_dir() {
                Self::copy_dir_recursive(&source_path, &destination_path)?;
            } else if file_type.is_file() {
                fs::copy(&source_path, &destination_path).map_err(|e| {
                    ClientError::Operation(format!(
                        "copy backup file {} failed: {}",
                        source_path.display(),
                        e
                    ))
                })?;
            } else {
                return Err(ClientError::Operation(
                    "unsupported special file found in base backup".to_string(),
                ));
            }
        }

        Ok(())
    }
}
