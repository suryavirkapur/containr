//! moves volume data when a mount is switched between per-service and
//! shared, so toggling `shared` never makes a volume look empty

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use super::ApiResult;
use super::{app_mount_root, conflict, internal_error, service_mount_root};
use containr_common::models::ContainerService;
use containr_runtime::service_support::SHARED_MOUNTS_DIR;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum MountMigration {
    /// the service's own data becomes the shared volume (a rename)
    MoveToShared { from: PathBuf, to: PathBuf },
    /// the service keeps a copy of the shared data; other services may
    /// still use the shared volume
    CopyFromShared { from: PathBuf, to: PathBuf },
}

/// what has to happen on disk for the mount changes between `previous` and
/// `updated`. errors when sharing would hide this service's data behind a
/// shared volume that already has other data.
pub(super) fn plan(
    data_dir: &Path,
    app_id: Uuid,
    previous: &ContainerService,
    updated: &ContainerService,
) -> ApiResult<Vec<MountMigration>> {
    let service_root = service_mount_root(data_dir, app_id, previous.id);
    let shared_root = app_mount_root(data_dir, app_id).join(SHARED_MOUNTS_DIR);
    let mut migrations = Vec::new();

    for mount in &updated.mounts {
        let Some(before) = previous
            .mounts
            .iter()
            .find(|before| before.name == mount.name)
        else {
            continue;
        };
        let managed = before.host_path.is_none() && mount.host_path.is_none();
        if !managed || before.shared == mount.shared {
            continue;
        }

        let private = service_root.join(&mount.name);
        let shared = shared_root.join(&mount.name);
        if mount.shared {
            if is_empty_dir(&private)? {
                continue;
            }
            if !is_empty_dir(&shared)? {
                return Err(conflict(format!(
                    "the shared volume {:?} already has data, and so does this \
                     service's {:?} volume. rename the volume or empty one of \
                     them first",
                    mount.name, mount.name
                )));
            }
            migrations.push(MountMigration::MoveToShared {
                from: private,
                to: shared,
            });
        } else if is_empty_dir(&private)? && !is_empty_dir(&shared)? {
            migrations.push(MountMigration::CopyFromShared {
                from: shared,
                to: private,
            });
        }
    }

    Ok(migrations)
}

/// runs the migrations. returns the moves that happened so a failed save
/// can put the data back with [`undo`].
pub(super) async fn apply(
    migrations: Vec<MountMigration>,
) -> ApiResult<Vec<MountMigration>> {
    let mut applied = Vec::new();
    for migration in migrations {
        let result = match &migration {
            MountMigration::MoveToShared { from, to } => {
                move_dir(from.clone(), to.clone()).await
            }
            MountMigration::CopyFromShared { from, to } => {
                copy_dir(from.clone(), to.clone()).await
            }
        };
        if let Err(error) = result {
            undo(applied).await;
            return Err(internal_error(format!(
                "failed to move volume data: {}",
                error
            )));
        }
        if matches!(migration, MountMigration::MoveToShared { .. }) {
            applied.push(migration);
        }
    }
    Ok(applied)
}

/// moves data back after a failed save; copies need no undo
pub(super) async fn undo(applied: Vec<MountMigration>) {
    for migration in applied.into_iter().rev() {
        if let MountMigration::MoveToShared { from, to } = migration {
            if let Err(error) = tokio::fs::rename(&to, &from).await {
                tracing::error!(
                    from = %to.display(),
                    to = %from.display(),
                    error = %error,
                    "failed to move volume data back"
                );
            }
        }
    }
}

