// The main-push cache warmer (`.github/workflows/ci-cache.yml`) against the four
// pull-request jobs it keeps warm.
//
// Pull requests restore the Rust build the warmer saves on `main` and save none
// of their own, so two things decide whether a pull request finds its build: the
// warmer saves under the key, and the paths, the job restores; and it compiles
// what the job compiles, with the same cargo arguments and target directories.
// The first is read off the workflow files. The second is read off the real
// sources: every task each job's targets reach in the real Nx graph (over every
// project, the superset of any affected selection), its command, and the justfile
// recipes that command runs, as `just --dry-run` prints them — held to the
// warmer's own `scripts/ci-warm.sh <os> --plan`, both ways round.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  copyProblems,
  LEG_FAMILIES,
  parsePins,
  pinProblems,
  retentionProblems,
} from "./cache-retention.mjs";

const load = () =>
  Object.fromEntries(
    readdirSync(".github/workflows")
      .filter((file) => /\.ya?ml$/.test(file))
      .map((file) => [
        file,
        parse(readFileSync(`.github/workflows/${file}`, "utf8")),
      ]),
  );

const WARMED = {
  linux: { warm: "warm-linux", jobs: ["lint", "test-linux"] },
  windows: { warm: "warm-windows", jobs: ["test-windows"] },
  macos: { warm: "warm-macos", jobs: ["test-macos"] },
};
// The rust-cache keys `main` already holds, saved by the pull-request jobs of
// the base workflow keyed by their job ids, before the warmer existed: read off
// the repository's cache list, `v0-rust-test-linux-Linux-x64-ff458983-72370637`
// and `v0-rust-test-windows-Windows_NT-x64-694142f9-72370637` (2026-11-01; no
// base job saved a macOS build). Each OS's shared key is that name, so a pull
// request restores main's existing build until the warmer has saved its own
// under the same key.
const MAIN_KEYS = {
  linux: "test-linux",
  windows: "test-windows",
  macos: "test-macos",
};
// What rust-cache hashes into the key besides the shared key: every installed
// toolchain and every CARGO*/RUST* variable. A step that installs a toolchain or
// exports one, ahead of the cache step, gives that job a key no other job has.
const changesRustHash = (step) =>
  (step.uses ?? "").startsWith("dtolnay/rust-toolchain@") ||
  /\brustup\b/.test(step.run ?? "");
const hashedBeforeToolchains = (job) => {
  const steps = job?.steps ?? [];
  const cache = steps.findIndex((s) =>
    (s.uses ?? "").startsWith("Swatinem/rust-cache@"),
  );
  return cache < 0 || !steps.slice(0, cache).some(changesRustHash);
};
const OS_OF = { ubuntu: "linux", windows: "windows", macos: "macos" };
const osOf = (runner) => OS_OF[String(runner).split("-")[0]];
const rustCaches = (job) =>
  (job?.steps ?? []).filter((s) =>
    (s.uses ?? "").startsWith("Swatinem/rust-cache@"),
  );

export function warmCacheProblems(workflows) {
  const problems = [];
  const ci = workflows["ci.yml"]?.jobs ?? {};
  const warmer = workflows["ci-cache.yml"];
  const pushOnly =
    JSON.stringify(warmer?.on) === '{"push":{"branches":["main"]}}';
  if (!pushOnly)
    problems.push("ci-cache.yml does not run on push to main alone");
  // rust-cache hashes the workflow's environment into its key.
  if (
    JSON.stringify(warmer?.env ?? {}) !==
    JSON.stringify(workflows["ci.yml"]?.env ?? {})
  )
    problems.push("ci-cache.yml's env is not ci.yml's, so its keys differ");
  for (const [os, { warm, jobs }] of Object.entries(WARMED)) {
    const job = warmer?.jobs?.[warm];
    if (!job) {
      problems.push(`ci-cache.yml has no ${warm} job`);
      continue;
    }
    if (osOf(job["runs-on"]) !== os)
      problems.push(`${warm} runs on ${job["runs-on"]}, not ${os}`);
    if (
      (job.steps ?? []).some((s) => /\bjust ci-(lint|test-)/.test(s.run ?? ""))
    )
      problems.push(`${warm} runs a pull-request job's checks`);
    if (
      !(job.steps ?? []).some(
        (s) => (s.run ?? "").trim() === `just ci-warm-${os}`,
      )
    )
      problems.push(`${warm} does not run 'just ci-warm-${os}'`);
    const [saved, ...more] = rustCaches(job);
    if (!saved || more.length)
      problems.push(`${warm} does not have exactly one rust-cache step`);
    else if (saved.with?.["save-if"] === false)
      problems.push(`${warm} does not save its build`);
    if (saved && saved.with?.["shared-key"] !== MAIN_KEYS[os])
      problems.push(
        `${warm} saves under ${JSON.stringify(saved.with?.["shared-key"])}, not ${MAIN_KEYS[os]}, the key main's existing build carries`,
      );
    if (!hashedBeforeToolchains(job))
      problems.push(
        `${warm} installs a toolchain before its rust-cache step, so its key's hash is its own`,
      );
    for (const id of jobs) {
      const pr = ci[id];
      if (!pr) continue;
      if (osOf(pr["runs-on"]) !== os)
        problems.push(`${id} runs on ${pr["runs-on"]}, not ${os}`);
      const restored = rustCaches(pr);
      if (restored.length !== 1) {
        problems.push(`${id} does not restore exactly one Rust build`);
        continue;
      }
      if (!hashedBeforeToolchains(pr))
        problems.push(
          `${id} installs a toolchain before its rust-cache step, so its key's hash is its own`,
        );
      const { "save-if": restoreSave, ...restoreWith } = restored[0].with ?? {};
      const { "save-if": _, ...saveWith } = saved?.with ?? {};
      if (restoreSave !== false) problems.push(`${id} saves a Rust cache`);
      if (restored[0].uses !== saved?.uses)
        problems.push(
          `${id} restores with ${restored[0].uses}, ${warm} saves with ${saved?.uses}`,
        );
      // The same key and the same paths: rust-cache derives both from these.
      if (JSON.stringify(restoreWith) !== JSON.stringify(saveWith))
        problems.push(
          `${id} restores ${JSON.stringify(restoreWith)}, which ${warm} does not save (${JSON.stringify(saveWith)})`,
        );
    }
  }
  // No pull-request job saves a Rust cache, of any kind.
  for (const [id, job] of Object.entries(ci))
    for (const step of job.steps ?? []) {
      const uses = step.uses ?? "";
      if (
        uses.startsWith("Swatinem/rust-cache@") &&
        step.with?.["save-if"] !== false
      )
        problems.push(`${id} saves a Rust cache`);
      if (/^actions\/cache(\/save)?@/.test(uses))
        problems.push(`${id} saves ${String(step.with?.path ?? "").trim()}`);
    }
  return problems;
}

