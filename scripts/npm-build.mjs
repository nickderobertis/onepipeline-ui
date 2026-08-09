#!/usr/bin/env node
// Build the npm packages this repository publishes. There are two deliverables,
// split by what they contain.
//
// The first distributes the prebuilt onepipeline-api binary — the direct analogue of
// the maturin PyPI wheels (see pyproject.toml). Its layout mirrors esbuild/@biomejs
// and every other "carry the native binary" npm tool:
//
//   onepipeline-api-cli                launcher package (npm/onepipeline-api-cli, committed)
//     bin/onepipeline-api.js            resolves + execs the platform binary
//     optionalDependencies:            one per Rust target in release.yml's matrix
//       onepipeline-api-cli-linux-x64
//       onepipeline-api-cli-linux-arm64
//       onepipeline-api-cli-darwin-x64
//       onepipeline-api-cli-darwin-arm64
//       onepipeline-api-cli-win32-x64  each carries the matching prebuilt binary
//
// The platform packages are UNSCOPED on purpose: a `@scope/` name needs an npm
// organization, which a publish token cannot create.
//
// npm installs only the optional dependency whose `os`/`cpu` match the host, so
// `npm install -g onepipeline-api-cli` is a seconds-fast binary install — the same
// promise the wheels make on PyPI.
//
// The second is `onepipeline-ui` itself: the built frontend, assembled by the `ui`
// mode below from `apps/dag-ui/dist`. It carries no binary and no dependencies — a
// Vite bundle inlines what it needs — so it is the committed manifest plus that
// directory, and nothing else.
//
// The version is sourced from Cargo.toml (release-plz stays the single version
// driver, exactly like the wheels' `dynamic = ["version"]`); pass --version to
// override. Nothing here publishes — it only assembles package directories under
// --out; release.yml packs and publishes them.
//
// Usage:
//   node scripts/npm-build.mjs platform --target <triple> --binary <path> \
//        [--version <v>] [--out <dir>]
//   node scripts/npm-build.mjs launcher [--version <v>] [--out <dir>]
//   node scripts/npm-build.mjs ui [--bundle <dir>] [--version <v>] [--out <dir>]
//
// Every mode prints the created package directory on stdout.

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Rust target triple -> npm platform package facts. Keys must match the release
// matrix in .github/workflows/release.yml; the (platform, arch) pair must match
// the PACKAGES map in npm/onepipeline-api-cli/bin/onepipeline-api.js and the
// optionalDependencies in npm/onepipeline-api-cli/package.json.
const TARGETS = {
  "x86_64-unknown-linux-gnu": { platform: "linux", arch: "x64", exe: false },
  "aarch64-unknown-linux-gnu": { platform: "linux", arch: "arm64", exe: false },
  "x86_64-apple-darwin": { platform: "darwin", arch: "x64", exe: false },
  "aarch64-apple-darwin": { platform: "darwin", arch: "arm64", exe: false },
  "x86_64-pc-windows-msvc": { platform: "win32", arch: "x64", exe: true },
};

const REPOSITORY = "https://github.com/nickderobertis/onepipeline-ui";

// Every failure names what to do next: this runs inside a release job, where the
// only diagnosis anyone gets is what it printed.
function die(msg, action) {
  process.stderr.write(`npm-build: ${msg}\nACTION: ${action}\n`);
  process.exit(1);
}

// Run a filesystem step, turning anything it throws into the script's own
// diagnostic. Node's raw `ENOENT: no such file or directory, open '...'` names
// the syscall and not the fix, and this runs inside a release job where the log
// is the only diagnosis anyone gets.
function attempt(what, action, step) {
  try {
    return step();
  } catch (error) {
    die(`${what}: ${error.message}`, action);
  }
}

