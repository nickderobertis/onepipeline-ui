// Read how each declared file input rule's probe moves the tasks that read it, in one
// process: starting Node and Nx for each of the 150-odd probes was most of this reader's
// cost, and a CI job ran past its cap on it (docs/linux-cold-cache-timing.md).
import {
  readFileSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { probeEdit } from "./nx-fixture.mjs";

// Exit 2 is invalid usage; exit 1 is an Nx/configuration failure.
function usage(message) {
  console.error(
    `nx-probe-hashes: ${message}\nACTION: name a readable Nx workspace and the JSON taskHashes printed for it`,
  );
  process.exit(2);
}

async function main() {
  const [workspace, beforePath] = process.argv.slice(2);
  if (!workspace || !beforePath) usage("workspace and hashes are required");
  let before;
  try {
    before = JSON.parse(readFileSync(beforePath, "utf8"));
  } catch (error) {
    usage(`cannot read hashes ${beforePath}: ${error.message}`);
  }
  if (!before || typeof before !== "object" || Array.isArray(before))
    usage("the hashes must be an object of tasks");
  for (const [id, task] of Object.entries(before)) {
    if (
      !/^[A-Za-z0-9@._/-]+:[A-Za-z0-9._-]+$/.test(id) ||
      !Array.isArray(task?.probes)
    )
      usage(`${id} is not a task carrying its probes`);
    for (const probe of task.probes)
      if (typeof probe?.file !== "string")
        usage(`${id} names a probe that is not a path`);
  }
  try {
    process.chdir(resolve(workspace));
  } catch (error) {
    usage(`cannot enter workspace ${workspace}: ${error.message}`);
  }
  // A probe is rewritten in place, so it must really be a file of this workspace.
  const root = realpathSync(process.cwd());
  for (const probe of Object.values(before).flatMap((task) => task.probes)) {
    let inside;
    try {
      inside = relative(root, realpathSync(probe.file));
    } catch (error) {
      usage(`cannot read probe ${probe.file}: ${error.message}`);
    }
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      usage(`${probe.file} is outside the workspace`);
  }
  process.env.NX_DAEMON = "false";
  process.env.NX_WORKSPACE_ROOT_PATH = process.cwd();
  const require = createRequire(`${process.cwd()}/package.json`);
  const load = (path) => import(pathToFileURL(require.resolve(path)).href);
  const { createProjectGraphAsync } = await load("nx/src/devkit-exports.js");
  const { readNxJson } = await load("nx/src/config/nx-json.js");
  const { createTaskGraph } = await load(
    "nx/src/tasks-runner/create-task-graph.js",
  );
  const { createTaskHasher } = await load(
    "nx/src/hasher/create-task-hasher.js",
  );
  const { resetWorkspaceContext } = await load(
    "nx/src/utils/workspace-context.js",
  );

  const hashes = async (ids) => {
    // A new context, graph and hasher read each edit as a separate Nx process would.
    resetWorkspaceContext();
    const graph = await createProjectGraphAsync({ exitOnError: true });
    const tasks = createTaskGraph(
      graph,
      {},
      [...new Set(ids.map((id) => id.split(":")[0]))],
      [...new Set(ids.map((id) => id.split(":")[1]))],
      undefined,
      {},
    );
    const hasher = createTaskHasher(graph, readNxJson(process.cwd()));
    const hashed = await hasher.hashTasks(
      ids.map((id) => tasks.tasks[id]),
      tasks,
      Object.fromEntries(ids.map((id) => [id, process.env])),
      process.cwd(),
      true,
    );
    return Object.fromEntries(ids.map((id, at) => [id, hashed[at].value]));
  };

  const ids = Object.keys(before);
  const probes = [
    ...new Set(
      Object.values(before).flatMap((task) =>
        task.probes.map((probe) => probe.file),
      ),
    ),
  ];
  const moved = {};
  for (const [at, file] of probes.entries()) {
    const original = readFileSync(file);
    const { atime, mtime } = statSync(file);
    const readers = ids.filter((id) =>
      before[id].probes.some((probe) => probe.file === file),
    );
    writeFileSync(file, probeEdit(file, original));
    // Nx keeps a file's hash while its whole-second mtime stands, so each edit claims
    // a later second than any before it (`taskHashes` gets this from a fresh archive).
    const later = new Date(Date.now() + (at + 1) * 2000);
    utimesSync(file, later, later);
    try {
      moved[file] = await hashes(readers);
    } finally {
      writeFileSync(file, original);
      utimesSync(file, atime, mtime);
    }
  }
  process.stdout.write(
    `${JSON.stringify({ moved, restored: await hashes(ids) })}\n`,
  );
}

main().catch((error) => {
  console.error(
    `nx-probe-hashes: ${error.message}\nACTION: fix the Nx configuration or runtime input named above`,
  );
  process.exitCode = 1;
});
