#!/usr/bin/env node
// The whole of a release's work, one recipe per CD job.
//
// release.yml's jobs live here: `build-linux`, `build-linux-arm64`,
// `build-macos` and `build-windows` each call `just release-<os>`, and
// `publish` calls `just release-publish` (release-plz.yml's one job is
// release-plz itself). The workflow only sets up a runner and calls a
// phase; what is built, under which name, and what is uploaded where is decided
// in this file, so it can be planned without building, driven on a developer's
// host and held to the last release's published artifacts.
//
// A platform job, in the order release.yml runs its phases:
//
//   build         compile each of its targets ONCE (maturin, inside the
//                 manylinux image of the runner's own architecture on Linux)
//                 and package the archive, the checksum, the wheel and the npm
//                 platform package from that one binary
//                 (scripts/release-package.py refuses different bytes).
//   test-install  install those exact files (archive, pip, npm through a local
//                 registry) and run what each installed.
//   upload R      publish this platform's files to one registry R (github, pypi
//                 or npm). Each asks the registry first and uploads only what it
//                 does not already serve, so a re-run finishes a partial upload.
//                 A re-run rebuilds, and the binary is not byte-reproducible, so
//                 what PyPI or npm already holds from an earlier attempt is kept
//                 rather than sent again, a version npm holds and does not serve
//                 yet is waited for, and the Release's archive and checksum
//                 follow them as a pair (`upload github` says how).
//   verify        install the version back from the Release and PyPI, on this
//                 OS, and run it: this job's build, or the earlier attempt's a
//                 registry kept, reporting a target served as two builds. npm is
//                 left to publish's `check`: npm serves a publish minutes after
//                 taking it, longer than a job that compiled for most of its
//                 timeout has left.
//   all --dry-run the rehearsal: build, test-install, then every switched-on
//                 upload reported rather than run. Only with --dry-run: a
//                 release runs each phase as its own workflow step.
//
// The publish job, which `needs` all four:
//
//   check         every platform's files are on every switched-on registry and
//                 every platform job succeeded. Each upload repeats it first, so
//                 a missing platform publishes nothing platform-independent.
//                 The phase itself, and only it, waits for npm to serve each
//                 platform package — fetching it by version as an install
//                 does — and for PyPI to list each wheel, unless a job failed
//                 or a Release asset is missing, so the launcher that pins
//                 them never goes out ahead of them.
//   build         assemble the platform-independent files: the npm launcher,
//                 the npm frontend package, the crate and the CycloneDX SBOM.
//   upload R      crate, npm or github, idempotent as above.
//   verify        install the launcher from npm, as a user does, and run it —
//                 an install that skipped this platform's package is not one;
//                 read the crate and the SBOM back.
//   settle        hold the GitHub Release to what published, through
//                 scripts/release-status.sh: a release that did not publish is
//                 demoted to a prerelease.
//
// Each job also has a `plan` phase, which prints, without building anything,
// every file, package name, wheel tag and target the job produces.
//
// Registries are reached through their real clients — gh, twine, npm, cargo,
// pip — and every endpoint can be pointed elsewhere, which is how the journeys
// in tests/release drive these phases against local doubles:
//
//   RELEASE_TAG              the tag being released; must be v<Cargo.toml version>
//   PYPI_PUBLISH, NPM_PUBLISH the operator's switches ('true', 'false' or unset)
//   CARGO_REGISTRY_TOKEN     its presence switches the crate on, as before
//   PYPI_TOKEN               twine's password for `upload pypi`
//   NODE_AUTH_TOKEN          npm's token for `upload npm` (setup-node's .npmrc)
//   RELEASE_PYPI_URL         PyPI's JSON API and simple index (https://pypi.org)
//   RELEASE_PYPI_UPLOAD_URL  PyPI's upload endpoint (https://upload.pypi.org/legacy/)
//   NPM_CONFIG_REGISTRY      npm's own registry setting
//   RELEASE_CRATES_INDEX     the sparse index read for the crate (https://index.crates.io)
//   RELEASE_CRATES_API       the crate registry's API, which the release probe
//                            reads (https://crates.io)
//   RELEASE_CARGO_PUBLISH_FLAGS extra `cargo publish` flags, as words
//   RELEASE_VERIFY_BUDGET    seconds a registry install is retried (600)
//   RELEASE_CHECK_BUDGET     seconds `check` waits, in all, for npm to serve the
//                            platform packages and PyPI to list the wheels (900)
//   RELEASE_NPM_HELD_BUDGET  seconds an `upload npm` waits for npm to serve a
//                            version it refused to take again because an earlier
//                            attempt published it (300)
//   BUILD_RESULTS            `build-<os>=<result>` pairs the publish job was handed
//   STEP_RESULTS             `<step>=<outcome>` pairs of the publish job's own steps
//
// Usage: release.mjs <linux|linux-arm64|macos|windows|publish> <phase> [R] [--out DIR]
//        [--version X.Y.Z (plan only)] [--dry-run]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS = process.platform === "win32";
const PYTHON = WINDOWS ? "python" : "python3";

// The one table of what is released. A target belongs to exactly one platform
// job; its npm package name and wheel tag are what v0.37.0 published, which
// .github/tests/release.test.mjs holds every platform's plan to.
// aarch64-unknown-linux-gnu was last released in v0.39.0 and is built again,
// natively on GitHub's arm64 Linux runner, by its own job;
// x86_64-apple-darwin stopped before that and stays stopped.
export const TARGETS = {
  "x86_64-unknown-linux-gnu": {
    platform: "linux",
    npm: "linux-x64",
    wheelTag: "manylinux_2_17_x86_64.manylinux2014_x86_64",
    archive: "tar.gz",
    exe: "",
  },
  "aarch64-unknown-linux-gnu": {
    platform: "linux-arm64",
    npm: "linux-arm64",
    wheelTag: "manylinux_2_17_aarch64.manylinux2014_aarch64",
    archive: "tar.gz",
    exe: "",
  },
  "aarch64-apple-darwin": {
    platform: "macos",
    npm: "darwin-arm64",
    wheelTag: "macosx_11_0_arm64",
    archive: "tar.gz",
    exe: "",
  },
  "x86_64-pc-windows-msvc": {
    platform: "windows",
    npm: "win32-x64",
    wheelTag: "win_amd64",
    archive: "zip",
    exe: ".exe",
  },
};
// Each platform job and the runner it builds on, natively: a Linux target is
// compiled in the manylinux image of its own architecture, never emulated.
export const PLATFORMS = {
  linux: "ubuntu-latest",
  "linux-arm64": "ubuntu-24.04-arm",
  macos: "macos-latest",
  windows: "windows-latest",
};
const WHEEL_PACKAGE = "onepipeline-api-cli";
const CRATE = "onepipeline-ui";
// A Linux target is built inside the manylinux image (`just wheel-linux`); every
// other target by maturin on its runner's own toolchain.
const manylinux = (target) => target.endsWith("-unknown-linux-gnu");
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// A phase's one success line, which a phase run inside another (`all`, or the
// check every publish upload repeats) leaves to the phase that ran it.
let quiet = false;
const say = (line) => {
  if (!quiet) console.log(line);
};

class Fault extends Error {
  constructor(message, action, exitCode = 1) {
    super(message);
    this.action = action;
    this.exitCode = exitCode;
  }
}
const usage = (message, action) => new Fault(message, action, 2);

function cargoVersion() {
  const toml = readFileSync(join(REPO_ROOT, "Cargo.toml"), "utf8");
  const section = toml.slice(toml.indexOf("[package]")).split(/\n\[/)[0];
  const version = section.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version || !VERSION.test(version))
    throw new Fault(
      "no X.Y.Z version in Cargo.toml [package]",
      "restore the version line release-plz maintains there",
    );
  return version;
}

// maturin spells a prerelease the PEP 440 way, and so does every wheel name.
export function pep440(version) {
  // Build metadata (`+…`) is refused rather than spelled: no release here
  // carries it, and a PEP 440 local version is a different, lowercased one.
  const match = version.match(/^(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.?(\d+))?$/);
  if (!match)
    throw usage(
      `${version} has no PEP 440 spelling this release knows`,
      "release X.Y.Z, or X.Y.Z-alpha.N, -beta.N or -rc.N",
    );
  const core = match[1].split(".").map(Number).join(".");
  const pre = match[2]
    ? { alpha: "a", beta: "b", rc: "rc" }[match[2]] + Number(match[3])
    : "";
  return `${core}${pre}`;
}

