/**
 * A host whose human items are real: the action-items journeys' world.
 *
 * Nothing here writes a human item. Runs are launched by the provisioned
 * `onepipeline` CLI of the release the server links — its own `start`, scheduler
 * and driver over plans of `kind: human` steps kept on a GitHub board — and items are
 * raised by that CLI as the sessions that own them, through a configured
 * design-review phase where a review completes through an approval authority.
 * The server then reads and writes the one journal the engine keeps beneath the
 * runs root, under the same host-local configuration, and every task is projected
 * onto a tracker. Two processes outside the engine stand in for what a host
 * reaches beyond it: the GitHub board (`tests/support/github_board.py`, a loopback
 * answering the requests onetaskgraph's `github-projects` source sends) and the
 * approval authority, a command a host configures, which here keeps the current
 * version of each design document and the approval records it wrote.
 *
 * The world outlives the server: `serveRebuilt` starts a new server over the same
 * journal (and a fresh board, whose address the configuration is rewritten to), so
 * a journey can stop the server, change what it acts as, and start it again.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { graphRecordsFor, SUPERVISOR_SESSION } from "./runs.mjs";
import { thisHost } from "./this-host.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ENGINE = join(
  REPO_ROOT,
  ".tools",
  "bin",
  process.platform === "win32" ? "onepipeline.exe" : "onepipeline",
);
const BOARD = join(REPO_ROOT, "tests", "support", "github_board.py");
/** What `start` settles with, as far as a world reads it. */
const settlementSchema = z.looseObject({ run_id: z.string().min(1) });
/** The engine's mutation receipt, as far as a world reads it. */
const receiptSchema = z.looseObject({
  item: z.looseObject({ item: z.looseObject({ id: z.string().min(1) }) }),
});
/** `human-items list --json`, as far as a world reads it. */
const listedSchema = z.array(
  z.looseObject({
    item: z.looseObject({ id: z.string().min(1), dedup_key: z.string() }),
  }),
);
/** What a built world keeps beside itself to be served again. */
const builtSchema = z.object({
  token: z.string().min(1),
  world: z.object({
    ids: z.record(z.string(), z.string()),
    runs: z.record(z.string(), z.string()),
    plans: z.record(z.string(), z.string()),
    sessions: z.array(z.string()).optional(),
  }),
});

/** The login a manager session acts on behalf of. */
export const USER = "operator";
/** The session whose items the journeys never see. */
export const OTHER_SESSION = "other-session";
/** What marks a workspace as holding a world already built. */
const BUILT = "human-items-world.json";
/** The file naming the session the next server acts as. */
export const ACTING = "acting-session";

const APPROVAL_AUTHORITY = `import json, sys
request = json.load(sys.stdin)
current = json.load(open(sys.argv[1])).get(request["board_copy"])
if current is None:
    sys.exit(3)
if current == request["key"]:
    with open(sys.argv[2], "a") as log:
        log.write(json.dumps({"board_copy": request["board_copy"], "key": current,
                              "actor": request["actor"],
                              "on_behalf_of": request["on_behalf_of"]}) + "\\n")
print(json.dumps({"board_copy": request["board_copy"], "key": current}))
`;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The variables a process of this world must not inherit from its caller. */
export function foreignVariables() {
  return [
    ...Object.keys(process.env).filter((name) =>
      name.startsWith("ONETASKGRAPH_"),
    ),
    "ONEPIPELINE_CONFIG",
    "ONEPIPELINE_LAUNCHER_SESSION",
    "ONEPIPELINE_WAKE_BUDGET",
  ];
}

/** Where everything of the world under `workspace` lives. */
function paths(workspace) {
  return {
    runs: join(workspace, "runs"),
    config: join(workspace, "config"),
    intents: join(workspace, "intents"),
    work: join(workspace, "work"),
    board: join(workspace, "github-board"),
    seed: join(workspace, "github-board-seed.json"),
    keys: join(workspace, "design-keys.json"),
    approvals: join(workspace, "approvals.ndjson"),
    adapter: join(workspace, "approve-design.py"),
    graph: join(workspace, "node-scope.yaml"),
    state: join(workspace, "state"),
  };
}

