import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  digest,
  expandMatrix,
  resolveScenario,
  resolveWorkflow,
  workflows,
} from "../workflow-graph.mjs";
import { history, prEvent } from "./histories.mjs";

const events = [
  ["pr-opened", "pull_request", "opened"],
  ["pr-synchronize", "pull_request", "synchronize"],
  ["pr-reopened", "pull_request", "reopened"],
  ["base-push", "push", null],
  ["release-merge", "push", null],
  ["tag-push", "push", null],
  ["release", "release", "published"],
  ["downstream", "workflow_run", "completed"],
  ["dispatch", "repository_dispatch", null],
  ["schedule", "schedule", null],
  ["manual-default", "workflow_dispatch", null],
  ["manual-opt-in", "workflow_dispatch", null],
];
const protectedNames = [
  "cross (macos-latest)",
  "cross (windows-latest)",
  "deny",
  "gate",
  "install (macos-latest)",
  "install (ubuntu-latest)",
  "install (windows-latest)",
  "llmlint",
  "msrv",
  "pr-title",
  "visual-docs / report (x86_64, shots/current, shots/verify, Visual docs)",
];
test("actual workflows, expressions and reusable calls record the complete lifecycle", () => {
  const h = history();
  const scenarios = [];
  try {
    for (const [id, event, action] of events)
      for (const diff of ["source", "version-only", "dependency"])
        for (const fork of [false, true])
          for (const releaseBranch of [false, true])
            for (const pypi of ["true", "false"])
              for (const npm of ["true", "false"])
                for (const cratePublish of ["true", "false"]) {
                  const payload = prEvent(
                    releaseBranch ? "release-plz-123" : "feature",
                    fork,
                  );
                  payload.event_name = event;
                  const policy = h.classify(payload, h.heads[diff]);
                  const scenario = {
                    id: `${id}/${diff}/${fork ? "fork" : "same"}/${releaseBranch ? "release" : "ordinary"}/${pypi}/${npm}/${cratePublish}`,
                    class: id,
                    event,
                    action,
                    branch: id === "tag-push" ? undefined : "main",
                    ref:
                      id === "tag-push" || event === "release"
                        ? "refs/tags/v1.1.0"
                        : "refs/heads/main",
                    upstream: workflows().find((w) => w.file === "release.yml")
                      .document.name,
                    headRef: payload.pull_request.head.ref,
                    vars: { PYPI_PUBLISH: pypi, NPM_PUBLISH: npm },
                    cratePublish,
                    inputs:
                      id === "manual-opt-in" ? { macos_diagnostic: true } : {},
                    policy,
                    diff,
                    fork,
                    releaseBranch,
                  };
                  const rows = resolveScenario(scenario, policy);
                  if (event === "pull_request") {
                    const names = rows.map((row) => row.name);
                    for (const name of protectedNames)
                      assert.ok(
                        names.includes(name),
                        `missing protected display name ${name} in ${scenario.id}`,
                      );
                    const mac = rows.filter(
                      (row) => row.macos && row.requested,
                    );
                    assert.equal(
                      mac.some((row) => row.workflow === "ci.yml"),
                      policy.macosRequired,
                      scenario.id,
                    );
                  }
                  if (
                    event !== "pull_request" &&
                    event !== "release" &&
                    id !== "manual-opt-in"
                  )
                    assert.deepEqual(
                      rows.filter((row) => row.macos && row.requested),
                      [],
                      scenario.id,
                    );
                  scenarios.push({ ...scenario, rows });
                }
    for (const input of ["{", "{}"]) {
      const policy = h.classify(input, h.heads.source);
      const rows = resolveScenario(
        {
          id: "unknown-pr",
          event: "pull_request",
          action: "synchronize",
          branch: "main",
        },
        policy,
      );
      assert.ok(rows.some((row) => row.macos && row.requested));
    }
    const runs = scenarios.flatMap((s) =>
      [...new Set(s.rows.map((row) => row.workflow))].map((workflow) => ({
        scenario: s.id,
        workflow,
        macJobs: s.rows.filter(
          (row) => row.workflow === workflow && row.macos && row.requested,
        ).length,
        rows: s.rows.filter((row) => row.workflow === workflow),
      })),
    );
    const lifecycles = [];
    for (const diff of ["source", "version-only", "dependency"])
      for (const fork of [false, true])
        for (const pypi of ["true", "false"])
          for (const npm of ["true", "false"])
            for (const cratePublish of ["true", "false"]) {
              const matching = (
                name,
                releaseBranch = false,
                selectedDiff = diff,
                selectedFork = fork,
              ) =>
                scenarios.find(
                  (s) =>
                    s.class === name &&
                    s.releaseBranch === releaseBranch &&
                    s.diff === selectedDiff &&
                    s.fork === selectedFork &&
                    s.vars.PYPI_PUBLISH === pypi &&
                    s.vars.NPM_PUBLISH === npm &&
                    s.cratePublish === cratePublish,
                );
              const phases = [
                matching("pr-synchronize"),
                matching("base-push"),
                matching("pr-synchronize", true, "version-only", false),
                matching("release-merge", false, "version-only", false),
                matching("tag-push"),
                matching("release"),
                matching("downstream"),
              ];
              const spending = phases.flatMap((s) =>
                [
                  ...new Set(
                    s.rows
                      .filter((row) => row.macos && row.requested)
                      .map((row) => row.workflow),
                  ),
                ].map((workflow) => ({
                  event: s.class,
                  workflow,
                  jobs: s.rows.filter(
                    (row) =>
                      row.workflow === workflow && row.macos && row.requested,
                  ),
                })),
              );
              lifecycles.push({
                diff,
                fork,
                pypi,
                npm,
                cratePublish,
                phases: phases.map((s) => s.id),
                macRuns: spending,
              });
            }
    const worst = lifecycles.reduce((a, b) =>
      a.macRuns.length >= b.macRuns.length ? a : b,
    );
    const macRuns = worst.macRuns;
    mkdirSync(".github/.telemetry", { recursive: true });
    writeFileSync(
      ".github/.telemetry/macos-policy.json",
      JSON.stringify(
        {
          schemaVersion: 1,
          sourceDigest: digest(),
          scenarios,
          runs,
          macRuns,
          lifecycles,
          jobsPerRun: Math.max(...runs.map((run) => run.macJobs)),
          runsPerChange: macRuns.length,
        },
        null,
        2,
      ),
    );
  } finally {
    h.close();
  }
});
test("unsupported runners/calls are explicit failures; real matrix include/exclude expands", () => {
  assert.throws(
    () =>
      resolveWorkflow(
        "bad.yml",
        { jobs: { bad: { "runs-on": `\${{ inputs.runner }}` } } },
        { event: "push" },
        {},
      ),
    /unresolved runner/,
  );
  assert.throws(
    () =>
      resolveWorkflow(
        "bad.yml",
        {
          jobs: { bad: { uses: "unknown/repo/.github/workflows/call.yml@v1" } },
        },
        { event: "push" },
        {},
      ),
    /unresolved reusable/,
  );
  assert.deepEqual(
    expandMatrix(
      {
        os: ["ubuntu-latest", "windows-latest"],
        exclude: [{ os: "windows-latest" }],
        include: [{ os: "macos-latest" }],
      },
      {},
    ),
    [{ os: "ubuntu-latest" }, { os: "macos-latest" }],
  );
});
test("Mac PR job contains the original cross and installed-binary proofs", () => {
  const ci = workflows().find((w) => w.file === "ci.yml").document;
  const steps = ci.jobs.macos.steps;
  const commands = steps.map((s) => s.run || "").join("\n");
  assert.match(commands, /just check-cross/);
  assert.match(commands, /cargo install --path \. --locked/);
  assert.match(commands, /scripts\/smoke-published.sh/);
  for (const id of ["cross-macos", "install-macos"]) {
    assert.equal(ci.jobs[id].if, "always()");
    assert.ok(ci.jobs[id].needs.includes("macos"));
    assert.match(ci.jobs[id].steps.at(-1).run, /macos-verdict.mjs/);
  }
});

