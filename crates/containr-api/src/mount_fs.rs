//! race-free filesystem access inside a container volume mount
//!
//! the volume file browser operates on host paths a container can
//! modify, so resolving a path and then using it in a second syscall is
//! a toctou hole: a container can swap a component for a symlink and
//! make containr read, write or delete files outside the mount. instead
//! the mount root is opened once as a directory fd and every lookup
//! below it happens component by component with `openat(2)` and
//! `O_NOFOLLOW` — a symlink anywhere in the path is refused at lookup
//! time instead of being resolved after a check.

use std::ffi::{CString, OsStr, OsString};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::{Component, Path};

/// how resolving a path under a mount can fail
#[derive(Debug)]
pub enum MountFsError {
    /// a component of the path is a symlink: a likely escape attempt
    Symlink,
    /// the path itself is invalid (`..`, root, empty for an entry op)
    Invalid,
    /// anything the kernel reported (missing, not a directory, ...)
    Io(std::io::Error),
}

impl MountFsError {
    fn io(error: std::io::Error) -> Self {
        MountFsError::Io(error)
    }
}

/// turns a failed component lookup into a mount error. the kernel
/// reports a symlink opened with O_NOFOLLOW|O_DIRECTORY as ENOTDIR (not
/// ELOOP), so a not-a-directory failure is lstat'ed — race-free, at the
/// dirfd — to tell an escape attempt from a real file
fn classify_lookup_error(
    dirfd: RawFd,
    name: &OsStr,
    error: std::io::Error,
) -> MountFsError {
    match error.raw_os_error() {
        Some(libc::ELOOP) => return MountFsError::Symlink,
        Some(libc::ENOTDIR) => {
            if let Ok(stat) = fstatat(dirfd, name, libc::AT_SYMLINK_NOFOLLOW) {
                if (stat.st_mode & libc::S_IFMT) == libc::S_IFLNK {
                    return MountFsError::Symlink;
                }
            }
        }
        _ => {}
    }
    MountFsError::Io(error)
}

impl std::fmt::Display for MountFsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MountFsError::Symlink => {
                write!(f, "path contains a symlink")
            }
            MountFsError::Invalid => write!(f, "invalid path"),
            MountFsError::Io(error) => write!(f, "{}", error),
        }
    }
}

impl std::error::Error for MountFsError {}

/// a directory entry of a volume listing
pub struct ListEntry {
    pub name: OsString,
    pub is_dir: bool,
    pub len: u64,
    pub modified: Option<std::time::SystemTime>,
}

/// an open handle to a container volume mount. all operations stay
/// under this root by construction
pub struct MountDir {
    root: OwnedFd,
}

impl MountDir {
    /// opens the mount root. the root itself must be a real directory,
    /// not a symlink
    pub fn open(base: &Path) -> Result<Self, MountFsError> {
        let fd = open_at(
            libc::AT_FDCWD,
            base.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        )
        .map_err(MountFsError::io)?;
        Ok(Self { root: fd })
    }

    /// opens an existing directory at `rel`, refusing symlinks
    pub fn open_dir(&self, rel: &Path) -> Result<OwnedFd, MountFsError> {
        walk(&self.root, &components(rel)?, false)
    }

    /// opens the directory at `rel`, creating missing components like
    /// `create_dir_all` would
    pub fn create_dir_all(&self, rel: &Path) -> Result<OwnedFd, MountFsError> {
        walk(&self.root, &components(rel)?, true)
    }

    /// opens the parent directory of `rel` and returns it with the leaf
    /// name, so leaf operations can run relative to it
    fn open_parent(
        &self,
        rel: &Path,
    ) -> Result<(OwnedFd, OsString), MountFsError> {
        let mut parts = components(rel)?;
        let name = parts.pop().ok_or(MountFsError::Invalid)?;
        Ok((walk(&self.root, &parts, false)?, name))
    }

    /// opens an existing file at `rel` for reading. a symlink leaf is
    /// refused
    pub fn open_file(&self, rel: &Path) -> Result<std::fs::File, MountFsError> {
        let (dir, name) = self.open_parent(rel)?;
        let fd =
            open_at(dir.as_raw_fd(), &name, libc::O_RDONLY | libc::O_NOFOLLOW)
                .map_err(|error| {
                    classify_lookup_error(dir.as_raw_fd(), &name, error)
                })?;
        Ok(std::fs::File::from(fd))
    }

    /// creates or truncates a regular file at `rel`. a symlink leaf is
    /// refused, missing parents fail
    pub fn create_file(
        &self,
        rel: &Path,
    ) -> Result<std::fs::File, MountFsError> {
        let (dir, name) = self.open_parent(rel)?;
        let fd = open_at(
            dir.as_raw_fd(),
            &name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC | libc::O_NOFOLLOW,
        )
        .map_err(|error| {
            classify_lookup_error(dir.as_raw_fd(), &name, error)
        })?;
        Ok(std::fs::File::from(fd))
    }

