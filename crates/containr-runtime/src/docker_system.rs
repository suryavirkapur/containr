//! docker host level operations: detailed stats, system info, disk usage
//! and cleanup

use std::collections::HashMap;

use bollard::models::{ContainerStatsResponse, ImageSummary};
use bollard::query_parameters::{
    DataUsageOptions, ListContainersOptions, ListImagesOptions,
    PruneBuildOptions, PruneContainersOptions, PruneImagesOptions,
    StatsOptions,
};
use futures::StreamExt;

use crate::docker::DockerContainerManager;
use crate::error::{ClientError, Result};

/// label set on every container created by containr
pub const CONTAINR_LABEL: &str = "containr";

/// detailed resource usage for one container
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DockerContainerMetrics {
    pub container_id: String,
    pub name: String,
    pub cpu_percent: f64,
    pub memory_used_bytes: u64,
    pub memory_limit_bytes: u64,
    pub network_rx_bytes: u64,
    pub network_tx_bytes: u64,
    pub block_read_bytes: u64,
    pub block_write_bytes: u64,
    pub pids: u64,
}

/// docker daemon information
#[derive(Debug, Clone, Default)]
pub struct DockerSystemInfo {
    pub docker_version: Option<String>,
    pub hostname: Option<String>,
    pub operating_system: Option<String>,
    pub kernel_version: Option<String>,
    pub containers_running: u64,
    pub containers_total: u64,
    pub images: u64,
}

/// disk usage for one docker resource category
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DockerDiskUsageEntry {
    pub count: u64,
    pub size_bytes: u64,
    pub reclaimable_bytes: u64,
}

/// docker `system df` summary
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DockerDiskUsage {
    pub images: DockerDiskUsageEntry,
    pub containers: DockerDiskUsageEntry,
    pub volumes: DockerDiskUsageEntry,
    pub build_cache: DockerDiskUsageEntry,
}

/// result of a cleanup run
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DockerCleanupResult {
    pub reclaimed_bytes: u64,
    pub images_deleted: u64,
}

fn non_negative(value: Option<i64>) -> u64 {
    value.unwrap_or(0).max(0) as u64
}

/// converts a raw stats response into metrics
pub fn metrics_from_stats(
    fallback_id: &str,
    stats: &ContainerStatsResponse,
) -> DockerContainerMetrics {
    let cpu_percent = match (&stats.cpu_stats, &stats.precpu_stats) {
        (Some(cpu), Some(precpu)) => {
            let usage = cpu
                .cpu_usage
                .as_ref()
                .and_then(|usage| usage.total_usage)
                .unwrap_or(0);
            let previous = precpu
                .cpu_usage
                .as_ref()
                .and_then(|usage| usage.total_usage)
                .unwrap_or(0);
            let cpu_delta = usage.saturating_sub(previous);
            let system_delta = cpu
                .system_cpu_usage
                .unwrap_or(0)
                .saturating_sub(precpu.system_cpu_usage.unwrap_or(0));
            if system_delta > 0 && cpu_delta > 0 {
                let cpus = cpu.online_cpus.unwrap_or(1).max(1) as f64;
                (cpu_delta as f64 / system_delta as f64) * cpus * 100.0
            } else {
                0.0
            }
        }
        _ => 0.0,
    };

    let (memory_used_bytes, memory_limit_bytes) = stats
        .memory_stats
        .as_ref()
        .map(|memory| (memory.usage.unwrap_or(0), memory.limit.unwrap_or(0)))
        .unwrap_or((0, 0));

    let (network_rx_bytes, network_tx_bytes) = stats
        .networks
        .as_ref()
        .map(|networks| {
            networks.values().fold((0u64, 0u64), |(rx, tx), network| {
                (
                    rx.saturating_add(network.rx_bytes.unwrap_or(0)),
                    tx.saturating_add(network.tx_bytes.unwrap_or(0)),
                )
            })
        })
        .unwrap_or((0, 0));

    let mut block_read_bytes = 0u64;
    let mut block_write_bytes = 0u64;
    if let Some(entries) = stats
        .blkio_stats
        .as_ref()
        .and_then(|blkio| blkio.io_service_bytes_recursive.as_ref())
    {
        for entry in entries {
            let value = entry.value.unwrap_or(0);
            match entry.op.as_deref().map(str::to_ascii_lowercase) {
                Some(op) if op == "read" => {
                    block_read_bytes = block_read_bytes.saturating_add(value)
                }
                Some(op) if op == "write" => {
                    block_write_bytes = block_write_bytes.saturating_add(value)
                }
                _ => {}
            }
        }
    }

    let pids = stats
        .pids_stats
        .as_ref()
        .and_then(|pids| pids.current)
        .unwrap_or(0);

    let container_id = stats
        .id
        .clone()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| fallback_id.to_string());
    let name = stats
        .name
        .as_deref()
        .map(|name| name.trim_start_matches('/').to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| fallback_id.to_string());

    DockerContainerMetrics {
        container_id,
        name,
        cpu_percent,
        memory_used_bytes,
        memory_limit_bytes,
        network_rx_bytes,
        network_tx_bytes,
        block_read_bytes,
        block_write_bytes,
        pids,
    }
}

