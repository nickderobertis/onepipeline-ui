// What keeps proven results in the Actions cache, read off the workflow files: shared by
// ci-warm.test.mjs, which refuses a workflow that loses any of it, and
// ci-cache-cleanup.test.mjs, which drives the same steps through their real interfaces.
import { createHash } from "node:crypto";
import { interpolate } from "../workflow-graph.mjs";

// The family prefixes each warm leg's cleanup names. rust-cache's and the two binaries' keys
// start with these. release-plz only restores its family now; the Linux leg still cleans
// it so copies saved before that stay covered.
export const LEG_FAMILIES = {
  "warm-linux": [
    "v0-rust-test-linux-Linux-x64-",
    "onepipeline-cli-Linux-X64-",
    "onepipeline-api-baseline-Linux-X64-",
    "v0-rust-release-plz-Linux-x64-",
  ],
  "warm-windows": [
    "v0-rust-test-windows-Windows_NT-x64-",
    "onepipeline-cli-Windows-X64-",
  ],
  "warm-macos": [
    "v0-rust-test-macos-Darwin-arm64-",
    "onepipeline-cli-macOS-ARM64-",
  ],
};
export const PULL_REQUEST_JOBS = [
  "lint",
  "test-linux",
  "test-windows",
  "test-macos",
];
export const COPIES = [
  ["scripts/actions-cache-prune.mjs", "scripts/actions-cache-prune.versions"],
  [
    "scripts/actions-budget-figures.sh",
    "scripts/actions-budget-figures.versions",
  ],
  ["scripts/nx-remote-cache.mjs", "scripts/nx-remote-cache.versions"],
  ["scripts/coverage-unit.sh", "scripts/coverage-unit.versions"],
  ["scripts/coverage-merge.mjs", "scripts/coverage-merge.versions"],
];
const CLEANUP = "actions-cache-prune.mjs";
const expression = (body) => `$${"{{"} ${body} }}`;

export const cleanupStep = (job) =>
  (job?.steps ?? []).find((step) => step.run?.includes(CLEANUP));
export const cleanupFamilies = (step) =>
  [...(step?.run ?? "").matchAll(/--family\s+(\S+)/g)].map((match) => match[1]);
const rustCacheAt = (job) =>
  (job?.steps ?? []).findIndex((step) =>
    step.uses?.startsWith("Swatinem/rust-cache@"),
  );
// The step straight after a warm leg's rust-cache step: what drops an inexact restore.
export const targetDeletion = (job) => (job?.steps ?? [])[rustCacheAt(job) + 1];
export const rustCacheId = (job) => (job?.steps ?? [])[rustCacheAt(job)]?.id;

// Whether a step writes a cache under this event, read from the input each action takes.
// Each answer evaluates the workflow's own expression; an action nothing here names cannot
// write one (setup-node and setup-python only with a `cache` input, refused below).
export function writesCache(step, context) {
  const uses = step.uses ?? "";
  const given = (name) => interpolate(step.with?.[name], context);
  if (uses.startsWith("oven-sh/setup-bun@"))
    return String(given("no-cache")) !== "true";
  if (uses.startsWith("astral-sh/setup-uv@"))
    return String(given("enable-cache")) !== "false";
  if (uses.startsWith("Swatinem/rust-cache@"))
    return String(given("save-if")) !== "false";
  if (uses.startsWith("op-nx/github-cache/start-cache-server@"))
    return !interpolate(step.env?.CACHE_READ_ONLY ?? "", context);
  if (/^actions\/cache(\/save)?@/.test(uses)) return true;
  if (/^actions\/setup-(node|python|go|java)@/.test(uses))
    return Boolean(step.with?.cache);
  return false;
}

// A fork's context, recorded: `read_only` is what the real trust step answers for one.
export const forkContext = (pullRequest) => ({
  github: {
    event: { pull_request: pullRequest },
    repository: pullRequest.base.repo.full_name,
    token: "token",
  },
  steps: { "nx-cache-trust": { outputs: { read_only: "true" } } },
});

