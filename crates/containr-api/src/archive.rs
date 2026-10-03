//! safe extraction of uploaded source archives (.tar, .tar.gz, .tgz)

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;
use tar::{Archive, EntryType};

/// maximum accepted upload size
pub const MAX_UPLOAD_BYTES: u64 = 512 * 1024 * 1024;
/// maximum inline dockerfile size
pub const MAX_DOCKERFILE_BYTES: usize = 256 * 1024;
/// maximum total size of extracted file contents
const MAX_EXTRACTED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// maximum number of archive entries
const MAX_ENTRIES: usize = 200_000;

/// returns true when the file name has a supported archive extension
pub fn is_supported_archive_name(name: &str) -> bool {
    let name = name.trim().to_ascii_lowercase();
    name.ends_with(".tar")
        || name.ends_with(".tar.gz")
        || name.ends_with(".tgz")
}

/// extracts a tar or gzip-compressed tar archive into `dest`. absolute
/// paths, `..` components, links escaping the root, entries nested under
/// extracted symlinks and device/fifo entries are rejected.
pub fn extract_archive(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let mut file = File::open(archive_path)
        .map_err(|error| format!("failed to open archive: {}", error))?;
    let mut magic = [0u8; 2];
    let read = file
        .read(&mut magic)
        .map_err(|error| format!("failed to read archive: {}", error))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("failed to read archive: {}", error))?;

    let reader = BufReader::new(file);
    if read == 2 && magic == [0x1f, 0x8b] {
        unpack(Archive::new(GzDecoder::new(reader)), dest)
    } else {
        unpack(Archive::new(reader), dest)
    }
}

fn unpack<R: Read>(mut archive: Archive<R>, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|error| {
        format!("failed to create extraction directory: {}", error)
    })?;
    archive.set_overwrite(true);
    archive.set_preserve_permissions(false);
    archive.set_unpack_xattrs(false);

    let mut symlinks: HashSet<PathBuf> = HashSet::new();
    let mut total_bytes = 0u64;
    let mut count = 0usize;

    let entries = archive
        .entries()
        .map_err(|error| format!("invalid archive: {}", error))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|error| format!("invalid archive: {}", error))?;
        count += 1;
        if count > MAX_ENTRIES {
            return Err("archive has too many entries".to_string());
        }

        let raw_path = entry
            .path()
            .map_err(|error| format!("invalid entry path: {}", error))?
            .into_owned();
        let path = normalize_entry_path(&raw_path)?;
        if path.as_os_str().is_empty() {
            // the archive root itself ("./")
            continue;
        }
        if path
            .ancestors()
            .skip(1)
            .any(|ancestor| symlinks.contains(ancestor))
        {
            return Err(format!(
                "archive entry {} is nested under a symlink",
                raw_path.display()
            ));
        }

        let entry_type = entry.header().entry_type();
        match entry_type {
            EntryType::Regular
            | EntryType::Continuous
            | EntryType::GNUSparse
            | EntryType::Directory => {}
            EntryType::Symlink => {
                let target = link_target(&entry)?;
                if target.is_absolute() {
                    return Err(format!(
                        "symlink {} has an absolute target",
                        raw_path.display()
                    ));
                }
                let parent = path.parent().unwrap_or_else(|| Path::new(""));
                resolve_inside_root(&parent.join(&target)).ok_or_else(
                    || {
                        format!(
                            "symlink {} escapes the archive root",
                            raw_path.display()
                        )
                    },
                )?;
                symlinks.insert(path.clone());
            }
            EntryType::Link => {
                let target = link_target(&entry)?;
                let target = normalize_entry_path(&target).map_err(|_| {
                    format!(
                        "hard link {} escapes the archive root",
                        raw_path.display()
                    )
                })?;
                if target.as_os_str().is_empty()
                    || target
                        .ancestors()
                        .any(|ancestor| symlinks.contains(ancestor))
                {
                    return Err(format!(
                        "hard link {} has an invalid target",
                        raw_path.display()
                    ));
                }
            }
            other => {
                return Err(format!(
                    "unsupported archive entry type {:?} for {}",
                    other,
                    raw_path.display()
                ));
            }
        }

        total_bytes =
            total_bytes.saturating_add(entry.header().size().unwrap_or(0));
        if total_bytes > MAX_EXTRACTED_BYTES {
            return Err("archive contents are too large".to_string());
        }

        let unpacked = entry.unpack_in(dest).map_err(|error| {
            format!("failed to extract {}: {}", raw_path.display(), error)
        })?;
        if !unpacked {
            return Err(format!(
                "archive entry {} escapes the archive root",
                raw_path.display()
            ));
        }
    }

    Ok(())
}

fn link_target<R: Read>(entry: &tar::Entry<'_, R>) -> Result<PathBuf, String> {
    entry
        .link_name()
        .map_err(|error| format!("invalid link target: {}", error))?
        .map(|target| target.into_owned())
        .ok_or_else(|| "link entry is missing its target".to_string())
}

/// rejects absolute paths and parent components, dropping `.` components
fn normalize_entry_path(path: &Path) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!(
                    "archive entry {} contains '..'",
                    path.display()
                ));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "archive entry {} is absolute",
                    path.display()
                ));
            }
        }
    }
    Ok(normalized)
}

