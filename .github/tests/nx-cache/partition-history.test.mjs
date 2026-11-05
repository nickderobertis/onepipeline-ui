import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertPartition } from "./partition.mjs";

const config = readFileSync(
  new URL("../../../.config/nextest.toml", import.meta.url),
  "utf8",
);
const versions = `mod cli { #[test] fn version_reports_the_crate_version() {} }
mod server { #[test] fn browser_supervision_is_removed_and_shutdown_is_host_only() {} }
mod ui { #[test] fn a_build_without_the_bundle_refuses_ui_naming_what_is_missing() {} }
#[test] fn ordinary() {}`;

for (const history of ["base advanced", "base merged", "branch adds test"]) {
  test(`partition survives ${history} and rejects added and dropped selections`, () => {
    const cwd = mkdtempSync(
      join(
        process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(),
        "partition-history-",
      ),
    );
    const git = (...args) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const commit = (message) => {
      git("add", ".");
      git("commit", "-m", message);
    };
    const tierPath = join(cwd, ".config/nextest.toml");
    try {
      git("init", "--initial-branch=main");
      git("config", "user.name", "Partition journey");
      git("config", "user.email", "partition@example.test");
      mkdirSync(join(cwd, ".config"));
      mkdirSync(join(cwd, "tests"));
      writeFileSync(
        join(cwd, "Cargo.toml"),
        '[package]\nname = "partition-journey"\nversion = "0.1.0"\nedition = "2024"\n',
      );
      writeFileSync(
        join(cwd, "Cargo.lock"),
        'version = 4\n[[package]]\nname = "partition-journey"\nversion = "0.1.0"\n',
      );
      writeFileSync(join(cwd, ".gitignore"), "/target/\n");
      writeFileSync(
        tierPath,
        history === "branch adds test"
          ? config
          : config.replace("|nx_worker_startup", ""),
      );
      writeFileSync(join(cwd, "tests/e2e.rs"), versions);
      writeFileSync(
        join(cwd, "tests/packaging.rs"),
        "#[test] fn the_assembled_launcher_pins_every_platform_package_to_the_crate_version() {}\n",
      );
      commit("original split");
      git("checkout", "-b", "feature");
      writeFileSync(join(cwd, "feature"), "independent branch edit\n");
      commit("branch edit");
      if (history !== "branch adds test") git("checkout", "main");
      writeFileSync(tierPath, config);
      writeFileSync(
        join(cwd, "tests/e2e.rs"),
        `${versions}\nmod nx_worker_startup { #[test] fn delayed_worker() {} }\n`,
      );
      commit("add worker tier journey");
      git("update-ref", "refs/remotes/origin/main", git("rev-parse", "main"));
      if (history !== "branch adds test") {
        git("checkout", "feature");
        if (history === "base merged")
          git("merge", "--no-ff", "main", "-m", "merge base into branch");
      }
      if (history === "base advanced") {
        git("checkout", "main");
        git("merge", "--no-ff", "feature", "-m", "synthetic PR merge");
      }
      assertPartition(cwd);

      // Pull a test from a tier outside the original selection into this split.
      writeFileSync(
        join(cwd, "tests/e2e.rs"),
        `${versions}\nmod packaging { #[test] fn launcher() {} }\n`,
      );
      writeFileSync(
        tierPath,
        config.replace("|packaging|release_probe", "|release_probe"),
      );
      commit("incorrectly add launcher to split");
      assert.throws(() => assertPartition(cwd), /packaging::launcher/);
      writeFileSync(join(cwd, "tests/e2e.rs"), versions);
      writeFileSync(
        tierPath,
        config
          .replace("|nx_worker_startup", "|ordinary|nx_worker_startup")
          .replace(
            "and not (test(=cli::",
            "and not (test(=ordinary) or test(=cli::",
          ),
      );
      commit("incorrectly drop ordinary journey");
      assert.throws(() => assertPartition(cwd), /ordinary/);
      writeFileSync(tierPath, config);
      assertPartition(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