function platformArtifacts(target, version) {
  const facts = TARGETS[target];
  const stem = `onepipeline-api-v${version}-${target}`;
  const npmPackage = `${WHEEL_PACKAGE}-${facts.npm}`;
  return [
    {
      target,
      kind: "archive",
      registry: "github",
      file: `${stem}.${facts.archive}`,
    },
    { target, kind: "checksum", registry: "github", file: `${stem}.sha256` },
    {
      target,
      kind: "wheel",
      registry: "pypi",
      package: WHEEL_PACKAGE,
      tags: facts.wheelTag.split(".").map((tag) => `py3-none-${tag}`),
      file: `onepipeline_api_cli-${pep440(version)}-py3-none-${facts.wheelTag}.whl`,
    },
    {
      target,
      kind: "npm",
      registry: "npm",
      package: npmPackage,
      file: `${npmPackage}-${version}.tgz`,
    },
  ];
}

export function plan(job, version = cargoVersion()) {
  if (job === "publish")
    return {
      job,
      runner: "ubuntu-latest",
      version,
      targets: [],
      artifacts: [
        {
          kind: "crate",
          registry: "crate",
          package: CRATE,
          file: `${CRATE}-${version}.crate`,
        },
        {
          kind: "npm",
          registry: "npm",
          package: WHEEL_PACKAGE,
          file: `${WHEEL_PACKAGE}-${version}.tgz`,
        },
        {
          kind: "npm",
          registry: "npm",
          package: "onepipeline-ui",
          file: `onepipeline-ui-${version}.tgz`,
        },
        {
          kind: "sbom",
          registry: "github",
          file: `onepipeline-api-v${version}.cdx.json`,
        },
      ],
    };
  const targets = Object.keys(TARGETS).filter(
    (t) => TARGETS[t].platform === job,
  );
  return {
    job,
    runner: PLATFORMS[job],
    version,
    targets,
    artifacts: targets.flatMap((target) => platformArtifacts(target, version)),
  };
}

// Where each kind of file is staged under --out, which is also where `upload`
// reads it from: a file nothing staged is a file nothing publishes.
function stagedPath(out, artifact) {
  const dir = {
    archive: "assets",
    checksum: "assets",
    sbom: "assets",
    wheel: "wheels",
    npm: "npm-artifacts",
    crate: "crates",
  }[artifact.kind];
  return join(out, dir, artifact.file);
}

// Every tool's output is captured, and shown only when it fails: a phase's own
// summary is its success output. `inherit` lets one through as it runs, and
// `log` keeps it in a file whatever happened.
// llmlint: ignore-block[changed_behavior_has_e2e] the Windows branch here (`shell` for npm, npx and the .cmd launcher, which Node cannot spawn without one, and Windows' own bsdtar) is taken only on a Windows runner, where the release's build-windows job runs it on every release before anything publishes; on every other host the option is false and the same call is driven end to end by tests/release/journeys.test.mjs.
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 1024,
    encoding: "utf8",
    shell: WINDOWS && ["npm", "npx"].includes(command),
    ...options,
    env: { ...process.env, ...options.env },
  });
  if (result.error)
    throw new Fault(
      `cannot run ${command}: ${result.error.message}`,
      `install ${command} and put it on PATH`,
    );
  return result;
}
// llmlint: ignore-end[changed_behavior_has_e2e]

function must(what, action, command, args, options) {
  const result = run(command, args, options);
  if (options?.log)
    writeFileSync(options.log, `${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.status !== 0) {
    if (!options?.inherit)
      process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
    throw new Fault(
      `${what} failed (${command} exited ${result.status})`,
      action,
    );
  }
  return result;
}

const switchedOn = (name) => {
  const value = process.env[name] ?? "";
  if (!["true", "false", ""].includes(value))
    throw usage(
      `${name} must be 'true', 'false' or unset, not '${value}'`,
      `fix the ${name} repository variable`,
    );
  return value === "true";
};
const crateSwitchedOn = () => Boolean(process.env.CARGO_REGISTRY_TOKEN);

function releaseTag(version) {
  const tag = process.env.RELEASE_TAG || `v${version}`;
  if (tag !== `v${version}`)
    throw new Fault(
      `release tag ${tag} differs from Cargo.toml's ${version}`,
      "build the tag whose version matches Cargo.toml; never restamp an existing release",
    );
  return tag;
}

const pypiUrl = () =>
  (process.env.RELEASE_PYPI_URL || "https://pypi.org").replace(/\/$/, "");
const cratesIndex = () =>
  (process.env.RELEASE_CRATES_INDEX || "https://index.crates.io").replace(
    /\/$/,
    "",
  );

// Retried the way every registry install here is: the install is the probe,
// because a registry's API answers before the CDN a user installs through does.
// `require` is a file the install has to have written for an attempt to count:
// npm skips an optional dependency it cannot fetch and still exits 0.
function retried(label, action, command, args, options = {}) {
  const { budget = process.env.RELEASE_VERIFY_BUDGET || "600", require } =
    options;
  const first = Number(budget) < 30 ? "1" : "5";
  must(label, action, "bash", [
    "scripts/retry-install.sh",
    "--budget",
    String(budget),
    "--first-delay",
    first,
    "--max-delay",
    String(Math.max(Number(first), Math.min(60, Number(budget)))),
    "--label",
    label,
    "--action",
    action,
    ...(require ? ["--require", portable(require)] : []),
    "--",
    command,
    ...args,
  ]);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// A path bash can be handed on every runner: Git Bash reads C:/x, not C:\x.
const portable = (path) => (WINDOWS ? path.replace(/\\/g, "/") : path);

function smoke(command, version, label) {
  must(
    `${label}: smoke test`,
    "the installed binary did not behave as this release; inspect the smoke output above",
    "bash",
    [
      "scripts/smoke-published.sh",
      "--expect-version",
      version,
      "--command",
      portable(command),
      "--label",
      label,
    ],
  );
}

// The `onepipeline-api` an npm install under `prefix` provides, as each caller
// can run it. On Windows npm writes three launchers into node_modules/.bin: an
// extensionless sh script, a .cmd and a .ps1. Git Bash, which runs
// scripts/smoke-published.sh, counts an .exe, or a script starting with `#!`,
// as executable and a .cmd as neither, so to it the .cmd is no command at all,
// while node can spawn nothing but the .cmd, and only through a shell. Everywhere
// else the one name is a symlink both can run.
export function npmLauncher(prefix, windows = WINDOWS) {
  const bin = join(prefix, "node_modules", ".bin");
  return {
    bash: join(bin, "onepipeline-api"),
    spawn: join(bin, windows ? "onepipeline-api.cmd" : "onepipeline-api"),
  };
}

function scratch(name) {
  const root = process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir();
  return mkdtempSync(join(root, `release-${name}-`));
}

// Registry reads. Each answers which of the planned files a registry already
// serves, which is what makes every upload idempotent and what `check` reads.

function githubAssets(tag) {
  const result = must(
    `listing the GitHub Release ${tag}'s assets`,
    "check that the Release exists and that GH_TOKEN can read it",
    "gh",
    ["release", "view", tag, "--json", "assets", "--jq", ".assets[].name"],
    { capture: true },
  );
  return new Set(result.stdout.split(/\r?\n/).filter(Boolean));
}

async function fetchJson(url, what) {
  let response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (error) {
    throw new Fault(
      `cannot reach ${what} at ${url}: ${error.message}`,
      `re-run when ${what} is reachable`,
    );
  }
  // `undefined` is the 404 alone; whatever a 200 carries, null included, is
  // handed back for the caller to validate.
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Fault(
      `${what} answered ${response.status} for ${url}`,
      `re-run when ${what} answers`,
    );
  try {
    return await response.json();
  } catch {
    throw new Fault(
      `${what} answered ${url} with something that is not JSON`,
      `re-run when ${what} answers`,
    );
  }
}

// PyPI's JSON for one release: its files are what it already serves, each
// filename to the sha256 PyPI records for it. Anything else in that shape is
// refused rather than read as "serves nothing", which would upload over a
// release PyPI already has, or as some digest, which would misname whose build
// it holds.
async function pypiFiles(version) {
  const url = `${pypiUrl()}/pypi/${WHEEL_PACKAGE}/${pep440(version)}/json`;
  const body = await fetchJson(url, "PyPI");
  if (body === undefined) return new Map();
  if (
    !Array.isArray(body?.urls) ||
    !body.urls.every(
      (entry) =>
        typeof entry?.filename === "string" &&
        /^[0-9a-f]{64}$/.test(entry.digests?.sha256 ?? ""),
    )
  )
    throw new Fault(
      `PyPI answered ${url} with no list of files and their sha256 digests`,
      "re-run when PyPI serves its JSON API",
    );
  return new Map(
    body.urls.map((entry) => [entry.filename, entry.digests.sha256]),
  );
}

function npmServes(pkg, version) {
  const result = run(
    "npm",
    ["view", `${pkg}@${version}`, "version", "--json", "--prefer-online"],
    { capture: true },
  );
  if (/E404|404 Not Found/.test(result.stderr)) return false;
  if (result.status === 0) {
    // A version the package does not have is the E404 above; one it has is
    // printed as a JSON string. Anything else, nothing included (a manifest
    // with no version in it), is refused rather than read as not served, which
    // would publish over a version npm already has.
    if (result.stdout.trim() === JSON.stringify(version)) return true;
    throw new Fault(
      `npm answered ${pkg}@${version} with ${result.stdout.trim() || "nothing"}`,
      "re-run when the npm registry answers; it named no such version",
    );
  }
  process.stderr.write(result.stderr);
  throw new Fault(
    `cannot ask npm about ${pkg}@${version}`,
    "re-run when the npm registry is reachable",
  );
}

// The integrity npm records for the tarball it serves as pkg@version, which an
// install checks what it fetches against. Asked only of a version npm serves,
// so anything but a sha512 integrity is refused rather than read as some build.
function npmIntegrity(pkg, version) {
  const result = must(
    `asking npm which ${pkg}@${version} it serves`,
    "re-run when the npm registry answers",
    "npm",
    [
      "view",
      `${pkg}@${version}`,
      "dist.integrity",
      "--json",
      "--prefer-online",
    ],
    { capture: true },
  );
  let integrity;
  try {
    integrity = JSON.parse(result.stdout);
  } catch {}
  if (
    typeof integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)
  )
    throw new Fault(
      `npm answered ${pkg}@${version}'s integrity with ${result.stdout.trim() || "nothing"}`,
      "re-run when the npm registry answers; it named no sha512 integrity for a version it serves",
    );
  return integrity;
}