test("actual reusable deploy condition respects cancellation", () => {
  const workflow = workflows().find((w) => w.file === "visual-docs.yml");
  const rows = resolveWorkflow(
    workflow.file,
    workflow.document,
    {
      event: "pull_request",
      action: "synchronize",
      results: { report: "cancelled" },
    },
    {},
  );
  assert.equal(
    rows.find((row) => row.job === "visual-docs / deploy-pages").requested,
    false,
  );
});

test("snapshot verification strips only the approved annotation and rejects any upstream byte change", () => {
  const scratch = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR, "snapshot-"),
  );
  try {
    mkdirSync(join(scratch, ".github/fixtures"), { recursive: true });
    for (const file of ["screencomp-v0.4.8.yml", "reusable-lock.json"])
      cpSync(
        `.github/fixtures/${file}`,
        join(scratch, ".github/fixtures", file),
      );
    cpSync("screencomp.toml", join(scratch, "screencomp.toml"));
    const document = workflows().find(
      (w) => w.file === "visual-docs.yml",
    ).document;
    const script = `import {resolveWorkflow} from ${JSON.stringify(new URL("../workflow-graph.mjs", import.meta.url).href)};
      resolveWorkflow("visual-docs.yml", JSON.parse(process.argv[1]), {event:"pull_request",action:"synchronize"}, {});`;
    const run = () =>
      spawnSync(
        "node",
        ["--input-type=module", "-e", script, JSON.stringify(document)],
        { cwd: scratch, encoding: "utf8" },
      );
    assert.equal(run().status, 0);
    const file = join(scratch, ".github/fixtures/screencomp-v0.4.8.yml");
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}# changed upstream byte\n`,
    );
    const refused = run();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /differs from pinned blob/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
