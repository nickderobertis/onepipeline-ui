import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const labels = [
  "Before Rust cache restore",
  "After Rust cache restore",
  "End of job",
];
function reportsValid(job) {
  const steps = job.steps;
  const restore = steps.findIndex((s) =>
    s.uses?.startsWith("Swatinem/rust-cache@"),
  );
  const positions = labels.map((label) =>
    steps.findIndex((s) => s.name === `Disk — ${label}`),
  );
  return (
    positions[0] === restore - 1 &&
    positions[1] === restore + 1 &&
    positions[2] === steps.length - 1 &&
    positions.every(
      (position, i) =>
        steps[position]?.if === "always()" &&
        steps[position]?.shell === "bash" &&
        steps[position]?.run.includes(
          `bash .github/scripts/report-disk.sh "${labels[i]}" || true`,
        ),
    )
  );
}

for (const [id, job] of Object.entries(workflow.jobs).filter(
  ([, job]) =>
    job["runs-on"].startsWith("ubuntu") &&
    job.steps.some((s) => s.uses?.startsWith("Swatinem/rust-cache@")),
)) {
  test(`${id} preserves all three best-effort reports around the restore`, () => {
    assert.ok(reportsValid(job));
    for (const label of labels) {
      for (const defect of ["missing", "moved", "conditional", "fatal"]) {
        const broken = structuredClone(job);
        const index = broken.steps.findIndex(
          (s) => s.name === `Disk — ${label}`,
        );
        if (defect === "missing") broken.steps.splice(index, 1);
        if (defect === "moved") {
          const [step] = broken.steps.splice(index, 1);
          broken.steps.unshift(step);
        }
        if (defect === "conditional") broken.steps[index].if = "success()";
        if (defect === "fatal")
          broken.steps[index].run = broken.steps[index].run.replace(
            `bash .github/scripts/report-disk.sh "${label}" || true`,
            `bash .github/scripts/report-disk.sh "${label}"`,
          );
        assert.equal(reportsValid(broken), false, `${label}: ${defect}`);
      }
    }
  });
}

function command(file, args) {
  const result = spawnSync(file, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("workflow reports real filesystem usage and survives a reporting failure", () => {
  const root = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? tmpdir(), "disk-report-"),
  );
  try {
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const summary = join(root, "summary");
    mkdirSync(join(workspace, "target"), { recursive: true });
    mkdirSync(home);
    writeFileSync(
      join(workspace, "target", "cache"),
      Buffer.alloc(1024 * 1024, 7),
    );
    const targetBytes = command("du", ["-s", "-B1", join(workspace, "target")])
      .trim()
      .split(/\s+/)[0];
    for (const label of labels) {
      writeFileSync(summary, "");
      const step = workflow.jobs.lint.steps.find(
        (s) => s.name === `Disk — ${label}`,
      );
      const sample = () =>
        command("df", ["-B1", "--output=size,used,avail", workspace])
          .trim()
          .split("\n")[1]
          .trim()
          .split(/\s+/)
          .map(Number);
      const before = sample();
      const result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            GITHUB_WORKSPACE: workspace,
            GITHUB_STEP_SUMMARY: summary,
          },
        },
      );
      const after = sample();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(summary, "utf8"), result.stdout);
      assert.ok(result.stdout.includes(label));
      const figures = [
        ...result.stdout.matchAll(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/gm),
      ];
      assert.equal(figures.length, 2);
      for (const match of figures) {
        const actual = match.slice(1).map(Number);
        assert.equal(actual[0], before[0]);
        // Other host processes can allocate while the report is running.
        for (const column of [1, 2])
          assert.ok(
            actual[column] >=
              Math.min(before[column], after[column]) - 1024 * 1024 &&
              actual[column] <=
                Math.max(before[column], after[column]) + 1024 * 1024,
          );
      }
      if (label === labels[1])
        assert.ok(
          result.stdout.includes(`${targetBytes}\t${workspace}/target`),
        );
      if (label === labels[1]) {
        rmSync(join(workspace, "target"), { recursive: true });
        writeFileSync(summary, "");
        const absent = spawnSync(
          "bash",
          ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: home,
              GITHUB_WORKSPACE: workspace,
              GITHUB_STEP_SUMMARY: summary,
            },
          },
        );
        assert.equal(absent.status, 0, absent.stderr);
        assert.match(absent.stdout, /target directory absent/);
        assert.ok(absent.stdout.includes(label));
        assert.equal(readFileSync(summary, "utf8"), absent.stdout);
      }
      const failed = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            GITHUB_WORKSPACE: join(root, "missing"),
            GITHUB_STEP_SUMMARY: summary,
          },
        },
      );
      assert.equal(failed.status, 0);
      assert.match(failed.stderr, /No such file or directory/);
      assert.match(
        failed.stderr,
        /verify the workspace, home and step-summary paths/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow preserves its verdict for input, allocation and summary failures", () => {
  const root = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? tmpdir(), "disk-errors-"),
  );
  const target = join(root, "target");
  mkdirSync(target);
  writeFileSync(join(target, "cache"), "restored cache");
  const summary = join(root, "summary");
  const step = workflow.jobs.lint.steps.find(
    (s) => s.name === `Disk — ${labels[1]}`,
  );
  const env = {
    ...process.env,
    HOME: root,
    GITHUB_WORKSPACE: root,
    GITHUB_STEP_SUMMARY: summary,
  };
  const run = (environment, invocation = step.run) =>
    spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", invocation],
      {
        encoding: "utf8",
        env: environment,
      },
    );
  try {
    for (const key of ["GITHUB_WORKSPACE", "HOME", "GITHUB_STEP_SUMMARY"]) {
      for (const value of [undefined, ""]) {
        const invalid = { ...env, [key]: value };
        const result = run(invalid);
        assert.equal(result.status, 0);
        assert.match(result.stderr, new RegExp(`Set ${key}`));
      }
    }
    for (const argument of ['""', ""]) {
      const result = run(env, step.run.replace(`"${labels[1]}"`, argument));
      assert.equal(result.status, 0);
      assert.match(result.stderr, /Pass the report label/);
    }
    const unwritable = run({ ...env, GITHUB_STEP_SUMMARY: root });
    assert.equal(unwritable.status, 0);
    assert.match(unwritable.stderr, /Is a directory/);
    assert.match(unwritable.stderr, /Disk report incomplete/);

    chmodSync(target, 0);
    const allocation = run(env);
    assert.equal(allocation.status, 0);
    assert.match(allocation.stderr, /Permission denied/);
    assert.match(allocation.stderr, /Disk report incomplete/);
    assert.match(allocation.stdout, /Restored target allocated bytes/);
    assert.equal(readFileSync(summary, "utf8"), allocation.stdout);
  } finally {
    chmodSync(target, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
