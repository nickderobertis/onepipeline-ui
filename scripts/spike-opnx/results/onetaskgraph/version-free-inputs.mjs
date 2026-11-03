#!/usr/bin/env node
// Spike (ci-release-test-cache / spike-opnx-audit), onetaskgraph: an Nx `runtime` input that
// stands in for every file release-plz + scripts/set-version.sh rewrite, with only the
// workspace's own release version masked. Prints one line per file, `<path> <sha256>` of the
// file with each occurrence of the workspace version V (root Cargo.toml [workspace.package]
// version) replaced by `<V>` -- but only in the contexts that carry the workspace's own version:
//   * a manifest's own `version = "V"` / `"version": "V"` line,
//   * a sibling pin naming one of this workspace's packages (onetaskgraph*, @onetaskgraph/*),
//   * Cargo.lock / uv.lock package blocks with no registry source (the workspace's own members),
//   * the SDKs' `__version__ = "V"` and `export const VERSION = "V";`.
// A version that disagrees with V stays literal, so a half-applied bump still moves the hash,
// and the shape of V (digits replaced by N) is printed, so a change of format moves it too.
// Pure node, no shell: runs the same under bash, Git Bash and pwsh on Linux, macOS and Windows.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p) =>
  readFileSync(join(root, p), "utf8").replaceAll("\r\n", "\n");
const workspaceManifest = read("Cargo.toml");
const section = workspaceManifest.split(/^\[workspace\.package\]$/m)[1] ?? "";
const V = (section.match(/^version = "([^"]+)"$/m) ?? [])[1];
if (!V) {
  console.error(
    "version-free-inputs: no [workspace.package] version in Cargo.toml",
  );
  process.exit(1);
}
const esc = V.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sub = (line) => line.replaceAll(V, "<V>");

const lineRules = [
  new RegExp(`^\\s*version\\s*=\\s*"${esc}"\\s*$`), // TOML own version
  new RegExp(`^\\s*"version"\\s*:\\s*"${esc}",?\\s*$`), // JSON own version
  new RegExp(`^\\s*onetaskgraph[\\w-]*\\s*=.*"=?${esc}"`), // Cargo sibling pin
  new RegExp(`^\\s*"@onetaskgraph/[\\w-]+"\\s*:\\s*"${esc}",?\\s*$`), // npm sibling pin
  new RegExp(`"onetaskgraph[\\w-]*==${esc}"`), // PEP 508 sibling pin
  new RegExp(`^__version__ = "${esc}"$`),
  new RegExp(`^export const VERSION = "${esc}";$`),
];

function normalizeLines(text) {
  return text
    .split("\n")
    .map((line) => (lineRules.some((r) => r.test(line)) ? sub(line) : line))
    .join("\n");
}

// Lockfiles: a [[package]] block is the workspace's own when it names no registry source.
function normalizeLock(text, own) {
  return text
    .split(/(?=^\[\[package\]\]$)/m)
    .map((block) => {
      if (!block.startsWith("[[package]]") || !own(block)) return block;
      return block.replace(
        new RegExp(`^version = "${esc}"$`, "m"),
        'version = "<V>"',
      );
    })
    .join("");
}
const cargoOwn = (b) => !/^source = /m.test(b);
const uvOwn = (b) => /^source = \{ (editable|virtual) = /m.test(b);

const files = [
  "Cargo.toml",
  "Cargo.lock",
  "package.json",
  "bun.lock",
  "pyproject.toml",
  "uv.lock",
];
for (const dir of ["crates", "npm/platforms"]) {
  for (const entry of readdirSync(join(root, dir)).sort()) {
    for (const name of ["Cargo.toml", "package.json"]) {
      const p = `${dir}/${entry}/${name}`;
      if (existsSync(join(root, p))) files.push(p);
    }
  }
}
files.push(
  "npm/cli/package.json",
  "sdks/python/pyproject.toml",
  "sdks/typescript/package.json",
  "sdks/python/src/onetaskgraph_sdk/__init__.py",
  "sdks/typescript/src/index.ts",
);

const out = [`version-shape ${V.replace(/\d+/g, "N")}`];
for (const p of files) {
  if (!existsSync(join(root, p))) {
    out.push(`${p} absent`);
    continue;
  }
  const text = read(p);
  const normal =
    p === "Cargo.lock"
      ? normalizeLock(text, cargoOwn)
      : p === "uv.lock"
        ? normalizeLock(text, uvOwn)
        : normalizeLines(text);
  out.push(`${p} ${createHash("sha256").update(normal).digest("hex")}`);
}
process.stdout.write(`${out.join("\n")}\n`);
