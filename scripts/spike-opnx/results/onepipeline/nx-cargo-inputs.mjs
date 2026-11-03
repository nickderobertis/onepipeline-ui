#!/usr/bin/env node
// An Nx `runtime` input: a digest of Cargo.toml and Cargo.lock with this
// workspace's own package versions left out — the only lines release-plz's
// version bump edits there — so a release pull request leaves every task keyed
// on them unchanged, while any other edit (a dependency's requirement in
// Cargo.toml, a third-party version or checksum in Cargo.lock) still moves it.
//
//   node scripts/nx-cargo-inputs.mjs            the version-blind digest
//   node scripts/nx-cargo-inputs.mjs --version  the root package's version alone,
//                                               for a target whose tests read it
//
// Dropped: the `version` key of the root manifest's `[package]` table, and the
// `version` of every Cargo.lock `[[package]]` entry with no `source` (a path
// package, i.e. a workspace member; each member's own manifest is a file input
// elsewhere). Line endings are normalised so the digest is one value on every
// platform. Node only, so it runs alike under cmd.exe, pwsh, Git Bash and sh.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) =>
  readFileSync(join(root, name), "utf8").replace(/\r\n/g, "\n");

function manifestWithoutVersion(text) {
  let table = "";
  let version = null;
  const kept = [];
  for (const line of text.split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(#.*)?$/);
    if (header) table = header[1].trim();
    const own =
      table === "package" && line.match(/^\s*version\s*=\s*"([^"]*)"/);
    if (own) {
      version = own[1];
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), version };
}

function lockWithoutMemberVersions(text) {
  // Entries are separated by blank lines; a member has no `source = ` line.
  return text
    .split(/\n(?=\[\[package\]\]\n)/)
    .map((entry) =>
      entry.startsWith("[[package]]\n") && !/^source = /m.test(entry)
        ? entry.replace(/^version = ".*"\n/m, "")
        : entry,
    )
    .join("\n");
}

const manifest = manifestWithoutVersion(read("Cargo.toml"));
if (process.argv.includes("--version")) {
  if (!manifest.version) {
    console.error(
      "nx-cargo-inputs: Cargo.toml's [package] declares no version",
    );
    process.exit(1);
  }
  process.stdout.write(`${manifest.version}\n`);
} else {
  const hash = createHash("sha256");
  hash.update("Cargo.toml\0").update(manifest.text).update("\0");
  hash
    .update("Cargo.lock\0")
    .update(lockWithoutMemberVersions(read("Cargo.lock")));
  process.stdout.write(`${hash.digest("hex")}\n`);
}