    /// lists the directory at `rel`
    pub fn list(&self, rel: &Path) -> Result<Vec<ListEntry>, MountFsError> {
        let fd = self.open_dir(rel)?;
        let mut entries = Vec::new();
        // iterating through /proc/self/fd keeps every lookup anchored to
        // the open dir fd, so names resolve inside the mount even if the
        // container moves directories around mid-listing
        for entry in
            std::fs::read_dir(fd_path(&fd)).map_err(MountFsError::io)?
        {
            let entry = entry.map_err(MountFsError::io)?;
            let file_type = entry.file_type().map_err(MountFsError::io)?;
            let meta = entry.metadata().map_err(MountFsError::io)?;
            entries.push(ListEntry {
                name: entry.file_name(),
                is_dir: file_type.is_dir(),
                len: meta.len(),
                modified: meta.modified().ok(),
            });
        }
        Ok(entries)
    }

    /// removes the entry at `rel`; directories are emptied recursively
    /// without ever following a symlink
    pub fn remove_all(&self, rel: &Path) -> Result<(), MountFsError> {
        let (dir, name) = self.open_parent(rel)?;
        remove_all_at(dir.as_raw_fd(), &name)
    }
}

/// `/proc/self/fd/<fd>` addresses the open file itself, so symlinks in
/// the path the fd was opened from can no longer matter
fn fd_path(fd: &OwnedFd) -> String {
    format!("/proc/self/fd/{}", fd.as_raw_fd())
}

/// the normal components of `rel`. `..`, roots and prefixes are rejected
fn components(rel: &Path) -> Result<Vec<OsString>, MountFsError> {
    let mut parts = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(name) => parts.push(name.to_os_string()),
            Component::CurDir => {}
            _ => return Err(MountFsError::Invalid),
        }
    }
    Ok(parts)
}

/// walks `parts` under `fd` with openat(O_DIRECTORY|O_NOFOLLOW) per
/// component. with `create`, missing components are mkdirat'ed
fn walk(
    fd: &OwnedFd,
    parts: &[OsString],
    create: bool,
) -> Result<OwnedFd, MountFsError> {
    let mut current = fd.try_clone().map_err(MountFsError::io)?;
    for part in parts {
        let dirfd = current.as_raw_fd();
        match open_at(
            dirfd,
            part,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        ) {
            Ok(next) => current = next,
            Err(error)
                if create && error.kind() == std::io::ErrorKind::NotFound =>
            {
                mkdir_at(dirfd, part).map_err(MountFsError::io)?;
                current = open_at(
                    dirfd,
                    part,
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
                )
                .map_err(|error| classify_lookup_error(dirfd, part, error))?;
            }
            Err(error) => {
                return Err(classify_lookup_error(dirfd, part, error))
            }
        }
    }
    Ok(current)
}

/// removes `name` under `dirfd`. directories are emptied recursively,
/// symlinks are removed as links and never followed
fn remove_all_at(dirfd: RawFd, name: &OsStr) -> Result<(), MountFsError> {
    let stat = fstatat(dirfd, name, libc::AT_SYMLINK_NOFOLLOW)
        .map_err(MountFsError::io)?;
    let is_dir = (stat.st_mode & libc::S_IFMT) == libc::S_IFDIR;
    if !is_dir {
        return unlink_at(dirfd, name, 0).map_err(MountFsError::io);
    }

    let dir = open_at(
        dirfd,
        name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
    )
    .map_err(MountFsError::io)?;

    // collect names first: unlinking while iterating a directory is
    // legal but fragile across filesystems
    let mut children = Vec::new();
    for entry in std::fs::read_dir(fd_path(&dir)).map_err(MountFsError::io)? {
        children.push(entry.map_err(MountFsError::io)?.file_name());
    }
    for child in children {
        remove_all_at(dir.as_raw_fd(), &child)?;
    }

    unlink_at(dirfd, name, libc::AT_REMOVEDIR).map_err(MountFsError::io)
}

fn c_name(name: &OsStr) -> Result<CString, MountFsError> {
    CString::new(name.as_bytes()).map_err(|_| MountFsError::Invalid)
}

fn open_at(
    dirfd: RawFd,
    name: &OsStr,
    flags: libc::c_int,
) -> std::io::Result<OwnedFd> {
    let name = c_name(name).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "nul byte")
    })?;
    // the mode argument is ignored unless O_CREAT is set, so passing it
    // unconditionally is safe
    let fd = unsafe {
        libc::openat(dirfd, name.as_ptr(), flags | libc::O_CLOEXEC, 0o644)
    };
    if fd < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

fn fstatat(
    dirfd: RawFd,
    name: &OsStr,
    flags: libc::c_int,
) -> std::io::Result<libc::stat> {
    let name = c_name(name).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "nul byte")
    })?;
    let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
    let result =
        unsafe { libc::fstatat(dirfd, name.as_ptr(), &mut stat, flags) };
    if result < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(stat)
    }
}

fn mkdir_at(dirfd: RawFd, name: &OsStr) -> std::io::Result<()> {
    let name = c_name(name).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "nul byte")
    })?;
    let result = unsafe { libc::mkdirat(dirfd, name.as_ptr(), 0o755) };
    if result < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn unlink_at(
    dirfd: RawFd,
    name: &OsStr,
    flags: libc::c_int,
) -> std::io::Result<()> {
    let name = c_name(name).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "nul byte")
    })?;
    let result = unsafe { libc::unlinkat(dirfd, name.as_ptr(), flags) };
    if result < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
