//! A real repository a lifecycle node's session can be cut in, seeded inside a
//! served workspace and registered in that workspace's own `onevcs` state root.
//!
//! Every other journey keeps that state root empty, so nothing it serves can
//! touch the registry of the host running it — and so no journey could let the
//! engine cut a real session either: a node's task naming a `repo` nobody
//! registered is refused before any branch exists. This seeds one inside the
//! workspace and registers it *there*, through the linked `onevcs`'s own
//! registration, so a session the engine opens is cut by that library over real
//! git and nothing of this host's own is read or written.

#![allow(dead_code)] // Each test binary uses the part of the harness it needs.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use crate::serving::{ONEVCS_HOME_DIR, ONEVCS_HOME_ENV};

/// The variable git reads its per-user config from.
pub const GIT_CONFIG_ENV: &str = "GIT_CONFIG_GLOBAL";

/// The branch the seeded repository publishes onto.
pub const BASE_BRANCH: &str = "main";

/// Where under a workspace the repository and what it needs are seeded.
const SCRATCH_DIR: &str = "scratch-repo";

/// A seeded, registered repository.
pub struct ScratchRepo {
    /// The name the plan's task addresses it by: the registered checkout's alias.
    pub alias: String,
    /// The git config every git call against it reads instead of this host's, and
    /// which a server driving a session in it is handed too: a host config that
    /// signs commits or installs hooks would otherwise decide what the engine's
    /// own git calls do.
    pub gitconfig: PathBuf,
}

/// Serialises the registrations: `onevcs` reads its state root and git its config
/// off process-global variables, so two journeys registering at once would each
/// write into whichever workspace set them last.
static POINTING: Mutex<()> = Mutex::new(());

/// Seed a bare origin and a checkout of it under `workspace`, publishing onto
/// [`BASE_BRANCH`] straight from the checkout, and register the checkout in the
/// workspace's own `onevcs` state root.
///
/// The rules file written beside the registry says the one thing a lifecycle
/// needs of this host: publish straight onto the base, so a session that gets as
/// far as publishing pushes to the bare origin on this disk and never asks a
/// forge for anything.
pub fn seed(workspace: &Path) -> ScratchRepo {
    let scratch = workspace.join(SCRATCH_DIR);
    let origin = scratch.join("origin.git");
    let checkout = scratch.join("service");
    let home = workspace.join(ONEVCS_HOME_DIR);
    for dir in [&origin, &home] {
        std::fs::create_dir_all(dir).expect("a scratch directory");
    }
    let gitconfig = scratch.join("gitconfig");
    std::fs::write(
        &gitconfig,
        "[user]\n\tname = onepipeline-ui journeys\n\temail = journeys@onepipeline-ui.invalid\n\
         [init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
    )
    .expect("the scratch git config");

    git(
        &gitconfig,
        &origin,
        &["init", "--bare", "--initial-branch", BASE_BRANCH],
    );
    git(
        &gitconfig,
        &scratch,
        &["clone", &origin.to_string_lossy(), "service"],
    );
    std::fs::write(
        checkout.join("README.md"),
        "the repository a session is cut in\n",
    )
    .expect("the seed file");
    git(&gitconfig, &checkout, &["add", "-A"]);
    git(
        &gitconfig,
        &checkout,
        &["commit", "-m", "chore: seed the repository"],
    );
    git(
        &gitconfig,
        &checkout,
        &["push", "-u", "origin", BASE_BRANCH],
    );

    std::fs::write(
        home.join("rules.yml"),
        "version: 3\nrules: []\ndefault:\n  publication: local-direct\n  approvals: none\n",
    )
    .expect("the rules file");

    let registration = {
        let _held = POINTING.lock().unwrap_or_else(|held| held.into_inner());
        let before = [ONEVCS_HOME_ENV, GIT_CONFIG_ENV].map(|name| (name, std::env::var_os(name)));
        std::env::set_var(ONEVCS_HOME_ENV, &home);
        std::env::set_var(GIT_CONFIG_ENV, &gitconfig);
        let registered = onevcs::register_checkout(&checkout, None);
        for (name, value) in before {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        registered
    }
    .unwrap_or_else(|refused| {
        panic!(
            "onevcs refused to register {}: {refused}",
            checkout.display()
        )
    });
    ScratchRepo {
        alias: registration.alias,
        gitconfig,
    }
}

/// Run git in `dir` under `gitconfig`, failing the journey on a refusal.
fn git(gitconfig: &Path, dir: &Path, args: &[&str]) {
    let ran = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env(GIT_CONFIG_ENV, gitconfig)
        .output()
        .expect("git runs");
    assert!(
        ran.status.success(),
        "git {args:?} in {} failed: {}",
        dir.display(),
        String::from_utf8_lossy(&ran.stderr)
    );
}
