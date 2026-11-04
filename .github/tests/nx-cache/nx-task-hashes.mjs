// Read the same Nx task hashes the remote cache uses, in an isolated process.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Exit 2 is invalid usage; exit 1 is an Nx/configuration failure.
function usage(message) {
  console.error(
    `nx-task-hashes: ${message}\nACTION: name a readable Nx workspace and --ci or project:target identifiers`,
  );
  process.exit(2);
}
async function main() {
  const [workspace, ...requested] = process.argv.slice(2);
  if (!workspace || requested.length === 0)
    usage("workspace and tasks are required");
  if (
    requested.some((id) => id.startsWith("--")) &&
    !(requested.length === 1 && requested[0] === "--ci")
  )
    usage("unknown or mixed task-selection flag");
  if (
    requested[0] !== "--ci" &&
    requested.some((id) => !/^[A-Za-z0-9@._/-]+:[A-Za-z0-9._-]+$/.test(id))
  )
    usage("task identifiers must be project:target");
  const root = resolve(workspace);
  try {
    for (const file of ["nx.json", "package.json"]) {
      const value = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        usage(`${file} must hold an object`);
    }
    process.chdir(root);
  } catch (error) {
    usage(`cannot read workspace ${root}: ${error.message}`);
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
  const { getInputs, filterUsingGlobPatterns } = await load(
    "nx/src/hasher/task-hasher.js",
  );
  const projectGraph = await createProjectGraphAsync({ exitOnError: true });
  const hasher = createTaskHasher(projectGraph, readNxJson(process.cwd()));
  const nx = readNxJson(process.cwd());
  const ids = requested.includes("--ci")
    ? Object.values(
        createTaskGraph(
          projectGraph,
          {},
          Object.keys(projectGraph.nodes),
          [
            ...new Set(
              [
                ...readFileSync("scripts/ci-job.sh", "utf8").matchAll(
                  /targets="([a-z,-]+)"/g,
                ),
              ].flatMap((match) => match[1].split(",")),
            ),
          ],
          undefined,
          {},
        ).tasks,
      )
        .filter((task) => {
          const config =
            projectGraph.nodes[task.target.project].data.targets[
              task.target.target
            ];
          return (
            (config.cache ?? nx.targetDefaults?.[task.target.target]?.cache) ===
              true && config.executor !== "nx:noop"
          );
        })
        .map((task) => task.id)
        .sort()
    : requested;
  for (const id of ids) {
    const [project, target] = id.split(":");
    if (!projectGraph.nodes[project]?.data.targets?.[target])
      usage(`unknown task ${id}`);
  }
  const graph = createTaskGraph(
    projectGraph,
    {},
    [...new Set(ids.map((id) => id.split(":")[0]))],
    [...new Set(ids.map((id) => id.split(":")[1]))],
    undefined,
    {},
  );
  const hashes = await hasher.hashTasks(
    ids.map((id) => graph.tasks[id]),
    graph,
    Object.fromEntries(ids.map((id) => [id, process.env])),
    process.cwd(),
    true,
  );
  const result = {};
  for (const [index, id] of ids.entries()) {
    const [project, target] = id.split(":");
    const hash = hashes[index];
    const node = projectGraph.nodes[project];
    const probes = getInputs(graph.tasks[id], projectGraph, nx)
      .selfInputs.filter(
        (input) => input.fileset && !input.fileset.startsWith("!"),
      )
      .map((input) => ({
        rule: input.fileset,
        file: filterUsingGlobPatterns(
          node.data.root,
          hash.inputs.files.map((file) => ({ file })),
          [input.fileset.replace("{workspaceRoot}/", "")],
        )[0]?.file,
      }))
      .filter((probe) => probe.file);
    result[id] = {
      probes,
      outputs:
        node.data.targets[target].outputs ??
        nx.targetDefaults?.[target]?.outputs ??
        [],
      hash: hash.value,
      nodes: hash.details.nodes,
      inputs: hash.inputs,
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
main().catch((error) => {
  console.error(
    `nx-task-hashes: ${error.message}\nACTION: fix the Nx configuration or runtime input named above`,
  );
  process.exitCode = 1;
});
