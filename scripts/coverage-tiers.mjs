#!/usr/bin/env node
// The coverage tiers the combined floor must read: every Nx target whose output
// is a `target/coverage-units/<tier>.lcov` report, each checked to be a target
// `onepipeline-ui-coverage:coverage` depends on. Printed space-separated for
// `_crate-coverage` to hand to `coverage-merge.mjs --unit`. A tier the aggregate
// does not depend on would be left out of the merge, and out of the floor,
// without anything else noticing.
//
// Reads project.json and tests/tiers/*/project.json from the working directory.
// Exit: 0 and the tier names; 1 naming the tiers the aggregate does not depend
// on, or a dependency on one that is not a tier, or no tier found.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const refuse = (message) => {
  console.error(`coverage-tiers: ${message}`);
  process.exit(1);
};
let projects;
try {
  const paths = [
    "project.json",
    ...readdirSync("tests/tiers").map((tier) =>
      join("tests/tiers", tier, "project.json"),
    ),
  ];
  projects = paths.map((path) => {
    const project = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof project?.name !== "string" ||
      typeof project?.targets !== "object" ||
      project.targets === null
    )
      throw new Error(`${path} names no project with targets`);
    return project;
  });
} catch (error) {
  refuse(
    `cannot read the tier project files: ${error.message}. ACTION: run from the repository root and repair the file named`,
  );
}
const tierOf = new Map();
for (const project of projects)
  for (const [target, definition] of Object.entries(project.targets ?? {}))
    for (const output of definition.outputs ?? []) {
      const match =
        /^\{workspaceRoot\}\/target\/coverage-units\/([\w-]+)\.lcov$/.exec(
          output,
        );
      if (!match) continue;
      const id = `${project.name}:${target}`;
      if (tierOf.has(id) || [...tierOf.values()].includes(match[1]))
        refuse(
          `${id} declares report ${match[1]}, which another output already claims. ACTION: give each tier target exactly one report of its own name`,
        );
      tierOf.set(id, match[1]);
    }
const coverage = projects.find((p) => p.name === "onepipeline-ui-coverage")
  ?.targets?.coverage;
const depended = new Set(
  (coverage?.dependsOn ?? []).flatMap((dependency) =>
    (dependency.projects ?? []).map(
      (project) => `${project}:${dependency.target}`,
    ),
  ),
);
if (tierOf.size === 0)
  refuse(
    "no target outputs a target/coverage-units/<tier>.lcov report. ACTION: declare that output on each coverage tier's test target",
  );
const missing = [...tierOf.keys()].filter((id) => !depended.has(id));
if (missing.length)
  refuse(
    `${missing.join(", ")} run a coverage tier that onepipeline-ui-coverage:coverage does not depend on. ACTION: add each to that target's dependsOn so the floor reads it`,
  );
const extra = [...depended].filter((id) => !tierOf.has(id));
if (extra.length)
  refuse(
    `onepipeline-ui-coverage:coverage depends on ${extra.join(", ")}, which run no coverage tier. ACTION: remove it, or make it one`,
  );
process.stdout.write([...tierOf.values()].sort().join(" "));
