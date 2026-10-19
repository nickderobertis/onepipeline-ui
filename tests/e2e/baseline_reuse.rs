//! Baseline provisioning through real Cargo, with a local dependency whose
//! build script records compilation and a library and binary identifying their
//! source tree. No compiler, recipe, or provisioning call is substituted.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

use tempfile::TempDir;

const MARKER: &str = "which-tree.txt";
const AT_THE_BASE: &str = "the base commit's tree\n";
const ON_THE_BRANCH: &str = "the branch's tree\n";
const BUILT_STEM: &str = "onepipeline-api";

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn provisioned() -> String {
    format!("onepipeline-api-baseline{}", std::env::consts::EXE_SUFFIX)
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// A real Cargo dependency records its builds. Like this crate, the fixture
/// has a library and binary; both must carry the base tree while dependencies
/// stay shared with the branch. No compiler or provisioning call is replaced.
#[test]
fn the_base_is_built_from_the_units_this_clone_already_compiled() {
    let work = TempDir::new().expect("real Cargo journey");
    let root = work.path().join("checkout");
    let dependency = work.path().join("dependency");
    for directory in [
        root.join("src"),
        root.join("scripts"),
        dependency.join("src"),
    ] {
        fs::create_dir_all(directory).expect("fixture sources");
    }
    for name in [
        "justfile",
        "rust-toolchain.toml",
        "scripts/ensure-baseline-api.sh",
    ] {
        fs::copy(repo_root().join(name), root.join(name)).expect("real provisioning interface");
    }
    fs::write(root.join(".gitattributes"), format!("{MARKER} -text\n"))
        .expect("preserve the marker's bytes");
    let dependency_path = serde_json::to_string(dependency.to_str().expect("UTF-8 fixture path"))
        .expect("encode the dependency path for TOML");
    fs::write(
        root.join("Cargo.toml"),
        format!(
            r#"[package]
name = "onepipeline-ui"
version = "0.0.0"
edition = "2021"

[[bin]]
name = "onepipeline-api"
path = "src/main.rs"

[dependencies]
reuse-probe = {{ path = {dependency_path} }}
"#
        ),
    )
    .expect("the fixture manifest");
    fs::write(
        dependency.join("Cargo.toml"),
        "[package]\nname = \"reuse-probe\"\nversion = \"0.0.0\"\nedition = \"2021\"\n",
    )
    .expect("the dependency manifest");
    fs::write(
        dependency.join("build.rs"),
        r#"use std::{env, fs::OpenOptions, io::Write};
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=REUSE_BUILD_LOG");
    let mut log = OpenOptions::new().create(true).append(true)
        .open(env::var_os("REUSE_BUILD_LOG").unwrap()).unwrap();
    writeln!(log, "compiled").unwrap();
}
"#,
    )
    .expect("a real dependency build observer");
    let library = "pub fn ready() -> &'static str { \"ready\" }\n";
    fs::write(dependency.join("src/lib.rs"), library).expect("the dependency");
    fs::write(
        root.join("src/lib.rs"),
        r#"pub fn source_tree() -> &'static str { include_str!("../which-tree.txt") }
"#,
    )
    .expect("a library that identifies its source tree");
    fs::write(
        root.join("src/main.rs"),
        r#"fn main() {
    assert_eq!(reuse_probe::ready(), "ready");
    assert_eq!(onepipeline_ui::source_tree(), include_str!("../which-tree.txt"), "library and binary must use the same source tree");
    print!("{}", onepipeline_ui::source_tree());
}
"#,
    )
    .expect("a binary that identifies its source tree");
    let log = work.path().join("dependency-builds");
    let command = |program: &str| {
        let mut command = Command::new(program);
        command
            .current_dir(&root)
            .env("REUSE_BUILD_LOG", &log)
            .env("CARGO_INCREMENTAL", "0");
        for name in [
            "CARGO_TARGET_DIR",
            "CARGO_ENCODED_RUSTFLAGS",
            "RUSTFLAGS",
            "RUSTC_WRAPPER",
            "RUSTC_WORKSPACE_WRAPPER",
        ] {
            command.env_remove(name);
        }
        command
    };
    let successful = |command: &mut Command| {
        let output = command.output().expect("run a real fixture command");
        assert!(output.status.success(), "{}", stderr(&output));
        output
    };
    successful(command("cargo").args(["generate-lockfile", "--offline"]));
    successful(command("git").args(["init", "--initial-branch=main", "--quiet"]));
    successful(command("git").args(["config", "user.email", "suite@example.invalid"]));
    successful(command("git").args(["config", "user.name", "the suite"]));
    fs::write(root.join(MARKER), AT_THE_BASE).expect("base source");
    successful(command("git").args(["add", "-A"]));
    successful(command("git").args(["commit", "--quiet", "-m", "the base"]));
    successful(command("git").args(["checkout", "--quiet", "-b", "a-branch"]));
    fs::write(root.join(MARKER), ON_THE_BRANCH).expect("branch source");
    successful(command("git").args(["add", "-A"]));
    successful(command("git").args(["commit", "--quiet", "-m", "the branch"]));
    successful(command("cargo").args(["build", "--offline", "--locked", "--quiet"]));
    let branch_binary = root
        .join("target/debug")
        .join(format!("{BUILT_STEM}{}", std::env::consts::EXE_SUFFIX));
    let baseline = root.join(".tools/bin").join(provisioned());
    successful(command("just").arg("_ensure-baseline"));
    assert_eq!(
        fs::read_to_string(&log).expect("dependency build record"),
        "compiled\n",
        "provisioning recompiled the dependency the branch already built"
    );
    for (binary, expected) in [(&baseline, AT_THE_BASE), (&branch_binary, ON_THE_BRANCH)] {
        assert_eq!(
            successful(&mut Command::new(binary)).stdout,
            expected.as_bytes(),
            "{} did not run the expected source tree",
            binary.display()
        );
    }

    // A changed dependency must still be rebuilt, and a failed build must leave
    // no stamp claiming the old executable is the requested baseline.
    let stamp = baseline.with_file_name(format!("{}.commit", provisioned()));
    fs::remove_file(&stamp).expect("request fresh provisioning");
    fs::write(
        dependency.join("src/lib.rs"),
        "compile_error!(\"the dependency cannot build\");\n",
    )
    .expect("a broken dependency");
    let refused = command("just")
        .arg("_ensure-baseline")
        .output()
        .expect("provision");
    assert!(!refused.status.success());
    assert!(
        stderr(&refused).contains("the dependency cannot build"),
        "{}",
        stderr(&refused)
    );
    assert!(!stamp.exists());
    fs::write(dependency.join("src/lib.rs"), library).expect("repair the dependency");
    successful(command("just").arg("_ensure-baseline"));
    assert!(stamp.exists());
    assert_eq!(
        successful(&mut Command::new(&baseline)).stdout,
        AT_THE_BASE.as_bytes()
    );
}