const tokenHandedTo = (step) =>
  /github\.token|secrets\.|GITHUB_TOKEN|GH_TOKEN/.test(JSON.stringify(step));

export function retentionProblems(workflows, budgets, forkPullRequest) {
  const problems = [];
  const warm = workflows["ci-cache.yml"];
  if (JSON.stringify(warm?.on) !== '{"push":{"branches":["main"]}}')
    problems.push("ci-cache.yml runs on more than a push to main");
  if (
    !warm?.concurrency?.group ||
    warm.concurrency["cancel-in-progress"] !== false
  )
    problems.push("ci-cache.yml is not held to one run at a time");
  for (const [name, families] of Object.entries(LEG_FAMILIES)) {
    const job = warm?.jobs?.[name];
    const steps = job?.steps ?? [];
    const cleanup = cleanupStep(job);
    if (!cleanup) {
      problems.push(`${name} has no cleanup step`);
      continue;
    }
    if (steps.at(-1) !== cleanup)
      problems.push(`${name}'s cleanup is not its last ordinary step`);
    const named = cleanupFamilies(cleanup);
    if (JSON.stringify(named) !== JSON.stringify(families))
      problems.push(`${name}'s cleanup names ${JSON.stringify(named)}`);
    if (
      job.permissions?.actions !== "write" ||
      job.permissions?.contents !== "read"
    )
      problems.push(`${name} does not hold exactly its cleanup's permissions`);
    if (cleanup.env?.GH_TOKEN !== expression("github.token"))
      problems.push(`${name}'s cleanup is not handed the token`);
    for (const step of steps)
      if (step !== cleanup && tokenHandedTo(step))
        problems.push(`${name} hands the token to '${step.name ?? step.uses}'`);
    const checkout = steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    if (checkout?.with?.["persist-credentials"] !== false)
      problems.push(`${name}'s checkout persists credentials`);
    const id = rustCacheId(job);
    const drop = targetDeletion(job);
    const takes = (hit) => {
      try {
        return interpolate(expression(drop?.if), {
          steps: { [id]: { outputs: { "cache-hit": hit } } },
        });
      } catch {
        return undefined;
      }
    };
    if (
      !id ||
      !drop?.run?.includes("rm -rf target") ||
      !String(drop.if).includes(`steps.${id}.outputs.cache-hit`) ||
      takes("true") !== false ||
      takes("false") !== true
    )
      problems.push(
        `${name} does not delete target on its own inexact restore`,
      );
  }
  const budget = budgets.find(
    (entry) => entry.id === "onepipeline-ui-cache-headroom",
  );
  const budgeted = (budget?.command ?? [])
    .filter((_, at, all) => all[at - 1] === "--family")
    .sort();
  const cleaned = Object.values(warm?.jobs ?? {})
    .flatMap((job) => cleanupFamilies(cleanupStep(job)))
    .sort();
  if (JSON.stringify(budgeted) !== JSON.stringify(cleaned))
    problems.push(
      `the headroom budget names ${JSON.stringify(budgeted)}, the cleanups ${JSON.stringify(cleaned)}`,
    );
  // ci-cache.yml is the only saver of Rust build caches, whatever workflow a step is in.
  for (const [file, workflow] of Object.entries(workflows)) {
    if (file === "ci-cache.yml") continue;
    for (const [id, job] of Object.entries(workflow?.jobs ?? {}))
      for (const step of job.steps ?? [])
        if (step.uses?.startsWith("Swatinem/rust-cache@")) {
          if (file === "release.yml")
            problems.push(`release.yml's ${id} has a Rust cache step`);
          else if (step.with?.["save-if"] !== false)
            problems.push(`${file}'s ${id} could save a Rust cache`);
        }
  }
  for (const id of PULL_REQUEST_JOBS) {
    const job = workflows["ci.yml"]?.jobs?.[id];
    if (rustCacheAt(job) < 0)
      problems.push(`ci.yml's ${id} does not restore a Rust build`);
    for (const step of job?.steps ?? [])
      if (writesCache(step, forkContext(forkPullRequest)))
        problems.push(
          `ci.yml's ${id} writes a cache from a fork: ${step.name ?? step.uses}`,
        );
  }
  for (const [file, workflow] of Object.entries(workflows)) {
    const on = workflow?.on;
    const pullRequest =
      on === "pull_request" ||
      (Array.isArray(on)
        ? on.includes("pull_request")
        : on?.pull_request !== undefined);
    if (!pullRequest) continue;
    const granted = [
      ["its workflow", workflow.permissions],
      ...Object.entries(workflow.jobs ?? {}).map(([id, job]) => [
        id,
        job.permissions,
      ]),
    ];
    for (const [where, permissions] of granted)
      if (permissions === "write-all" || permissions?.actions === "write")
        problems.push(
          `${file} grants actions: write to ${where}, which a pull request runs`,
        );
  }
  return problems;
}

