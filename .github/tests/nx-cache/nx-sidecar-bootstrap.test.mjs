import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { OP_NX_COMMIT } from "../../../scripts/nx-remote-cache.mjs";
import { sidecarCheckout } from "./nx-cache-journey.mjs";

test("bootstrap provisions and repairs the real pinned tool through local Git, and refuses bad usage", async () => {
  const source = await sidecarCheckout();
  const cwd = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(),
      "sidecar-setup-",
    ),
  );
  const script = resolve(".github/tests/nx-cache/setup-sidecar.mjs");
  // Git itself rewrites the transport to the tool bootstrap already installed.
  // Every clone/checkout is real; this test makes no external-service request.
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${pathToFileURL(source).href}.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/op-nx/github-cache.git",
  };
  const cli = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
  try {
    const usage = cli("--unknown");
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /ACTION: run without arguments/);
    writeFileSync(join(cwd, ".tools"), "a file blocks tool provisioning");
    const blocked = cli();
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /setup-sidecar:.*(?:ENOTDIR|EEXIST)/);
    assert.match(blocked.stderr, /ACTION:/);
    rmSync(join(cwd, ".tools"));
    const installed = cli();
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const action = await sidecarCheckout(cwd);
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: action,
        encoding: "utf8",
      }).trim(),
      OP_NX_COMMIT,
    );
    execFileSync("git", ["checkout", "--quiet", "HEAD^"], { cwd: action });
    await assert.rejects(sidecarCheckout(cwd), /ACTION: run just nx run/);
    writeFileSync(join(action, "start-cache-server/index.js"), "modified tool");
    const repaired = cli();
    assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
    assert.equal(await sidecarCheckout(cwd), action);
    assert.deepEqual(
      readFileSync(join(action, "start-cache-server/index.js")),
      readFileSync(join(source, "start-cache-server/index.js")),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