/// lexically resolves a relative path, returning None if it leaves the root
fn resolve_inside_root(path: &Path) -> Option<PathBuf> {
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if !resolved.pop() {
                    return None;
                }
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    use tar::{Builder, Header};

    fn header(entry_type: EntryType, size: u64) -> Header {
        let mut header = Header::new_gnu();
        header.set_entry_type(entry_type);
        header.set_size(size);
        header.set_mode(if entry_type == EntryType::Directory {
            0o755
        } else {
            0o644
        });
        header
    }

    /// writes a raw tar with an unchecked path so malicious names survive
    fn raw_entry(
        builder: &mut Builder<Vec<u8>>,
        entry_type: EntryType,
        path: &str,
        link: Option<&str>,
        data: &[u8],
    ) {
        let mut header = header(entry_type, data.len() as u64);
        {
            let gnu = header.as_gnu_mut().expect("gnu header");
            gnu.name[..path.len()].copy_from_slice(path.as_bytes());
            if let Some(link) = link {
                gnu.linkname[..link.len()].copy_from_slice(link.as_bytes());
            }
        }
        header.set_cksum();
        builder.append(&header, data).expect("append entry");
    }

    fn write_archive(dir: &Path, bytes: Vec<u8>, gzip: bool) -> PathBuf {
        let path = dir.join(if gzip { "src.tar.gz" } else { "src.tar" });
        let data = if gzip {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
            encoder.write_all(&bytes).expect("gzip");
            encoder.finish().expect("gzip finish")
        } else {
            bytes
        };
        std::fs::write(&path, data).expect("write archive");
        path
    }

    fn extract(
        entries: impl FnOnce(&mut Builder<Vec<u8>>),
        gzip: bool,
    ) -> (tempfile::TempDir, Result<(), String>) {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut builder = Builder::new(Vec::new());
        entries(&mut builder);
        let bytes = builder.into_inner().expect("finish tar");
        let archive = write_archive(dir.path(), bytes, gzip);
        let result = extract_archive(&archive, &dir.path().join("out"));
        (dir, result)
    }

    #[test]
    fn extracts_plain_and_gzip_archives() {
        for gzip in [false, true] {
            let (dir, result) = extract(
                |builder| {
                    raw_entry(builder, EntryType::Directory, "app/", None, b"");
                    raw_entry(
                        builder,
                        EntryType::Regular,
                        "app/Dockerfile",
                        None,
                        b"FROM scratch",
                    );
                    raw_entry(
                        builder,
                        EntryType::Symlink,
                        "app/link",
                        Some("Dockerfile"),
                        b"",
                    );
                    raw_entry(
                        builder,
                        EntryType::Link,
                        "app/hard",
                        Some("app/Dockerfile"),
                        b"",
                    );
                },
                gzip,
            );
            result.expect("archive should extract");
            let out = dir.path().join("out/app");
            assert_eq!(
                std::fs::read_to_string(out.join("Dockerfile")).expect("read"),
                "FROM scratch"
            );
            assert!(out.join("hard").exists());
        }
    }

    #[test]
    fn rejects_parent_traversal() {
        let (dir, result) = extract(
            |builder| {
                raw_entry(builder, EntryType::Regular, "../evil", None, b"x");
            },
            false,
        );
        assert!(result.is_err());
        assert!(!dir.path().join("evil").exists());
    }

    #[test]
    fn rejects_absolute_paths() {
        let (_dir, result) = extract(
            |builder| {
                raw_entry(
                    builder,
                    EntryType::Regular,
                    "/tmp/containr-evil",
                    None,
                    b"x",
                );
            },
            false,
        );
        assert!(result.is_err());
    }

    #[test]
    fn rejects_escaping_symlinks() {
        for target in ["../outside", "/etc/passwd", "a/../../x"] {
            let (_dir, result) = extract(
                |builder| {
                    raw_entry(
                        builder,
                        EntryType::Symlink,
                        "link",
                        Some(target),
                        b"",
                    );
                },
                false,
            );
            assert!(result.is_err(), "symlink to {} should fail", target);
        }
    }

    #[test]
    fn rejects_writes_through_symlinks() {
        let (dir, result) = extract(
            |builder| {
                raw_entry(builder, EntryType::Directory, "d/", None, b"");
                raw_entry(builder, EntryType::Symlink, "d/up", Some(".."), b"");
                raw_entry(
                    builder,
                    EntryType::Symlink,
                    "d/up/esc",
                    Some("../x"),
                    b"",
                );
            },
            false,
        );
        assert!(result.is_err());
        assert!(!dir.path().join("out/esc").exists());
    }

    #[test]
    fn rejects_escaping_hard_links_and_devices() {
        let (_dir, result) = extract(
            |builder| {
                raw_entry(
                    builder,
                    EntryType::Link,
                    "hard",
                    Some("../../etc/passwd"),
                    b"",
                );
            },
            false,
        );
        assert!(result.is_err());

        for entry_type in [EntryType::Char, EntryType::Block, EntryType::Fifo] {
            let (_dir, result) = extract(
                |builder| {
                    raw_entry(builder, entry_type, "dev", None, b"");
                },
                false,
            );
            assert!(result.is_err());
        }
    }

    #[test]
    fn archive_name_check() {
        assert!(is_supported_archive_name("src.tar"));
        assert!(is_supported_archive_name("SRC.TAR.GZ"));
        assert!(is_supported_archive_name("src.tgz"));
        assert!(!is_supported_archive_name("src.zip"));
    }
}
