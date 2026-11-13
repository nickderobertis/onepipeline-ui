// Modularization option A, applied to the checkout in the current directory:
//   node <this>
// moves the four script-only tiers' modules (ci_jobs, judged_tier,
// deps_audit_toolchain, nx_worker_startup) out of the `e2e` test binary into
// a workspace member of their own, `tests/script_journeys`, which depends on
// serde_json, serde-saphyr and tempfile and not on onepipeline-ui, so a change under `src/`
// cannot reach it. Its main.rs reaches the moved files and the support they
// use by #[path], unedited. `deps_audit` stays in `e2e` as well, because its
// own tier runs there. The two Nx-graph helpers nx_worker_startup takes from
// ensure_sibling.rs, which imports the library, are copied with the items
// they need into `view_task_graph.rs`.
//
// It is a compile-and-link prototype: it builds as the split layout would, for
// measuring that layout's cold build. Moving the files' runtime paths and the
// tiers' nextest profiles and Nx projects is not done.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const MOVED = [
  "ci_jobs",
  "judged_tier",
  "deps_audit_toolchain",
  "nx_worker_startup",
];
const HELPERS = [
  "TASKS_THAT_COMPILE_THE_READ_API",
  "COMPILING_TIERS",
  "VIEW_BUILD",
  "repo_root",
  "stderr",
  "view_task_graph",
  "assert_view_task_graph",
  "task_dependencies",
  "reaches",
];
const fail = (what) => {
  console.error(`split-script-journeys: ${what}`);
  process.exit(1);
};
if (existsSync("tests/script_journeys"))
  fail("tests/script_journeys already exists: the split is applied");

// One top-level item of a Rust file, with its doc comment: from the line that
// declares it to the first line closing it at column 0.
const item = (lines, name) => {
  const at = lines.findIndex((l) =>
    new RegExp(`^(pub\\(super\\) )?(const|fn) ${name}\\b`).test(l),
  );
  if (at < 0) fail(`ensure_sibling.rs no longer declares ${name}`);
  let start = at;
  while (start > 0 && lines[start - 1].startsWith("///")) start--;
  const closes = /^(pub\(super\) )?fn /.test(lines[at]) ? /^}$/ : /;$/;
  let end = at;
  while (!closes.test(lines[end])) end++;
  return lines
    .slice(start, end + 1)
    .join("\n")
    .replace(/^pub\(super\) /m, "")
    .replace(
      /^(fn (view_task_graph|assert_view_task_graph)\b)/m,
      "pub(super) $1",
    );
};
const sibling = readFileSync("tests/e2e/ensure_sibling.rs", "utf8").split("\n");
mkdirSync("tests/script_journeys", { recursive: true });
writeFileSync(
  "tests/script_journeys/view_task_graph.rs",
  `//! Copied from tests/e2e/ensure_sibling.rs by split-script-journeys.mjs.
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde_json::Value;
use std::process::{Command, Output};

${HELPERS.map((n) => item(sibling, n)).join("\n\n")}
`,
);

const manifest = readFileSync("Cargo.toml", "utf8");
const edition = /^edition = "(\d+)"/m.exec(manifest)?.[1];
const dep = (name) => {
  const line = new RegExp(`^${name} = .*$`, "m").exec(manifest)?.[0];
  if (!line) fail(`Cargo.toml no longer names ${name}`);
  return line;
};
writeFileSync(
  "tests/script_journeys/Cargo.toml",
  `[package]
name = "onepipeline-ui-script-journeys"
version = "0.0.0"
edition = "${edition}"
publish = false

[[test]]
name = "script-journeys"
path = "main.rs"

[dev-dependencies]
${dep("serde_json")}
${dep("serde-saphyr")}
${dep("tempfile")}
`,
);
writeFileSync(
  "tests/script_journeys/main.rs",
  `//! The script-only journeys, apart from the crate they never call.
${[...MOVED, "deps_audit"].map((m) => `#[path = "../e2e/${m}.rs"]\nmod ${m};`).join("\n")}

#[path = "view_task_graph.rs"]
mod ensure_sibling;
#[path = "../support/stub_bin.rs"]
mod stub_bin;
#[cfg(unix)]
#[path = "../support/workspace_copy.rs"]
mod workspace_copy;
`,
);

if (/^\[workspace\]/m.test(manifest))
  fail("Cargo.toml already declares a workspace");
writeFileSync(
  "Cargo.toml",
  `${manifest.trimEnd()}\n\n[workspace]\nmembers = [".", "tests/script_journeys"]\n`,
);
let main = readFileSync("tests/e2e/main.rs", "utf8");
for (const m of MOVED) {
  if (!main.includes(`\nmod ${m};\n`))
    fail(`tests/e2e/main.rs no longer declares mod ${m}`);
  main = main.replace(`\nmod ${m};\n`, "\n");
}
writeFileSync("tests/e2e/main.rs", main);
console.log(
  `split-script-journeys: moved ${MOVED.join(", ")} into tests/script_journeys`,
);