fn image_usage_from_summaries(images: &[ImageSummary]) -> DockerDiskUsageEntry {
    let mut usage = DockerDiskUsageEntry {
        count: images.len() as u64,
        ..Default::default()
    };
    for image in images {
        let size = image.size.max(0) as u64;
        usage.size_bytes = usage.size_bytes.saturating_add(size);
        if image.containers <= 0 {
            usage.reclaimable_bytes =
                usage.reclaimable_bytes.saturating_add(size);
        }
    }
    usage
}

impl DockerContainerManager {
    /// one-shot detailed stats for a container (stream=false)
    pub async fn get_container_metrics(
        &self,
        id: &str,
    ) -> Result<DockerContainerMetrics> {
        if self.is_stub() {
            return Ok(DockerContainerMetrics {
                container_id: id.to_string(),
                name: id.to_string(),
                ..Default::default()
            });
        }

        let options = StatsOptions {
            stream: false,
            one_shot: false,
        };
        let mut stream = self.client().stats(id, Some(options));
        match stream.next().await {
            Some(Ok(stats)) => Ok(metrics_from_stats(id, &stats)),
            Some(Err(error)) => Err(ClientError::Operation(format!(
                "docker stats failed: {}",
                error
            ))),
            None => {
                Err(ClientError::Operation("no stats returned".to_string()))
            }
        }
    }

    /// docker daemon version and counters
    pub async fn system_info(&self) -> Result<DockerSystemInfo> {
        if self.is_stub() {
            return Ok(DockerSystemInfo::default());
        }

        let info = self.client().info().await.map_err(|error| {
            ClientError::Operation(format!("docker info failed: {}", error))
        })?;
        let version = self
            .client()
            .version()
            .await
            .ok()
            .and_then(|version| version.version);

        Ok(DockerSystemInfo {
            docker_version: version.or(info.server_version),
            hostname: info.name,
            operating_system: info.operating_system,
            kernel_version: info.kernel_version,
            containers_running: non_negative(info.containers_running),
            containers_total: non_negative(info.containers),
            images: non_negative(info.images),
        })
    }

