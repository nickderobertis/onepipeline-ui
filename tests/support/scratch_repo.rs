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

/// The variable `onevcs` reads the program it runs in place of `gh` from. That
/// library declares it in a module it does not export, so it is named here.
pub const GH_ENV: &str = "ONEVCS_GH";

/// The branch the seeded repository publishes onto.
pub const BASE_BRANCH: &str = "main";

/// Where under a workspace the repository and what it needs are seeded.
const SCRATCH_DIR: &str = "scratch-repo";

/// A seeded, registered repository.
pub struct ScratchRepo {
    /// The name the plan's task addresses it by: the registered checkout's alias.
    pub alias: String,
    /// The bare origin the checkout publishes to, which a kept branch is put on.
    pub origin: PathBuf,
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
    let gitconfig = scratch_gitconfig(workspace);
    std::fs::write(
        home_of(workspace).join("rules.yml"),
        "version: 3\nrules: []\ndefault:\n  publication: local-direct\n  approvals: none\n",
    )
    .expect("the rules file");
    seed_one(workspace, &gitconfig, "service", None)
}

/// The two repositories a publication-boundary journey spans, both of one
/// synthetic owner: `service`, which the host's rules declare **private**, and
/// `library`, which they declare **public**.
pub struct BoundaryRepos {
    /// `github.com/owner/service`, private.
    pub private: ScratchRepo,
    /// `github.com/owner/library`, public.
    pub public: ScratchRepo,
    /// The program `onevcs` runs in place of `gh`, which refuses everything: what
    /// either side is is the rules file's statement, so nothing here asks GitHub
    /// and a server driving sessions in them is handed this too.
    pub refusing_gh: PathBuf,
}

/// The private repository's alias, and the name its synthetic identity carries.
pub const PRIVATE_ALIAS: &str = "service";
/// The public repository's alias, and the name its synthetic identity carries.
pub const PUBLIC_ALIAS: &str = "library";

/// Seed [`BoundaryRepos`] under `workspace`, each registered in the workspace's
/// own `onevcs` state root against a hosted identity of the synthetic owner
/// `owner`, so the linked `onevcs` resolves which side each is on.
///
/// The visibility of each is the operator's statement — a version-4 rules file's
/// `visibility:`, written before either is registered — because the host's own
/// answer is a GitHub read no journey may make; [`BoundaryRepos::refusing_gh`]
/// holds that for anything that would ask anyway. Each identity names its host
/// and nothing else: the clone a session cuts takes its remote from the
/// checkout, which points at the bare origin on this disk, so every fetch and
/// push stays here.
#[cfg(unix)]
pub fn seed_boundary(workspace: &Path) -> BoundaryRepos {
    use std::os::unix::fs::PermissionsExt;

    let gitconfig = scratch_gitconfig(workspace);
    let refusing_gh = workspace.join(SCRATCH_DIR).join("refusing-gh");
    std::fs::write(
        &refusing_gh,
        "#!/bin/sh\necho 'no forge is asked anything here' >&2\nexit 1\n",
    )
    .expect("the refusing gh stand-in");
    std::fs::set_permissions(&refusing_gh, std::fs::Permissions::from_mode(0o700))
        .expect("chmod the refusing gh stand-in");
    std::fs::write(
        home_of(workspace).join("rules.yml"),
        format!(
            "version: 4\nrules:\n  - match: {{owner: owner, name: {PUBLIC_ALIAS}}}\n    \
             visibility: public\n  - match: {{owner: owner}}\n    visibility: private\n\
             default:\n  publication: local-direct\n  approvals: none\n"
        ),
    )
    .expect("the rules file");
    let hosted = |alias: &str| {
        onevcs::Url::parse(&format!("https://github.com/owner/{alias}.git"))
            .expect("a hosted identity")
    };
    let private = seed_one(
        workspace,
        &gitconfig,
        PRIVATE_ALIAS,
        Some((&hosted(PRIVATE_ALIAS), &refusing_gh)),
    );
    let public = seed_one(
        workspace,
        &gitconfig,
        PUBLIC_ALIAS,
        Some((&hosted(PUBLIC_ALIAS), &refusing_gh)),
    );
    BoundaryRepos {
        private,
        public,
        refusing_gh,
    }
}

/// The workspace's own `onevcs` state root, created.
fn home_of(workspace: &Path) -> PathBuf {
    let home = workspace.join(ONEVCS_HOME_DIR);
    std::fs::create_dir_all(&home).expect("the onevcs state root");
    home
}

/// The git config every scratch repository of `workspace` is driven under.
fn scratch_gitconfig(workspace: &Path) -> PathBuf {
    let scratch = workspace.join(SCRATCH_DIR);
    std::fs::create_dir_all(&scratch).expect("a scratch directory");
    let gitconfig = scratch.join("gitconfig");
    std::fs::write(
        &gitconfig,
        "[user]\n\tname = onepipeline-ui journeys\n\temail = journeys@onepipeline-ui.invalid\n\
         [init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
    )
    .expect("the scratch git config");
    gitconfig
}

/// Seed one bare origin and a checkout of it named `alias` under `workspace`,
/// and register the checkout — against `hosted`'s identity, with `onevcs`
/// running its program in place of `gh`, where one is given.
fn seed_one(
    workspace: &Path,
    gitconfig: &Path,
    alias: &str,
    hosted: Option<(&onevcs::Url, &Path)>,
) -> ScratchRepo {
    let scratch = workspace.join(SCRATCH_DIR);
    // `seed`'s single origin keeps the name every journey before the boundary's
    // already reads; a second repository's is its own.
    let origin = if hosted.is_none() {
        scratch.join("origin.git")
    } else {
        scratch.join(format!("{alias}.git"))
    };
    let checkout = scratch.join(alias);
    std::fs::create_dir_all(&origin).expect("a scratch directory");
    git(
        gitconfig,
        &origin,
        &["init", "--bare", "--initial-branch", BASE_BRANCH],
    );
    git(
        gitconfig,
        &scratch,
        &["clone", &origin.to_string_lossy(), alias],
    );
    std::fs::write(
        checkout.join("README.md"),
        "the repository a session is cut in\n",
    )
    .expect("the seed file");
    git(gitconfig, &checkout, &["add", "-A"]);
    git(
        gitconfig,
        &checkout,
        &["commit", "-m", "chore: seed the repository"],
    );
    git(gitconfig, &checkout, &["push", "-u", "origin", BASE_BRANCH]);

    let home = home_of(workspace);
    let registration = {
        let _held = POINTING.lock().unwrap_or_else(|held| held.into_inner());
        let before =
            [ONEVCS_HOME_ENV, GIT_CONFIG_ENV, GH_ENV].map(|name| (name, std::env::var_os(name)));
        std::env::set_var(ONEVCS_HOME_ENV, &home);
        std::env::set_var(GIT_CONFIG_ENV, gitconfig);
        if let Some((_, gh)) = hosted {
            std::env::set_var(GH_ENV, gh);
        }
        let registered = onevcs::register_checkout(&checkout, hosted.map(|(url, _)| url));
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
        origin,
        gitconfig: gitconfig.to_path_buf(),
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
