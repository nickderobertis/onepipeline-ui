//! Recording stand-ins on PATH.
//!
//! A gate script that shells out to `llmlint` or `gh` talks across a boundary a
//! test cannot let it reach: one bills a model call per shard and answers
//! differently each time, the other rewrites a real GitHub Release. Standing in
//! for the *program on PATH* is the narrowest place to cut — the script under
//! test is the real one, run the way CI runs it, and the stand-in is what makes
//! what it asked for observable.
//!
//! Installing the program and putting it in front of the real one are one act,
//! so they are one call: a stand-in written into a directory no `PATH` names has
//! substituted nothing, and the search path is what every caller actually needs.
//! That keeps the whole substitution — and the reason a suite is allowed one —
//! at a single site in each suite.

use std::ffi::OsString;
use std::fs;
use std::path::Path;

/// Write `script` into `dir` as an executable program called `name`, and answer
/// with this process's PATH with `dir` in front, so the stand-in outranks
/// whatever real program of that name the machine running the suite happens to
/// have.
pub fn install(dir: &Path, name: &str, script: &str) -> OsString {
    fs::create_dir_all(dir).expect("create the stand-in directory");
    let program = dir.join(name);
    fs::write(&program, script).expect("write the stand-in");
    make_executable(&program);

    let mut entries = vec![dir.to_path_buf()];
    entries.extend(std::env::split_paths(
        &std::env::var_os("PATH").expect("PATH is set"),
    ));
    std::env::join_paths(entries).expect("join PATH")
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("chmod the stand-in");
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {
    // The shell reads the `#!` line to decide a file is a program it can run,
    // so there is no mode bit here to set.
}
