// Provision the pinned test tool during bootstrap; the cache journeys stay offline.
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { OP_NX_COMMIT } from "../../../scripts/nx-remote-cache.mjs";
import { run, sidecarCheckout } from "./nx-cache-journey.mjs";

if (process.argv.length !== 2) {
  console.error(
    "setup-sidecar: unexpected arguments\nACTION: run without arguments from the workspace root",
  );
  process.exitCode = 2;
} else {
  try {
    const action = resolve(".tools/op-nx-cache", OP_NX_COMMIT);
    if (!existsSync(join(action, ".git"))) {
      mkdirSync(action, { recursive: true });
      await run("git", [
        "clone",
        "--quiet",
        "https://github.com/op-nx/github-cache.git",
        action,
      ]);
    }
    await run("git", ["checkout", "--quiet", "--force", OP_NX_COMMIT], {
      cwd: action,
    });
    await sidecarCheckout();
    console.log(`Cache journey sidecar provisioned at ${OP_NX_COMMIT}`);
  } catch (error) {
    console.error(
      `setup-sidecar: ${error.message}\nACTION: repair .tools or git/network access and run just nx run github-workflows-nx-cache:bootstrap`,
    );
    process.exitCode = 1;
  }
}