// What a registry identifies a file's bytes by: npm the sha512 integrity it
// records for a tarball, the Release and PyPI its sha256.
function digestOf(artifact, path) {
  return artifact.registry === "npm"
    ? `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`
    : sha256(path);
}

// The sha256 of each of `files` the GitHub Release has attached, read back
// from the Release itself, since an asset's name says nothing of whose build
// it is.
function githubDigests(tag, files) {
  const digests = new Map();
  if (!files.length) return digests;
  const work = scratch("github-held");
  try {
    must(
      `downloading the GitHub Release ${tag}'s ${files.map((a) => a.file).join(", ")}`,
      "check that GH_TOKEN can read the Release's assets",
      "gh",
      [
        "release",
        "download",
        tag,
        "--dir",
        portable(work),
        "--clobber",
        ...files.flatMap((a) => ["--pattern", a.file]),
      ],
      { capture: true },
    );
    for (const a of files) digests.set(a.file, sha256(join(work, a.file)));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return digests;
}

const REGISTRY = { github: "the Release", pypi: "PyPI", npm: "npm" };

// PyPI and npm never replace a published file, so a file either holds under
// this version's name with other bytes than this build's is an earlier
// attempt's — nothing else publishes under this version's names, and a re-run
// rebuilds a binary that is not byte-identical to the one before — and it is
// what this release ships from that registry: it is kept, never sent again,
// and verify installs and runs it.
function keptFromEarlier(job, registry, what, tag, held, ours) {
  say(
    `release ${job}: ${REGISTRY[registry]} already holds ${what} from an earlier attempt of ${tag} (${held}, where this build's is ${ours}); it is kept, since ${REGISTRY[registry]} never replaces a published ${registry === "npm" ? "version" : "file"}, and this build's is not uploaded`,
  );
}

// scripts/publish-npm.sh's exit status for a publish npm refused because it
// already holds the version and serves nothing for it yet.
const NPM_HOLDS = 3;

function heldBudget() {
  const budget = process.env.RELEASE_NPM_HELD_BUDGET || "300";
  if (!/^\d+$/.test(budget))
    throw usage(
      `RELEASE_NPM_HELD_BUDGET must be a whole number of seconds, not '${budget}'`,
      "set RELEASE_NPM_HELD_BUDGET to whole seconds, or unset it for 300",
    );
  return Number(budget);
}

// Publish one npm package through scripts/publish-npm.sh, and answer whether
// npm took this build's. A publish npm refuses because it already holds the
// version — staged for a maintainer's approval, or taken and not listed yet —
// holds an earlier attempt's upload: the attempt that gave up waiting for npm
// is how a re-run gets here, and v0.41.2's build-windows re-run was refused so
// (`409 Cannot publish over previously staged version`). A version is
// immutable, so that upload is what this release ships, and it is waited for
// within RELEASE_NPM_HELD_BUDGET rather than failed on. Five minutes because a
// platform job reaches its uploads with little of its timeout left; a wait it
// cannot finish fails, naming the version, and its re-run waits again.
async function publishNpm(a, path, version, tag, what) {
  if (!process.env.NODE_AUTH_TOKEN)
    throw new Fault(
      "NPM_PUBLISH is on but NODE_AUTH_TOKEN is empty",
      "add the NPM_TOKEN secret (see gh-secrets.json) or unset NPM_PUBLISH",
    );
  const result = run("bash", ["scripts/publish-npm.sh", portable(path)]);
  if (result.status === 0) return true;
  process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.status !== NPM_HOLDS)
    throw new Fault(
      `${what} failed (bash exited ${result.status})`,
      "re-run this job; versions npm already serves are skipped",
    );
  const budget = heldBudget();
  const started = Date.now();
  const deadline = started + budget * 1000;
  let delay = budget < 30 ? 1 : 5;
  for (;;) {
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (npmServes(a.package, version)) {
      process.stderr.write(
        `npm serves ${a.package}@${version}, which an earlier attempt of ${tag} published, after ${elapsed}s\n`,
      );
      return false;
    }
    if (Date.now() + delay * 1000 > deadline)
      throw new Fault(
        `npm holds ${a.package}@${version} from an earlier attempt of ${tag} and still does not serve it after ${elapsed}s`,
        `re-run this job once npm serves it (\`npm view ${a.package}@${version} version\` names it); a version npm staged is served only once a maintainer approves it, with the \`npm stage approve\` publish-npm names above`,
      );
    process.stderr.write(
      `  npm holds ${a.package}@${version} from an earlier attempt and does not serve it yet after ${elapsed}s; asking again in ${delay}s...\n`,
    );
    await new Promise((done) => setTimeout(done, delay * 1000));
    delay = Math.min(delay * 2, 60);
  }
}

// Which of PyPI and npm, among the switched-on ones, hold an earlier attempt's
// file for `target` — a wheel or package other than this build's.
async function heldElsewhere(job, out, target, version) {
  const carriers = plan(job, version).artifacts.filter(
    (a) => a.target === target && (a.kind === "wheel" || a.kind === "npm"),
  );
  requireStaged(out, carriers);
  const fixed = [];
  const wheel = carriers.find((a) => a.kind === "wheel");
  if (switchedOn("PYPI_PUBLISH")) {
    const held = (await pypiFiles(version)).get(wheel.file);
    if (held && held !== digestOf(wheel, stagedPath(out, wheel)))
      fixed.push("PyPI");
  }
  const pkg = carriers.find((a) => a.kind === "npm");
  if (
    switchedOn("NPM_PUBLISH") &&
    npmServes(pkg.package, version) &&
    npmIntegrity(pkg.package, version) !== digestOf(pkg, stagedPath(out, pkg))
  )
    fixed.push("npm");
  return fixed;
}

