// `just gate`'s time budget, driven through the real wrapper the recipe runs its
// body inside (scripts/gate-time.sh), the real reporter it measures with
// (scripts/gate-time-budget.mjs) and the real onebudgetspec binary this
// workspace pins. Nothing is stood in for: the bodies are real short commands,
// and the records the budget is checked over are written where the wrapper
// reads them. What is asserted is exit statuses, warnings and record contents,
// never a duration.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const ROOT = resolve(".");
const WRAPPER = join(ROOT, "scripts/gate-time.sh");
const scratch = mkdtempSync(
  join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(), "gate-time-"),
);
after(() => rmSync(scratch, { recursive: true, force: true }));

let serial = 0;
const fresh = () => {
  serial += 1;
  const dir = join(scratch, String(serial));
  mkdirSync(dir, { recursive: true });
  return dir;
};

function gate(args, env = {}) {
  const run = spawnSync("bash", [WRAPPER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const record = (seconds, extra = {}) => ({
  schema_version: 1,
  invocation: "seeded",
  command: ["just", "_gate-body", "origin/main"],
  started_at_ms: 1_000_000,
  ended_at_ms: 1_000_000 + seconds * 1000,
  exit_code: 0,
  ...extra,
});

test("the wrapper records this invocation, replacing a stale record, and checks it", () => {
  const dir = fresh();
  const path = join(dir, "record.json");
  writeFileSync(
    path,
    `${JSON.stringify(record(5000, { invocation: "stale" }))}\n`,
  );
  const run = gate(["--", "bash", "-c", "echo body ran"], {
    ONEPIPELINE_UI_GATE_TIME_RECORD: path,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /body ran/);
  const written = JSON.parse(readFileSync(path, "utf8"));
  assert.notEqual(written.invocation, "stale");
  assert.deepEqual(written.command, ["bash", "-c", "echo body ran"]);
  assert.equal(written.exit_code, 0);
  assert.equal(written.schema_version, 1);
  assert.ok(written.ended_at_ms >= written.started_at_ms);
  // The stale record said 5000 s, over the line; this run's own is within it.
  assert.match(run.stdout, /^budget onepipeline-ui-gate-time: .* — within;/m);
  assert.doesNotMatch(run.stderr, /warning/);
});

test("a failing body still fails the gate, with its own status, and leaves its record", () => {
  const dir = fresh();
  const path = join(dir, "record.json");
  writeFileSync(
    path,
    `${JSON.stringify(record(10, { invocation: "stale" }))}\n`,
  );
  const run = gate(["--", "bash", "-c", "exit 7"], {
    ONEPIPELINE_UI_GATE_TIME_RECORD: path,
  });
  assert.equal(run.status, 7);
  const written = JSON.parse(readFileSync(path, "utf8"));
  assert.notEqual(written.invocation, "stale");
  assert.equal(written.exit_code, 7);
  // A failed gate's time says nothing, so no budget is checked over it.
  assert.doesNotMatch(run.stdout, /budget onepipeline-ui-gate-time/);
});

test("within the threshold the gate passes quietly; over it, it warns and still passes", () => {
  const dir = fresh();
  const path = join(dir, "record.json");
  writeFileSync(path, `${JSON.stringify(record(1200))}\n`);
  const within = gate(["--check"], { ONEPIPELINE_UI_GATE_TIME_RECORD: path });
  assert.equal(within.status, 0, within.stderr);
  assert.match(
    within.stdout,
    /onepipeline-ui-gate-time: actual 1200 seconds, budget 1800 seconds/,
  );
  assert.doesNotMatch(within.stderr, /warning/);

  writeFileSync(path, `${JSON.stringify(record(2400))}\n`);
  const over = gate(["--check"], { ONEPIPELINE_UI_GATE_TIME_RECORD: path });
  assert.equal(over.status, 0, over.stderr);
  assert.match(
    over.stdout,
    /onepipeline-ui-gate-time: actual 2400 seconds, .* — over;/,
  );
  assert.match(
    over.stderr,
    /gate-time: warning: this gate ran over the budget onepipeline-ui-gate-time/,
  );
});

test("a missing or failed record, or an invalid budgets file, fails the gate", () => {
  const dir = fresh();
  const missing = gate(["--check"], {
    ONEPIPELINE_UI_GATE_TIME_RECORD: join(dir, "absent.json"),
  });
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /no readable gate record/);
  assert.equal(missing.stdout, "");
  assert.match(
    missing.stderr,
    /could not be held to its budget: onebudgetspec exited 3/,
  );

  const failed = join(dir, "failed.json");
  writeFileSync(failed, `${JSON.stringify(record(10, { exit_code: 1 }))}\n`);
  const refused = gate(["--check"], {
    ONEPIPELINE_UI_GATE_TIME_RECORD: failed,
  });
  assert.equal(refused.status, 3);
  assert.match(refused.stderr, /records a gate that failed/);

  // A copy of budgets.yaml whose gate-time budget lost its threshold, beside
  // the real scripts it runs, as a budgets file is checked from its directory.
  const invalid = fresh();
  symlinkSync(join(ROOT, "scripts"), join(invalid, "scripts"));
  symlinkSync(join(ROOT, "node_modules"), join(invalid, "node_modules"));
  const budgets = readFileSync(join(ROOT, "budgets.yaml"), "utf8");
  const broken = budgets.replace(
    /(id: onepipeline-ui-gate-time[\s\S]*?)\n {4}threshold: 1800\n/,
    "$1\n",
  );
  assert.notEqual(broken, budgets);
  writeFileSync(join(invalid, "budgets.yaml"), broken);
  const good = join(dir, "good.json");
  writeFileSync(good, `${JSON.stringify(record(10))}\n`);
  const rejected = gate(["--check"], {
    ONEPIPELINE_UI_GATE_TIME_RECORD: good,
    ONEPIPELINE_UI_GATE_TIME_BUDGETS: join(invalid, "budgets.yaml"),
  });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /onebudgetspec exited 2/);
});

test("a record gate-time.sh did not write is refused, never read as a time", () => {
  const dir = fresh();
  const cases = [
    ["not JSON", "{ half a record"],
    ["a wrong schema", JSON.stringify(record(10, { schema_version: 2 }))],
    ["no invocation", JSON.stringify(record(10, { invocation: 7 }))],
    ["a fractional start", JSON.stringify(record(10, { started_at_ms: 1.5 }))],
    ["an end before its start", JSON.stringify(record(10, { ended_at_ms: 0 }))],
    [
      "dates no clock can show",
      JSON.stringify(
        record(10, { started_at_ms: 9e15, ended_at_ms: 9e15 + 1000 }),
      ),
    ],
  ];
  for (const [what, text] of cases) {
    const path = join(dir, `${what.replaceAll(" ", "-")}.json`);
    writeFileSync(path, `${text}\n`);
    const run = gate(["--check"], { ONEPIPELINE_UI_GATE_TIME_RECORD: path });
    assert.equal(run.status, 3, `${what}: ${run.stdout}${run.stderr}`);
    assert.match(
      run.stderr,
      what === "not JSON"
        ? /no readable gate record/
        : /is not a gate record scripts\/gate-time\.sh wrote/,
      what,
    );
  }
});

test("the wrapper refuses a call that names no body", () => {
  for (const args of [[], ["--"], ["just", "check"], ["--check", "extra"]]) {
    const run = gate(args);
    assert.equal(run.status, 2, JSON.stringify(args));
    assert.match(run.stderr, /ACTION: run 'scripts\/gate-time\.sh/);
  }
});

// The recipe as just itself parses it: `gate` has no dependency and one line,
// the wrapper around `_gate-body`, which is where every check runs.
export function gateRecipeProblems(dump) {
  const problems = [];
  const recipes = dump.recipes ?? {};
  const gateRecipe = recipes.gate;
  const body = recipes["_gate-body"];
  if (!gateRecipe) return ["the justfile has no gate recipe"];
  if ((gateRecipe.dependencies ?? []).length)
    problems.push("gate has a dependency that runs outside the wrapper");
  const lines = (r) =>
    (r?.body ?? []).map((line) =>
      line
        .map((fragment) =>
          typeof fragment === "string" ? fragment : JSON.stringify(fragment),
        )
        .join(""),
    );
  const gateLines = lines(gateRecipe);
  if (
    gateLines.length !== 1 ||
    !/^@?bash scripts\/gate-time\.sh -- just _gate-body "\$1"$/.test(
      gateLines[0],
    )
  )
    problems.push(
      `gate does not run only its body inside the wrapper: ${JSON.stringify(gateLines)}`,
    );
  if (!body) problems.push("the justfile has no _gate-body recipe");
  else {
    const bodyLines = lines(body);
    for (const step of ["just check", "just lint-llm-diff"])
      if (!bodyLines.some((line) => line.replace(/^@/, "").startsWith(step)))
        problems.push(`_gate-body does not run ${step}`);
  }
  return problems;
}

const dump = () =>
  JSON.parse(
    execFileSync("just", ["--dump", "--dump-format", "json"], {
      encoding: "utf8",
    }),
  );

test("the gate recipe runs its whole body inside the wrapper", () => {
  assert.deepEqual(gateRecipeProblems(dump()), []);
  const outside = structuredClone(dump());
  outside.recipes.gate.dependencies = [{ recipe: "check", arguments: [] }];
  assert.ok(
    gateRecipeProblems(outside).includes(
      "gate has a dependency that runs outside the wrapper",
    ),
  );
  const unwrapped = structuredClone(dump());
  unwrapped.recipes.gate.body = [["@just _gate-body "], ['"$1"']];
  assert.ok(
    gateRecipeProblems(unwrapped).some((p) =>
      p.startsWith("gate does not run only its body"),
    ),
  );
  const thin = structuredClone(dump());
  thin.recipes["_gate-body"].body = thin.recipes["_gate-body"].body.filter(
    (line) => !line.join("").includes("lint-llm-diff"),
  );
  assert.ok(
    gateRecipeProblems(thin).includes(
      "_gate-body does not run just lint-llm-diff",
    ),
  );
  assert.ok(existsSync(WRAPPER));
});

test("a budgets file or a record the wrapper cannot reach fails the gate, saying which", () => {
  const dir = fresh();
  const good = join(dir, "good.json");
  writeFileSync(good, `${JSON.stringify(record(10))}\n`);
  const missing = gate(["--check"], {
    ONEPIPELINE_UI_GATE_TIME_RECORD: good,
    ONEPIPELINE_UI_GATE_TIME_BUDGETS: join(dir, "no-such-dir", "budgets.yaml"),
  });
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.match(
    missing.stderr,
    /no budgets file at .*no-such-dir\/budgets\.yaml/,
  );
  assert.doesNotMatch(missing.stderr, /warning/);

  // A record whose directory is a file: nothing can be written there.
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "");
  const unwritable = gate(["--", "bash", "-c", "true"], {
    ONEPIPELINE_UI_GATE_TIME_RECORD: join(blocker, "record.json"),
  });
  assert.equal(unwritable.status, 1);
  assert.match(
    unwritable.stderr,
    /cannot create the directory of the gate record at .*blocker\/record\.json/,
  );
  assert.match(
    unwritable.stderr,
    /ACTION: make .*blocker a writable directory/,
  );
});

test("a stale record the wrapper cannot replace, or a record it cannot write, fails the gate with the cause", () => {
  const dir = fresh();
  // A directory where the record goes: rm -f cannot replace it.
  const occupied = join(dir, "occupied.json");
  mkdirSync(join(occupied, "inside"), { recursive: true });
  const replace = gate(["--", "bash", "-c", "true"], {
    ONEPIPELINE_UI_GATE_TIME_RECORD: occupied,
  });
  assert.equal(replace.status, 1);
  assert.match(
    replace.stderr,
    /cannot replace the gate record at .*occupied\.json: .*[Ii]s a directory/,
  );

  // A directory the body can run beside but nothing can be written in.
  const locked = join(dir, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o555);
  try {
    const write = gate(["--", "bash", "-c", "echo body ran"], {
      ONEPIPELINE_UI_GATE_TIME_RECORD: join(locked, "record.json"),
    });
    assert.equal(write.status, 1);
    assert.match(write.stdout, /body ran/);
    assert.match(
      write.stderr,
      /cannot write the gate record at .*locked\/record\.json: .*EACCES/,
    );
    assert.match(write.stderr, /ACTION: make .*locked a writable directory/);
  } finally {
    chmodSync(locked, 0o755);
  }
});
