// The rehearsal's staged files, as the journeys that read them name them.
// ./journeys.test.mjs runs the rehearsal — the build-linux recipe in its dry-run
// mode — and stages its files under OUT; ./rehearsal-failures.test.mjs and
// ./registries.test.mjs read them afterwards, both at once in a target that
// depends on it, so neither waits behind the other.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { plan } from "../../scripts/release.mjs";
import { ROOT, version } from "./support.mjs";

export const VERSION = version();
export const TAG = `v${VERSION}`;
export const TARGET = "x86_64-unknown-linux-gnu";
// Inside the checkout: the manylinux container mounts only that.
export const OUT = join(ROOT, "target/release-journey/linux");
export const linuxPlan = plan("linux");
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const staged = (artifact) =>
  join(
    OUT,
    {
      archive: "assets",
      checksum: "assets",
      wheel: "wheels",
      npm: "npm-artifacts",
    }[artifact.kind],
    artifact.file,
  );
export const fileOf = (kind) =>
  linuxPlan.artifacts.find((a) => a.kind === kind);

// A journey over the staged files says so when there are none, rather than
// failing on whichever file it happened to read first.
export function requireRehearsal() {
  assert.ok(
    existsSync(join(OUT, "assets")),
    "the rehearsal (onepipeline-ui-release:rehearse) staged the Linux build",
  );
}
