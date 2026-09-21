//! The browser view served beside the read API: `serve --ui`.
//!
//! What the consumer's same-origin proxy did, the binary now does, and these
//! journeys hold it to that split over a real port: the view's own files at
//! their paths, its `index.html` at every path the bundle has no file for, and
//! the API's prefixes answered exactly as they are without the flag — by the
//! API, never by a page. The bundle compared against is the one on disk that
//! `build.rs` embedded, so a build that embedded a stale or a partial bundle
//! fails here rather than in a browser.

use std::fs;
use std::path::{Path, PathBuf};

use assert_cmd::Command;
use predicates::str::contains;
use serde_json::Value;

use crate::fixture_run;
use crate::http;
use crate::serving::Serving;

/// Where `build.rs` reads the bundle from, which is where `dag-ui:build` writes
/// it — the one directory `scripts/npm-build.mjs ui` publishes too.
fn bundle_on_disk() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("apps/dag-ui/dist")
}

/// The bundle this build embedded, read back off disk to compare the served
/// bytes against.
///
/// The journeys over the embedded view need the tree to have built it before
/// the binary was compiled — `onepipeline-ui:test` depends on `dag-ui:build`
/// for exactly this — and say so rather than passing over a binary that
/// embedded nothing.
fn built_bundle() -> PathBuf {
    let bundle = bundle_on_disk();
    assert!(
        bundle.join("index.html").is_file(),
        "no built browser view at {} — run `just build` (Nx's `dag-ui:build`) before the crate's \
         tests, so the binary under test carries the view",
        bundle.display()
    );
    bundle
}

/// The path of the first stylesheet and the first script `index.html` names,
/// each as a browser would ask for it: absolute, under `/assets/`.
fn assets_named_by(index: &str) -> Vec<String> {
    index
        .split('"')
        .filter(|value| value.starts_with("/assets/"))
        .map(str::to_owned)
        .collect()
}

fn a_run_served_with(arguments: &[&str]) -> Serving {
    Serving::start_with_args(
        |root| {
            fixture_run::write(root, fixture_run::RUN_ID);
        },
        arguments,
    )
}