test("each OS's warm job saves the build its pull-request jobs restore, and none saves its own", () => {
  assert.deepEqual(warmCacheProblems(load()), []);
});

test("a warm key no pull-request job restores, or a pull-request job saving, is refused", () => {
  const cases = [
    [
      (w) => {
        rustCaches(w["ci-cache.yml"].jobs["warm-windows"])[0].with[
          "shared-key"
        ] = "other";
      },
      /^test-windows restores .*"shared-key":"test-windows".*, which warm-windows does not save/,
    ],
    [
      (w) => {
        rustCaches(w["ci.yml"].jobs["test-macos"])[0].with["shared-key"] =
          "test-linux";
      },
      /^test-macos restores .*test-linux.*, which warm-macos does not save/,
    ],
    [
      (w) => {
        delete rustCaches(w["ci.yml"].jobs.lint)[0].with["save-if"];
      },
      /^lint saves a Rust cache$/,
    ],
    [
      (w) => {
        w["ci.yml"].jobs["test-linux"].steps.push({
          uses: "actions/cache/save@v4",
          with: { path: "target", key: "k" },
        });
      },
      /^test-linux saves target$/,
    ],
    [
      (w) => {
        rustCaches(w["ci-cache.yml"].jobs["warm-linux"])[0].with["save-if"] =
          false;
      },
      /^warm-linux does not save its build$/,
    ],
    [
      (w) => {
        for (const job of [
          w["ci-cache.yml"].jobs["warm-windows"],
          w["ci.yml"].jobs["test-windows"],
        ])
          rustCaches(job)[0].with["shared-key"] = "warm-windows";
      },
      /^warm-windows saves under "warm-windows", not test-windows, the key main's existing build carries$/,
    ],
    [
      (w) => {
        const steps = w["ci.yml"].jobs.lint.steps;
        const cache = steps.findIndex((s) =>
          (s.uses ?? "").startsWith("Swatinem/rust-cache@"),
        );
        steps.splice(cache, 0, {
          uses: "dtolnay/rust-toolchain@master",
          with: { toolchain: "1.97" },
        });
      },
      /^lint installs a toolchain before its rust-cache step/,
    ],
    [
      (w) => {
        w["ci-cache.yml"].jobs["warm-linux"].steps.splice(1, 0, {
          run: "rustup toolchain install 1.97",
        });
      },
      /^warm-linux installs a toolchain before its rust-cache step/,
    ],
    [
      (w) => {
        w["ci-cache.yml"].env = {};
      },
      /^ci-cache.yml's env is not ci.yml's/,
    ],
    [
      (w) => {
        delete w["ci-cache.yml"].jobs["warm-macos"];
      },
      /^ci-cache.yml has no warm-macos job$/,
    ],
    [
      (w) => {
        w["ci-cache.yml"].on.pull_request = {};
      },
      /^ci-cache.yml does not run on push to main alone$/,
    ],
  ];
  for (const [mutate, expected] of cases) {
    const workflows = structuredClone(load());
    mutate(workflows);
    const problems = warmCacheProblems(workflows);
    assert.ok(
      problems.some((p) => expected.test(p)),
      `${expected}: ${problems}`,
    );
  }
});

