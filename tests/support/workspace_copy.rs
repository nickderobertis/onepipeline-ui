//! A scratch copy of this workspace in a git repository of its own, so a journey
//! can commit a change and ask the real scripts, through the real Nx, what that
//! change selects — `nx_affected`'s selection and `ci_jobs`' four recipes.
//!
//! Nothing is stood in for. The copy is every file this checkout carries —
//! every `project.json`, `nx.json`, the sources whose imports Nx reads edges
//! from — and Nx is the one this workspace installed, borrowed rather than
//! reinstalled. Unix only: the borrowed install is a symlink.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;
use std::process::{Command, Output};

use tempfile::TempDir;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// A scratch copy of this workspace, committed once as the base a change is
/// measured from.
pub struct Workspace {
    pub dir: TempDir,
    /// The commit every change is made on top of.
    pub base: String,
}

impl Workspace {
    pub fn new() -> Self {
        let dir = TempDir::new().expect("temp dir");
        let workspace = dir.path().join("workspace");
        // Every file a checkout of this branch carries, tracked or about to be,
        // read from the working tree so the graph asked about is this tree's.
        let listed = Command::new("git")
            .args([
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ])
            .current_dir(repo_root())
            .output()
            .expect("git is on PATH");
        assert!(listed.status.success(), "git ls-files: {}", stderr(&listed));
        for name in listed.stdout.split(|byte| *byte == 0) {
            let name = std::str::from_utf8(name).expect("a utf-8 path");
            let source = repo_root().join(name);
            // A file deleted in the working tree is still in the index; what the
            // tree does not have, the copy does not need.
            if name.is_empty() || !source.is_file() {
                continue;
            }
            let destination = workspace.join(name);
            fs::create_dir_all(destination.parent().expect("a parent directory"))
                .expect("create the copy's directory");
            fs::copy(&source, &destination)
                .unwrap_or_else(|error| panic!("copy {name} into the scratch workspace: {error}"));
        }
        // The orchestrator, borrowed: `scripts/workspace-install.sh` sees its
        // shim and installs nothing, as it does in a bootstrapped clone.
        symlink(
            repo_root().join("node_modules"),
            workspace.join("node_modules"),
        )
        .expect("borrow the workspace's node_modules");

        let fixture = Self {
            dir,
            base: String::new(),
        };
        fixture.git(&["init", "--quiet"]);
        fixture.git(&["add", "-A"]);
        fixture.git(&["commit", "--quiet", "--no-verify", "-m", "the base"]);
        let base = fixture.git(&["rev-parse", "HEAD"]);
        Self { base, ..fixture }
    }

    pub fn root(&self) -> PathBuf {
        self.dir.path().join("workspace")
    }

    /// Run git in the workspace under a configuration of its own, so nothing
    /// this host signs commits with or hooks into them reaches it.
    pub fn git(&self, arguments: &[&str]) -> String {
        let config = self.dir.path().join("gitconfig");
        if !config.exists() {
            fs::write(
                &config,
                "[user]\n\tname = the suite\n\temail = suite@example.invalid\n\
                 [commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n",
            )
            .expect("the scratch git config");
        }
        let output = Command::new("git")
            .args(arguments)
            .current_dir(self.root())
            .env("GIT_CONFIG_GLOBAL", &config)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("git is on PATH");
        assert!(
            output.status.success(),
            "git {arguments:?}: {}",
            stderr(&output)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    /// Commit an edit to `path` on top of the base: a line appended to a file
    /// that exists, which changes its bytes and nothing it means to a reader that
    /// parses it — a JSON document still parses, a script still runs.
    pub fn change(&self, path: &str) -> &Self {
        let file = self.root().join(path);
        let mut bytes = fs::read(&file).unwrap_or_else(|error| panic!("read {path}: {error}"));
        bytes.push(b'\n');
        fs::write(&file, bytes).unwrap_or_else(|error| panic!("write {path}: {error}"));
        self.git(&["commit", "--quiet", "--no-verify", "-am", "the change"]);
        self
    }
}
