#!/usr/bin/env node
// Each named task's resolved hash inputs at the checkout in the current
// directory, as Nx's own `show target inputs` computes them, matched against a
// list of changed files: `node <this> <tasks.json> <changed.txt>` prints JSON
// { task: { files: [matched...], runtime: [...], environment: [...],
// dep_outputs: [...], file_count } }.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const [tasksFile, changedFile] = process.argv.slice(2);
const req = createRequire(`${process.cwd()}/package.json`);
const nx = req.resolve("nx/package.json").replace(/package\.json$/, "");
const { createProjectGraphAsync } = req(
  `${nx}dist/src/project-graph/project-graph.js`,
);
const { readNxJson } = req(`${nx}dist/src/config/nx-json.js`);
const { getTaskRawInputs } = req(`${nx}dist/src/hasher/check-task-files.js`);

const tasks = JSON.parse(readFileSync(tasksFile, "utf8"));
const changed = new Set(
  readFileSync(changedFile, "utf8").split("\n").filter(Boolean),
);
const projectGraph = await createProjectGraphAsync({ exitOnError: true });
const nxJson = readNxJson();
const out = {};
for (const id of tasks) {
  try {
    const r = await getTaskRawInputs(id, { projectGraph, nxJson });
    out[id] = {
      files: r.files.filter((f) => changed.has(f)),
      file_count: r.files.length,
      runtime: r.runtime ?? [],
      environment: r.environment ?? [],
      dep_outputs: r.depOutputs ?? [],
    };
  } catch (error) {
    out[id] = { error: String(error.message ?? error).slice(0, 300) };
  }
}
process.stdout.write(`${JSON.stringify(out)}\n`);