// Shell words, enough for the justfile's and the plan's command lines: quotes
// group and are removed, and nothing is expanded.
export function words(line) {
  const out = [];
  let word = null;
  let quote = null;
  let escaped = false;
  for (const c of line) {
    if (escaped) {
      word = (word ?? "") + c;
      escaped = false;
    } else if (c === "\\" && quote !== "'") {
      escaped = true;
      word ??= "";
    } else if (quote) {
      if (c === quote) quote = null;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (/\s/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
    } else word = (word ?? "") + c;
  }
  if (word !== null) out.push(word);
  return out;
}

// The environment that changes what cargo compiles; any other assignment in
// front of a command (a nextest profile, a profile file name) selects or names
// what runs.
const COMPILE_ENV = new Set([
  "RUSTFLAGS",
  "RUSTDOCFLAGS",
  "CARGO_ENCODED_RUSTFLAGS",
]);
// Arguments that decide which tests run or how they report, never what is built.
const RUN_ONLY = new Set([
  "--status-level",
  "--final-status-level",
  "-E",
  "--test",
]);
const RUN_ONLY_FLAGS = new Set(["--no-run", "--no-tests=pass"]);

// One compile's signature, or null when the words are not a compile of this
// crate: the compile environment, then the command with what only selects or
// reports runs removed, so a line that runs tests and the warm line that only
// builds them read alike.
export function compileSignature(tokens) {
  const env = [];
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) {
    const [name] = tokens[i].split("=", 1);
    if (COMPILE_ENV.has(name)) env.push(tokens[i]);
    i += 1;
  }
  if (tokens[i] === "env") i += 1;
  if (tokens[i] === "nice" && tokens[i + 1] === "-n") i += 3;
  let rest = tokens.slice(i);
  // A coverage unit is `cargo llvm-cov --no-report <its arguments>` by contract
  // (scripts/coverage-unit.sh), and reads alike to the warm line that compiles it.
  // Its `--cargo` form is that build with cargo's own arguments, so `nextest run` there is
  // llvm-cov's `nextest`.
  if (rest[0] === "bash" && rest[1] === "scripts/coverage-unit.sh") {
    const split = rest.indexOf("--");
    let args = rest.slice(split + 1);
    if (rest[2] === "--cargo" && args[0] === "nextest" && args[1] === "run")
      args = ["nextest", ...args.slice(2)];
    rest = ["cargo", "llvm-cov", ...args, "--no-report"];
  }
  if (rest[0] === "just" && rest[1] === "wheel-linux")
    return [...env, ...rest].join(" ");
  if (rest[0] === "maturin" && rest[1] === "build")
    return [...env, ...rest].join(" ");
  if (rest[0] !== "cargo") return null;
  let at = 1;
  if ((rest[at] ?? "").startsWith("+")) at += 1;
  const sub = rest.slice(at, at + 2).join(" ");
  const compiles =
    ["build", "check", "clippy", "doc", "test"].includes(rest[at]) ||
    sub === "nextest run" ||
    sub === "llvm-cov nextest" ||
    sub === "auditable build" ||
    (rest[at] === "install" && rest.includes("--path"));
  if (!compiles) return null;
  const kept = [];
  const testing = sub === "nextest run" || sub === "llvm-cov nextest";
  for (let k = 0; k < rest.length; k += 1) {
    if (testing && RUN_ONLY.has(rest[k])) {
      k += 1;
      continue;
    }
    if (testing && RUN_ONLY_FLAGS.has(rest[k])) continue;
    kept.push(rest[k]);
  }
  return [...env, ...kept].join(" ");
}

// The compiles in one recipe body or command: each `&&`/`||`/`;` segment of
// each logical line, with a nested `just <recipe>` followed through.
function lineSegments(text) {
  return text
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim().replace(/^@/, ""))
    .map(evaluated)
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => line.split(/\s*(?:&&|\|\||;)\s*/))
    .map((segment) => segment.replace(/^\{\s*/, "").trim())
    .filter(Boolean);
}

// A dry run prints a variable defined by a backtick expression as that
// expression; this puts back the value `just --evaluate` gives it.
let backticks;
function evaluated(line) {
  if (!backticks) {
    const values = Object.fromEntries(
      just(["--evaluate"])
        .split("\n")
        .map((row) => row.match(/^(\S+)\s+:= "(.*)"$/))
        .filter(Boolean)
        .map(([, name, value]) => [name, value]),
    );
    backticks = readFileSync("justfile", "utf8")
      .split("\n")
      .map((row) => row.match(/^([a-z][\w-]*) := (`.*`)$/))
      .filter(Boolean)
      .map(([, name, expression]) => [expression, values[name]]);
  }
  let out = line;
  for (const [expression, value] of backticks)
    out = out.split(expression).join(value);
  return out;
}

