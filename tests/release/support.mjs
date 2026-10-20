// What the release journeys share: a scratch directory, the registry and `gh`
// doubles, and the environment that points the real release recipes at them.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOUBLES = join(ROOT, "tests/release/doubles");

export function scratch(name) {
  const root = process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir();
  return mkdtempSync(join(root, `release-journey-${name}-`));
}

export const version = () =>
  readFileSync(join(ROOT, "Cargo.toml"), "utf8").match(
    /^\[package\][\s\S]*?^version = "([^"]+)"/m,
  )[1];

// A GitHub Release `tag` with notes, as release-plz leaves one, behind a `gh`
// double on a PATH directory of its own.
export function githubDouble(dir, tag, notes = "### Added\n\n- the release\n") {
  const state = join(dir, "gh");
  const bin = join(dir, "gh-bin");
  mkdirSync(join(state, "releases", tag, "assets"), { recursive: true });
  mkdirSync(join(state, "fail"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(state, "releases", tag, "body"), notes);
  writeFileSync(join(state, "releases", tag, "prerelease"), "false");
  writeFileSync(join(state, "calls.log"), "");
  chmodSync(join(DOUBLES, "gh.mjs"), 0o755);
  symlinkSync(join(DOUBLES, "gh.mjs"), join(bin, "gh"));
  const release = join(state, "releases", tag);
  return {
    state,
    bin,
    assets: join(release, "assets"),
    calls: () =>
      readFileSync(join(state, "calls.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    uploads: function () {
      return this.calls().filter(
        (c) => c[0] === "release" && c[1] === "upload",
      );
    },
    body: () => readFileSync(join(release, "body"), "utf8"),
    prerelease: () =>
      readFileSync(join(release, "prerelease"), "utf8").trim() === "true",
    failUploads: (file) => writeFileSync(join(state, "fail", file), ""),
    healUploads: () => {
      rmSync(join(state, "fail"), { recursive: true, force: true });
      mkdirSync(join(state, "fail"));
    },
  };
}

// The registry doubles, as a process of their own: the journeys spawn the
// release recipes synchronously, and a server in this process could not answer
// while they wait.
export async function registryDoubles(dir) {
  const state = join(dir, "registries");
  mkdirSync(state, { recursive: true });
  const child = spawn(
    process.execPath,
    [join(DOUBLES, "registries.mjs"), state],
    {
      stdio: "inherit",
    },
  );
  // It mints two RSA keys before it listens, which on a loaded host takes
  // longer than five seconds, so it is given thirty.
  for (let i = 0; i < 600 && !existsSync(join(state, "port")); i++)
    await sleep(50);
  const port = readFileSync(join(state, "port"), "utf8");
  const base = `http://127.0.0.1:${port}`;
  const control = (name, entries) =>
    writeFileSync(join(state, "control", name), entries.join("\n"));
  return {
    state,
    base,
    npm: `${base}/npm/`,
    // What points a client at the GitHub API double instead of GitHub.
    forgeEnv: {
      HTTPS_PROXY: `http://127.0.0.1:${readFileSync(join(state, "proxy-port"), "utf8")}`,
      https_proxy: `http://127.0.0.1:${readFileSync(join(state, "proxy-port"), "utf8")}`,
      SSL_CERT_FILE: join(state, "tls", "ca.pem"),
    },
    uploads: () =>
      existsSync(join(state, "uploads.log"))
        ? readFileSync(join(state, "uploads.log"), "utf8")
            .split("\n")
            .filter(Boolean)
        : [],
    failUploads: (file) =>
      writeFileSync(join(state, "control", "fail", file), ""),
    served: () =>
      existsSync(join(state, "served.log"))
        ? readFileSync(join(state, "served.log"), "utf8")
            .split("\n")
            .filter(Boolean)
        : [],
    hide: (entries) => control("hide", entries),
    unserve: (entries) => control("unserved", entries),
    stage: (entries) => control("stage", entries),
    // A maintainer approving every version npm staged: each is published as
    // it was staged, and npm serves it from then on.
    approveStaged: () => {
      const held = join(state, "npm-staged");
      for (const file of readdirSync(held).filter((f) => f.endsWith(".json"))) {
        const { packageName, version, manifest } = JSON.parse(
          readFileSync(join(held, file), "utf8"),
        );
        const { dist: _dist, ...rest } = manifest;
        mkdirSync(join(state, "npm", packageName), { recursive: true });
        renameSync(
          join(held, file.replace(/\.json$/, ".tgz")),
          join(state, "npm", packageName, `${version}.tgz`),
        );
        writeFileSync(
          join(state, "npm", packageName, `${version}.json`),
          JSON.stringify(rest),
        );
        rmSync(join(held, file));
      }
    },
    corrupt: (entries) => control("corrupt", entries),
    breakReads: (entries) => control("broken", entries),
    clear: () => {
      for (const name of [
        "hide",
        "unserved",
        "stage",
        "corrupt",
        "broken",
        "fail",
      ])
        rmSync(join(state, "control", name), { recursive: true, force: true });
      mkdirSync(join(state, "control", "fail"));
    },
    close: () =>
      new Promise((done) => {
        child.once("exit", done);
        child.kill("SIGTERM");
      }),
  };
}

// The environment a release job hands its recipe, pointed at the doubles. Only
// the runner context is dropped — a journey must not inherit the ref of
// whatever CI run it happens to be in — and the release tools `just
// release-tools` provisions come first on PATH.
export function releaseEnv({ gh, registries, home, extra = {} }) {
  const npmrc = join(home, "npmrc");
  const token = "double-token";
  writeFileSync(
    npmrc,
    `${registries.npm.replace(/^https?:/, "")}:_authToken=\${NODE_AUTH_TOKEN}\n`,
  );
  const path = [
    gh.bin,
    join(ROOT, ".tools/release-venv/bin"),
    join(ROOT, ".tools/bin"),
    process.env.PATH,
  ].join(":");
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("GITHUB_") &&
          !key.startsWith("NPM_CONFIG_") &&
          !key.startsWith("npm_config_") &&
          ![
            "RELEASE_TAG",
            "CARGO_REGISTRY_TOKEN",
            "BUILD_RESULTS",
            "STEP_RESULTS",
          ].includes(key),
      ),
    ),
    PATH: path,
    GH_DOUBLE_STATE: gh.state,
    RELEASE_TAG: `v${version()}`,
    PYPI_PUBLISH: "true",
    NPM_PUBLISH: "true",
    PYPI_TOKEN: token,
    NODE_AUTH_TOKEN: token,
    CARGO_REGISTRY_TOKEN: token,
    RELEASE_PYPI_URL: registries.base,
    RELEASE_PYPI_UPLOAD_URL: `${registries.base}/legacy/`,
    RELEASE_CRATES_INDEX: `${registries.base}/index`,
    RELEASE_CRATES_API: registries.base,
    RELEASE_CARGO_PUBLISH_FLAGS: `--index sparse+${registries.base}/index/ --token ${token} --no-verify`,
    NPM_CONFIG_REGISTRY: registries.npm,
    NPM_CONFIG_USERCONFIG: npmrc,
    NPM_CONFIG_CACHE: join(home, "npm-cache"),
    PIP_CONFIG_FILE: "/dev/null",
    // npm retries a failed fetch twice, at 10 s and then 60 s, and pacote
    // repeats that over its own retries: a journey that serves a corrupt
    // tarball or answers a publish with a 500 waited minutes on that backoff.
    // The same retries, at a local double's pace.
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: "100",
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: "500",
    RELEASE_VERIFY_BUDGET: "6",
    RELEASE_CHECK_BUDGET: "6",
    ...extra,
  };
}

// The same recipe left running, for a journey that changes what a registry
// serves while the recipe waits on it: resolves once it exits. `output()` is
// what it has printed so far and `exited()` whether it has, so a journey can
// change the registry once the recipe says it is waiting rather than after a
// guessed delay.
export function recipeRunning(job, args, env) {
  const child = spawn("just", [`release-${job}`, ...args], { cwd: ROOT, env });
  let stdout = "";
  let stderr = "";
  let exited = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const running = new Promise((done) =>
    child.once("exit", (status) => {
      exited = true;
      done({ status, stdout, stderr, output: `${stdout}\n${stderr}` });
    }),
  );
  running.output = () => `${stdout}\n${stderr}`;
  running.exited = () => exited;
  return running;
}

export function recipe(job, args, env) {
  const result = spawnSync("just", [`release-${job}`, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}\n${result.stderr}`,
  };
}
