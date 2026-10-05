//! helpers shared by the deployment worker, cron scheduler and app service
//! manager when turning a service definition into a docker container

use std::path::Path;

use uuid::Uuid;

use crate::docker::{DockerBindMount, DockerPortMapping};
use crate::image::RegistryCredentials;
use containr_common::models::{is_docker_hub_host, ContainerService};
use containr_common::{decrypt, derive_key, Database};

/// builds bind mounts for a service. managed mounts live under
/// `{work_dir}/app-mounts/{app}/{service}/{name}`; mounts with a host_path
/// bind that absolute host path instead.
pub fn build_service_mounts(
    work_dir: &Path,
    app_id: Uuid,
    service: &ContainerService,
) -> anyhow::Result<Vec<DockerBindMount>> {
    let mut mounts = Vec::new();
    let mounts_root = work_dir
        .join("app-mounts")
        .join(app_id.to_string())
        .join(service.id.to_string());

    for mount in &service.mounts {
        let host_path = mount
            .host_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let source = match host_path {
            Some(host_path) => {
                let path = Path::new(host_path);
                if !path.is_absolute() {
                    return Err(anyhow::anyhow!(
                        "host path {} for mount {} must be absolute",
                        host_path,
                        mount.name
                    ));
                }
                if !path.exists() {
                    std::fs::create_dir_all(path)?;
                }
                path.to_path_buf()
            }
            None => {
                let source = mounts_root.join(&mount.name);
                std::fs::create_dir_all(&source)?;
                source
            }
        };
        mounts.push(DockerBindMount {
            source: source.to_string_lossy().to_string(),
            target: mount.target.clone(),
            read_only: mount.read_only,
            // managed dirs behave like docker named volumes and get the
            // image's files and ownership on first use
            seed_from_image: host_path.is_none(),
        });
    }

    Ok(mounts)
}

/// decrypts a value stored with the `enc:` prefix
pub fn decrypt_stored_secret(
    value: &str,
    encryption_secret: Option<&str>,
) -> anyhow::Result<String> {
    let trimmed = value.trim();
    let payload = trimmed.strip_prefix("enc:").unwrap_or(trimmed);

    if trimmed.starts_with("enc:") {
        let secret = encryption_secret.ok_or_else(|| {
            anyhow::anyhow!("encryption key is not configured")
        })?;
        let key = derive_key(secret);
        return decrypt(payload, &key).map_err(|error| {
            anyhow::anyhow!("failed to decrypt registry password: {}", error)
        });
    }

    Ok(payload.to_string())
}

/// resolves pull credentials for a service image. explicit service
/// registry auth wins; otherwise the owner's saved registry whose host
/// matches the image registry is used.
pub fn resolve_registry_credentials(
    db: Option<&Database>,
    owner_id: Uuid,
    service: &ContainerService,
    image: &str,
    encryption_secret: Option<&str>,
) -> anyhow::Result<Option<RegistryCredentials>> {
    if let Some(registry_auth) = service.registry_auth.as_ref() {
        let password =
            decrypt_stored_secret(&registry_auth.password, encryption_secret)?;
        return Ok(Some(RegistryCredentials {
            server: registry_auth.server.clone(),
            username: registry_auth.username.clone(),
            password,
        }));
    }

    let Some(db) = db else {
        return Ok(None);
    };
    let registry = db
        .list_registries_by_owner(owner_id)?
        .into_iter()
        .find(|registry| registry.matches_image(image));
    let Some(registry) = registry else {
        return Ok(None);
    };

    let password =
        decrypt_stored_secret(&registry.password_enc, encryption_secret)?;
    // docker hub credentials must use the default index address
    let server = if is_docker_hub_host(&registry.server) {
        None
    } else {
        Some(registry.server.clone())
    };

    Ok(Some(RegistryCredentials {
        server,
        username: registry.username,
        password,
    }))
}