#[test]
fn with_ui_the_root_answers_the_bundles_index_and_its_assets_answer_their_bytes() {
    let bundle = built_bundle();
    let index = fs::read(bundle.join("index.html")).expect("read the built index");
    let serving = a_run_served_with(&["--ui"]);

    let root = http::get_raw(serving.address, "/");
    assert_eq!(root.status, 200);
    assert_eq!(
        root.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(root.body, index, "GET / is not the bundle's index.html");
    // Revalidated on every load, since it names the hashes of the current build.
    assert_eq!(root.header("cache-control"), Some("no-cache"));
    // The index names its assets absolutely, so a deep link at any path finds them.
    let assets = assets_named_by(&String::from_utf8_lossy(&index));
    assert!(
        assets.iter().any(|asset| asset.ends_with(".js"))
            && assets.iter().any(|asset| asset.ends_with(".css")),
        "the built index names no script and stylesheet under /assets/: {assets:?}"
    );
    for asset in assets {
        let on_disk = fs::read(bundle.join(asset.trim_start_matches('/')))
            .unwrap_or_else(|err| panic!("the index names {asset}, which the bundle lacks: {err}"));
        let served = http::get_raw(serving.address, &asset);
        assert_eq!(served.status, 200, "{asset}");
        assert_eq!(served.body, on_disk, "{asset} is not served byte for byte");
        let expected_type = if asset.ends_with(".js") {
            "text/javascript; charset=utf-8"
        } else {
            "text/css; charset=utf-8"
        };
        assert_eq!(
            served.header("content-type"),
            Some(expected_type),
            "{asset}"
        );
        // Hashed by content, so a browser may keep it for as long as it likes.
        assert_eq!(
            served.header("cache-control"),
            Some("public, max-age=31536000, immutable"),
            "{asset}"
        );
    }
}

/// The app is a single-page one: a path it owns is a route, not a file, and
/// opens as the index rather than as a 404.
#[test]
fn with_ui_a_deep_link_the_bundle_has_no_file_for_answers_the_index() {
    let bundle = built_bundle();
    let index = fs::read(bundle.join("index.html")).expect("read the built index");
    let serving = a_run_served_with(&["--ui"]);
    for path in [
        &format!("/?list=runs&run={}&view=graph", fixture_run::RUN_ID),
        "/observatory/runs/some-run",
        "/assets/",
        "/index.html",
        // A path that merely begins with the API's letters is the view's.
        "/apix",
        "/healthzz",
    ] {
        let served = http::get_raw(serving.address, path);
        assert_eq!(served.status, 200, "{path}");
        assert_eq!(
            served.header("content-type"),
            Some("text/html; charset=utf-8"),
            "{path}"
        );
        assert_eq!(served.body, index, "{path} is not answered with index.html");
    }
}

/// `observed_at` is the instant of the read; everything else the API answers
/// is the same with the view beside it as without.
fn without_observed_at(mut body: Value) -> Value {
    if let Some(object) = body.as_object_mut() {
        object.remove("observed_at");
    }
    body
}

#[test]
fn with_ui_the_api_answers_exactly_what_it_answers_without_it() {
    built_bundle();
    let with = a_run_served_with(&["--ui"]);
    let without = a_run_served_with(&[]);
    for path in [
        "/healthz",
        "/api/v2/runs",
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
        "/api/v2/projects",
        // And a path the API has no route for, under its own prefix, is the
        // error contract on both — never a page.
        "/api/v2/no-such-route",
        "/api",
        "/api/",
        "/api/v2/runs/no-such-run",
    ] {
        let a = http::get(with.address, path);
        let b = http::get(without.address, path);
        assert_eq!(a.status, b.status, "{path}");
        assert_eq!(
            without_observed_at(a.json()),
            without_observed_at(b.json()),
            "{path} differs with --ui"
        );
    }
    let refused = http::get_raw(with.address, "/api/v2/no-such-route");
    assert_eq!(refused.status, 404);
    assert!(
        refused
            .header("content-type")
            .is_some_and(|value| value.starts_with("application/json")),
        "{:?}",
        refused.header("content-type")
    );
}

/// Off by default: a caller that asked for the read API alone gets the read API
/// alone, and `/` is what it has always been.
#[test]
fn without_ui_the_root_is_the_error_contracts_404_as_before() {
    let serving = a_run_served_with(&[]);
    for path in ["/", "/index.html", "/assets/anything.js"] {
        let response = http::get(serving.address, path);
        assert_eq!(response.status, 404, "{path}");
        assert_eq!(response.json()["error"]["code"], "no_such_route", "{path}");
    }
}

/// A view on disk in place of the built-in one.
fn a_view_on_disk() -> tempfile::TempDir {
    let dist = tempfile::tempdir().expect("temp dir");
    fs::write(
        dist.path().join("index.html"),
        "<!doctype html><title>another release</title>",
    )
    .expect("write the index");
    fs::create_dir(dist.path().join("assets")).expect("assets dir");
    fs::write(
        dist.path().join("assets/app-1234.js"),
        "console.log('on disk')",
    )
    .expect("write the script");
    fs::write(dist.path().join("favicon.svg"), "<svg/>").expect("write the icon");
    dist
}

#[test]
fn ui_dist_serves_the_directory_named_in_place_of_the_embedded_bundle() {
    let dist = a_view_on_disk();
    let dir = dist.path().to_str().expect("utf-8 path");
    let serving = a_run_served_with(&["--ui", "--ui-dist", dir]);

    let root = http::get_raw(serving.address, "/");
    assert_eq!(root.status, 200);
    assert_eq!(
        root.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(root.body, b"<!doctype html><title>another release</title>");

    let script = http::get_raw(serving.address, "/assets/app-1234.js");
    assert_eq!(script.status, 200);
    assert_eq!(
        script.header("content-type"),
        Some("text/javascript; charset=utf-8")
    );
    assert_eq!(script.body, b"console.log('on disk')");
    let icon = http::get_raw(serving.address, "/favicon.svg");
    assert_eq!(icon.header("content-type"), Some("image/svg+xml"));
    assert_eq!(icon.body, b"<svg/>");

    // A deep link is the index here too.
    let deep = http::get_raw(serving.address, "/runs/deep/link?view=graph");
    assert_eq!(deep.body, root.body);
    // And the API is still the API.
    assert_eq!(
        http::get(serving.address, "/healthz").json()["status"],
        "ok"
    );
    assert_eq!(http::get(serving.address, "/api/v2/nope").status, 404);

    // A rebuild reaches the browser without a restart: the directory is read
    // per request.
    fs::write(
        dist.path().join("index.html"),
        "<!doctype html><title>rebuilt</title>",
    )
    .expect("rewrite the index");
    assert_eq!(
        http::get_raw(serving.address, "/").body,
        b"<!doctype html><title>rebuilt</title>"
    );
}

/// A request cannot climb out of the directory it was told to serve: a path
/// with a `..` in it, or one that is not a plain file under it, is the index.
#[test]
fn ui_dist_never_serves_a_file_outside_the_directory() {
    let dist = a_view_on_disk();
    let outside = dist.path().join("../secret-beside-the-view.txt");
    fs::write(&outside, "not for serving").expect("write the file beside the view");
    let dir = dist.path().to_str().expect("utf-8 path");
    let serving = a_run_served_with(&["--ui", "--ui-dist", dir]);
    let index = http::get_raw(serving.address, "/").body;
    for path in [
        "/../secret-beside-the-view.txt",
        "/assets/../../secret-beside-the-view.txt",
        "/./assets/app-1234.js",
        "/assets//app-1234.js",
        "/assets",
    ] {
        let served = http::get_raw(serving.address, path);
        assert_eq!(served.status, 200, "{path}");
        assert_eq!(
            served.body, index,
            "{path} was answered with something other than the index"
        );
    }
    fs::remove_file(outside).expect("remove the file beside the view");
}

/// The directory is checked once, at the command line, and read per request
/// after that — so its index can go while the server is up, and what a reader
/// meets then is said rather than drawn.
///
/// A rebuild is when it happens: Vite empties `dist` before it writes it, so a
/// browser loading the view across a `just build` asks for an index that is not
/// there for a moment. A blank `200` would be a page a reader reloads forever;
/// this says what is wrong, and the reader's next request — after the build —
/// is the rebuilt view. The API beside it never stops answering: the view's
/// trouble is the view's.
#[test]
fn a_view_whose_index_goes_while_it_is_served_says_so_and_recovers() {
    let dist = a_view_on_disk();
    let dir = dist.path().to_str().expect("utf-8 path");
    let serving = a_run_served_with(&["--ui", "--ui-dist", dir]);
    assert_eq!(http::get_raw(serving.address, "/").status, 200);

    fs::remove_file(dist.path().join("index.html")).expect("take the index away");
    for path in ["/", "/assets/gone-1234.js", "/runs/deep/link"] {
        let served = http::get_raw(serving.address, path);
        assert_eq!(served.status, 500, "{path}");
        assert_eq!(
            served.header("content-type"),
            Some("text/plain; charset=utf-8"),
            "{path}"
        );
        assert_eq!(
            String::from_utf8_lossy(&served.body),
            "the browser view has no index.html to serve",
            "{path}"
        );
    }
    // A file the bundle still has is still its own bytes: only the fallback is
    // gone, and only the paths that need it are refused.
    let script = http::get_raw(serving.address, "/assets/app-1234.js");
    assert_eq!(script.status, 200);
    assert_eq!(script.body, b"console.log('on disk')");
    // And the API never noticed.
    assert_eq!(
        http::get(serving.address, "/healthz").json()["status"],
        "ok"
    );

    fs::write(
        dist.path().join("index.html"),
        "<!doctype html><title>rebuilt</title>",
    )
    .expect("the rebuild finishes");
    let recovered = http::get_raw(serving.address, "/runs/deep/link");
    assert_eq!(recovered.status, 200);
    assert_eq!(recovered.body, b"<!doctype html><title>rebuilt</title>");
}

fn cli() -> Command {
    Command::cargo_bin("onepipeline-api").expect("the binary is built")
}

#[test]
fn serve_help_documents_the_view_flags() {
    cli()
        .args(["serve", "--help"])
        .assert()
        .success()
        .stdout(contains("--ui"))
        .stdout(contains("--ui-dist <DIR>"))
        .stdout(contains("browser view"));
}

#[test]
fn a_ui_dist_with_no_index_is_a_usage_error_that_names_it() {
    let runs = tempfile::tempdir().expect("temp dir");
    let empty = tempfile::tempdir().expect("temp dir");
    cli()
        .args(["serve", "--runs-root"])
        .arg(runs.path())
        .arg("--ui")
        .arg("--ui-dist")
        .arg(empty.path())
        .assert()
        .code(2)
        .stderr(contains(format!(
            "{} holds no built browser view: it has no index.html",
            empty.path().display()
        )));
    cli()
        .args(["serve", "--runs-root"])
        .arg(runs.path())
        .args(["--ui", "--ui-dist", "/no/such/view"])
        .assert()
        .code(2)
        .stderr(contains("/no/such/view holds no built browser view"));
}

/// `--ui-dist` qualifies `--ui`; on its own it names a view nothing would serve.
#[test]
fn ui_dist_without_ui_is_a_usage_error() {
    let runs = tempfile::tempdir().expect("temp dir");
    let dist = a_view_on_disk();
    cli()
        .args(["serve", "--runs-root"])
        .arg(runs.path())
        .arg("--ui-dist")
        .arg(dist.path())
        .assert()
        .code(2)
        .stderr(contains("--ui-dist"))
        .stderr(contains("--ui"));
}

/// Where the build of this crate from its own packaged tree goes: under this
/// clone's `target`, so the dependencies it compiles once are reused by every
/// later run, and never beside another clone's.
fn no_bundle_target() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("target/no-bundle")
}

/// Build `onepipeline-api` the way `cargo install onepipeline-ui` from
/// crates.io does, and answer the binary: out of the crate tarball `cargo
/// package` makes — which carries the view's sources and never its build — with
/// no `bundled-ui` feature.
///
/// The tarball is the tree a crates.io install compiles, so a build of it is the
/// one real way to a binary that embedded nothing: `apps/dag-ui/dist` is not in
/// it however recently this checkout built the view. That absence is asserted
/// rather than assumed, since a widened `include` would otherwise turn this
/// into a second build of the bundled binary that proves nothing.
fn a_build_without_the_bundle() -> PathBuf {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
    let target = no_bundle_target();
    let crate_dir = format!("{}-{}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));
    let packages = target.join("package");
    let tree = packages.join(&crate_dir);
    // A build of a tree is its own: whatever the suite's own compile was told
    // — coverage instrumentation above all — is not what a host installing the
    // crate compiles it with, and the target directory is this one alone.
    let cargo_in = |dir: &Path| {
        let mut command = std::process::Command::new(&cargo);
        command.current_dir(dir);
        for variable in [
            "RUSTFLAGS",
            "CARGO_ENCODED_RUSTFLAGS",
            "CARGO_BUILD_RUSTFLAGS",
            "RUSTC_WRAPPER",
            "RUSTC_WORKSPACE_WRAPPER",
            "CARGO_TARGET_DIR",
            "CARGO_BUILD_TARGET_DIR",
            "LLVM_PROFILE_FILE",
        ] {
            command.env_remove(variable);
        }
        command
    };
    let run = |mut command: std::process::Command, what: &str| {
        let output = command
            .output()
            .unwrap_or_else(|err| panic!("{what} could not start: {err}"));
        assert!(
            output.status.success(),
            "{what} failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };

    // `--offline` and `--locked` as `tests/packaging.rs` lists the same
    // tarball; `--no-verify` because the build below is the verification, run
    // where its binary can be found.
    let mut package = cargo_in(Path::new(env!("CARGO_MANIFEST_DIR")));
    package
        .args([
            "package",
            "--no-verify",
            "--offline",
            "--locked",
            "--allow-dirty",
            "--target-dir",
        ])
        .arg(&target);
    run(package, "cargo package");

    // Unpacked afresh at one stable path, so the build below reuses its own
    // last compile rather than starting over under a new name. Relative paths
    // throughout, which every platform's `tar` reads the same way.
    if tree.exists() {
        fs::remove_dir_all(&tree).expect("clear the last unpacked tree");
    }
    let mut unpack = std::process::Command::new("tar");
    unpack
        .current_dir(&packages)
        .args(["-xzf", &format!("{crate_dir}.crate")]);
    run(unpack, "tar");
    assert!(
        tree.join("build.rs").is_file() && tree.join("apps/dag-ui/src").is_dir(),
        "the unpacked crate is not this crate's tree: {}",
        tree.display()
    );
    assert!(
        !tree.join("apps/dag-ui/dist").exists(),
        "the crate tarball carries a built view, so a build of it is not a build without one"
    );

    let mut build = cargo_in(&tree);
    build
        .args([
            "build",
            "--offline",
            "--locked",
            "--bin",
            "onepipeline-api",
            "--target-dir",
        ])
        .arg(&target);
    run(build, "cargo build of the packaged crate");
    target
        .join("debug")
        .join(format!("onepipeline-api{}", std::env::consts::EXE_SUFFIX))
}

/// A binary built without the bundle refuses `--ui` naming what is missing —
/// exit `70`, before it takes a port — and is otherwise a whole server: the API
/// alone without the flag, and a view from `--ui-dist` with it.
///
/// Driven through a real build of the crate as crates.io serves it, since that
/// is the one way a host ends up with such a binary; every other journey here
/// runs the binary this suite built beside a built view, which embedded it.
#[test]
fn a_build_without_the_bundle_refuses_ui_naming_what_is_missing() {
    let binary = a_build_without_the_bundle();
    let (_workspace, runs) = fixture_run::workspace();
    fixture_run::write(&runs, fixture_run::RUN_ID);

    Command::new(&binary)
        .args(["serve", "--runs-root"])
        .arg(&runs)
        .args(["--bind", "127.0.0.1:0", "--ui"])
        .env_remove(onepipeline_ui::cli::SESSION_ENV)
        // A binary that did not refuse would serve until killed; this bound
        // turns that into a failed assertion rather than a hung suite.
        .timeout(std::time::Duration::from_secs(30))
        .assert()
        .code(i32::from(onepipeline_ui::cli::EXIT_SOFTWARE))
        .stdout("")
        .stderr(contains(
            "this build carries no browser view: it was built without the bundle at \
             apps/dag-ui/dist",
        ))
        .stderr(contains(
            "ACTION: serve a built view with --ui-dist DIR, or install a prebuilt \
             onepipeline-api of this release",
        ));

    // Without the flag it is the read API, as every build is.
    let api = Serving::start_binary_with_args(
        &binary,
        |root| {
            fixture_run::write(root, fixture_run::RUN_ID);
        },
        &[],
    );
    let health = http::get(api.address, "/healthz");
    assert_eq!(health.status, 200, "{}", health.body);
    let run = http::get(
        api.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    );
    assert_eq!(run.status, 200, "{}", run.body);
    assert!(run.body.contains(fixture_run::RUN_ID), "{}", run.body);
    drop(api);

    // And a view on disk is served whatever the build carries.
    let dist = a_view_on_disk();
    let dist_arg = dist.path().to_str().expect("a UTF-8 temp path");
    let viewed = Serving::start_binary_with_args(
        &binary,
        |root| {
            fixture_run::write(root, fixture_run::RUN_ID);
        },
        &["--ui", "--ui-dist", dist_arg],
    );
    let page = http::get_raw(viewed.address, "/");
    assert_eq!(page.status, 200);
    assert_eq!(page.body, b"<!doctype html><title>another release</title>");
}

/// The decision the journey above drives through a real bundle-less binary,
/// held in this process as well: [`onepipeline_ui::ui::View::resolve`] given
/// what such a build's `EMBEDDED` is, `None`. The journey's binary is compiled
/// apart from this suite and so is not coverage-instrumented; this is what
/// counts the refusal's lines, and it pins the precedence around it — no view
/// unless asked, `--ui-dist` over whatever the build carries, and this build's
/// own embedded bundle for `--ui` alone.
#[test]
fn resolve_refuses_ui_for_a_build_that_embedded_nothing() {
    use onepipeline_ui::ui::{UiDist, View};
    let refusal = View::resolve(true, None, None).expect_err("refused");
    assert!(
        refusal.contains("built without the bundle at apps/dag-ui/dist"),
        "{refusal}"
    );
    assert!(refusal.contains("prebuilt distributions"), "{refusal}");
    assert!(refusal.contains("just build"), "{refusal}");
    // Not asked for a view, it does not matter what the build carries.
    assert!(View::resolve(false, None, None)
        .expect("no view asked for")
        .is_none());
    // And a directory on disk serves whatever the build carries.
    let dist = a_view_on_disk();
    let on_disk = UiDist::try_from(dist.path().to_path_buf()).expect("a built view");
    match View::resolve(true, Some(&on_disk), None).expect("a view") {
        Some(View::Directory(served)) => assert_eq!(served, on_disk),
        other => panic!("not the directory named: {other:?}"),
    }
    // This build does carry one, and that is what `--ui` alone serves.
    match View::resolve(true, None, onepipeline_ui::ui::EMBEDDED).expect("a view") {
        Some(View::Embedded(files)) => assert!(files.iter().any(|file| file.path == "index.html")),
        other => panic!("not the embedded bundle: {other:?}"),
    }
}

/// A configuration file is the other way into the same arguments: it carries
/// the view flags on the same terms, and leaves them out when they are off so a
/// consumer reading the shape before them reads what it always read.
#[test]
fn a_config_file_carries_the_view_flags_and_omits_them_when_off() {
    use onepipeline_ui::cli::ServeArgs;
    let runs = tempfile::tempdir().expect("temp dir");
    let dist = a_view_on_disk();
    let root = serde_json::to_string(runs.path()).expect("encode the root");
    let view = serde_json::to_string(dist.path()).expect("encode the view");

    let plain: ServeArgs =
        serde_json::from_str(&format!(r#"{{"runs_root":{root}}}"#)).expect("parse config");
    assert!(!plain.ui);
    assert!(plain.ui_dist.is_none());
    let encoded = serde_json::to_string(&plain).expect("serialize");
    assert!(!encoded.contains("\"ui\""), "{encoded}");

    let with: ServeArgs = serde_json::from_str(&format!(
        r#"{{"runs_root":{root},"ui":true,"ui_dist":{view}}}"#
    ))
    .expect("parse config");
    assert!(with.ui);
    assert_eq!(
        with.ui_dist.as_ref().map(|dist| dist.as_path()),
        Some(dist.path())
    );
    let encoded = serde_json::to_string(&with).expect("serialize");
    assert!(encoded.contains(r#""ui":true"#), "{encoded}");
    assert!(
        encoded.contains(&format!(r#""ui_dist":{view}"#)),
        "{encoded}"
    );

    let err = serde_json::from_str::<ServeArgs>(&format!(
        r#"{{"runs_root":{root},"ui":true,"ui_dist":"/no/such/view"}}"#
    ))
    .expect_err("rejected");
    assert!(
        err.to_string().contains("holds no built browser view"),
        "{err}"
    );
}
