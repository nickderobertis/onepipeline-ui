// Inspect Nx's resolved inputs rather than maintaining a second manifest-reader list.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const [workspace, ...extra] = process.argv.slice(2);
if (!workspace || extra.length) {
  console.error("nx-manifest-graph: name exactly one workspace directory");
  process.exit(2);
}
try {
  process.chdir(resolve(workspace));
  process.env.NX_DAEMON = "false";
  process.env.NX_WORKSPACE_ROOT_PATH = process.cwd();
  const require = createRequire(`${process.cwd()}/package.json`);
  const { createProjectGraphAsync } = require("nx/src/devkit-exports.js");
  const { getInputs } = require("nx/src/hasher/task-hasher.js");
  const nx = JSON.parse(readFileSync("nx.json", "utf8"));
  const graph = await createProjectGraphAsync({ exitOnError: true });
  const projects = {};
  for (const [name, node] of Object.entries(graph.nodes)) {
    const targets = Object.entries(node.data.targets ?? {}).filter(
      ([target, config]) =>
        config.executor !== "nx:noop" &&
        ((config.cache ?? nx.targetDefaults?.[target]?.cache) === true ||
          config.inputs),
    );
    const consumesManifests = targets.some(([target]) =>
      getInputs(
        { target: { project: name, target } },
        graph,
        nx,
      ).selfInputs.some((input) =>
        input.runtime?.includes("scripts/nx-version-free-inputs.mjs"),
      ),
    );
    projects[name] = {
      root: node.data.root,
      consumesManifests,
      dependencies: graph.dependencies[name]
        .map((edge) => edge.target)
        .filter((name) => graph.nodes[name]),
    };
  }
  console.log(JSON.stringify({ schema: 1, projects }));
} catch (error) {
  console.error(
    `nx-manifest-graph: ${error.message}\nACTION: fix the named workspace or Nx input configuration`,
  );
  process.exitCode = 1;
}
