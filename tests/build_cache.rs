//! The browser bundle cache against real Nx and Vite builds.
//! Kept behind dag-ui-build-cache:test, a project that depends on nothing in
//! the crate, so only a change to what these builds read runs them.

#![cfg(unix)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tempfile::TempDir;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// Build the real app in an isolated checkout, warm its cache, then change the
/// model it imports. Replaying the old bundle would reject the server's new
/// timeline schema even though both source trees agreed on it.
#[test]
fn changing_the_imported_model_invalidates_the_browser_bundle_cache() {
    use std::os::unix::fs::symlink;

    let fixture = TempDir::new().expect("isolated workspace");
    let root = fixture.path();
    let tracked = Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(repo_root())
        .output()
        .expect("tracked workspace files");
    assert!(tracked.status.success(), "{}", stderr(&tracked));
    for name in tracked
        .stdout
        .split(|byte| *byte == 0)
        .filter(|s| !s.is_empty())
    {
        let relative = Path::new(std::str::from_utf8(name).expect("UTF-8 path"));
        let source = repo_root().join(relative);
        if source.is_file() {
            let target = root.join(relative);
            fs::create_dir_all(target.parent().expect("parent")).expect("directory");
            fs::copy(source, target).expect("copy tracked file");
        }
    }
    // Share installed tools, but resolve workspace imports to this checkout's
    // own sources so the model edit below reaches the actual Vite build.
    let modules = root.join("node_modules");
    fs::create_dir(&modules).expect("modules");
    for entry in fs::read_dir(repo_root().join("node_modules")).expect("installed tools") {
        let entry = entry.expect("tool");
        if entry.file_name() != "@onepipeline-ui" {
            symlink(entry.path(), modules.join(entry.file_name())).expect("installed tool link");
        }
    }
    let scope = modules.join("@onepipeline-ui");
    fs::create_dir(&scope).expect("workspace scope");
    for entry in
        fs::read_dir(repo_root().join("node_modules/@onepipeline-ui")).expect("workspace packages")
    {
        let entry = entry.expect("package");
        let source = fs::canonicalize(entry.path()).expect("workspace source");
        let relative = source.strip_prefix(repo_root()).expect("local package");
        symlink(root.join(relative), scope.join(entry.file_name())).expect("workspace link");
    }
    symlink(
        repo_root().join("apps/dag-ui/node_modules"),
        root.join("apps/dag-ui/node_modules"),
    )
    .expect("app's installed build tools");
    let build = || {
        let output = Command::new("just")
            .args(["nx", "run", "dag-ui:build"])
            .env("NX_DAEMON", "false")
            .env_remove("NX_SKIP_NX_CACHE")
            .current_dir(root)
            .output()
            .expect("build app");
        assert!(
            output.status.success(),
            "build failed: {}{}",
            stderr(&output),
            String::from_utf8_lossy(&output.stdout)
        );
        String::from_utf8(output.stdout).expect("build output")
    };
    let bundle = || fs::read(root.join("apps/dag-ui/dist/index.html")).expect("bundle index");
    let cold = build();
    assert!(!cold.contains("[local cache]"), "{cold}");
    let before = bundle();
    let warm = build();
    assert!(warm.contains("[local cache]"), "{warm}");
    assert_eq!(bundle(), before, "cached build changes no bytes");
    let model = root.join("packages/dag-model/src/index.ts");
    let source = fs::read_to_string(&model).expect("model");
    let schema = onepipeline_ui::contract::TIMELINE_SCHEMA_VERSION;
    let changed = source.replace(
        &format!("export const TIMELINE_SCHEMA_VERSION = {schema};"),
        &format!("export const TIMELINE_SCHEMA_VERSION = {};", schema + 1),
    );
    assert_ne!(source, changed, "changed the model's schema");
    fs::write(model, changed).expect("new model schema");
    let rebuilt = build();
    assert!(!rebuilt.contains("[local cache]"), "{rebuilt}");
    assert_ne!(bundle(), before, "new model changes the shipped bundle");
}
