// Compare nextest's own listings, rather than interpreting its filter language.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const selected = (listing) =>
  Object.entries(listing["rust-suites"])
    .flatMap(([binary, suite]) =>
      Object.entries(suite.testcases)
        .filter(([, testcase]) => testcase["filter-match"].status === "matches")
        .map(([name]) => `${binary}/${name}`),
    )
    .sort();
test("the split tiers run exactly the tests the original targets ran", () => {
  const scratch = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(), "nx-partition-"),
  );
  const execute = (args) =>
    execFileSync("cargo", ["nextest", ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  try {
    const base = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
      encoding: "utf8",
    }).trim();
    const oldConfig = join(scratch, "base-nextest.toml");
    writeFileSync(
      oldConfig,
      execFileSync("git", ["show", `${base}:.config/nextest.toml`]),
    );
    const metadata = join(scratch, "binaries.json");
    writeFileSync(
      metadata,
      execute([
        "list",
        "--locked",
        "--test",
        "e2e",
        "--test",
        "packaging",
        "--list-type",
        "binaries-only",
        "--message-format",
        "json",
      ]),
    );
    const list = (profile, old = false) =>
      selected(
        JSON.parse(
          execute([
            "list",
            "--binaries-metadata",
            metadata,
            "--profile",
            profile,
            "--message-format",
            "json",
            ...(old ? ["--config-file", oldConfig] : []),
          ]),
        ),
      );
    const before = [...list("e2e", true), ...list("repo-tooling", true)].sort();
    const versions = list("versions");
    assert.equal(versions.length, 4);
    const after = [...list("e2e"), ...list("repo-tooling"), ...versions].sort();
    assert.deepEqual(after, before);
    assert.equal(
      new Set(after).size,
      after.length,
      "the split must not duplicate tests",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
