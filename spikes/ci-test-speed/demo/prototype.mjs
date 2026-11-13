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
import { readFileSync, writeFileSync } from "node:fs";

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
  default:
    console.error(
      "usage: prototype.mjs nx-cache-concurrency|pyramid-no-bundle",
    );
    process.exit(2);
}
console.log(`prototype: applied ${name}`);
