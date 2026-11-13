#!/usr/bin/env node
import { execFileSync } from "node:child_process";
// The digest a coverage tier's Nx key hashes for "every tracked file its run can
// read": the whole checkout, less the manifests and changelogs the version-free
// inputs already digest, less the paths that group of tiers cannot read. Reads
// are covered unless they are listed here, and `coverage-units.test.mjs` fails
// naming any listed path a journey can reach.
//
// A runtime input rather than Nx file inputs: Nx selects affected projects from a
// target's file inputs, and these files are read by a compile or a journey without
// being what decides which tier a change is for.
//
//   node scripts/coverage-tier-key.mjs base|no-machinery|no-ci-scripts [--list]
//
// Prints one sha256, or with --list the covered paths, one per line. Exit 2 on
// usage; exit 1 with an ACTION on git or read failures, since a key computed from a
// partial listing would serve a stale result.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

// Directories and files a tier's run never opens. `docs/contract.md` stays in.
const NEVER_READ = [
  /^docs\/(dag-ui|engine-dependency-history|graph-edge-capture-regression|human-items|linux-cold-cache-timing|release-sweep-timing)\.md$/,
  /^docs\/screens\//,
];
const NOT_READ_BY_THE_PRODUCT_TIERS = [
  /^\.github\/(fixtures|tests|reporting|scripts)\//,
  /^tests\/release\//,
  /^tests\/tiers\//,
  /^pool-maintenance\//,
  /^judged-diff\//,
];
const NOT_READ_BY_THE_SERVER_TIERS = [
  /^\.github\/workflows\//,
  /^scripts\/(actions-budget-figures\.|actions-cache-prune\.|ci-compile-env\.sh$|ci-job|ci-tier\.sh$|ci-warm\.sh$|deps-audit\.mjs$|ensure-baseline-api\.sh$|gate-time|measure-cold-linux|nx-affected\.sh$|nx-remote-cache\.|nx\.sh$|publish-npm\.sh$|release-probe\.sh$|release-status\.sh$|retry-install\.sh$|semver-check\.sh$|session-setup\.sh$|setup-llmlint\.sh$|smoke-published\.sh$|verify-staged-release\.mjs$|visual-capture\.sh$|workspace-install\.sh$)/,
];
const GROUPS = {
  base: NEVER_READ,
  "no-machinery": [...NEVER_READ, ...NOT_READ_BY_THE_PRODUCT_TIERS],
  "no-ci-scripts": [
    ...NEVER_READ,
    ...NOT_READ_BY_THE_PRODUCT_TIERS,
    ...NOT_READ_BY_THE_SERVER_TIERS,
  ],
};
// Reach the key through their version-free digests, or not at all for a changelog.
const DIGESTED =
  /^(Cargo\.toml|Cargo\.lock|package\.json|bun\.lock|package-lock\.json|pnpm-lock\.yaml|pyproject\.toml|uv\.lock|CHANGELOG.*)$/;

const [group, ...rest] = process.argv.slice(2);
const list = rest[0] === "--list" && rest.length === 1;
if (!Object.hasOwn(GROUPS, group ?? "") || (rest.length > 0 && !list)) {
  console.error(
    "usage: node scripts/coverage-tier-key.mjs base|no-machinery|no-ci-scripts [--list]",
  );
  process.exit(2);
}
const fail = (what, error) => {
  console.error(
    `coverage-tier-key: ${what}: ${error.message}\nACTION: run this from the repository root of a checkout whose tracked files git can read`,
  );
  process.exit(1);
};
const excluded = GROUPS[group];
let listing;
try {
  listing = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
} catch (error) {
  fail("git ls-files failed", error);
}
const covered = listing
  .split("\0")
  .filter(
    (path) =>
      path &&
      !DIGESTED.test(basename(path)) &&
      !excluded.some((pattern) => pattern.test(path)),
  )
  .sort();
if (list) {
  process.stdout.write(`${covered.join("\n")}\n`);
} else {
  const digest = createHash("sha256");
  for (const path of covered) {
    digest.update(path);
    digest.update("\0");
    try {
      digest.update(readFileSync(path));
    } catch (error) {
      // A staged-away entry or a symlink to a directory has no bytes, but its state
      // is still part of the key: a file that vanished must not read like an empty one.
      if (error.code !== "ENOENT" && error.code !== "EISDIR")
        fail(`cannot read ${path}`, error);
      digest.update(`\0unreadable:${error.code}`);
    }
    digest.update("\0");
  }
  process.stdout.write(`${digest.digest("hex")}\n`);
}