const just = (args) =>
  execFileSync("just", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

// `just --dry-run` prints a recipe's lines with every expression evaluated for
// this host, Linux. The install's build directory is the one expression that
// differs by OS, so for the others it is read off the recipe's own text.
function installBuildDir(os) {
  const text = just(["--show", "_crate-install-build"]);
  const match = text.match(
    /build\.build-dir="\{\{ if os\(\) == "linux" \{ "([^"]+)" \} else \{ "([^"]+)" \} \}\}"/,
  );
  assert.ok(
    match,
    "_crate-install-build no longer chooses its build directory by OS",
  );
  return os === "linux" ? match[1] : match[2];
}

function recipeCompiles(recipe, args, os, seen = new Set()) {
  if (seen.has(recipe)) return [];
  seen.add(recipe);
  // A dry run prints the recipe's lines on stderr, evaluated, and runs none.
  const run = spawnSync("just", ["--dry-run", recipe, ...args], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, `just --dry-run ${recipe}: ${run.stderr}`);
  return compilesIn(run.stderr, os, `just ${recipe}`, seen);
}

function compilesIn(text, os, source, seen = new Set()) {
  const found = [];
  for (const segment of lineSegments(text)) {
    const tokens = words(segment);
    const nested = tokens.indexOf("just");
    if (
      nested >= 0 &&
      tokens[nested + 1] &&
      !tokens[nested + 1].startsWith("-") &&
      tokens[nested + 1] !== "wheel-linux"
    ) {
      found.push(
        ...recipeCompiles(
          tokens[nested + 1],
          tokens.slice(nested + 2),
          os,
          seen,
        ),
      );
      continue;
    }
    let signature = compileSignature(tokens);
    if (!signature) continue;
    if (os !== "linux" && source === "just _crate-install-build")
      signature = signature.replace(
        `build.build-dir="${installBuildDir("linux")}"`,
        `build.build-dir="${installBuildDir(os)}"`,
      );
    found.push({ source, signature });
  }
  return found;
}

// The Nx targets each job's recipe runs, from scripts/ci-job.sh's one list.
function jobTargets() {
  const text = readFileSync("scripts/ci-job.sh", "utf8");
  const block = (job) =>
    text.match(
      new RegExp(
        `\\n  ${job}\\)([\\s\\S]*?)\\n    ;;|\\n  ${job}\\) ([^\\n]*)`,
      ),
    );
  const targets = (fragment) =>
    [...fragment.matchAll(/targets="([^"]+)"/g)].map((m) => m[1]);
  const lintLine = text.match(/\n {2}lint\) targets="([^"]+)"/);
  const winLine = text.match(/\n {2}test-windows\) targets="([^"]+)"/);
  const macLine = text.match(/\n {2}test-macos\) targets="([^"]+)"/);
  const linuxBlock = block("test-linux");
  assert.ok(
    lintLine && winLine && macLine && linuxBlock,
    "scripts/ci-job.sh's job list moved",
  );
  return {
    lint: [lintLine[1]],
    "test-linux": targets(linuxBlock[0]),
    "test-windows": [winLine[1]],
    "test-macos": [macLine[1]],
  };
}

const projects = new Map();
function project(name) {
  if (!projects.has(name))
    projects.set(
      name,
      JSON.parse(
        execFileSync(
          "bash",
          ["scripts/nx.sh", "show", "project", name, "--json"],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          },
        ),
      ),
    );
  return projects.get(name);
}

function tasksOf(targets) {
  const graph = JSON.parse(
    execFileSync(
      "bash",
      ["scripts/nx.sh", "run-many", "-t", targets, "--graph=stdout"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      },
    ),
  );
  return Object.keys(graph.tasks.tasks);
}

// Every compile a job's checks make, each with the task or recipe it is in.
export function jobCompiles(job, os) {
  const found = [];
  for (const targets of jobTargets()[job])
    for (const task of tasksOf(targets)) {
      const [name, target] = task.split(":");
      const options = project(name).targets?.[target]?.options ?? {};
      const commands = [options.command, ...(options.commands ?? [])].filter(
        Boolean,
      );
      for (const command of commands)
        for (const compile of compilesIn(String(command), os, `nx ${task}`))
          found.push({ ...compile, task });
    }
  return found;
}