/// a missing directory counts as empty
fn is_empty_dir(path: &Path) -> ApiResult<bool> {
    match std::fs::read_dir(path) {
        Ok(mut entries) => Ok(entries.next().is_none()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(true),
        Err(error) => Err(internal_error(format!(
            "failed to read {}: {}",
            path.display(),
            error
        ))),
    }
}

async fn move_dir(from: PathBuf, to: PathBuf) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    // an empty placeholder (e.g. seeded on an earlier deploy) blocks rename
    match tokio::fs::remove_dir(&to).await {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    tokio::fs::rename(&from, &to).await
}

async fn copy_dir(from: PathBuf, to: PathBuf) -> std::io::Result<()> {
    tokio::task::spawn_blocking(move || copy_dir_all(&from, &to))
        .await
        .map_err(std::io::Error::other)?
}

/// recursive copy keeping permissions, ownership and symlinks, like `cp -a`
fn copy_dir_all(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{lchown, MetadataExt};

    let meta = std::fs::symlink_metadata(from)?;
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir_all(&source, &target)?;
        } else if kind.is_symlink() {
            let link = std::fs::read_link(&source)?;
            std::os::unix::fs::symlink(link, &target)?;
            let link_meta = std::fs::symlink_metadata(&source)?;
            lchown(&target, Some(link_meta.uid()), Some(link_meta.gid()))?;
        } else {
            // fs::copy keeps the permission bits
            std::fs::copy(&source, &target)?;
            let file_meta = entry.metadata()?;
            lchown(&target, Some(file_meta.uid()), Some(file_meta.gid()))?;
        }
    }
    std::fs::set_permissions(to, meta.permissions())?;
    lchown(to, Some(meta.uid()), Some(meta.gid()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use containr_common::models::ServiceMount;

    fn service(app_id: Uuid, shared: bool) -> ContainerService {
        let mut service = ContainerService::new(
            app_id,
            "db".to_string(),
            "postgres:16".to_string(),
            5432,
        );
        service.mounts = vec![ServiceMount {
            name: "data".to_string(),
            target: "/var/lib/postgresql/data".to_string(),
            read_only: false,
            host_path: None,
            shared,
        }];
        service
    }

    fn with_shared(
        service: &ContainerService,
        shared: bool,
    ) -> ContainerService {
        let mut updated = service.clone();
        updated.mounts[0].shared = shared;
        updated
    }

    #[tokio::test]
    async fn sharing_moves_the_service_data_into_the_shared_volume() {
        let root = tempfile::tempdir().expect("tempdir");
        let app_id = Uuid::new_v4();
        let before = service(app_id, false);
        let private =
            service_mount_root(root.path(), app_id, before.id).join("data");
        std::fs::create_dir_all(private.join("base")).expect("mkdir");
        std::fs::write(private.join("base/table"), "rows").expect("write");

        let after = with_shared(&before, true);
        let migrations =
            plan(root.path(), app_id, &before, &after).expect("plan");
        assert_eq!(migrations.len(), 1);
        apply(migrations).await.expect("apply");

        let shared = app_mount_root(root.path(), app_id)
            .join(SHARED_MOUNTS_DIR)
            .join("data");
        assert_eq!(
            std::fs::read_to_string(shared.join("base/table")).ok(),
            Some("rows".to_string())
        );
        assert!(!private.exists());
    }

    #[tokio::test]
    async fn unsharing_copies_the_shared_data_back() {
        let root = tempfile::tempdir().expect("tempdir");
        let app_id = Uuid::new_v4();
        let before = service(app_id, true);
        let shared = app_mount_root(root.path(), app_id)
            .join(SHARED_MOUNTS_DIR)
            .join("data");
        std::fs::create_dir_all(&shared).expect("mkdir");
        std::fs::write(shared.join("file"), "kept").expect("write");
        std::os::unix::fs::symlink("file", shared.join("link"))
            .expect("symlink");

        let after = with_shared(&before, false);
        apply(plan(root.path(), app_id, &before, &after).expect("plan"))
            .await
            .expect("apply");

        let private =
            service_mount_root(root.path(), app_id, before.id).join("data");
        assert_eq!(
            std::fs::read_to_string(private.join("file")).ok(),
            Some("kept".to_string())
        );
        assert_eq!(
            std::fs::read_link(private.join("link")).ok(),
            Some(PathBuf::from("file"))
        );
        // the shared copy stays for other services
        assert!(shared.join("file").exists());
    }

    #[test]
    fn sharing_refuses_to_hide_data_behind_a_full_shared_volume() {
        let root = tempfile::tempdir().expect("tempdir");
        let app_id = Uuid::new_v4();
        let before = service(app_id, false);
        let private =
            service_mount_root(root.path(), app_id, before.id).join("data");
        let shared = app_mount_root(root.path(), app_id)
            .join(SHARED_MOUNTS_DIR)
            .join("data");
        for dir in [&private, &shared] {
            std::fs::create_dir_all(dir).expect("mkdir");
            std::fs::write(dir.join("file"), "x").expect("write");
        }

        let error =
            plan(root.path(), app_id, &before, &with_shared(&before, true))
                .expect_err("conflict");
        assert_eq!(error.0, axum::http::StatusCode::CONFLICT);
    }

    #[test]
    fn empty_or_unchanged_volumes_need_nothing() {
        let root = tempfile::tempdir().expect("tempdir");
        let app_id = Uuid::new_v4();
        let before = service(app_id, false);
        assert!(plan(
            root.path(),
            app_id,
            &before,
            &with_shared(&before, true)
        )
        .expect("plan")
        .is_empty());
        assert!(plan(root.path(), app_id, &before, &before)
            .expect("plan")
            .is_empty());
    }
}
