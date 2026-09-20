//! Embed the built browser view in the binary, so `onepipeline-api serve --ui`
//! serves the DAG Observatory of **this** release from the one artifact a host
//! installs — the binary the crate, the wheels and the npm launcher all wrap —
//! with no npm package beside it.
//!
//! The bundle is `apps/dag-ui/dist`, exactly what `scripts/npm-build.mjs ui`
//! publishes as the `onepipeline-ui` npm package: one build, read by both, so
//! the view a host opens through `--ui` is byte for byte the one that release
//! shipped separately. This writes `$OUT_DIR/embedded_ui.rs`, a table of every
//! file in it as `include_bytes!`, which `src/ui.rs` includes.
//!
//! Two shapes of build, told apart by the `bundled-ui` feature:
//!
//! - **Without it** — `cargo build`, `cargo test`, `cargo install` from
//!   crates.io — the bundle is embedded when it has been built and the table
//!   is `None` when it has not. A binary carrying `None` refuses `--ui` naming
//!   what is missing (`src/ui.rs`) and still serves one from `--ui-dist`. This
//!   is what keeps a `cargo check` or a clippy run from needing a frontend
//!   toolchain.
//! - **With it** — every prebuilt distribution `release.yml` builds — a missing
//!   bundle is a build error rather than a binary that refuses. A release that
//!   stopped building the view before the binary must fail there, not ship an
//!   `--ui` nobody can use; `tests/packaging.rs` holds every job that compiles
//!   the binary to passing the feature after building the bundle.
//!
//! The directory is scanned rather than listed: Vite names its assets by
//! content hash, so any list here would be stale on the next build.

use std::fmt::Write as _;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// Where the built view is, relative to the crate root: Vite's `outDir` in
/// `apps/dag-ui/vite.config.ts`, and the default `scripts/npm-build.mjs ui`
/// packages from. `tests/packaging.rs` holds the three to one another.
const BUNDLE_DIR: &str = "apps/dag-ui/dist";

/// The file every bundle has, and the one every unmatched path is answered
/// with: a directory without it is not a built view.
const INDEX: &str = "index.html";

/// The generated file's name under `OUT_DIR`, as `src/ui.rs` includes it.
const GENERATED: &str = "embedded_ui.rs";

fn main() {
    let manifest_dir = PathBuf::from(env("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(env("OUT_DIR"));
    let bundle = manifest_dir.join(BUNDLE_DIR);
    // Cargo re-runs this when anything under the watched path changes, and
    // re-runs it on *every* build while a watched path is missing. So the
    // bundle is watched while it is there — the whole directory is scanned —
    // and its parent, the app itself, while it is not: that is the directory
    // the bundle appears in, it exists on every checkout, and it is small
    // enough (the app's sources and its own installs) that scanning it costs
    // nothing a rebuild on every `cargo build` would not cost a thousand times
    // over.
    let watched = if bundle.is_dir() {
        bundle.clone()
    } else {
        bundle
            .parent()
            .expect("the bundle is under the app")
            .to_path_buf()
    };
    println!("cargo:rerun-if-changed={}", watched.display());
    println!("cargo:rerun-if-changed=build.rs");
    let required = std::env::var_os("CARGO_FEATURE_BUNDLED_UI").is_some();
    // Quiet on both outcomes: a build without the bundle is a binary that
    // refuses `--ui` in its own words at run time, and the recipes here are
    // quiet on success.
    if let Err(refusal) = embed(&bundle, required, &out_dir.join(GENERATED)) {
        eprintln!("{refusal}");
        std::process::exit(1);
    }
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("cargo sets {name} for a build script"))
}

/// Write the table of the bundle at `bundle` to `generated`.
///
/// Answers how many files were embedded, or `None` when there is no bundle to
/// embed and `required` is false — in which case the table written is `None`
/// too, and the binary refuses `--ui` at run time. With `required`, a missing
/// bundle is the error a release build has to stop on, naming the directory and
/// what builds it.
///
/// Public so `tests/e2e/packaging.rs` can drive it over real directories
/// without a cargo invocation around it: the cargo half is the two `env` reads
/// above, and the decision is here.
pub fn embed(bundle: &Path, required: bool, generated: &Path) -> Result<Option<usize>, String> {
    let index = bundle.join(INDEX);
    if !index.is_file() {
        if required {
            return Err(format!(
                "onepipeline-ui: the `bundled-ui` feature is on, but there is no built browser view at {}\n\
                 ACTION: build it first — `just build` — so the binary can carry the view of this release, \
                 or build without the feature for a binary that serves one from --ui-dist only.",
                bundle.display()
            ));
        }
        write(generated, "/// No browser view was built when this binary was.\npub const EMBEDDED: Option<&[EmbeddedFile]> = None;\n")?;
        return Ok(None);
    }
    let mut files = Vec::new();
    collect(bundle, bundle, &mut files)?;
    // Sorted so the generated file — and with it the binary — is the same for
    // the same bundle whatever order the filesystem listed it in.
    files.sort();
    let mut table = String::from(
        "/// Every file of the browser view built beside this binary, by its path under the bundle.\n\
         pub const EMBEDDED: Option<&[EmbeddedFile]> = Some(&[\n",
    );
    for (relative, absolute) in &files {
        // `{:?}` renders each as a Rust string literal with every escape a
        // path needs — backslashes on Windows included.
        writeln!(
            table,
            "    EmbeddedFile {{ path: {relative:?}, bytes: include_bytes!({:?}) }},",
            absolute.display().to_string()
        )
        .expect("writing to a String cannot fail");
    }
    table.push_str("]);\n");
    write(generated, &table)?;
    Ok(Some(files.len()))
}

/// Every file under `dir`, as (path relative to `root` with `/` separators,
/// absolute path).
fn collect(root: &Path, dir: &Path, files: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
    let entries = fs::read_dir(dir)
        .map_err(|err| format!("onepipeline-ui: cannot read {}: {err}", dir.display()))?;
    for entry in entries {
        let path = entry
            .map_err(|err| {
                format!(
                    "onepipeline-ui: cannot read an entry of {}: {err}",
                    dir.display()
                )
            })?
            .path();
        if path.is_dir() {
            collect(root, &path, files)?;
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .expect("a path under the bundle")
            .components()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        files.push((relative, path));
    }
    Ok(())
}

fn write(generated: &Path, table: &str) -> Result<(), String> {
    fs::File::create(generated)
        .and_then(|mut file| file.write_all(table.as_bytes()))
        .map_err(|err| {
            format!(
                "onepipeline-ui: cannot write {}: {err}",
                generated.display()
            )
        })
}