// The warmer's plan, as its script prints it, each line with the compiles it
// makes: a recipe or an Nx target the line runs is read the way a job's task is.
export function warmPlan(os) {
  return execFileSync("bash", ["scripts/ci-warm.sh", os, "--plan"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => {
      const [source, command] = line.split("\t");
      const tokens = words(command);
      let signatures;
      if (tokens[0] === "just" && tokens[1] !== "wheel-linux")
        signatures = recipeCompiles(tokens[1], tokens.slice(2), os).map(
          (c) => c.signature,
        );
      else if (
        tokens[0] === "bash" &&
        tokens[1] === "scripts/nx.sh" &&
        tokens[2] === "run"
      ) {
        const [name, target] = tokens[3].split(":");
        const options = project(name).targets?.[target]?.options ?? {};
        signatures = compilesIn(
          String(options.command ?? ""),
          os,
          `nx ${tokens[3]}`,
        ).map((c) => c.signature);
      } else signatures = [compileSignature(tokens)].filter(Boolean);
      return { source, command, signatures };
    });
}

// The compiles a test makes itself, inside a journey, which no recipe line
// shows: each is held to its source file, which must spell every argument.
function inTestProblems(line) {
  const file = line.source.replace(/^test /, "");
  const text = readFileSync(file, "utf8");
  const tokens = words(line.command).slice(1);
  return tokens
    .filter(
      (token) =>
        !text.includes(JSON.stringify(token).slice(1, -1)) &&
        !text.includes(token),
    )
    .map(
      (token) => `${line.source} does not spell '${token}' of: ${line.command}`,
    );
}

export function warmDriftProblems(plans, compilesByJob) {
  const problems = [];
  const seen = new Set();
  for (const [os, { jobs }] of Object.entries(WARMED)) {
    const plan = plans[os];
    const warm = new Set(plan.flatMap((line) => line.signatures));
    const needed = new Set();
    for (const job of jobs)
      for (const compile of compilesByJob[job]) {
        needed.add(compile.signature);
        if (!warm.has(compile.signature))
          problems.push(
            `${job} compiles '${compile.signature}' (${compile.source}), which ci-warm.sh ${os} does not`,
          );
      }
    for (const line of plan) {
      if (line.signatures.length === 0) {
        problems.push(
          `ci-warm.sh ${os} runs '${line.command}', which compiles nothing`,
        );
        continue;
      }
      if (line.source.startsWith("test ")) {
        problems.push(...inTestProblems(line));
        continue;
      }
      for (const signature of line.signatures)
        if (!needed.has(signature))
          problems.push(
            `ci-warm.sh ${os} compiles '${signature}' (${line.source}), which no ${jobs.join(" or ")} task compiles`,
          );
    }
  }
  return problems.filter((p) => !seen.has(p) && seen.add(p));
}

let real;
function realInputs() {
  real ??= {
    plans: Object.fromEntries(
      Object.keys(WARMED).map((os) => [os, warmPlan(os)]),
    ),
    compilesByJob: Object.fromEntries(
      Object.entries(WARMED).flatMap(([os, { jobs }]) =>
        jobs.map((job) => [job, jobCompiles(job, os)]),
      ),
    ),
  };
  return real;
}

test("the warmer compiles what each OS's pull-request jobs compile, and nothing else", () => {
  const { plans, compilesByJob } = realInputs();
  // The four jobs compile something on every OS, so an empty reading is a broken
  // reader, not agreement.
  for (const job of ["lint", "test-linux", "test-windows", "test-macos"])
    assert.ok(compilesByJob[job].length > 0, `no compile found for ${job}`);
  assert.deepEqual(warmDriftProblems(plans, compilesByJob), []);
});

test("a compile the warmer drops, changes or invents is refused", () => {
  const { plans, compilesByJob } = realInputs();
  const without = (os, source) => ({
    ...plans,
    [os]: plans[os].filter((line) => line.source !== source),
  });
  const edited = (os, source, from, to) => ({
    ...plans,
    [os]: plans[os].map((line) =>
      line.source === source
        ? {
            ...line,
            command: line.command.replace(from, to),
            signatures: line.signatures.map((signature) =>
              signature.replace(from, to),
            ),
          }
        : line,
    ),
  });
  const cases = [
    [
      without("windows", "just _crate-install-build"),
      /^test-windows compiles 'cargo install --path \. .*target\/install-smoke\/build.*which ci-warm\.sh windows does not$/,
    ],
    [
      without("linux", "just _crate-doc"),
      /^test-linux compiles 'RUSTDOCFLAGS=-D warnings cargo doc/,
    ],
    [
      edited(
        "linux",
        "nx dag-ui:build-api-server",
        "target/dag-ui-api",
        "target/other",
      ),
      /^ci-warm\.sh linux compiles 'cargo build .*target\/other' .*which no lint or test-linux task compiles$/,
    ],
    [
      edited("macos", "just _tier-test", "--locked", "--release --locked"),
      /^test-macos compiles 'cargo nextest run --locked'/,
    ],
    [
      edited(
        "linux",
        "test tests/e2e/linked_report.rs",
        "target/auditable",
        "target/elsewhere",
      ),
      /^test tests\/e2e\/linked_report\.rs does not spell 'target\/elsewhere'/,
    ],
  ];
  for (const [plan, expected] of cases) {
    const problems = warmDriftProblems(plan, compilesByJob);
    assert.ok(
      problems.some((p) => expected.test(p)),
      `${expected}: ${problems}`,
    );
  }
  // A recipe that changes its own compile is a drift the other way round.
  const changed = {
    ...compilesByJob,
    lint: compilesByJob.lint.map((c) =>
      c.source === "just _crate-msrv"
        ? { ...c, signature: `${c.signature} --features x` }
        : c,
    ),
  };
  assert.ok(
    warmDriftProblems(plans, changed).some((p) =>
      /^lint compiles 'RUSTFLAGS=-D warnings cargo \+\S+ check .* --features x'/.test(
        p,
      ),
    ),
  );
});

// `scripts/ci-warm.sh linux` run for real from a scratch root holding a copy of
// it and a tree restored from a cache saved before the wheel smoke moved out of
// `target`. The compilers it hands its lines to (`just`, `cargo`, and the `bash`
// that runs Nx) are recording stand-ins on PATH: each line is minutes of
// compiling, and what is under test is what the script does around them.
function warmFromScratch(args, { locked = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ci-warm-legacy-"));
  mkdirSync(join(root, "scripts"));
  copyFileSync("scripts/ci-warm.sh", join(root, "scripts/ci-warm.sh"));
  const legacy = join(
    root,
    "target/wheel-smoke/venv/lib/python3.12/site-packages/pip/_vendor/colorama/tests",
  );
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "__init__.py"), "");
  const build = join(root, "target/wheel-x86_64-unknown-linux-gnu");
  mkdirSync(build, { recursive: true });
  const bin = join(root, "stand-ins");
  mkdirSync(bin);
  const calls = join(root, "calls.log");
  for (const name of ["just", "cargo", "bash"]) {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\necho "${name} $*" >> '${calls}'\n`,
    );
    chmodSync(join(bin, name), 0o755);
  }
  // A directory whose entries cannot be unlinked: what a tree left owned by
  // another user looks like to the job.
  if (locked) chmodSync(join(root, "target/wheel-smoke"), 0o555);
  const run = spawnSync(
    "/bin/bash",
    [join(root, "scripts/ci-warm.sh"), "linux", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    },
  );
  const result = {
    run,
    legacy: existsSync(join(root, "target/wheel-smoke")),
    build: existsSync(build),
    calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
  };
  if (locked) chmodSync(join(root, "target/wheel-smoke"), 0o755);
  rmSync(root, { recursive: true, force: true });
  return result;
}

test("the Linux warm drops the wheel smoke's old tree from what it saves, and its plan touches nothing", () => {
  const warmed = warmFromScratch([]);
  assert.equal(warmed.run.status, 0, warmed.run.stderr);
  assert.match(
    warmed.calls,
    /^just wheel-linux x86_64-unknown-linux-gnu \.tools\/wheel-smoke$/m,
  );
  assert.equal(warmed.legacy, false, "target/wheel-smoke survived the warm");
  assert.equal(warmed.build, true, "the warm removed cargo's wheel build");

  const planned = warmFromScratch(["--plan"]);
  assert.equal(planned.run.status, 0, planned.run.stderr);
  assert.equal(planned.calls, "", "--plan ran a compile");
  assert.equal(planned.legacy, true, "--plan removed target/wheel-smoke");

  // A tree it cannot remove fails the warm, before the save could carry it.
  const stuck = warmFromScratch([], { locked: true });
  assert.equal(stuck.run.status, 1, stuck.run.stderr);
  assert.match(stuck.run.stderr, /could not remove target\/wheel-smoke/);
  assert.match(
    stuck.run.stderr,
    /^ACTION: make target\/wheel-smoke removable/m,
  );
});

// What keeps proven results in the Actions cache (cache-retention.mjs says what each holds).
const readBudgets = () => parse(readFileSync("budgets.yaml", "utf8")).budgets;
const forkPullRequest = () =>
  JSON.parse(readFileSync(".github/tests/nx-cache/events/fork.json", "utf8"))
    .pull_request;
const retention = (workflows = load(), budgets = readBudgets()) =>
  retentionProblems(workflows, budgets, forkPullRequest());
const warmJob = (w, name) => w["ci-cache.yml"].jobs[name];
const stepOf = (job, test) => job.steps.find(test);
const uses = (prefix) => (step) => step.uses?.startsWith(prefix);

test("the warm legs, the budget and the pull-request jobs hold the cache's room", () => {
  assert.deepEqual(retention(), []);
  assert.deepEqual(
    copyProblems((path) => readFileSync(path, "utf8")),
    [],
  );
});

test("each way of losing that room is refused", () => {
  const cases = [
    [
      "a leg's cleanup step is gone",
      (w) => {
        warmJob(w, "warm-macos").steps.pop();
      },
      /warm-macos has no cleanup step/,
    ],
    [
      "a cleanup is no longer last",
      (w) => {
        warmJob(w, "warm-linux").steps.push({ run: "true" });
      },
      /warm-linux's cleanup is not its last ordinary step/,
    ],
    [
      "a family leaves a cleanup",
      (w) => {
        const step = warmJob(w, "warm-windows").steps.at(-1);
        step.run = step.run.replace(/--family onepipeline-cli-\S+/, "");
      },
      /warm-windows's cleanup names/,
    ],
    [
      "the budget's families stop matching",
      (_, budgets) => {
        const budget = budgets.find(
          (entry) => entry.id === "onepipeline-ui-cache-headroom",
        );
        budget.command = budget.command.slice(0, -2);
      },
      /the headroom budget names/,
    ],
    [
      "a Rust step in ci.yml could save",
      (w) => {
        const step = stepOf(
          w["ci.yml"].jobs["test-macos"],
          uses("Swatinem/rust-cache@"),
        );
        delete step.with["save-if"];
      },
      /ci\.yml's test-macos could save a Rust cache/,
    ],
    [
      "a pull-request job stops restoring",
      (w) => {
        const job = w["ci.yml"].jobs.lint;
        job.steps = job.steps.filter(
          (step) => !uses("Swatinem/rust-cache@")(step),
        );
      },
      /ci\.yml's lint does not restore a Rust build/,
    ],
    [
      "release-plz's Rust step saves by default",
      (w) => {
        delete stepOf(
          w["release-plz.yml"].jobs["release-plz"],
          uses("Swatinem/rust-cache@"),
        ).with?.["save-if"];
      },
      /release-plz\.yml's release-plz could save a Rust cache/,
    ],
    [
      "release-plz's Rust step saves outright",
      (w) => {
        stepOf(
          w["release-plz.yml"].jobs["release-plz"],
          uses("Swatinem/rust-cache@"),
        ).with = { "save-if": true };
      },
      /release-plz\.yml's release-plz could save a Rust cache/,
    ],
    [
      "release.yml gains a Rust cache step",
      (w) => {
        w["release.yml"].jobs.publish.steps.push({
          uses: "Swatinem/rust-cache@v2.9.2",
          with: { "save-if": false },
        });
      },
      /release\.yml's publish has a Rust cache step/,
    ],
    [
      "the warm workflow runs on more than main",
      (w) => {
        w["ci-cache.yml"].on.pull_request = {};
      },
      /ci-cache\.yml runs on more than a push to main/,
    ],
    [
      "the warm workflow's runs may overlap",
      (w) => {
        delete w["ci-cache.yml"].concurrency;
      },
      /ci-cache\.yml is not held to one run at a time/,
    ],
    [
      "actions: write reaches a pull-request job",
      (w) => {
        w["ci.yml"].jobs["test-linux"].permissions.actions = "write";
      },
      /ci\.yml grants actions: write to test-linux/,
    ],
    [
      "a pull-request workflow grants actions: write at its top",
      (w) => {
        w["visual-docs.yml"].permissions = { actions: "write" };
      },
      /visual-docs\.yml grants actions: write to its workflow/,
    ],
    [
      "a leg's checkout persists credentials",
      (w) => {
        delete stepOf(warmJob(w, "warm-windows"), uses("actions/checkout@"))
          .with["persist-credentials"];
      },
      /warm-windows's checkout persists credentials/,
    ],
    [
      "another step is handed the token",
      (w) => {
        stepOf(warmJob(w, "warm-linux"), (step) =>
          step.run?.includes("ci-warm-linux"),
        ).env = { GITHUB_TOKEN: `$${"{{"} github.token }}` };
      },
      /warm-linux hands the token to 'Compile what lint and test-linux compile'/,
    ],
    [
      "setup-bun's guard goes",
      (w) => {
        delete stepOf(
          w["ci.yml"].jobs["test-windows"],
          uses("oven-sh/setup-bun@"),
        ).with["no-cache"];
      },
      /test-windows writes a cache from a fork: oven-sh\/setup-bun/,
    ],
    [
      "setup-uv's guard goes",
      (w) => {
        delete stepOf(w["ci.yml"].jobs.lint, uses("astral-sh/setup-uv@")).with[
          "enable-cache"
        ];
      },
      /lint writes a cache from a fork: astral-sh\/setup-uv/,
    ],
    [
      "the sidecar stops being read-only for a fork",
      (w) => {
        delete stepOf(
          w["ci.yml"].jobs["test-linux"],
          uses("op-nx/github-cache/start-cache-server@"),
        ).env.CACHE_READ_ONLY;
      },
      /test-linux writes a cache from a fork: op-nx/,
    ],
    [
      "a setup action turns its own cache on",
      (w) => {
        stepOf(
          w["ci.yml"].jobs["test-macos"],
          uses("actions/setup-node@"),
        ).with.cache = "npm";
      },
      /test-macos writes a cache from a fork: actions\/setup-node/,
    ],
    [
      "a leg loses its target deletion",
      (w) => {
        const job = warmJob(w, "warm-macos");
        job.steps = job.steps.filter(
          (step) => !step.run?.includes("rm -rf target"),
        );
      },
      /warm-macos does not delete target on its own inexact restore/,
    ],
    [
      "the deletion reads another step's output",
      (w) => {
        stepOf(warmJob(w, "warm-linux"), (step) =>
          step.run?.includes("rm -rf target"),
        ).if = "steps.sibling.outputs.cache-hit != 'true'";
      },
      /warm-linux does not delete target on its own inexact restore/,
    ],
    [
      "the deletion takes an exact restore too",
      (w) => {
        stepOf(warmJob(w, "warm-windows"), (step) =>
          step.run?.includes("rm -rf target"),
        ).if = "steps.rust-cache.outputs.cache-hit == 'false' || always()";
      },
      /warm-windows does not delete target on its own inexact restore/,
    ],
  ];
  for (const [name, mutate, expected] of cases) {
    const workflows = load();
    const budgets = readBudgets();
    mutate(workflows, budgets);
    const problems = retention(workflows, budgets);
    assert.ok(
      problems.some((problem) => expected.test(problem)),
      `${name}: ${JSON.stringify(problems)}`,
    );
  }
});

test("an altered copy of a shared script is refused", () => {
  const real = (path) => readFileSync(path, "utf8");
  for (const [path, change, expected] of [
    [
      "scripts/actions-cache-prune.mjs",
      (text) => text.replace("const PER_PAGE = 100;", "const PER_PAGE = 99;"),
      /actions-cache-prune\.mjs does not match its header/,
    ],
    [
      "scripts/nx-remote-cache.mjs",
      (text) => `${text}\n`,
      /nx-remote-cache\.mjs does not match its header/,
    ],
    [
      "scripts/actions-budget-figures.sh",
      (text) => text.replace("set -euo pipefail", "set -eu"),
      /actions-budget-figures\.sh does not match its header/,
    ],
    [
      "scripts/actions-cache-prune.versions",
      (text) => text.replace("1 ", "2 "),
      /actions-cache-prune\.mjs is version 1, /,
    ],
  ]) {
    const problems = copyProblems((file) =>
      file === path ? change(real(file)) : real(file),
    );
    assert.ok(
      problems.some((problem) => expected.test(problem)),
      `${path}: ${JSON.stringify(problems)}`,
    );
  }
});

test("every tool ci.yml and ci-cache.yml install is at the tracked file's exact version", () => {
  const pins = readFileSync(".github/ci-tool-versions", "utf8");
  assert.deepEqual(pinProblems(load(), pins), []);
  const justfile = readFileSync("justfile", "utf8");
  const parsed = parsePins(pins);
  for (const [pin, variable] of [
    ["release-plz", "release-plz-version"],
    ["cargo-cyclonedx", "cyclonedx-version"],
  ])
    assert.match(
      justfile,
      new RegExp(
        `^${variable} := "${parsed.get(pin).replaceAll(".", "\\.")}"$`,
        "m",
      ),
      `${pin}'s pin has left the justfile's ${variable}`,
    );
  for (const [name, mutate, expected] of [
    [
      "a tool loses its version",
      (w) => {
        const step = w["ci.yml"].jobs["test-linux"].steps.find((s) =>
          s.uses?.startsWith("taiki-e/install-action@"),
        );
        step.with.tool = step.with.tool.replace(/^just@[^,]+/, "just");
      },
      /ci\.yml's test-linux installs just at , not its pin/,
    ],
    [
      "a warm leg names a version of its own",
      (w) => {
        const step = w["ci-cache.yml"].jobs["warm-macos"].steps.find((s) =>
          s.uses?.startsWith("taiki-e/install-action@"),
        );
        step.with.tool = step.with.tool.replace(
          /nextest@[^,]+/,
          "nextest@0.9.100",
        );
      },
      /ci-cache\.yml's warm-macos installs nextest at 0\.9\.100, not its pin/,
    ],
    [
      "node floats on its major",
      (w) => {
        w["ci.yml"].jobs.lint.steps.find((s) =>
          s.uses?.startsWith("actions/setup-node@"),
        ).with["node-version"] = "24";
      },
      /ci\.yml's lint installs node at 24, not its pin/,
    ],
    [
      "a job installs before reading the file",
      (w) => {
        const job = w["ci-cache.yml"].jobs.advisories;
        job.steps = job.steps.filter(
          (s) => !s.run?.includes(".github/ci-tool-versions"),
        );
      },
      /ci-cache\.yml's advisories installs before it reads the pins/,
    ],
  ]) {
    const workflows = load();
    mutate(workflows);
    const problems = pinProblems(workflows, pins);
    assert.ok(
      problems.some((problem) => expected.test(problem)),
      `${name}: ${JSON.stringify(problems)}`,
    );
  }
  assert.ok(
    pinProblems(load(), pins.replace("nextest=0.9.151", "nextest=latest")).some(
      (problem) => /pin nextest is not exact/.test(problem),
    ),
  );
  assert.ok(
    pinProblems(load(), pins.replace(/^just=.*$/m, "")).some((problem) =>
      /installs just at .* not its pin/.test(problem),
    ),
  );
  assert.deepEqual(Object.keys(LEG_FAMILIES), [
    "warm-linux",
    "warm-windows",
    "warm-macos",
  ]);
});
