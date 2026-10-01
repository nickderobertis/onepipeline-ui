//! The file an adoption retains as the run's driver: one holding the engine
//! this process is running, whatever happens to the file it started from.
//!
//! The driver an adoption leaves behind is this executable at its hidden
//! `drive-run` verb, so the run is driven by the engine this server links. The
//! path the process started from is only a name for that engine, and a package
//! upgrade or a rebuild replaces the file at that name under a running server —
//! after which Linux reports the executable as `PATH (deleted)`, a name nothing
//! can be spawned from, and the file now at `PATH` is another build. A path
//! checked and then handed to the engine is not enough either: the engine
//! resolves it again when it starts the driver, after ending the run's parked
//! driver, and an upgrade landing between the two would start the new build.
//!
//! So on Linux the engine is never handed the path. It is handed a name under
//! the per-user cache that only this crate writes, and that name is proved to
//! be the running image before it is handed over: a hard link of the started
//! file whose inode *is* the running image's, or — when the file was replaced,
//! or cannot be linked there — a copy of the image the kernel keeps at
//! `/proc/self/exe` for as long as the process lives. Whatever is installed at
//! the path afterwards cannot reach that name. The driver runs from it, and
//! re-executes it for each dispatch it gives a process of its own, because that
//! is what its own `current_exe` names.

use std::path::PathBuf;

use crate::error::ApiError;

/// The program a driver retained now runs: this process's own executable.
///
/// # Errors
///
/// An executable this process cannot name, or a name for its running image it
/// could not keep, with why.
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

/// A kept name for the running image, proved to be it.
#[cfg(target_os = "linux")]
fn resolve(started: PathBuf) -> Result<PathBuf, ApiError> {
    linux::kept(&started).map_err(|error| {
        let replaced = std::fs::metadata(&started).is_err();
        ApiError::Engine(if replaced {
            format!(
                "the file this server started from has been replaced, and no copy of the \
                 engine it runs could be kept to retain a driver: {error}"
            )
        } else {
            format!(
                "no name for the engine this server runs could be kept to retain a driver: {error}"
            )
        })
    })
}

#[cfg(target_os = "linux")]
mod linux {
    use std::fs::{self, File, Metadata};
    use std::io::{self, Read};
    use std::os::unix::fs::MetadataExt;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    /// Where Linux keeps the image a process runs, deleted or not.
    const RUNNING_IMAGE: &str = "/proc/self/exe";

    /// The name the image is kept under, which is what a driver run from it is
    /// listed as.
    const KEPT_NAME: &str = "onepipeline-api";

    /// The kept name this process last proved, and the inode it proved, so a
    /// later adoption re-proves nothing while that name still holds that inode.
    static PROVED: Mutex<Option<(PathBuf, u64, u64)>> = Mutex::new(None);

    /// A name under the cache that holds the running image, reused while it
    /// still does.
    pub(super) fn kept(started: &Path) -> io::Result<PathBuf> {
        let mut proved = PROVED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((path, dev, ino)) = proved.as_ref() {
            if fs::metadata(path).is_ok_and(|kept| kept.dev() == *dev && kept.ino() == *ino) {
                return Ok(path.clone());
            }
        }
        let running = fs::metadata(RUNNING_IMAGE)?;
        let path = keep(started, &running)?;
        let kept = fs::metadata(&path)?;
        *proved = Some((path.clone(), kept.dev(), kept.ino()));
        Ok(path)
    }

    /// Prove an existing kept name for `running`, or make one.
    ///
    /// Named for the image — its device, inode, size and modification time — so
    /// every server running that image shares one name rather than one each. A
    /// name already there is used only once it is proved: a hard link by being
    /// the running inode, a copy by holding the running image's bytes. One that
    /// is neither — an inode number reused since that copy was made — is left to
    /// whatever driver runs from it, and this image is kept beside it.
    fn keep(started: &Path, running: &Metadata) -> io::Result<PathBuf> {
        let identity = format!(
            "{}-{}-{}-{}.{}",
            running.dev(),
            running.ino(),
            running.size(),
            running.mtime(),
            running.mtime_nsec(),
        );
        let drivers = drivers_dir();
        let existing = drivers.join(&identity).join(KEPT_NAME);
        if holds_running_image(&existing, running)? {
            return Ok(existing);
        }
        let dir = if existing.exists() {
            drivers.join(format!("{identity}.{}", std::process::id()))
        } else {
            drivers.join(&identity)
        };
        fs::create_dir_all(&dir)?;
        let kept = dir.join(KEPT_NAME);
        let writing = dir.join(format!(".{KEPT_NAME}.{}", std::process::id()));
        let _ = fs::remove_file(&writing);
        // A link is free where the cache shares the started file's filesystem,
        // and is kept only if it is the running inode: an upgrade that replaced
        // the path before the link was made has linked the new build, which is
        // dropped here, never handed on.
        let linked = fs::hard_link(started, &writing).is_ok()
            && fs::metadata(&writing).is_ok_and(|link| is_inode(&link, running));
        if !linked {
            let _ = fs::remove_file(&writing);
            // `fs::copy` carries the image's own permissions, executable bits
            // included.
            fs::copy(RUNNING_IMAGE, &writing)?;
        }
        // Renamed into place, so a name that is there is a whole one.
        fs::rename(&writing, &kept)?;
        Ok(kept)
    }

    /// Whether `path` holds the running image: is its inode, or a copy of it.
    fn holds_running_image(path: &Path, running: &Metadata) -> io::Result<bool> {
        let Ok(kept) = fs::metadata(path) else {
            return Ok(false);
        };
        if is_inode(&kept, running) {
            return Ok(true);
        }
        if kept.len() != running.len() {
            return Ok(false);
        }
        same_bytes(File::open(path)?, File::open(RUNNING_IMAGE)?)
    }

    fn is_inode(file: &Metadata, running: &Metadata) -> bool {
        file.dev() == running.dev() && file.ino() == running.ino()
    }

    /// Whether two readers hold the same bytes, read a block at a time.
    fn same_bytes(mut left: File, mut right: File) -> io::Result<bool> {
        let mut left_block = vec![0; 1 << 20];
        let mut right_block = vec![0; 1 << 20];
        loop {
            let read = fill(&mut left, &mut left_block)?;
            if fill(&mut right, &mut right_block)? != read
                || left_block[..read] != right_block[..read]
            {
                return Ok(false);
            }
            if read == 0 {
                return Ok(true);
            }
        }
    }

    /// Read until `block` is full or the file ends, answering how much was read.
    fn fill(file: &mut File, block: &mut [u8]) -> io::Result<usize> {
        let mut filled = 0;
        while filled < block.len() {
            match file.read(&mut block[filled..])? {
                0 => break,
                read => filled += read,
            }
        }
        Ok(filled)
    }

    /// The directory kept images live under: `$XDG_CACHE_HOME`, else
    /// `~/.cache`, else the system's temporary directory.
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
}
