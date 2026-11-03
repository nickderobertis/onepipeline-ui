#!/usr/bin/env node
// Spike `spike-opnx-audit` (plan ci-release-test-cache): the Nx task hash of
// every task one of ci.yml's jobs runs, computed by Nx's own hasher — the
// createProjectGraphAsync -> createTaskGraph -> createTaskHasher().hashTask()
// sequence op-nx/github-cache's `capture-hashes.mjs` uses — so a figure here is
// the key the remote cache would be asked for, not a re-derivation of it.
//
// Usage:
//   task-hashes.mjs capture <workspace> <project:target>... [--out <file>]
//   task-hashes.mjs diff <before.json> <after.json>
//
// `capture` loads Nx from <workspace>'s own node_modules, with the daemon off,
// and prints (or writes) {nx, tasks: {<id>: {hash, nodes}}}: `nodes` is Nx's
// per-input breakdown, so `diff` can name the inputs that moved each hash.
// `diff` prints one line per task: `same <id>` or `moved <id>: <input>, ...`.
// Exit 0 on success, 2 on a usage error, 1 when a task is not in the graph or
// a record is unreadable or names a task the other does not.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const usage = (message) => {
  console.error(`task-hashes: ${message}`);
  console.error(
    "ACTION: run 'task-hashes.mjs capture <workspace> <project:target>... [--out <file>]' or 'task-hashes.mjs diff <before.json> <after.json>'",
  );
  process.exit(2);
};

async function capture(workspace, ids, out) {
  const root = resolve(workspace);
  process.chdir(root);
  process.env.NX_DAEMON = "false";
  process.env.NX_WORKSPACE_ROOT_PATH = root;
  const require = createRequire(`${root}/package.json`);
  const load = (path) => import(pathToFileURL(require.resolve(path)).href);
  const { createProjectGraphAsync } = await load("nx/src/devkit-exports.js");
  const { readNxJson } = await load("nx/src/config/nx-json.js");
  const { createTaskGraph } = await load(
    "nx/src/tasks-runner/create-task-graph.js",
  );
  const { createTaskHasher } = await load(
    "nx/src/hasher/create-task-hasher.js",
  );
  const nxVersion = JSON.parse(
    readFileSync(require.resolve("nx/package.json"), "utf8"),
  ).version;
  const projectGraph = await createProjectGraphAsync({ exitOnError: true });
  const nxJson = readNxJson(root);
  const hasher = createTaskHasher(projectGraph, nxJson);
  const tasks = {};
  for (const id of ids) {
    const at = id.lastIndexOf(":");
    if (at <= 0) usage(`'${id}' is not <project:target>`);
    const project = id.slice(0, at);
    const target = id.slice(at + 1);
    const graph = createTaskGraph(
      projectGraph,
      {},
      [project],
      [target],
      undefined,
      {},
    );
    const task = graph.tasks[id];
    if (!task) {
      console.error(
        `task-hashes: no task ${id} in the task graph; it has ${Object.keys(graph.tasks).join(", ") || "none"}`,
      );
      console.error("ACTION: name a task the workspace's graph holds");
      process.exit(1);
    }
    const hash = await hasher.hashTask(task, graph, process.env);
    tasks[id] = { hash: hash.value, nodes: hash.details.nodes };
  }
  const record = `${JSON.stringify({ nx: nxVersion, tasks }, null, 2)}\n`;
  if (out) writeFileSync(out, record);
  else process.stdout.write(record);
}

// A record is what `capture` writes: {tasks: {<id>: {hash: string, nodes: {...}}}}.
function readRecord(path) {
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`task-hashes: cannot read ${path}: ${error.message}`);
    console.error("ACTION: pass a record written by 'task-hashes.mjs capture'");
    process.exit(1);
  }
  const tasks = record?.tasks;
  const valid =
    tasks !== null &&
    typeof tasks === "object" &&
    Object.values(tasks).every(
      (task) =>
        typeof task?.hash === "string" &&
        task.nodes !== null &&
        typeof task.nodes === "object",
    );
  if (!valid) {
    console.error(`task-hashes: ${path} is not a capture record`);
    console.error("ACTION: pass a record written by 'task-hashes.mjs capture'");
    process.exit(1);
  }
  return tasks;
}

function diff(beforePath, afterPath) {
  const before = readRecord(beforePath);
  const after = readRecord(afterPath);
  const unmatched = [
    ...Object.keys(before)
      .filter((id) => !after[id])
      .map((id) => `${id} is only in ${beforePath}`),
    ...Object.keys(after)
      .filter((id) => !before[id])
      .map((id) => `${id} is only in ${afterPath}`),
  ];
  for (const id of Object.keys(before).sort()) {
    if (!after[id]) continue;
    if (before[id].hash === after[id].hash) {
      console.log(`same ${id} ${before[id].hash}`);
      continue;
    }
    const keys = new Set([
      ...Object.keys(before[id].nodes),
      ...Object.keys(after[id].nodes),
    ]);
    const moved = [...keys]
      .filter((key) => before[id].nodes[key] !== after[id].nodes[key])
      .sort();
    console.log(
      `moved ${id} ${before[id].hash} -> ${after[id].hash}: ${moved.join(", ")}`,
    );
  }
  if (unmatched.length > 0) {
    for (const line of unmatched) console.error(`task-hashes: ${line}`);
    console.error(
      "ACTION: capture both states with the same task list, so every task is compared",
    );
    process.exit(1);
  }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "capture") {
  const outAt = rest.indexOf("--out");
  let out;
  if (outAt >= 0) {
    out = rest[outAt + 1];
    if (!out || out.startsWith("--")) usage("--out needs a path");
    rest.splice(outAt, 2);
  }
  const [workspace, ...ids] = rest;
  if (!workspace || ids.length === 0)
    usage("capture needs a workspace and at least one task");
  await capture(workspace, ids, out && resolve(out));
} else if (mode === "diff") {
  if (rest.length !== 2) usage("diff needs two records");
  diff(rest[0], rest[1]);
} else {
  usage("the mode is capture or diff");
}
