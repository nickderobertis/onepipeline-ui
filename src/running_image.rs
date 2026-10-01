//! The file an adoption retains as the run's driver: one holding the engine
//! this process is running, whatever has happened to the file it started from.
//!
//! The driver an adoption leaves behind is this executable at its hidden
//! `drive-run` verb, so the run is driven by the engine this server links. The
//! path the process started from is only a name for that engine while it still
//! names it: a package upgrade or a rebuild replaces the file under a running
//! server, after which Linux reports the executable as `PATH (deleted)`, a name
//! nothing can be spawned from — and the file now at `PATH` is another build,
//! which must not be retained in this one's place either. The kernel keeps the
//! image this process runs reachable at `/proc/self/exe` for as long as the
//! process lives, so that is what a driver is retained from once the path no
//! longer names it: a private copy of those bytes, which the driver runs and
//! re-executes for each dispatch it gives a process of its own, because that is
//! what its own `current_exe` names.

use std::path::PathBuf;

use crate::error::ApiError;

/// The program a driver retained now runs: this process's own executable.
///
/// # Errors
///
/// An executable this process cannot name, or — once its file has been
/// replaced — a copy of the running image it could not keep, with why.
pub(crate) fn driver_program() -> Result<PathBuf, ApiError> {
    let started = std::env::current_exe().map_err(|error| {
        ApiError::Engine(format!(
            "cannot find this executable to retain a driver: {error}"
        ))
    })?;
    resolve(started)
}

/// A platform whose `current_exe` names the file the process started from
/// rather than its image, and keeps nothing for a replaced one to be copied
/// from: the path is what there is to retain.
#[cfg(not(target_os = "linux"))]
#[allow(
    clippy::unnecessary_wraps,
    reason = "one signature with the Linux reading, which can refuse"
)]
fn resolve(started: PathBuf) -> Result<PathBuf, ApiError> {
    Ok(started)
}

/// The file this process started from while it is still the running image,
/// and a kept copy of the running image once it is not.
#[cfg(target_os = "linux")]
fn resolve(started: PathBuf) -> Result<PathBuf, ApiError> {
    use std::os::unix::fs::MetadataExt;

    let running = std::fs::metadata(RUNNING_IMAGE).map_err(|error| {
        ApiError::Engine(format!(
            "cannot read the image this process runs to retain a driver: {error}"
        ))
    })?;
    // The same inode is the same bytes: an install never edits a running
    // executable in place — the kernel refuses a write to one — it replaces
    // the file, and a replaced file is another inode, or no file at all.
    let unchanged = std::fs::metadata(&started)
        .is_ok_and(|on_disk| on_disk.dev() == running.dev() && on_disk.ino() == running.ino());
    if unchanged {
        return Ok(started);
    }
    keep_a_copy(&running).map_err(|error| {
        ApiError::Engine(format!(
            "the file this server started from has been replaced, and no copy of the \
             engine it runs could be kept to retain a driver: {error}"
        ))
    })
}

/// Where Linux keeps the image a process runs, deleted or not.
#[cfg(target_os = "linux")]
const RUNNING_IMAGE: &str = "/proc/self/exe";

/// The name the copy is kept under, which is what a driver run from it is
/// listed as.
#[cfg(target_os = "linux")]
const KEPT_NAME: &str = "onepipeline-api";

/// A copy of the running image under the per-user cache, made once per image.
///
/// Named for the image it was copied from — its device, inode, size and both
/// timestamps — so every server running that image retains the same copy
/// rather than one each, and an image that differs in any of them is another
/// copy. The copy is written under a temporary name and renamed into place, so
/// a copy that is there is a whole one. It is never removed: a driver retained
/// from it runs from it, and re-executes it for every dispatch, for as long as
/// that driver lives.
#[cfg(target_os = "linux")]
fn keep_a_copy(running: &std::fs::Metadata) -> std::io::Result<PathBuf> {
    use std::os::unix::fs::MetadataExt;

    let image = format!(
        "{}-{}-{}-{}.{}-{}.{}",
        running.dev(),
        running.ino(),
        running.size(),
        running.mtime(),
        running.mtime_nsec(),
        running.ctime(),
        running.ctime_nsec(),
    );
    let dir = drivers_dir().join(image);
    let kept = dir.join(KEPT_NAME);
    if kept.is_file() {
        return Ok(kept);
    }
    std::fs::create_dir_all(&dir)?;
    let writing = dir.join(format!(".{KEPT_NAME}.{}", std::process::id()));
    // `fs::copy` carries the image's own permissions, executable bits included.
    std::fs::copy(RUNNING_IMAGE, &writing)?;
    std::fs::rename(&writing, &kept)?;
    Ok(kept)
}

/// The directory kept copies live under: `$XDG_CACHE_HOME`, else `~/.cache`,
/// else the system's temporary directory.
#[cfg(target_os = "linux")]
fn drivers_dir() -> PathBuf {
    let absolute = |variable: &str| {
        std::env::var_os(variable)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    };
    absolute("XDG_CACHE_HOME")
        .or_else(|| absolute("HOME").map(|home| home.join(".cache")))
        .unwrap_or_else(std::env::temp_dir)
        .join("onepipeline-api")
        .join("drivers")
}
