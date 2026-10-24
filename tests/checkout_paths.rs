//! Every tracked path checks out on Windows without git's long-path support.
//!
//! Git for Windows leaves `core.longpaths` off, and the runners do not turn it
//! on, so a file whose full path reaches `MAX_PATH` fails the checkout with
//! `Filename too long` — and a directory fails earlier, because creating one
//! leaves room for an 8.3 name. The fullest checkouts are not the runner's own
//! but the ones `tests/e2e/semver_check.rs` makes of this tree under a temporary
//! directory: CI run 40113743603 failed there on a recorded history fixture
//! whose path fitted the runner's checkout and not the journey's.

use std::process::Command;

/// `MAX_PATH`, counting the terminating NUL a path never spells.
const MAX_PATH: usize = 260;

/// `CreateDirectoryW`'s limit without the long-path prefix: room is kept for an
/// 8.3 file name inside whatever it creates.
const MAX_DIRECTORY: usize = MAX_PATH - 12;

/// The roots a tracked path is checked out under on Windows, each with the
/// separator that joins it to the path.
///
/// The runner checks this repository out under `D:\a\<repo>\<repo>`. The
/// `semver_check` journeys copy the tracked tree into `history` and check it out
/// again into `release-baseline`, both under a `tempfile` directory in `%TEMP%`;
/// the runner spells `%TEMP%` with the 8.3 `RUNNER~1`, and the long spelling of
/// the same account is taken instead so a runner that stops shortening it still
/// fits.
const ROOTS: &[&str] = &[
    r"D:\a\onepipeline-ui\onepipeline-ui\",
    r"C:\Users\runneradmin\AppData\Local\Temp\.tmpAAAAAA\history\",
    r"C:\Users\runneradmin\AppData\Local\Temp\.tmpAAAAAA\release-baseline\",
];

fn tracked_paths() -> Vec<String> {
    let listed = Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("git is on PATH");
    assert!(
        listed.status.success(),
        "git ls-files failed:\n{}",
        String::from_utf8_lossy(&listed.stderr)
    );
    let listed = String::from_utf8(listed.stdout).expect("the tracked paths are utf-8");
    let paths: Vec<String> = listed
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect();
    assert!(!paths.is_empty(), "this checkout tracks no files");
    paths
}

/// Every way `tracked` is too long under `root`: the file itself, or the
/// directory git creates to hold it — the longest of those it creates on the
/// way. Lengths are counted in UTF-16 units, which is what Windows counts.
fn too_long(root: &str, tracked: &str) -> Vec<String> {
    let windows = |relative: &str| format!("{root}{}", relative.replace('/', r"\"));
    let length = |path: &str| path.encode_utf16().count();
    let mut found = Vec::new();
    let file = windows(tracked);
    if length(&file) >= MAX_PATH {
        found.push(format!("{} characters: {file}", length(&file)));
    }
    if let Some(parent) = tracked.rsplit_once('/').map(|(parent, _)| parent) {
        let directory = windows(parent);
        if length(&directory) >= MAX_DIRECTORY {
            found.push(format!(
                "directory of {} characters: {directory}",
                length(&directory)
            ));
        }
    }
    found
}

#[test]
fn every_tracked_path_checks_out_under_every_windows_root() {
    let refused: Vec<String> = tracked_paths()
        .iter()
        .flat_map(|tracked| ROOTS.iter().flat_map(move |root| too_long(root, tracked)))
        .collect();
    assert!(
        refused.is_empty(),
        "git for Windows cannot create these without core.longpaths; shorten them:\n{}",
        refused.join("\n")
    );
}