async function crateServes(version) {
  const response = await fetch(`${cratesIndex()}/on/ep/${CRATE}`).catch(
    (error) => {
      throw new Fault(
        `cannot reach the crates.io index: ${error.message}`,
        "re-run when crates.io is reachable",
      );
    },
  );
  if (response.status === 404) return false;
  if (!response.ok)
    throw new Fault(
      `the crates.io index answered ${response.status}`,
      "re-run when it answers",
    );
  const records = (await response.text()).split("\n").filter(Boolean);
  // A name the index has nothing under is a 404; a 200 lists records.
  if (!records.length)
    throw new Fault(
      "the crate index answered with no records",
      "re-run when the crate index serves its records",
    );
  return records.some((line) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Fault(
        `the crate index serves a record that is not JSON: ${line.slice(0, 80)}`,
        "re-run when the crate index serves its records",
      );
    }
    if (
      typeof record?.name !== "string" ||
      typeof record.vers !== "string" ||
      !Array.isArray(record.deps)
    )
      throw new Fault(
        `the crate index serves a record that is not an index entry: ${line.slice(0, 80)}`,
        "re-run when the crate index serves its records",
      );
    return record.name === CRATE && record.vers === version;
  });
}

function requireStaged(out, artifacts) {
  const missing = artifacts
    .filter((a) => !existsSync(stagedPath(out, a)))
    .map((a) => a.file);
  if (missing.length)
    throw new Fault(
      `nothing staged under ${out} for: ${missing.join(", ")}`,
      "run the build phase of this recipe first, with the same --out",
    );
}

function buildPlatform(job, out) {
  const { version, targets, artifacts } = plan(job);
  const tag = releaseTag(version);
  for (const target of targets.filter((t) => !manylinux(t)))
    must(
      "rustup target add",
      `confirm the pinned toolchain supports ${target}`,
      "rustup",
      ["target", "add", target],
    );
  if (!existsSync(join(REPO_ROOT, "apps/dag-ui/dist/index.html")))
    throw new Fault(
      "the browser view is not built, and the binary embeds it",
      "run 'just build', then re-run",
    );
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const target of targets) {
    const wheels = join(out, `build-${target}`);
    if (manylinux(target)) {
      // The manylinux image, through the one Linux wheel definition ci.yml's
      // `wheel` job also runs (`just wheel-linux`): the binary the wheel, the
      // archive and the npm package all carry is compiled here once, to a
      // glibc 2.17 floor.
      const inside = relative(REPO_ROOT, wheels);
      if (inside.startsWith("..") || resolve(REPO_ROOT, inside) !== wheels)
        throw usage(
          `--out ${out} is outside the checkout the manylinux container mounts`,
          "pass an --out under the repository",
        );
      must(
        `the ${target} build`,
        `fix the build error above; 'just wheel-linux ${target}' reproduces it`,
        "just",
        ["wheel-linux", target, inside],
        { log: join(out, `build-${target}.log`) },
      );
    } else {
      must(
        `the ${target} build`,
        "inspect the compiler error, restore the locked toolchain and browser bundle, then re-run",
        "maturin",
        [
          "build",
          "--release",
          "--locked",
          "--target",
          target,
          "--out",
          wheels,
          "--features",
          "bundled-ui",
        ],
        {
          env: { RUSTFLAGS: "-D warnings" },
          log: join(out, `build-${target}.log`),
        },
      );
    }
    const built = readdirSync(wheels).filter((name) => name.endsWith(".whl"));
    if (built.length !== 1)
      throw new Fault(
        `the ${target} build left ${built.length} wheels, not one`,
        "clear the --out directory and rebuild",
      );
    must(
      `packaging ${target}`,
      "follow the release-package ACTION above",
      PYTHON,
      [
        "scripts/release-package.py",
        "--target",
        target,
        "--wheel",
        join(wheels, built[0]),
        "--out",
        out,
        "--tag",
        tag,
      ],
      { capture: true },
    );
  }
  // The plan is the contract: a build that staged anything else, or less, is
  // not the release the plan (and its test against v0.37.0) describes.
  requireStaged(out, artifacts);
  const staged = ["assets", "wheels", "npm-artifacts"].flatMap((dir) =>
    readdirSync(join(out, dir)),
  );
  const extra = staged.filter(
    (file) => !artifacts.some((a) => a.file === file),
  );
  if (extra.length)
    throw new Fault(
      `the build staged files the plan does not name: ${extra.join(", ")}`,
      "make plan() and release-package.py agree",
    );
  say(
    `release ${job}: built and packaged ${targets.join(", ")} from one binary each`,
  );
}

function testInstall(job, out) {
  const { version, targets, artifacts } = plan(job);
  requireStaged(out, artifacts);
  for (const target of targets)
    must(
      `installing the staged ${target} files`,
      "the files this job would publish do not install and run; fix them before anything publishes",
      "node",
      ["scripts/verify-staged-release.mjs", out, target, version],
    );
  say(
    `release ${job}: installed the staged archive, wheel and npm package of ${targets.join(", ")} and ran each, server and embedded view included`,
  );
}

// What a dry run would have published with, reported once by the phase.
const wouldRun = [];
function announce(dryRun, command, args) {
  if (dryRun) {
    wouldRun.push([command, ...args].join(" "));
    return false;
  }
  return true;
}

