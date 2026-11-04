// Read the same Nx task hashes the remote cache uses, in an isolated process.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [workspace, ...ids] = process.argv.slice(2);
process.chdir(resolve(workspace));
process.env.NX_DAEMON = "false";
process.env.NX_WORKSPACE_ROOT_PATH = process.cwd();
const require = createRequire(`${process.cwd()}/package.json`);
const load = (path) => import(pathToFileURL(require.resolve(path)).href);
const { createProjectGraphAsync } = await load("nx/src/devkit-exports.js");
const { readNxJson } = await load("nx/src/config/nx-json.js");
const { createTaskGraph } = await load(
  "nx/src/tasks-runner/create-task-graph.js",
);
const { createTaskHasher } = await load("nx/src/hasher/create-task-hasher.js");
const projectGraph = await createProjectGraphAsync({ exitOnError: true });
const hasher = createTaskHasher(projectGraph, readNxJson(process.cwd()));
const result = {};
for (const id of ids) {
  const [project, target] = id.split(":");
  const graph = createTaskGraph(
    projectGraph,
    {},
    [project],
    [target],
    undefined,
    {},
  );
  const hash = await hasher.hashTask(graph.tasks[id], graph, process.env);
  result[id] = { hash: hash.value, nodes: hash.details.nodes };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