    /// docker `system df` summary with list-based fallbacks for daemons
    /// that don't report the summary fields
    pub async fn disk_usage(&self) -> Result<DockerDiskUsage> {
        if self.is_stub() {
            return Ok(DockerDiskUsage::default());
        }

        let df = self.client().df(None::<DataUsageOptions>).await.map_err(
            |error| {
                ClientError::Operation(format!("docker df failed: {}", error))
            },
        )?;

        let images = match df.image_usage {
            Some(summary) => DockerDiskUsageEntry {
                count: non_negative(summary.total_count),
                size_bytes: non_negative(summary.total_size),
                reclaimable_bytes: non_negative(summary.reclaimable),
            },
            None => {
                let images = self
                    .client()
                    .list_images(Some(ListImagesOptions {
                        all: false,
                        ..Default::default()
                    }))
                    .await
                    .map_err(|error| {
                        ClientError::Operation(format!(
                            "docker image list failed: {}",
                            error
                        ))
                    })?;
                image_usage_from_summaries(&images)
            }
        };

        let containers = match df.container_usage {
            Some(summary) => DockerDiskUsageEntry {
                count: non_negative(summary.total_count),
                size_bytes: non_negative(summary.total_size),
                reclaimable_bytes: non_negative(summary.reclaimable),
            },
            None => {
                let containers = self
                    .client()
                    .list_containers(Some(ListContainersOptions {
                        all: true,
                        size: true,
                        ..Default::default()
                    }))
                    .await
                    .map_err(|error| {
                        ClientError::Operation(format!(
                            "docker ps failed: {}",
                            error
                        ))
                    })?;
                let mut usage = DockerDiskUsageEntry {
                    count: containers.len() as u64,
                    ..Default::default()
                };
                for container in containers {
                    let size = non_negative(container.size_rw);
                    usage.size_bytes = usage.size_bytes.saturating_add(size);
                    let running = matches!(
                        container.state,
                        Some(
                            bollard::models::ContainerSummaryStateEnum::RUNNING
                        )
                    );
                    if !running {
                        usage.reclaimable_bytes =
                            usage.reclaimable_bytes.saturating_add(size);
                    }
                }
                usage
            }
        };

        let volumes = df
            .volume_usage
            .map(|summary| DockerDiskUsageEntry {
                count: non_negative(summary.total_count),
                size_bytes: non_negative(summary.total_size),
                reclaimable_bytes: non_negative(summary.reclaimable),
            })
            .unwrap_or_default();

        let build_cache = df
            .build_cache_usage
            .map(|summary| DockerDiskUsageEntry {
                count: non_negative(summary.total_count),
                size_bytes: non_negative(summary.total_size),
                reclaimable_bytes: non_negative(summary.reclaimable),
            })
            .unwrap_or_default();

        Ok(DockerDiskUsage {
            images,
            containers,
            volumes,
            build_cache,
        })
    }