async function uploadPlatform(job, out, registry, dryRun) {
  const { version, artifacts, targets } = plan(job);
  const tag = releaseTag(version);
  const files = artifacts.filter((a) => a.registry === registry);
  if (!files.length)
    throw usage(
      `the ${job} job publishes nothing to '${registry}'`,
      "upload github, pypi or npm",
    );
  requireStaged(out, files);
  const published = [];
  const present = [];
  if (registry === "github") {
    const served = dryRun ? new Set() : githubAssets(tag);
    const held = githubDigests(
      tag,
      files.filter((a) => served.has(a.file)),
    );
    // The Release, unlike PyPI and npm, can replace a file, so its archive and
    // checksum follow them, as a pair, so that the three serve one build:
    //   * kept, when PyPI or npm holds an earlier attempt's file for this
    //     target and the Release holds both halves of a pair. This job uploads
    //     the pair after PyPI and npm, so an attempt that attached a pair got
    //     past both of them; and whichever attempt's pair it is, nothing this
    //     build uploads is what PyPI and npm will go on serving, so replacing
    //     it would leave the Release the one registry serving another build;
    //   * replaced with this build's, when neither holds an earlier attempt's
    //     file: PyPI and npm took this build, or are switched off, and the pair
    //     is all that is left of the earlier one; or when the Release holds
    //     only half of a pair, since an archive and a checksum from two builds
    //     do not verify, and an archive cannot be rebuilt from its checksum.
    // What neither choice makes one build — PyPI or npm keeping an earlier
    // attempt's file beside a pair the Release does not hold whole — verify
    // reports, because it compares the binary each registry serves.
    for (const target of targets) {
      const pair = files.filter((a) => a.target === target);
      const ours = new Map(
        pair.map((a) => [a.file, digestOf(a, stagedPath(out, a))]),
      );
      const earlier = pair.filter(
        (a) => held.has(a.file) && held.get(a.file) !== ours.get(a.file),
      );
      const fixed = earlier.length
        ? await heldElsewhere(job, out, target, version)
        : [];
      const archive = pair.find((a) => a.kind === "archive").file;
      if (fixed.length && pair.every((a) => held.has(a.file))) {
        say(
          `release ${job}: the Release already holds ${pair.map((a) => a.file).join(" and ")} from an earlier attempt of ${tag} (${held.get(archive)}, where this build's is ${ours.get(archive)}); kept, because ${fixed.join(" and ")} ${fixed.length === 1 ? "holds" : "hold"} that attempt's ${target} build too and never ${fixed.length === 1 ? "replaces" : "replace"} a file`,
        );
        present.push(...pair.map((a) => a.file));
        continue;
      }
      for (const a of pair) {
        if (held.get(a.file) === ours.get(a.file)) {
          present.push(a.file);
          continue;
        }
        const args = [
          "release",
          "upload",
          tag,
          stagedPath(out, a),
          ...(held.has(a.file) ? ["--clobber"] : []),
        ];
        if (announce(dryRun, "gh", args)) {
          must(
            `uploading ${a.file}`,
            "re-run this job; assets already attached are skipped",
            "gh",
            args,
          );
          published.push(a.file);
        }
      }
      if (earlier.length)
        say(
          `release ${job}: the Release held ${earlier.map((a) => a.file).join(" and ")} from an earlier attempt of ${tag}; replaced with this build's, because ${
            fixed.length
              ? `the Release held only part of that attempt's pair, and a pair from two builds does not verify; ${fixed.join(" and ")} still ${fixed.length === 1 ? "serves" : "serve"} that attempt's build, which verify reports`
              : `neither PyPI nor npm holds that attempt's ${target} build`
          }`,
        );
    }
  } else if (registry === "pypi") {
    const served = dryRun ? new Map() : await pypiFiles(version);
    for (const a of files) {
      const args = [
        "-m",
        "twine",
        "upload",
        "--non-interactive",
        "--disable-progress-bar",
        "--repository-url",
        process.env.RELEASE_PYPI_UPLOAD_URL ||
          "https://upload.pypi.org/legacy/",
        "--username",
        "__token__",
        stagedPath(out, a),
      ];
      if (served.has(a.file)) {
        const ours = digestOf(a, stagedPath(out, a));
        if (served.get(a.file) !== ours)
          keptFromEarlier(job, "pypi", a.file, tag, served.get(a.file), ours);
        present.push(a.file);
      } else if (announce(dryRun, PYTHON, args)) {
        if (!process.env.PYPI_TOKEN)
          throw new Fault(
            "PYPI_PUBLISH is on but PYPI_TOKEN is empty",
            "add the PYPI_TOKEN secret (see gh-secrets.json) or unset PYPI_PUBLISH",
          );
        must(
          `uploading ${a.file} to PyPI`,
          "re-run this job; wheels PyPI already serves are skipped",
          PYTHON,
          args,
          { env: { TWINE_PASSWORD: process.env.PYPI_TOKEN } },
        );
        published.push(a.file);
      }
    }
  } else {
    for (const a of files) {
      const path = stagedPath(out, a);
      if (dryRun) {
        announce(dryRun, "bash", ["scripts/publish-npm.sh", path]);
        continue;
      }
      if (
        !npmServes(a.package, version) &&
        (await publishNpm(a, path, version, tag, `publishing ${a.file} to npm`))
      ) {
        published.push(a.file);
        continue;
      }
      // npm serves this version, which nothing in this job installs back (see
      // `verify`), so whose build it is is read from the hash npm records for
      // it, which an install checks what it fetches against.
      const ours = digestOf(a, path);
      const servedAs = npmIntegrity(a.package, version);
      if (servedAs !== ours)
        keptFromEarlier(
          job,
          "npm",
          `${a.package}@${version}`,
          tag,
          servedAs,
          ours,
        );
      present.push(a.file);
    }
  }
  say(
    dryRun
      ? `release ${job}: dry run — ${registry} would run: ${wouldRun.join("; ")}`
      : `release ${job}: ${registry} published ${published.join(", ") || "nothing"}; already served ${present.join(", ") || "nothing"}`,
  );
}

// Install this platform's files back from the Release and PyPI, on this OS,
// and run them. Where a registry records this job's file, the bytes installed
// are held to what this job staged, so an edge of it serving some other build
// fails here rather than for a user. Where it records an earlier attempt's —
// which `upload` kept, because PyPI never replaces a file and the Release's
// pair follows PyPI and npm — that build is what this release ships from it,
// so it is what is installed and run; a target the registries serve as more
// than one build is reported.
// npm is not waited for here: it serves a publish minutes after taking it,
// longer than this job has left (see the header), so publish's `check` waits
// for it, and `upload npm` holds a version npm already had to this build.
//
// llmlint: ignore[changed_behavior_has_e2e] the macOS and Windows branches of this function (the venv's Scripts directory, Windows' own bsdtar, the .exe name) run only on those runners, which the release's build-macos and build-windows jobs are on every release; tests/release drives this function end to end on Linux against registry doubles, through every refusal it makes.
async function verifyPlatform(job, out) {
  const { version, targets, artifacts } = plan(job);
  const tag = releaseTag(version);
  // What every installed binary is held to, so it has to have been staged:
  // without it there is nothing to say a registry served this job's build.
  requireStaged(out, artifacts);
  const missingBinaries = targets
    .map((target) => `${target}/onepipeline-api${TARGETS[target].exe}`)
    .filter((binary) => !existsSync(join(out, binary)));
  if (missingBinaries.length)
    throw new Fault(
      `nothing staged under ${out} for: ${missingBinaries.join(", ")}`,
      "run the build phase of this recipe first, with the same --out",
    );
  const exeBytes = (target) =>
    readFileSync(join(out, target, `onepipeline-api${TARGETS[target].exe}`));
  const sameBytes = (installed, target, where) => {
    if (!readFileSync(installed).equals(exeBytes(target)))
      throw new Fault(
        `${where} installed a different binary than this job built`,
        "check which build the registry serves for this version",
      );
  };
  for (const target of targets) {
    const files = artifacts.filter((a) => a.target === target);
    const archive = files.find((a) => a.kind === "archive").file;
    const checksum = files.find((a) => a.kind === "checksum").file;
    const exe = `onepipeline-api${TARGETS[target].exe}`;
    const work = scratch(`verify-${target}`);
    // The sha256 of the binary each registry installed, by registry.
    const builds = new Map();
    // A registry's own record of `artifact` is this job's, or an earlier
    // attempt's, which is then what is run rather than held to this build.
    const ownOrEarlier = (artifact, held, installed, where, carrier) => {
      const ours = sha256(stagedPath(out, artifact));
      if (held === undefined || held === ours)
        sameBytes(installed, target, carrier);
      else
        say(
          `release ${job}: ${where} serves ${artifact.file} from an earlier attempt of ${tag} (${held}, where this build's is ${ours}); installing and running that build`,
        );
      builds.set(where, sha256(installed));
    };
    try {
      const dl = join(work, "github");
      retried(
        `GitHub Release ${archive}`,
        "check the Release's assets: `upload github` may have attached no archive or no checksum for this target",
        "gh",
        [
          "release",
          "download",
          tag,
          "--dir",
          portable(dl),
          "--clobber",
          "--pattern",
          archive,
          "--pattern",
          checksum,
        ],
      );
      const recorded = readFileSync(join(dl, checksum), "utf8").split(/\s+/)[0];
      if (recorded !== sha256(join(dl, archive)))
        throw new Fault(
          `${archive} does not match the checksum published beside it`,
          "re-upload both from one build",
        );
      // Windows' own tar is bsdtar, which reads the .zip; Git's GNU tar does not.
      const tar = WINDOWS
        ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
        : "tar";
      must(
        "extracting the archive",
        "the published archive is unreadable; re-upload it",
        tar,
        ["-xf", join(dl, archive), "-C", dl],
      );
      ownOrEarlier(
        files.find((a) => a.kind === "archive"),
        sha256(join(dl, archive)),
        join(dl, exe),
        "the Release",
        "the GitHub Release archive",
      );
      smoke(join(dl, exe), version, `GitHub Release ${tag} ${target}`);

      if (switchedOn("PYPI_PUBLISH")) {
        const venv = join(work, "venv");
        must("creating a venv", "install Python with venv support", PYTHON, [
          "-m",
          "venv",
          venv,
        ]);
        const bin = join(venv, WINDOWS ? "Scripts" : "bin");
        const index = new URL(`${pypiUrl()}/simple/`);
        const trusted =
          index.protocol === "http:" ? ["--trusted-host", index.hostname] : [];
        retried(
          `PyPI ${WHEEL_PACKAGE} ${version} on ${target}`,
          `check ${pypiUrl()}/project/${WHEEL_PACKAGE}/ — no wheel for this platform may have published`,
          join(bin, "pip"),
          [
            "install",
            "--disable-pip-version-check",
            "--no-cache-dir",
            "--index-url",
            index.href,
            ...trusted,
            `${WHEEL_PACKAGE}==${pep440(version)}`,
          ],
        );
        // Read after the install, which waited for PyPI to serve the wheel; a
        // listing that still omits it is held to this build, which is the one
        // a wheel PyPI took moments ago is.
        const wheel = files.find((a) => a.kind === "wheel");
        ownOrEarlier(
          wheel,
          (await pypiFiles(version)).get(wheel.file),
          join(bin, exe),
          "PyPI",
          "PyPI",
        );
        smoke(
          join(bin, exe),
          version,
          `PyPI ${WHEEL_PACKAGE} ${version} on ${target}`,
        );
      }
      if (new Set(builds.values()).size > 1)
        // Each ran above, so this is not a failure; but a re-run after a
        // partial publish can leave the registries serving more than one
        // build, and whoever reads this release should not have to find out.
        say(
          `release ${job}: ${target} is served as more than one build: ${[
            ...builds,
          ]
            .map(([where, digest]) => `${where} ${digest.slice(0, 12)}…`)
            .join(
              ", ",
            )}; each installs and runs, and each was test-installed by the attempt that built it`,
        );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  say(
    `release ${job}: ${targets.join(", ")} installed from the Release${switchedOn("PYPI_PUBLISH") ? " and PyPI" : ""} and ran${switchedOn("NPM_PUBLISH") ? "; npm's copy is publish's check to wait for" : ""}`,
  );
}

function pairs(name) {
  const value = process.env[name] ?? "";
  const out = {};
  for (const pair of value.split(/\s+/).filter(Boolean)) {
    const match = pair.match(
      /^([a-z][a-z0-9-]*)=(success|failure|cancelled|skipped)$/,
    );
    if (!match)
      throw usage(
        `${name} takes 'name=<success|failure|cancelled|skipped>' pairs, not '${pair}'`,
        `fix the ${name} the workflow passes`,
      );
    out[match[1]] = match[2];
  }
  return out;
}

// Every platform's files, on every switched-on registry, before anything
// platform-independent publishes: the launcher pins every platform package and
// the crate claims the release, so neither goes out while one platform is
// missing. A platform job that did not succeed is missing whatever it left.
//
// Neither package registry serves an upload the moment it takes it. npm lists
// a version minutes after `npm publish` returns — v0.41.1's linux-x64 package
// was taken at 05:22:57 and npm's own `time` for it reads 05:27:10 — and lists
// it before it serves its tarball, so its platform packages are fetched by
// version, as an install fetches them. PyPI's JSON API is served from a cache
// that can still omit a wheel uploaded seconds before: v0.41.1's macOS and
// Windows wheels, taken at 05:25:19 and 05:25:17, were not in it at 05:25:58.
// So a wheel or package a registry does not answer for yet is *late*, not
// missing, and with `wait`, which the phase passes, every late one is waited
// for within one deadline; the uploads' repeat of the check asks each once.
// Only what is late for nothing else is waited for: when a job did not
// succeed, or a Release asset — which GitHub's API answers for at once — is
// missing, the check cannot pass however long it waits, so everything late is
// reported now rather than read as a registry that has not caught up.
function checkBudget() {
  const budget = process.env.RELEASE_CHECK_BUDGET || "900";
  if (!/^\d+$/.test(budget))
    throw usage(
      `RELEASE_CHECK_BUDGET must be a whole number of seconds, not '${budget}'`,
      "set RELEASE_CHECK_BUDGET to whole seconds, or unset it for 900",
    );
  return Number(budget);
}

async function check({ wait = false } = {}) {
  const budget = wait ? checkBudget() : 0;
  const version = cargoVersion();
  const tag = releaseTag(version);
  const pypi = switchedOn("PYPI_PUBLISH");
  const npm = switchedOn("NPM_PUBLISH");
  const missing = [];
  // The jobs' own results, when the workflow hands them over: a job that did
  // not succeed may have published some of its files and verified none.
  if (process.env.BUILD_RESULTS) {
    const results = pairs("BUILD_RESULTS");
    for (const job of Object.keys(PLATFORMS)) {
      const result = results[`build-${job}`] ?? "not reported";
      if (result !== "success") missing.push(`build-${job} (${result})`);
    }
  }
  const assets = githubAssets(tag);
  const wheels = pypi ? await pypiFiles(version) : null;
  const unlisted = [];
  for (const job of Object.keys(PLATFORMS))
    for (const a of plan(job, version).artifacts) {
      if (a.registry === "github" && !assets.has(a.file))
        missing.push(`GitHub Release ${a.file}`);
      if (a.registry === "pypi" && wheels && !wheels.has(a.file))
        unlisted.push(a);
      if (a.registry === "npm" && npm && !npmServes(a.package, version))
        unlisted.push(a);
    }
  const named = (a) =>
    a.registry === "pypi" ? `PyPI ${a.file}` : `npm ${a.package}@${version}`;
  if (missing.length || (!wait && unlisted.length))
    missing.push(...unlisted.map(named));
  else {
    // One deadline for every late wheel and package, so three slow ones
    // cannot take three budgets.
    const deadline = Date.now() + budget * 1000;
    const late = unlisted.filter((a) => a.registry === "pypi");
    if (late.length)
      missing.push(...(await awaitWheels(version, late, deadline)).map(named));
    if (npm) await awaitNpm(version, deadline, missing);
  }
  if (missing.length)
    throw new Fault(
      `not every platform published ${tag}, so nothing platform-independent will: ${missing.join(", ")}`,
      "re-run the failed build job; the publish job publishes once every platform is served",
    );
  say(`release publish: every platform's ${tag} files are served`);
}

// PyPI's JSON for this version, asked again until it lists every wheel in
// `late` or the deadline passes, backing off as scripts/retry-install.sh does.
// Returns the wheels it still did not list. A read that fails, or answers
// something that is not a list of files, is refused as at first rather than
// waited out as a wheel PyPI has not caught up with.
async function awaitWheels(version, late, deadline) {
  const started = Date.now();
  let delay = (deadline - started) / 1000 < 30 ? 1 : 5;
  let pending = late;
  for (let attempt = 1; ; attempt++) {
    const elapsed = Math.round((Date.now() - started) / 1000);
    const names = pending.map((a) => a.file).join(", ");
    if (Date.now() + delay * 1000 > deadline) {
      process.stderr.write(
        `::error::PyPI ${names}: still not listed after ${attempt} reads over ${elapsed}s\n`,
      );
      return pending;
    }
    process.stderr.write(
      `  PyPI does not list ${names} yet after ${elapsed}s; asking again in ${delay}s...\n`,
    );
    await new Promise((done) => setTimeout(done, delay * 1000));
    const listed = await pypiFiles(version);
    pending = pending.filter((a) => !listed.has(a.file));
    if (!pending.length) {
      process.stderr.write(
        `PyPI ${late.map((a) => a.file).join(", ")}: listed after ${Math.round((Date.now() - started) / 1000)}s\n`,
      );
      return [];
    }
    delay = Math.min(delay * 2, 60);
  }
}

// Every platform package fetched by version within the deadline; one npm does
// not serve by then is added to `missing`.
async function awaitNpm(version, deadline, missing) {
  const work = scratch("check-npm");
  try {
    for (const job of Object.keys(PLATFORMS))
      for (const a of plan(job, version).artifacts.filter(
        (artifact) => artifact.registry === "npm",
      )) {
        try {
          retried(
            `npm ${a.package} ${version}`,
            `check that npm serves ${a.package}@${version}: build-${job} published it, so npm took it, but has not served it within the wait`,
            "npm",
            [
              "cache",
              "add",
              "--prefer-online",
              "--cache",
              portable(join(work, a.package)),
              `${a.package}@${version}`,
            ],
            {
              budget: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)),
            },
          );
        } catch (error) {
          if (!(error instanceof Fault)) throw error;
          missing.push(`npm ${a.package}@${version}`);
        }
      }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function buildPublish(out) {
  const { version, artifacts } = plan("publish");
  const tag = releaseTag(version);
  rmSync(out, { recursive: true, force: true });
  for (const dir of ["npm", "npm-artifacts", "assets", "crates"])
    mkdirSync(join(out, dir), { recursive: true });
  for (const mode of ["launcher", "ui"]) {
    const dir = must(
      `assembling the npm ${mode}`,
      "follow the npm-build ACTION above",
      "node",
      ["scripts/npm-build.mjs", mode, "--out", join(out, "npm")],
      { capture: true },
    ).stdout.trim();
    must(
      `packing the npm ${mode}`,
      "inspect npm pack's output",
      "npm",
      ["pack", "--pack-destination", join(out, "npm-artifacts")],
      { cwd: dir, capture: true },
    );
  }
  const target = join(out, "cargo-target");
  must(
    "packaging the crate",
    "fix the packaging error above; `cargo package --list` names what ships",
    "cargo",
    ["package", "--locked", "--no-verify", "--target-dir", target],
  );
  const crate = artifacts.find((a) => a.kind === "crate").file;
  writeFileSync(
    join(out, "crates", crate),
    readFileSync(join(target, "package", crate)),
  );
  must(
    "generating the CycloneDX SBOM",
    "install cargo-cyclonedx 0.5.7 (`just release-tools`), then re-run",
    "cargo",
    [
      "cyclonedx",
      "--format",
      "json",
      "--all",
      "--features",
      "bundled-ui",
      "--target",
      "all",
      "--override-filename",
      "bom",
    ],
  );
  writeFileSync(
    join(out, "assets", `onepipeline-api-${tag}.cdx.json`),
    readFileSync(join(REPO_ROOT, "bom.json")),
  );
  rmSync(join(REPO_ROOT, "bom.json"), { force: true });
  requireStaged(out, artifacts);
  console.log(
    `release publish: assembled ${artifacts.map((a) => a.file).join(", ")}`,
  );
}

async function uploadPublish(out, registry, dryRun) {
  const { version, artifacts } = plan("publish");
  const tag = releaseTag(version);
  const files = artifacts.filter((a) => a.registry === registry);
  if (!files.length)
    throw usage(
      `the publish job publishes nothing to '${registry}'`,
      "upload crate, npm or github",
    );
  if (!dryRun) {
    quiet = true;
    await check();
    quiet = false;
  }
  requireStaged(out, files);
  const published = [];
  if (registry === "crate") {
    if (!crateSwitchedOn()) {
      console.log(
        "release publish: CARGO_REGISTRY_TOKEN is not set; the crate is not published",
      );
      return;
    }
    if (!dryRun && (await crateServes(version))) {
      console.log(
        `release publish: ${CRATE} ${version} is already on the crate registry`,
      );
      return;
    }
    const flags = (process.env.RELEASE_CARGO_PUBLISH_FLAGS ?? "")
      .split(/\s+/)
      .filter(Boolean);
    if (announce(dryRun, "cargo", ["publish", "--locked", ...flags])) {
      must(
        "cargo publish",
        "fix the error above and re-run this job; a version already live is skipped",
        "cargo",
        ["publish", "--locked", ...flags],
        { env: { RUSTFLAGS: "-D warnings" } },
      );
      published.push(files[0].file);
    }
  } else if (registry === "npm") {
    // The launcher pins every platform package `check` just found, so it is
    // installable the moment it is live.
    for (const a of files) {
      const path = stagedPath(out, a);
      if (dryRun) {
        announce(dryRun, "bash", ["scripts/publish-npm.sh", path]);
        continue;
      }
      if (npmServes(a.package, version)) continue;
      // A version an earlier attempt of this job published and npm does not
      // serve yet is waited for, as a platform job's is.
      if (await publishNpm(a, path, version, tag, `publishing ${a.file}`))
        published.push(a.file);
    }
  } else {
    const served = dryRun ? new Set() : githubAssets(tag);
    for (const a of files)
      if (
        !served.has(a.file) &&
        announce(dryRun, "gh", ["release", "upload", tag, stagedPath(out, a)])
      ) {
        must(
          `uploading ${a.file}`,
          "re-run this job; assets already attached are skipped",
          "gh",
          ["release", "upload", tag, stagedPath(out, a)],
        );
        published.push(a.file);
      }
  }
  say(
    dryRun
      ? `release publish: dry run — ${registry} would run: ${wouldRun.join("; ")}`
      : `release publish: ${registry} published ${published.join(", ") || "nothing new"}`,
  );
}

// What release-targets.toml declares, read the way its consumers read it: with a
// standard TOML parser and no knowledge of this repository.
function declaredTargets() {
  const program =
    "import json,tomllib\nwith open('release-targets.toml','rb') as f: print(json.dumps([t['id'] for t in tomllib.load(f)['target']]))";
  return JSON.parse(
    must(
      "reading release-targets.toml",
      "restore a release-targets.toml whose every [[target]] has an id",
      PYTHON,
      ["-c", program],
      { capture: true },
    ).stdout,
  );
}

function probe(id) {
  return run("bash", ["scripts/release-probe.sh", id], { capture: true });
}

// The question a consumer waiting on this release asks, asked of the registries
// it was just published to: every declared target on a switched-on registry
// answers this version. Then the probe's other two answers, which only a live
// registry can give: a name nobody released is answered empty, and an
// identifier it cannot read is refused rather than answered.
// Returns what each declared target answered, for the one success line.
export function probeDeclaredTargets(version) {
  const answers = [];
  const live = {
    crate: crateSwitchedOn(),
    pypi: switchedOn("PYPI_PUBLISH"),
    npm: switchedOn("NPM_PUBLISH"),
  };
  for (const id of declaredTargets()) {
    const answer = probe(id);
    if (answer.status !== 0) {
      process.stderr.write(answer.stderr);
      throw new Fault(
        `the release probe could not establish what ${id} serves`,
        "re-run when the registry is reachable",
      );
    }
    const served = answer.stdout.trim();
    // Each registry in its own spelling of this version: PyPI's is PEP 440's
    // (`1.2.3rc1`), and on npm or crates.io that is another version entirely.
    const registry = id.split(":")[0];
    const expected = registry === "pypi" ? pep440(version) : version;
    // A probe answers a registry's newest release, so a prerelease cut by hand
    // behind a newer stable one fails here too, and is demoted as unpublished:
    // that is what a consumer waiting on it would be told.
    if (live[registry] && served !== expected)
      throw new Fault(
        `the release probe answers ${served || "nothing"} for ${id}, not ${expected}`,
        "check that registry for the version this release published",
      );
    answers.push(`${id} -> ${served || "nothing yet"}`);
  }
  for (const registry of ["crate", "pypi", "npm"]) {
    const id = `${registry}:onepipeline-ui-has-never-been-published`;
    const answer = probe(id);
    if (answer.status !== 0 || answer.stdout.trim())
      throw new Fault(
        `the release probe answered '${answer.stdout.trim()}' (exit ${answer.status}) for ${id}: ${answer.stderr.trim() || "no diagnostic"}`,
        "a name nobody released must be answered empty; check the registry and the probe",
      );
  }
  for (const id of [
    "onepipeline-ui",
    "docker:onepipeline-ui",
    "npm:Not A Package",
  ])
    if (probe(id).status === 0)
      throw new Fault(
        `the release probe answered ${id} instead of refusing it`,
        "fix scripts/release-probe.sh's identifier checks",
      );
  return answers;
}

async function verifyPublish(out) {
  const { version, artifacts } = plan("publish");
  const tag = releaseTag(version);
  const sbom = artifacts.find((a) => a.kind === "sbom").file;
  if (!githubAssets(tag).has(sbom))
    throw new Fault(
      `the Release has no ${sbom}`,
      "re-run this job's upload github",
    );
  if (crateSwitchedOn() && !(await crateServes(version)))
    throw new Fault(
      `the crate index does not list ${CRATE} ${version}`,
      "re-run this job's upload crate",
    );
  if (switchedOn("NPM_PUBLISH")) {
    // The frontend, installed as a consumer installs it, carries the bundle
    // this job built and packed. The install is retried until npm serves it,
    // and is the only question asked of npm about it: npm lists a publish minutes
    // after taking it, so v0.41.0's single `npm view`, six seconds after
    // `upload npm` returned, refused a frontend whose npm `time` is 97 seconds
    // after the upload.
    const frontend = scratch("verify-frontend");
    try {
      retried(
        `npm onepipeline-ui ${version}`,
        "check that npm serves the frontend package at this version; if it never took it, re-run this job's upload npm",
        "npm",
        [
          "install",
          "--prefix",
          portable(frontend),
          "--prefer-online",
          "--no-audit",
          "--no-fund",
          "--cache",
          portable(join(frontend, ".cache")),
          `onepipeline-ui@${version}`,
        ],
      );
      const index = (root) =>
        join(root, "onepipeline-ui", "dist", "index.html");
      const installed = index(join(frontend, "node_modules"));
      if (
        !existsSync(installed) ||
        !readFileSync(installed).equals(readFileSync(index(join(out, "npm"))))
      )
        throw new Fault(
          `npm's onepipeline-ui@${version} does not carry the frontend this release built`,
          "re-publish the frontend package from this job's build",
        );
    } finally {
      rmSync(frontend, { recursive: true, force: true });
    }
    const work = scratch("verify-launcher");
    // The platform package this host's install pulls in beside the launcher;
    // an install that skipped it has not installed anything that runs.
    const own = Object.values(TARGETS).find(
      (facts) => facts.npm === `${process.platform}-${process.arch}`,
    );
    try {
      retried(
        `npm ${WHEEL_PACKAGE} ${version}`,
        "check that npm serves the launcher and this platform's package at this version",
        "npm",
        [
          "install",
          "--prefix",
          portable(work),
          "--prefer-online",
          "--no-audit",
          "--no-fund",
          "--cache",
          portable(join(work, ".cache")),
          `${WHEEL_PACKAGE}@${version}`,
        ],
        own && {
          require: join(
            work,
            "node_modules",
            `${WHEEL_PACKAGE}-${own.npm}`,
            "package.json",
          ),
        },
      );
      smoke(npmLauncher(work).bash, version, `npm ${WHEEL_PACKAGE} ${version}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  const answers = probeDeclaredTargets(version);
  console.log(
    `release publish: ${tag}'s platform-independent artifacts are served; the release probe answers ${answers.join(", ")}`,
  );
}

function settle() {
  const version = cargoVersion();
  const results = { ...pairs("BUILD_RESULTS"), ...pairs("STEP_RESULTS") };
  const status = run("bash", ["scripts/release-status.sh"], {
    inherit: true,
    env: {
      RELEASE_TAG: releaseTag(version),
      JOB_RESULTS:
        Object.entries(results)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ") || "none=skipped",
      EXPECT_CRATE: crateSwitchedOn() ? "true" : "false",
      EXPECT_NPM: switchedOn("NPM_PUBLISH") ? "true" : "false",
    },
  });
  // A status script stopped by a signal has no exit status and printed no
  // verdict, so it is a failure of its own rather than an exit code of null,
  // which would end this phase as a success.
  if (status.signal)
    throw new Fault(
      `scripts/release-status.sh was stopped by ${status.signal} before it decided the release`,
      "re-run the publish job; settle decides again from the same results",
    );
  if (status.status !== 0)
    throw new Fault(
      "the release did not publish",
      "see release-status's ACTION above",
      status.status,
    );
}

// Every phase that stages files starts by deleting --out, so it is held to the
// build tree: a directory under the checkout's target/, never the checkout, an
// ancestor of it, or anything else a mistyped argument could name.
// Containment is checked on real paths — the nearest existing ancestor
// resolved through any symlink — so a link under target/ cannot carry the
// deletion somewhere else.
function stagingDirectory(path) {
  const refuse = () =>
    usage(
      `--out ${path} is not a directory under ${join(REPO_ROOT, "target")}`,
      "pass an --out under the checkout's target/, which the build may delete and recreate",
    );
  const target = join(REPO_ROOT, "target");
  mkdirSync(target, { recursive: true });
  const out = resolve(path);
  let existing = out;
  const rest = [];
  while (!existsSync(existing)) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  const realTarget = realpathSync(target);
  const own = relative(realpathSync(REPO_ROOT), realTarget);
  if (own !== "target") throw refuse();
  const real = join(realpathSync(existing), ...rest);
  const inside = relative(realTarget, real);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw refuse();
  if (existsSync(out) && lstatSync(out).isSymbolicLink()) throw refuse();
  return out;
}

async function main(argv) {
  const [job, phase, ...rest] = argv;
  const jobs = [...Object.keys(PLATFORMS), "publish"];
  if (!jobs.includes(job))
    throw usage(
      `unknown job ${job ?? "(none)"}`,
      `pass one of ${jobs.join(", ")}`,
    );
  let out = stagingDirectory(join(REPO_ROOT, "target", "release-dist", job));
  let version;
  let dryRun = false;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--out" || arg === "--version") {
      if (rest[i + 1] === undefined)
        throw usage(`${arg} needs a value`, `give ${arg} a value`);
      if (arg === "--out") out = stagingDirectory(rest[++i]);
      else version = rest[++i];
    } else if (arg.startsWith("--"))
      throw usage(
        `unknown option ${arg}`,
        "pass --out DIR, --version X.Y.Z (plan) or --dry-run",
      );
    else positional.push(arg);
  }
  // Only the phases that publish can be rehearsed; a dry-run build or verdict
  // would still stage files or rewrite the Release.
  if (dryRun && phase !== "upload" && phase !== "all")
    throw usage(
      `--dry-run is taken by upload and all, not ${phase}`,
      "omit --dry-run, or rehearse with upload <registry> --dry-run or all --dry-run",
    );
  if (version !== undefined && (phase !== "plan" || !VERSION.test(version)))
    throw usage(
      "--version X.Y.Z is taken by the plan phase alone",
      "omit it; every other phase releases Cargo.toml's version",
    );
  const platform = job !== "publish";
  const registries = platform
    ? ["github", "pypi", "npm"]
    : ["crate", "npm", "github"];
  const takesRegistry = phase === "upload";
  if (
    takesRegistry
      ? positional.length !== 1 || !registries.includes(positional[0])
      : positional.length
  )
    throw usage(
      `'${[phase, ...positional].join(" ")}' is not a ${job} phase`,
      `pass upload <${registries.join("|")}>, or a phase without arguments`,
    );

  switch (`${platform ? "platform" : "publish"}:${phase}`) {
    case "platform:plan":
    case "publish:plan":
      process.stdout.write(`${JSON.stringify(plan(job, version), null, 2)}\n`);
      return;
    case "platform:build":
      return buildPlatform(job, out);
    case "platform:test-install":
      return testInstall(job, out);
    case "platform:upload":
      return uploadPlatform(job, out, positional[0], dryRun);
    case "platform:verify":
      return verifyPlatform(job, out);
    case "platform:all": {
      if (!dryRun)
        throw usage(
          "all is the rehearsal, and needs --dry-run",
          "pass --dry-run; a release runs each phase as its own workflow step",
        );
      quiet = true;
      buildPlatform(job, out);
      testInstall(job, out);
      const registries = ["github"];
      if (switchedOn("PYPI_PUBLISH")) registries.push("pypi");
      if (switchedOn("NPM_PUBLISH")) registries.push("npm");
      for (const registry of registries)
        await uploadPlatform(job, out, registry, dryRun);
      quiet = false;
      say(
        `release ${job}: built, installed and ran ${plan(job).targets.join(", ")}; dry run — registry verification skipped, nothing was published; it would run: ${wouldRun.join("; ")}`,
      );
      return;
    }
    case "publish:check":
      return check({ wait: true });
    case "publish:build":
      return buildPublish(out);
    case "publish:upload":
      return uploadPublish(out, positional[0], dryRun);
    case "publish:verify":
      return verifyPublish(out);
    case "publish:settle":
      return settle();
    default:
      throw usage(
        `unknown ${job} phase ${phase ?? "(none)"}`,
        platform
          ? "pass plan, build, test-install, upload <github|pypi|npm>, verify or all"
          : "pass plan, check, build, upload <crate|npm|github>, verify or settle",
      );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const fault =
      error instanceof Fault
        ? error
        : new Fault(
            `${error.message}\n${error.stack}`,
            error.path
              ? `${error.code ?? "a filesystem error"} on ${error.path}: repair that path (every parent a directory, the file present, writable by this user; it is under the --out directory or target/), then re-run \`node scripts/release.mjs ${process.argv.slice(2).join(" ")}\``
              : `this is a defect in scripts/release.mjs, not in the release's inputs: the stack above names the line; re-run \`node scripts/release.mjs ${process.argv.slice(2).join(" ")}\` once it is fixed`,
          );
    console.error(`release: ${fault.message}`);
    console.error(`ACTION: ${fault.action}`);
    process.exitCode = fault.exitCode;
  }
}