// The version both registries index this release under. npm rejects anything
// that is not semver, and a version with a stray specifier would publish under a
// name no consumer could ask for — so it is validated here rather than at the
// registry, whichever source it came from.
// At most one `-prerelease` and one `+build`, in that order: repeating either
// (`1.2.3+one+two`) is not a version npm will take.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// Read the crate version from the root Cargo.toml [package] section. A tiny hand
// parser avoids a TOML dependency: take the first `version = "..."` after the
// `[package]` header and before the next section, so a dependency's version can
// never be mistaken for the crate's.
function cargoVersion() {
  const toml = attempt(
    "cannot read Cargo.toml",
    "run this from a checkout of the repository, where Cargo.toml is readable",
    () => readFileSync(join(REPO_ROOT, "Cargo.toml"), "utf8")
  );
  const pkg = toml.indexOf("[package]");
  if (pkg === -1) {
    die("no [package] section in Cargo.toml", "run this from the repository root");
  }
  const rest = toml.slice(pkg);
  const end = rest.indexOf("\n[", 1);
  const section = end === -1 ? rest : rest.slice(0, end);
  const m = section.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!m) {
    die(
      "could not parse version from Cargo.toml [package]",
      "restore the `version = \"X.Y.Z\"` line release-plz maintains there"
    );
  }
  return m[1];
}

// The release version: Cargo.toml's unless --version overrides it, validated
// either way before it reaches a manifest.
function resolveVersion(args) {
  const version = args.version ?? cargoVersion();
  if (!VERSION.test(version)) {
    die(
      `'${version}' is not a version either registry can index`,
      args.version === undefined
        ? "fix the `version` in Cargo.toml [package]; it must read X.Y.Z"
        : "pass --version X.Y.Z (a -prerelease or +build suffix is allowed), or omit it to take Cargo.toml's"
    );
  }
  return version;
}

// Options are allowlisted per mode: an unrecognized flag is a caller that meant
// something this script will not do, and silently ignoring it would assemble a
// package that is not the one they asked for.
function parseArgs(argv, allowed) {
  const out = {};
  const usage = allowed.map((name) => `--${name}`).join(", ");
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) die(`unexpected argument: ${a}`, `pass options as ${usage}`);
    const key = a.slice(2);
    if (!allowed.includes(key)) die(`unknown option --${key}`, `this mode takes ${usage}`);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) die(`--${key} needs a value`, `give --${key} a value`);
    out[key] = val;
    i += 1;
  }
  return out;
}

function writeJson(path, obj) {
  attempt(`cannot write ${path}`, "check that its directory is writable", () =>
    writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`)
  );
}

function buildPlatform(args) {
  const target =
    args.target || die("platform: --target <triple> is required", `pass --target with one of: ${Object.keys(TARGETS).join(", ")}`);
  const binary =
    args.binary || die("platform: --binary <path> is required", "pass --binary the path to the built onepipeline-api for that target");
  const facts =
    TARGETS[target] || die(`platform: unknown target ${target}`, `pass one of: ${Object.keys(TARGETS).join(", ")}`);
  const version = resolveVersion(args);
  const outRoot = resolve(args.out || join(REPO_ROOT, "npm", "dist"));

  const pkgName = `onepipeline-api-cli-${facts.platform}-${facts.arch}`;
  const pkgDir = join(outRoot, pkgName);
  const binDir = join(pkgDir, "bin");
  const binName = facts.exe ? "onepipeline-api.exe" : "onepipeline-api";

  // Resolve the source binary with a `.exe` fallback: a bash caller may pass the
  // extensionless path (Git Bash's `test -x` matches onepipeline-api.exe
  // transparently, but Node's copyFileSync needs the real name).
  let srcBin = resolve(binary);
  if (!existsSync(srcBin) && existsSync(`${srcBin}.exe`)) srcBin = `${srcBin}.exe`;
  if (!existsSync(srcBin)) {
    die(
      `platform: binary not found: ${binary}`,
      `build it first: cargo build --release --locked --target ${target}`
    );
  }

  attempt(
    `cannot assemble ${pkgName} under ${outRoot}`,
    "check that --out names a writable directory with room for the binary",
    () => {
      rmSync(pkgDir, { recursive: true, force: true });
      mkdirSync(binDir, { recursive: true });
      copyFileSync(srcBin, join(binDir, binName));
      if (!facts.exe) chmodSync(join(binDir, binName), 0o755);
    }
  );

  writeJson(join(pkgDir, "package.json"), {
    name: pkgName,
    version,
    description: `Prebuilt onepipeline-api binary for ${facts.platform} ${facts.arch}.`,
    homepage: REPOSITORY,
    license: "MIT",
    author: "Nick DeRobertis",
    repository: { type: "git", url: `git+${REPOSITORY}.git` },
    // os/cpu make npm install this package only on the matching host, so the
    // launcher's optionalDependency resolution picks exactly one.
    os: [facts.platform],
    cpu: [facts.arch],
    files: [`bin/${binName}`],
  });

  attempt(`cannot write the ${pkgName} README`, "check that --out is writable", () =>
    writeFileSync(
      join(pkgDir, "README.md"),
    `# ${pkgName}\n\nPrebuilt \`onepipeline-api\` binary for ${facts.platform} ${facts.arch}.\n` +
      "This is a platform-specific dependency of " +
        "[`onepipeline-api-cli`](https://www.npmjs.com/package/onepipeline-api-cli); install " +
        "that instead.\n"
    )
  );

  process.stdout.write(`${pkgDir}\n`);
}

