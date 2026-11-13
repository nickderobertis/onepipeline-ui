// One prototype, applied to the checkout in the current directory on top of
// apply-measurement.mjs: `node <this> <name>`. A treatment demonstration is
// the session head plus one commit carrying apply-measurement.mjs --touch-src
// and exactly one of these; its control carries the first alone.
//
//   nx-cache-concurrency  faster tests that prove the same: the nx-cache suite
//                         runs four files at once rather than two (its own
//                         comment measures it as mostly waiting on the nested
//                         Nx and Git processes it starts).
//   pyramid-no-bundle     a pyramid sample: the versions tier stops running
//                         the real packaged-crate journey
//                         ui::a_build_without_the_bundle_refuses_ui_naming_what_is_missing,
//                         standing in for a faked test of the same refusal
//                         (whose own cost is a few milliseconds).
//   pyramid-fake          the pyramid sample with its fakes in place: the
//                         journey leaves the versions tier as above, and in
//                         its place that tier runs a packaging test holding
//                         that the crate tarball carries the frontend sources
//                         and no built view. Beside it the e2e tier already
//                         runs ui::resolve_refuses_ui_for_a_build_that_embedded_nothing,
//                         the refusal driven in-process with no bundle.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

// The fake that stands in for the packaged-crate half of the journey: what
// `cargo package --list` would upload carries the frontend's sources (so a
// build from it is this crate) and nothing under apps/dag-ui/dist (so it is a
// build without the bundle). It does not build the tarball.
const TARBALL_FAKE = `
/// The pyramid sample's fake for the no-bundle journey's packaged half: the
/// crate as crates.io serves it carries the view's sources and no built view.
#[test]
fn the_crate_tarball_carries_the_view_sources_and_no_built_view() {
    let packaged = packaged_files();
    assert!(packaged.iter().any(|path| path == "build.rs"), "{packaged:?}");
    assert!(
        packaged.iter().any(|path| path.starts_with("apps/dag-ui/src/")),
        "{packaged:?}"
    );
    let built: Vec<&String> = packaged
        .iter()
        .filter(|path| path.starts_with("apps/dag-ui/dist/"))
        .collect();
    assert!(built.is_empty(), "the crate tarball carries a built view: {built:?}");
}
`;

const name = process.argv[2];
const edit = (file, from, to) => {
  const text = readFileSync(file, "utf8");
  if (!text.includes(from)) {
    console.error(`prototype: ${file} no longer holds ${JSON.stringify(from)}`);
    process.exit(1);
  }
  writeFileSync(file, text.replace(from, to));
};
switch (name) {
  case "nx-cache-concurrency":
    edit(
      ".github/tests/nx-cache/project.json",
      "node --test --test-concurrency=2 .github/tests/nx-cache/*.test.mjs",
      "node --test --test-concurrency=4 .github/tests/nx-cache/*.test.mjs",
    );
    break;
  case "pyramid-no-bundle":
    edit(
      ".config/nextest.toml",
      " or test(=ui::a_build_without_the_bundle_refuses_ui_naming_what_is_missing))) or (binary(=packaging)",
      ")) or (binary(=packaging)",
    );
    break;
  case "pyramid-fake":
    edit(
      ".config/nextest.toml",
      " or test(=ui::a_build_without_the_bundle_refuses_ui_naming_what_is_missing))) or (binary(=packaging) and test(=the_assembled_launcher_pins_every_platform_package_to_the_crate_version))",
      ")) or (binary(=packaging) and (test(=the_assembled_launcher_pins_every_platform_package_to_the_crate_version) or test(=the_crate_tarball_carries_the_view_sources_and_no_built_view)))",
    );
    appendFileSync("tests/packaging.rs", TARBALL_FAKE);
    break;
  default:
    console.error(
      "usage: prototype.mjs nx-cache-concurrency|pyramid-no-bundle|pyramid-fake",
    );
    process.exit(2);
}
console.log(`prototype: applied ${name}`);
