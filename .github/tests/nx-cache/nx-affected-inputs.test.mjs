import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { taskHashes, workspaceFixture } from "./nx-fixture.mjs";

const recordedBase = "d978e887c28c654761cf94c6a59c7a36c269d9ba";
const env = {
  ...process.env,
  NX_DAEMON: "false",
  NX_ISOLATE_PLUGINS: "false",
  GITHUB_ACTIONS: "",
  NX_SKIP_NX_CACHE: "false",
  NX_SKIP_REMOTE_CACHE: "true",
};
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function commit(cwd) {
  git(cwd, "add", ".");
  git(
    cwd,
    "-c",
    "user.name=Cache selection",
    "-c",
    "user.email=cache@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "selection fixture",
  );
  return git(cwd, "rev-parse", "HEAD");
}
function affected(cwd, base) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "node_modules/nx/dist/bin/nx.js",
        "show",
        "projects",
        "--affected",
        `--base=${base}`,
        "--head=HEAD",
        "--json",
      ],
      { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ),
  );
}
function inspect(cwd) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [resolve(".github/tests/nx-cache/nx-manifest-graph.mjs"), cwd],
      { env, encoding: "utf8" },
    ),
  ).projects;
}
function missingSelections(before, after) {
  return before.filter((name) => !after.includes(name));
}

test("semantic manifest inputs retain the recorded base's real Nx affected selections", () => {
  const base = workspaceFixture(recordedBase);
  const cwd = workspaceFixture();
  try {
    const cases = [
      [
        "Cargo.toml",
        (text) =>
          text.replace('serde = { version = "1"', 'serde = { version = "^1.0"'),
      ],
      [
        "Cargo.lock",
        (text) =>
          text.replace(/(name = "serde"\nversion = ")[^"]+/, "$11.0.999"),
      ],
      [
        "package.json",
        (text) => text.replace('"vitest": "4.1.1"', '"vitest": "^4.1.1"'),
      ],
      [
        "bun.lock",
        (text) => text.replace('"vitest": "4.1.1"', '"vitest": "^4.1.1"'),
      ],
      [
        "pyproject.toml",
        (text) => text.replace("maturin>=1.7,<2.0", "maturin>=1.8,<2.0"),
      ],
      [
        "Cargo.toml",
        (text) =>
          text.replace(
            /^version = "(\d+)\.(\d+)\.(\d+)"/m,
            (_, major, minor, patch) =>
              `version = "${major}.${minor}.${Number(patch) + 1}"`,
          ),
      ],
    ];
    for (const [file, mutate] of cases) {
      const selections = [];
      for (const root of [base, cwd]) {
        const start = commit(root);
        const path = join(root, file);
        const original = readFileSync(path, "utf8");
        const changed = mutate(original);
        assert.notEqual(
          changed,
          original,
          `${file} probe must change a dependency or version`,
        );
        writeFileSync(path, changed);
        commit(root);
        selections.push(affected(root, start));
        writeFileSync(path, original);
      }
      assert.deepEqual(
        missingSelections(...selections),
        [],
        `${file} lost affected projects`,
      );
      assert.ok(
        selections[0].includes(
          file.startsWith("Cargo") ? "onepipeline-ui-e2e" : "onepipeline-ui",
        ),
        `${file} base selection includes a manifest consumer`,
      );
    }
    const implementationBase = commit(cwd);
    const sourcePath = join(cwd, "src/lib.rs");
    writeFileSync(
      sourcePath,
      `${readFileSync(sourcePath, "utf8")}\n// A source-only edit must not select registry installation journeys.\n`,
    );
    commit(cwd);
    const implementationSelection = affected(cwd, implementationBase);
    for (const registry of [
      "github-workflows-installs",
      "github-workflows-judge-install",
    ])
      assert.ok(
        !implementationSelection.includes(registry),
        `${registry} was selected by an unrelated API source edit`,
      );
    const projects = inspect(cwd);
    const validate = () => {
      for (const [name, project] of Object.entries(projects)) {
        if (name !== "onepipeline-ui" && project.consumesManifests)
          assert.ok(
            project.dependencies.includes("onepipeline-ui"),
            `${name} lost its root manifest owner edge`,
          );
        const visit = (next, trail) => {
          assert.ok(
            !trail.includes(next),
            `project cycle: ${[...trail, next].join(" -> ")}`,
          );
          for (const dependency of projects[next].dependencies)
            visit(dependency, [...trail, next]);
        };
        visit(name, []);
      }
    };
    validate();
    const reader = projects["onepipeline-ui-e2e"];
    const dependencies = reader.dependencies;
    reader.dependencies = dependencies.filter(
      (name) => name !== "onepipeline-ui",
    );
    assert.throws(validate, /lost its root manifest owner edge/);
    reader.dependencies = dependencies;
    projects["onepipeline-ui"].dependencies.push("onepipeline-ui-e2e");
    assert.throws(validate, /project cycle/);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a real affected cached test replays after an actual release version edit", () => {
  const cwd = workspaceFixture();
  try {
    const start = commit(cwd);
    const id = "timeline-categories:test";
    const before = taskHashes(cwd, [id])[id].hash;
    const run = () =>
      execFileSync(
        process.execPath,
        ["node_modules/nx/dist/bin/nx.js", "run", id, "--output-style=static"],
        { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
    assert.match(run(), /Successfully ran target test/);
    const current = readFileSync(join(cwd, "Cargo.toml"), "utf8").match(
      /^version = "(\d+)\.(\d+)\.(\d+)"/m,
    );
    const nextVersion = `${current[1]}.${current[2]}.${Number(current[3]) + 1}`;
    for (const file of ["Cargo.toml", "Cargo.lock"]) {
      const path = join(cwd, file);
      const text = readFileSync(path, "utf8");
      const changed =
        file === "Cargo.toml"
          ? text.replace(/^version = "[^"]+"/m, `version = "${nextVersion}"`)
          : text.replace(
              /(name = "onepipeline-ui"\nversion = ")[^"]+/,
              (_, prefix) => `${prefix}${nextVersion}`,
            );
      writeFileSync(path, changed);
    }
    commit(cwd);
    assert.ok(affected(cwd, start).includes("timeline-categories"));
    assert.equal(taskHashes(cwd, [id])[id].hash, before);
    assert.match(run(), /read the output from the cache/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("manifest graph inspection rejects invalid workspaces and recovers", () => {
  for (const [args, status] of [
    [[], 2],
    [[".", "extra"], 2],
    [["missing-nx-workspace"], 1],
  ]) {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [resolve(".github/tests/nx-cache/nx-manifest-graph.mjs"), ...args],
          { env, encoding: "utf8", stdio: "pipe" },
        ),
      (error) =>
        error.status === status && /nx-manifest-graph:/.test(error.stderr),
    );
  }
  assert.ok(inspect(".")["onepipeline-ui"]);
});