// Body hash under each header, and the header against the last line of its versions file.
export function copyProblems(read) {
  const problems = [];
  for (const [path, versions] of COPIES) {
    const text = read(path);
    const lines = text.split("\n");
    const at = lines.findIndex((line) => /^(#|\/\/) sha256: /.test(line));
    const header = lines[at]?.split("sha256: ")[1];
    const version = lines
      .slice(0, at)
      .map((line) => line.match(/version: (\d+)/)?.[1])
      .find(Boolean);
    const body = createHash("sha256")
      .update(lines.slice(at + 1).join("\n"))
      .digest("hex");
    if (body !== header) problems.push(`${path} does not match its header`);
    const last = read(versions).trim().split("\n").at(-1);
    if (last !== `${version} ${header}`)
      problems.push(
        `${path} is version ${version}, ${versions} ends at ${last}`,
      );
  }
  return problems;
}

const EXACT = /^[0-9]+\.[0-9]+\.[0-9]+$/;
export function parsePins(text) {
  return new Map(
    text
      .replaceAll("\r", "")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=")),
  );
}
const pinned = (name) => expression(`steps.tool-pins.outputs.${name}`);

// Every install in the workflows a cached test target's tools come through, each at the
// tracked file's exact version and after the step that reads it.
export function pinProblems(workflows, pinsText) {
  const pins = parsePins(pinsText);
  const problems = [];
  for (const [name, version] of pins)
    if (!EXACT.test(version))
      problems.push(`pin ${name} is not exact: ${version}`);
  const owed = (where, name, given) => {
    if (given !== pinned(name) || !pins.has(name))
      problems.push(`${where} installs ${name} at ${given}, not its pin`);
  };
  for (const file of ["ci.yml", "ci-cache.yml"])
    for (const [id, job] of Object.entries(workflows[file]?.jobs ?? {})) {
      const where = `${file}'s ${id}`;
      const steps = job.steps ?? [];
      const read = steps.findIndex((step) =>
        step.run?.includes(".github/ci-tool-versions"),
      );
      steps.forEach((step, at) => {
        const uses = step.uses ?? "";
        const installs =
          uses.startsWith("taiki-e/install-action@") ||
          uses.startsWith("actions/setup-node@") ||
          uses.startsWith("astral-sh/setup-uv@");
        if (!installs) return;
        if (read < 0 || at < read)
          problems.push(`${where} installs before it reads the pins`);
        if (uses.startsWith("actions/setup-node@"))
          owed(where, "node", step.with?.["node-version"]);
        if (uses.startsWith("astral-sh/setup-uv@"))
          owed(where, "uv", step.with?.version);
        if (uses.startsWith("taiki-e/install-action@"))
          for (const tool of String(step.with?.tool).split(",")) {
            const [name, ...given] = tool.split("@");
            owed(where, name, given.join("@"));
          }
      });
    }
  return problems;
}