    /// prunes unused images, the build cache and stopped containr
    /// containers. volumes are never pruned.
    pub async fn cleanup(
        &self,
        images: bool,
        build_cache: bool,
        containers: bool,
    ) -> Result<DockerCleanupResult> {
        let mut result = DockerCleanupResult::default();
        if self.is_stub() {
            return Ok(result);
        }

        // containers first so their images become unused
        if containers {
            let filters = HashMap::from([(
                "label".to_string(),
                vec![format!("{}=true", CONTAINR_LABEL)],
            )]);
            let pruned = self
                .client()
                .prune_containers(Some(PruneContainersOptions {
                    filters: Some(filters),
                }))
                .await
                .map_err(|error| {
                    ClientError::Operation(format!(
                        "docker container prune failed: {}",
                        error
                    ))
                })?;
            result.reclaimed_bytes = result
                .reclaimed_bytes
                .saturating_add(non_negative(pruned.space_reclaimed));
        }

        if images {
            // dangling=false prunes every image without a container
            let filters = HashMap::from([(
                "dangling".to_string(),
                vec!["false".to_string()],
            )]);
            let pruned = self
                .client()
                .prune_images(Some(PruneImagesOptions {
                    filters: Some(filters),
                }))
                .await
                .map_err(|error| {
                    ClientError::Operation(format!(
                        "docker image prune failed: {}",
                        error
                    ))
                })?;
            result.reclaimed_bytes = result
                .reclaimed_bytes
                .saturating_add(non_negative(pruned.space_reclaimed));
            result.images_deleted = pruned
                .images_deleted
                .unwrap_or_default()
                .iter()
                .filter(|item| item.deleted.is_some())
                .count() as u64;
        }

        if build_cache {
            let pruned = self
                .client()
                .prune_build(Some(PruneBuildOptions {
                    all: Some(true),
                    ..Default::default()
                }))
                .await
                .map_err(|error| {
                    ClientError::Operation(format!(
                        "docker build cache prune failed: {}",
                        error
                    ))
                })?;
            result.reclaimed_bytes = result
                .reclaimed_bytes
                .saturating_add(non_negative(pruned.space_reclaimed));
        }

        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bollard::models::{
        ContainerBlkioStatEntry, ContainerBlkioStats, ContainerCpuStats,
        ContainerCpuUsage, ContainerMemoryStats, ContainerNetworkStats,
        ContainerPidsStats,
    };

    #[test]
    fn metrics_from_stats_sums_networks_and_block_io() {
        let stats = ContainerStatsResponse {
            id: Some("abc".to_string()),
            name: Some("/containr-web".to_string()),
            cpu_stats: Some(ContainerCpuStats {
                cpu_usage: Some(ContainerCpuUsage {
                    total_usage: Some(200),
                    ..Default::default()
                }),
                system_cpu_usage: Some(2000),
                online_cpus: Some(2),
                ..Default::default()
            }),
            precpu_stats: Some(ContainerCpuStats {
                cpu_usage: Some(ContainerCpuUsage {
                    total_usage: Some(100),
                    ..Default::default()
                }),
                system_cpu_usage: Some(1000),
                ..Default::default()
            }),
            memory_stats: Some(ContainerMemoryStats {
                usage: Some(10),
                limit: Some(100),
                ..Default::default()
            }),
            networks: Some(HashMap::from([
                (
                    "eth0".to_string(),
                    ContainerNetworkStats {
                        rx_bytes: Some(5),
                        tx_bytes: Some(7),
                        ..Default::default()
                    },
                ),
                (
                    "eth1".to_string(),
                    ContainerNetworkStats {
                        rx_bytes: Some(1),
                        tx_bytes: Some(1),
                        ..Default::default()
                    },
                ),
            ])),
            blkio_stats: Some(ContainerBlkioStats {
                io_service_bytes_recursive: Some(vec![
                    ContainerBlkioStatEntry {
                        op: Some("read".to_string()),
                        value: Some(30),
                        ..Default::default()
                    },
                    ContainerBlkioStatEntry {
                        op: Some("Write".to_string()),
                        value: Some(40),
                        ..Default::default()
                    },
                ]),
                ..Default::default()
            }),
            pids_stats: Some(ContainerPidsStats {
                current: Some(3),
                limit: None,
            }),
            ..Default::default()
        };

        let metrics = metrics_from_stats("fallback", &stats);
        assert_eq!(metrics.container_id, "abc");
        assert_eq!(metrics.name, "containr-web");
        assert!((metrics.cpu_percent - 20.0).abs() < f64::EPSILON);
        assert_eq!(metrics.memory_used_bytes, 10);
        assert_eq!(metrics.memory_limit_bytes, 100);
        assert_eq!(metrics.network_rx_bytes, 6);
        assert_eq!(metrics.network_tx_bytes, 8);
        assert_eq!(metrics.block_read_bytes, 30);
        assert_eq!(metrics.block_write_bytes, 40);
        assert_eq!(metrics.pids, 3);
    }

    #[test]
    fn image_usage_counts_unused_images_as_reclaimable() {
        let images = vec![
            ImageSummary {
                size: 100,
                containers: 1,
                ..Default::default()
            },
            ImageSummary {
                size: 50,
                containers: 0,
                ..Default::default()
            },
        ];
        let usage = image_usage_from_summaries(&images);
        assert_eq!(usage.count, 2);
        assert_eq!(usage.size_bytes, 150);
        assert_eq!(usage.reclaimable_bytes, 50);
    }
}