/// published host ports for a replica. only the first replica binds host
/// ports since replicas cannot share them.
pub fn service_port_mappings(
    service: &ContainerService,
    replica_index: u32,
) -> Vec<DockerPortMapping> {
    if replica_index != 0 {
        return Vec::new();
    }

    service
        .port_mappings
        .iter()
        .map(|mapping| DockerPortMapping {
            host_port: mapping.host_port,
            container_port: mapping.container_port,
            protocol: mapping.protocol.as_str().to_string(),
        })
        .collect()
}

/// returns true when the image must be pulled from a registry, i.e. it is
/// the service's configured image rather than a locally built one
pub fn should_pull_service_image(
    service: &ContainerService,
    image: &str,
) -> bool {
    let configured = service.image.trim();
    !configured.is_empty() && configured == image.trim()
}

#[cfg(test)]
mod tests {
    use super::*;
    use containr_common::models::{
        ContainerRegistry, PortMapping, PortProtocol, ServiceMount, User,
    };
    use containr_common::{encrypt, DatabaseConfig};

    fn service() -> ContainerService {
        ContainerService::new(
            Uuid::new_v4(),
            "web".to_string(),
            "ghcr.io/demo/web:1".to_string(),
            80,
        )
    }

    #[test]
    fn host_path_mounts_bind_the_host_path() {
        let root = tempfile::tempdir().expect("tempdir");
        let host_dir = root.path().join("host");
        let mut service = service();
        service.mounts = vec![
            ServiceMount {
                name: "data".to_string(),
                target: "/data".to_string(),
                read_only: false,
                host_path: None,
            },
            ServiceMount {
                name: "host".to_string(),
                target: "/host".to_string(),
                read_only: true,
                host_path: Some(host_dir.to_string_lossy().to_string()),
            },
        ];

        let mounts = build_service_mounts(root.path(), Uuid::nil(), &service)
            .expect("mounts");
        assert!(mounts[0].source.contains("app-mounts"));
        assert!(mounts[0].seed_from_image);
        assert_eq!(mounts[1].source, host_dir.to_string_lossy());
        assert!(!mounts[1].seed_from_image);
        assert!(host_dir.exists());
        assert!(mounts[1].read_only);
    }

    #[test]
    fn port_mappings_only_bind_first_replica() {
        let mut service = service();
        service.port_mappings = vec![PortMapping {
            host_port: 5353,
            container_port: 53,
            protocol: PortProtocol::Udp,
        }];
        let first = service_port_mappings(&service, 0);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].protocol, "udp");
        assert!(service_port_mappings(&service, 1).is_empty());
    }

    #[test]
    fn pulls_only_configured_images() {
        let service = service();
        assert!(should_pull_service_image(&service, "ghcr.io/demo/web:1"));
        assert!(!should_pull_service_image(&service, "containr/x:built"));
    }

    #[test]
    fn owner_registry_is_used_when_service_has_no_auth() {
        let root = tempfile::tempdir().expect("tempdir");
        let db = Database::open(&DatabaseConfig {
            path: root
                .path()
                .join("db.sqlite3")
                .to_string_lossy()
                .into_owned(),
        })
        .expect("db");
        let user = User::new_with_password(
            "a@example.com".to_string(),
            "hash".to_string(),
        );
        db.save_user(&user).expect("save user");
        let key = derive_key("secret");
        let encrypted =
            format!("enc:{}", encrypt("pw", &key).expect("encrypt"));
        db.save_registry(&ContainerRegistry::new(
            user.id,
            "ghcr.io".to_string(),
            "bob".to_string(),
            encrypted,
        ))
        .expect("save registry");

        let service = service();
        let credentials = resolve_registry_credentials(
            Some(&db),
            user.id,
            &service,
            &service.image,
            Some("secret"),
        )
        .expect("resolve")
        .expect("credentials");
        assert_eq!(credentials.username, "bob");
        assert_eq!(credentials.password, "pw");
        assert_eq!(credentials.server.as_deref(), Some("ghcr.io"));

        let none = resolve_registry_credentials(
            Some(&db),
            user.id,
            &service,
            "redis:7",
            Some("secret"),
        )
        .expect("resolve");
        assert!(none.is_none());
    }
}