function buildLauncher(args) {
  const version = resolveVersion(args);
  const outRoot = resolve(args.out || join(REPO_ROOT, "npm", "dist"));
  const src = join(REPO_ROOT, "npm", "onepipeline-api-cli");
  const dest = join(outRoot, "onepipeline-api-cli");

  attempt(
    `cannot copy the committed launcher from ${src}`,
    "restore npm/onepipeline-api-cli from git, and check that --out is writable",
    () => {
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(outRoot, { recursive: true });
      cpSync(src, dest, { recursive: true });
    }
  );

  // Stamp the real version into the launcher's own version and every
  // optionalDependency, so the launcher pins the exact platform packages this
  // release publishes. The committed manifest carries a placeholder instead: a
  // real number there would be a second version source to drift.
  const manifestPath = join(dest, "package.json");
  const manifest = attempt(
    "the committed launcher manifest is missing or is not JSON",
    "restore npm/onepipeline-api-cli/package.json from git",
    () => JSON.parse(readFileSync(manifestPath, "utf8"))
  );
  manifest.version = version;
  for (const dep of Object.keys(manifest.optionalDependencies || {})) {
    manifest.optionalDependencies[dep] = version;
  }
  writeJson(manifestPath, manifest);

  process.stdout.write(`${dest}\n`);
}

// Assemble the frontend package: the committed manifest plus the bundle Vite built.
// The bundle is an input rather than something built here — `just build` (Nx's
// `dag-ui:build`) owns that step, and running it from inside a packaging script would
// be a second place the frontend gets built.
function buildUi(args) {
  const version = resolveVersion(args);
  const outRoot = resolve(args.out || join(REPO_ROOT, "npm", "dist"));
  const src = join(REPO_ROOT, "npm", "onepipeline-ui");
  // `--bundle` names the built view; it defaults to where Nx puts it. Explicit so
  // a release can assemble from a downloaded artifact, and so the "nothing was
  // built" refusal below can be exercised without emptying the checkout.
  const bundle = resolve(args.bundle || join(REPO_ROOT, "apps", "dag-ui", "dist"));
  const dest = join(outRoot, "onepipeline-ui");

  if (!existsSync(join(bundle, "index.html"))) {
    die(
      `ui: no built frontend at ${bundle}`,
      "build it first: just build (or `nx run dag-ui:build`)"
    );
  }

  attempt(
    `cannot assemble the frontend package under ${outRoot}`,
    "restore npm/onepipeline-ui from git, and check that --out is writable",
    () => {
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(outRoot, { recursive: true });
      cpSync(src, dest, { recursive: true });
      cpSync(bundle, join(dest, "dist"), { recursive: true });
    }
  );

  // The same placeholder discipline the launcher follows: the committed manifest
  // carries no real number, so release-plz stays the single version driver.
  const manifestPath = join(dest, "package.json");
  const manifest = attempt(
    "the committed frontend manifest is missing or is not JSON",
    "restore npm/onepipeline-ui/package.json from git",
    () => JSON.parse(readFileSync(manifestPath, "utf8"))
  );
  manifest.version = version;
  writeJson(manifestPath, manifest);

  process.stdout.write(`${dest}\n`);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "platform") {
  buildPlatform(parseArgs(rest, ["target", "binary", "version", "out"]));
} else if (mode === "launcher") {
  buildLauncher(parseArgs(rest, ["version", "out"]));
} else if (mode === "ui") {
  buildUi(parseArgs(rest, ["version", "out", "bundle"]));
} else {
  die(
    `unknown mode ${mode === undefined ? "(none given)" : mode}`,
    "run `npm-build.mjs platform --target <triple> --binary <path> [--version <v>] [--out <dir>]`, `npm-build.mjs launcher [--version <v>] [--out <dir>]`, or `npm-build.mjs ui [--version <v>] [--out <dir>]`"
  );
}