/** The environment every process of the world runs in, as a plain object. */
export function worldEnvironment(workspace, token) {
  const at = paths(workspace);
  return {
    XDG_CONFIG_HOME: at.config,
    XDG_STATE_HOME: at.state,
    CACHE_BOARD_TOKEN: token,
    HOSTNAME: thisHost(),
    USER,
    ONEPIPELINE_RUNS_DIR: at.runs,
    ONEPIPELINE_NODE_GRAPH: at.graph,
    // No step of any run here can reach a model, however its holds resolve.
    ONEPIPELINE_ONEAGENTGRAPH_BIN: "false",
    ONEAGENTGRAPH_STATE_DIR: graphRecordsFor(at.runs),
  };
}

/** `onepipeline ARGS…` in the world, as `session` (a manager acting for the user). */
export function engine(workspace, token, args, session) {
  const env = { ...process.env };
  for (const name of foreignVariables()) delete env[name];
  Object.assign(env, worldEnvironment(workspace, token));
  if (session !== undefined) env.ONEPIPELINE_LAUNCHER_SESSION = session;
  return execFileSync(ENGINE, args, {
    cwd: paths(workspace).work,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Start the loopback board over `dir`; answers its process and address. */
function startBoard(dir, seed, token) {
  mkdirSync(dir, { recursive: true });
  const endpoint = join(dir, "endpoint");
  // A world served again still holds the endpoint its last board published,
  // which names a port nothing listens on any more: wait for this board's own.
  rmSync(endpoint, { force: true });
  // llmlint: ignore[e2e_not_mocked] GitHub is the external tracker these journeys may double; the loopback answers only the requests the github-projects source sends, and everything of onepipeline under test is real.
  const board = spawn("python3", [BOARD, dir, seed], {
    env: { ...process.env, CACHE_BOARD_TOKEN: token },
    stdio: ["ignore", "ignore", "inherit"],
  });
  // However this process ends, the board it started ends with it.
  process.on("exit", () => board.kill("SIGKILL"));
  const deadline = Date.now() + 10_000;
  while (!existsSync(endpoint)) {
    if (board.exitCode !== null) throw new Error("the loopback board exited");
    if (Date.now() > deadline)
      throw new Error("the loopback board did not listen");
    sleep(20);
  }
  return { board, url: readFileSync(endpoint, "utf8") };
}

function writeConfiguration(workspace, endpoint) {
  const at = paths(workspace);
  mkdirSync(join(at.config, "onepipeline"), { recursive: true });
  writeFileSync(
    join(at.config, "onepipeline", "config.yaml"),
    [
      "human_items:",
      "  enabled: true",
      "  task_source: board",
      "  approval_adapters:",
      "    approve-design:",
      `      command: ["python3", ${JSON.stringify(at.adapter)}, ${JSON.stringify(at.keys)}, ${JSON.stringify(at.approvals)}]`,
      "  hooks:",
      "    - phase: design-review",
      "      kind: task",
      '      title: "{{ title }}"',
      '      body: "{{ body }}"',
      "      priority: high",
      "      block: {scope: nothing}",
      "      approval: {adapter: approve-design}",
      "",
    ].join("\n"),
  );
  // The plan store is the checkout's own, where both a launch and the server
  // — which is started in that checkout — discover it.
  writeFileSync(
    join(at.work, "onetaskgraph.yaml"),
    [
      "sources:",
      "  board:",
      "    plugin: github-projects",
      "    task_projection:",
      `      host: ${JSON.stringify(thisHost())}`,
      `      directory: ${JSON.stringify(at.intents)}`,
      "      project: human",
      "    config:",
      "      owner: generic",
      "      project_number: 1",
      "      repository: generic/approval",
      "      token_env: CACHE_BOARD_TOKEN",
      `      endpoint: ${endpoint}/graphql`,
      "      status_mapping:",
      "        todo: Todo",
      "        queued: Queued",
      "        in-progress: In Progress",
      "        unknown: Needs Attention",
      "        done: Done",
      "        cancelled: Canceled",
      "      priority_mapping:",
      "        urgent: Urgent",
      "        high: High",
      "        medium: Medium",
      "        low: Low",
      "",
    ].join("\n"),
  );
}

const STATUS_OPTIONS = [
  "Todo",
  "Queued",
  "In Progress",
  "Needs Attention",
  "Done",
  "Canceled",
];

/**
 * The board every world's plans live on: `plans` maps each plan's name to its
 * steps, `{id, title, deps, priority, body, question}`, every one a `kind:
 * human` issue of the plan — and `human`, the project projected tasks of no plan
 * are filed under. Its issues are what the board serves when it starts.
 */
function boardSeed(plans) {
  let number = 0;
  const issue = (title, content, metadata, parent, blockedBy) => ({
    number: ++number,
    title,
    content,
    metadata,
    status: "Todo",
    state: "OPEN",
    reason: null,
    parent,
    ...(blockedBy.length > 0 ? { blocked_by: blockedBy } : {}),
  });
  const issues = {
    human: issue("Human work", "## Plan\n- Work for people.", {}, null, []),
  };
  for (const [name, steps] of Object.entries(plans)) {
    issues[name] = issue(
      name,
      "",
      {
        "onepipeline.schema_version": 3,
        "onepipeline.concurrency": 4,
        "onepipeline.goal": { text: `Deliver ${name}` },
      },
      null,
      [],
    );
    for (const step of steps) {
      const body = step.body ?? `Do ${step.id}.`;
      issues[`${name}-${step.id}`] = issue(
        step.title,
        body,
        {
          "onepipeline.id": step.id,
          "onepipeline.kind": "human",
          "onetaskgraph.repositories": [],
          "onepipeline.human_item": {
            kind: step.question ? "question" : "task",
            priority: step.priority ?? "low",
            title: step.title,
            body,
          },
        },
        name,
        (step.deps ?? []).map((dep) => `${name}-${dep}`),
      );
    }
  }
  return { repository: "generic/approval", options: STATUS_OPTIONS, issues };
}

/** The run `start` launched, driven until it waits on a person. */
function start(workspace, token, plan) {
  const printed = engine(
    workspace,
    token,
    ["start", plan, "--attach"],
    SUPERVISOR_SESSION,
  );
  const last = printed
    .split("\n")
    .reverse()
    .find((line) => line.startsWith("{"));
  if (last === undefined) throw new Error(`start printed ${printed}`);
  return settlementSchema.parse(JSON.parse(last)).run_id;
}

function raise(workspace, token, session, input) {
  const path = join(workspace, `raise-${input.dedup_key}.json`);
  writeFileSync(
    path,
    JSON.stringify({ schema_version: 1, approval: null, ...input }),
  );
  const receipt = receiptSchema.parse(
    JSON.parse(
      engine(
        workspace,
        token,
        ["human-items", "raise", "--input", path],
        session,
      ),
    ),
  );
  return receipt.item.item.id;
}

/** Raise a design review through the configured phase; answers its id. */
function raiseDesign(
  workspace,
  token,
  { dedup, title, body, owner, copy, key },
) {
  const path = join(workspace, `design-${dedup}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      owner,
      dedup_key: dedup,
      vars: { title, body },
      approval: { board_copy: copy, key },
    }),
  );
  const receipt = receiptSchema.parse(
    JSON.parse(
      engine(
        workspace,
        token,
        ["human-items", "raise", "--phase", "design-review", "--context", path],
        owner.session,
      ),
    ),
  );
  return receipt.item.item.id;
}

/** The id of the item the engine raised for `run`'s human step `node`. */
function stepItem(workspace, token, run, node) {
  const found = listedSchema
    .parse(
      JSON.parse(
        engine(workspace, token, [
          "human-items",
          "list",
          "--json",
          "--run",
          run,
        ]),
      ),
    )
    .find(({ item }) => item.dedup_key === `run:${run}#${node}`);
  if (found === undefined)
    throw new Error(`the engine raised no item for ${run}'s step ${node}`);
  return found.item.id;
}

function owner(run = null, plan = null, session = SUPERVISOR_SESSION) {
  return { session, run, plan };
}

const QUEUE_PLANS = {
  "plan-a": [
    {
      id: "region",
      title: "Which region should the canary run in?",
      question: true,
      priority: "high",
      body: "The canary needs a region before deploy starts. us-east has more traffic; eu-west matches the incident report.",
    },
    { id: "build", title: "Build the release binaries", deps: ["region"] },
    { id: "test", title: "Run the release journeys", deps: ["build"] },
    { id: "lint", title: "Lint the changed files", deps: ["region"] },
    { id: "package", title: "Package the wheels", deps: ["region"] },
    { id: "publish", title: "Publish to the registries", deps: ["region"] },
  ],
  // Kept on the board, never launched: the plan a plan hold and a review name.
  "plan-b": [
    { id: "docs", title: "Rewrite the operator guide" },
    { id: "screens", title: "Photograph every surface", deps: ["docs"] },
  ],
};

/** The queue every journey but the long-body ones reads. */
function buildQueue(workspace, token) {
  const planA = "board:plan-a";
  const runA = start(workspace, token, planA);
  const ids = {};
  ids.region = stepItem(workspace, token, runA, "region");
  ids.build = raise(workspace, token, SUPERVISOR_SESSION, {
    dedup_key: "build-service",
    kind: "task",
    title: "Restore the build service",
    body: "The shared build service stopped answering. Restart it on the build host and confirm one cached build finishes.",
    priority: "urgent",
    owner: owner(),
    block: { scope: "host" },
  });
  ids.export = raise(workspace, token, SUPERVISOR_SESSION, {
    dedup_key: "legacy-export",
    kind: "question",
    title: "Keep the legacy export format?",
    body: "Two teams still read the legacy CSV export. Dropping it simplifies the writer; keeping it costs one more test suite.",
    priority: "low",
    owner: owner(null, "board:plan-b"),
    block: { scope: "plan", plan: "board:plan-b" },
  });
  ids.cache = raise(workspace, token, SUPERVISOR_SESSION, {
    dedup_key: "warm-cache",
    kind: "question",
    title: "Should retries reuse the warm cache?",
    body: "Retries currently start cold and take eight minutes. Reusing the warm cache is faster but can hide a stale artifact.",
    priority: "urgent",
    owner: owner(),
    block: { scope: "nothing" },
  });
  ids.design = raiseDesign(workspace, token, {
    dedup: "action-items-design",
    title: "Review the action-items design",
    body: "Read the action-items design document and complete this task once its layout and keyboard flow look right to you.",
    owner: owner(runA, planA),
    copy: "docs/design/action-items.md",
    key: "sha256:5d1c0a",
  });
  ids.dashboard = raiseDesign(workspace, token, {
    dedup: "dashboard-layout",
    title: "Review the dashboard layout",
    body: "Read the dashboard design document and complete this task when the column widths and empty states read clearly.",
    owner: owner(null, "board:plan-b"),
    copy: "docs/design/dashboard.md",
    key: "sha256:91aa07",
  });
  // The dashboard document moved on after its review was raised.
  writeFileSync(
    paths(workspace).keys,
    JSON.stringify({
      "docs/design/action-items.md": "sha256:5d1c0a",
      "docs/design/dashboard.md": "sha256:c4e2f9",
    }),
  );
  ids.other = raise(workspace, token, OTHER_SESSION, {
    dedup_key: "deploy-credentials",
    kind: "task",
    title: "Rotate the deploy credentials",
    body: "Rotate the expiring deploy credentials before Friday and record the new expiry date on the release checklist page.",
    priority: "urgent",
    owner: owner(null, null, OTHER_SESSION),
    block: { scope: "nothing" },
  });
  ids.answered = raise(workspace, token, SUPERVISOR_SESSION, {
    dedup_key: "changelog-section",
    kind: "question",
    title: "Which changelog section holds the fix?",
    body: "The fix touches both the reader and the launcher. Say which changelog section the release notes should list it under.",
    priority: "medium",
    owner: owner(runA, planA),
    block: { scope: "nothing" },
  });
  engine(
    workspace,
    token,
    ["human-items", "answer", ids.answered, "--text", "Fixes"],
    SUPERVISOR_SESSION,
  );
  ids.dismissed = raise(workspace, token, SUPERVISOR_SESSION, {
    dedup_key: "flaky-screenshots",
    kind: "task",
    title: "Re-run the flaky screenshot job",
    body: "The screenshot job failed once on a timeout. Re-run it and close this task if the second attempt passes cleanly.",
    priority: "low",
    owner: owner(),
    block: { scope: "nothing" },
  });
  engine(
    workspace,
    token,
    ["human-items", "dismiss", ids.dismissed],
    SUPERVISOR_SESSION,
  );
  return { ids, runs: { a: runA }, plans: { a: planA, b: "board:plan-b" } };
}

const LONG_PLANS = {
  "plan-a": [
    { id: "prepare", title: "Prepare the release" },
    { id: "build", title: "Build the release binaries", deps: ["prepare"] },
    { id: "test", title: "Run the release journeys", deps: ["prepare"] },
    { id: "rebase", title: "Rebase the release branch", deps: ["prepare"] },
    { id: "retag", title: "Retag the release", deps: ["rebase"] },
  ],
};

/** The long-body world: one long body among short ones, and sources of every shape. */
function buildLong(workspace, token) {
  const planA = "board:plan-a";
  const runA = start(workspace, token, planA);
  const sentence =
    "This task gathers every follow-up the release review left open so that nothing is lost between sessions. ";
  const ids = {};
  ids.short = raise(workspace, token, SUPERVISOR_SESSION, {
    dedup_key: "build-service",
    kind: "task",
    title: "Restore the build service",
    body: "The shared build service stopped answering. Restart it on the build host and confirm one cached build finishes.",
    priority: "urgent",
    owner: owner(),
    block: { scope: "host" },
  });
  ids.long = raise(workspace, token, SUPERVISOR_SESSION, {
    dedup_key: "release-follow-ups",
    kind: "task",
    title: "Work through the release review follow-ups",
    body: `${sentence.repeat(40)}The final words are: ship the reviewed release.`,
    priority: "high",
    owner: owner(runA, planA),
    block: { scope: "plan", plan: planA },
  });
  ids.region = raise(workspace, token, SUPERVISOR_SESSION, {
    dedup_key: "canary-region",
    kind: "question",
    title: "Which region should the canary run in?",
    body: "The canary needs a region before deploy starts. us-east has more traffic; eu-west matches the incident report.",
    priority: "medium",
    owner: owner(),
    block: { scope: "nothing" },
  });
  ids.export = raise(workspace, token, SUPERVISOR_SESSION, {
    dedup_key: "legacy-export",
    kind: "question",
    title: "Keep the legacy export format?",
    body: "Two teams still read the legacy CSV export. Dropping it simplifies the writer; keeping it costs one more test suite.",
    priority: "low",
    owner: owner(runA, planA),
    block: { scope: "nothing" },
  });
  ids.planOnly = raise(workspace, token, SUPERVISOR_SESSION, {
    dedup_key: "shared-fixtures",
    kind: "question",
    title: "Which plan owns the shared fixtures?",
    body: "The fixtures moved out of every run. Say which plan keeps them so its owner reviews changes to them.",
    priority: "low",
    owner: owner(null, "board:plan-c"),
    block: { scope: "nothing" },
  });
  ids.runOnly = raise(workspace, token, SUPERVISOR_SESSION, {
    dedup_key: "flaky-runner",
    kind: "task",
    title: "File the flaky-runner report",
    body: "Collect the three runner timeouts from this run and file them with the infrastructure tracker today.",
    priority: "low",
    owner: owner(runA),
    block: { scope: "nothing" },
  });
  ids.oneStep = raise(workspace, token, SUPERVISOR_SESSION, {
    dedup_key: "release-base",
    kind: "task",
    title: "Pick the release branch's base",
    body: "The release branch can rebase onto main or onto last week's tag. Pick one so the rebase step can run.",
    priority: "low",
    owner: owner(runA, planA),
    block: { scope: "work", run: runA, node: "rebase" },
  });
  ids.prepare = stepItem(workspace, token, runA, "prepare");
  return { ids, runs: { a: runA }, plans: { a: planA } };
}

/** The manager sessions the sessions world is raised across. */
export const SESSIONS = Array.from({ length: 10 }, (_, n) => `manager-${n}`);

/** Ten manager sessions, each with a task and a question of its own. */
function buildSessions(workspace, token) {
  const ids = {};
  const priorities = ["urgent", "high", "medium", "low"];
  SESSIONS.forEach((session, n) => {
    ids[`${session}-task`] = raise(workspace, token, session, {
      dedup_key: `${session}-task`,
      kind: "task",
      title: `Sign off ${session}'s release notes`,
      body: `Read the release notes ${session} drafted and complete this task once they say what shipped.`,
      priority: priorities[n % 4],
      owner: owner(null, null, session),
      block: { scope: "nothing" },
    });
    ids[`${session}-question`] = raise(workspace, token, session, {
      dedup_key: `${session}-question`,
      kind: "question",
      title: `Which day should ${session} ship?`,
      body: `${session} is ready to ship on Tuesday or Thursday; say which day suits the release train.`,
      priority: priorities[(n + 1) % 4],
      owner: owner(null, null, session),
      block: { scope: "nothing" },
    });
  });
  return { ids, runs: {}, plans: {}, sessions: SESSIONS };
}

const WORLDS = {
  sessions: { plans: {}, build: buildSessions },
  queue: { plans: QUEUE_PLANS, build: buildQueue },
  long: { plans: LONG_PLANS, build: buildLong },
};

/**
 * The corpus `serve-fixture.mjs` serves for the world `name`: built once into the
 * workspace, served again over the same journal by every later start of it.
 */
export function humanItemsWorld(workspace, name) {
  // An own key only: `constructor` or `__proto__` would otherwise read as a world.
  const kind = Object.hasOwn(WORLDS, name) ? WORLDS[name] : undefined;
  if (kind === undefined)
    throw new Error(
      `'${name}' is not a human-items world; name one of ${Object.keys(WORLDS).join(", ")}`,
    );
  const at = paths(workspace);
  const built = join(workspace, BUILT);
  const kept = existsSync(built)
    ? builtSchema.parse(JSON.parse(readFileSync(built, "utf8")))
    : undefined;
  const token = kept?.token ?? `token-${process.pid}-${Date.now()}`;
  let board;
  let world;
  return {
    persistent: kept !== undefined,
    build: () => {
      for (const dir of [at.runs, at.intents, at.work, at.state])
        mkdirSync(dir, { recursive: true });
      writeFileSync(at.seed, JSON.stringify(boardSeed(kind.plans)));
      const started = startBoard(at.board, at.seed, token);
      board = started.board;
      writeConfiguration(workspace, started.url);
      if (kept !== undefined) {
        world = kept.world;
        return;
      }
      writeFileSync(at.adapter, APPROVAL_AUTHORITY);
      writeFileSync(at.keys, "{}");
      writeFileSync(
        at.graph,
        "version: 1\nname: node-scope\nmembers:\n  worker:\n    kind: oneharness\n    oneharness_config: ./child.toml\n",
      );
      writeFileSync(join(workspace, ACTING), SUPERVISOR_SESSION);
      world = kind.build(workspace, token);
      writeFileSync(built, JSON.stringify({ token, world }));
    },
    facts: () => ({
      ...world,
      workspace,
      token,
      engine: ENGINE,
      approvals: at.approvals,
      keys: at.keys,
      journal: join(at.runs, "human-items"),
      board: join(at.board, "state.json"),
      acting: join(workspace, ACTING),
      cwd: at.work,
      environment: worldEnvironment(workspace, token),
      removed: foreignVariables(),
    }),
    session: () => readFileSync(join(workspace, ACTING), "utf8").trim(),
    cwd: at.work,
    environment: worldEnvironment(workspace, token),
    removeEnvironment: foreignVariables(),
    // Answers once the board has exited, so nothing of it writes into the
    // workspace after its server is gone.
    cleanup: () =>
      new Promise((resolveExit) => {
        if (
          board === undefined ||
          board.exitCode !== null ||
          board.signalCode !== null
        )
          return resolveExit();
        board.once("exit", () => resolveExit());
        board.kill("SIGTERM");
      }),
  };
}
