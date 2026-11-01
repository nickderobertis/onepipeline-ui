// The two tools that keep the release-tail recordings honest, driven as a
// maintainer runs them: gh-replay.mjs's record mode, which asks the real `gh`
// and saves its answer, and reconcile.mjs, which asks `gh` again and diffs.
//
// Both reach GitHub only through the `gh` on PATH, so that is the one thing
// stood in for: a `gh` that serves this repository's own recordings through
// gh-replay.mjs's replay mode, from a directory the test may edit — the way
// GitHub's answer would differ from a recording, or fail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const ROOT = resolve(".");
const RECORDINGS = join(ROOT, ".github/fixtures/release-tail/v0.64.0");
const DOUBLE = join(ROOT, ".github/fixtures/release-tail/gh-replay.mjs");
const RECONCILE = join(ROOT, ".github/fixtures/release-tail/reconcile.mjs");
const scratch = mkdtempSync(
  join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(), "replay-double-"),
);
after(() => rmSync(scratch, { recursive: true, force: true }));

// A `gh` serving `served` (a directory of recordings), noting whether it was
// handed a token, and answering `status` instead when one is given. What it is
// told arrives in its environment, never spliced into its source: `env` holds
// it, with PATH, for whatever runs it.
function ghServing(served, status = "") {
  const dir = mkdtempSync(join(scratch, "gh-"));
  const tokens = join(dir, "tokens");
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash
env | grep -c '^\\(GH_TOKEN\\|GITHUB_TOKEN\\)=' >> "$SHIM_TOKENS" || true
unset GH_REPLAY_RECORD GH_REPLAY_LOG GH_TOKEN GITHUB_TOKEN
GH_REPLAY_FIXTURES="$SHIM_SERVED" GH_REPLAY_STATUS="$SHIM_STATUS" exec node "$SHIM_DOUBLE" "$@"
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  return {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      SHIM_TOKENS: tokens,
      SHIM_SERVED: served,
      SHIM_STATUS: status,
      SHIM_DOUBLE: DOUBLE,
    },
    tokens,
  };
}

// The Release run's jobs, which replay serves with its sidecar's one change, for
// reconcile; and release-plz's run's, served exactly as recorded, for record mode.
const listing = readdirSync(RECORDINGS).find((file) =>
  /runs-41269844133-jobs.*\.json$/.test(file),
);
const plain = readdirSync(RECORDINGS).find((file) =>
  /runs-41269793170-jobs.*\.json$/.test(file),
);
const sidecar = JSON.parse(readFileSync(join(RECORDINGS, plain), "utf8"));
const recorded = readFileSync(
  join(RECORDINGS, plain.replace(/\.json$/, ".http")),
);

test("record mode saves gh's answer byte for byte with its sidecar, and hands gh no token", () => {
  const into = join(scratch, "recorded");
  const gh = ghServing(RECORDINGS);
  const run = spawnSync(
    "node",
    [DOUBLE, "api", "--include", "--method", "GET", sidecar.path],
    {
      encoding: "buffer",
      env: {
        ...process.env,
        ...gh.env,
        GH_REPLAY_RECORD: into,
        GH_REPLAY_SOURCE: JSON.stringify({
          repository: "nickderobertis/onepipeline-ui",
          release: "v0.64.0",
        }),
        GH_TOKEN: "placeholder-onevcs-hands-over",
        GITHUB_TOKEN: "placeholder-onevcs-hands-over",
      },
    },
  );
  assert.equal(run.status, 0, run.stderr.toString());
  // What it answers is what gh answered, byte for byte.
  assert.deepEqual(run.stdout, recorded);
  const saved = readdirSync(into);
  assert.equal(saved.length, 2, saved);
  const http = saved.find((file) => file.endsWith(".http"));
  assert.deepEqual(readFileSync(join(into, http)), recorded);
  const written = JSON.parse(
    readFileSync(join(into, http.replace(/\.http$/, ".json")), "utf8"),
  );
  assert.equal(written.path, sidecar.path);
  assert.deepEqual(written.fetched_from, {
    repository: "nickderobertis/onepipeline-ui",
    release: "v0.64.0",
  });
  assert.equal(written.served_with, null);
  assert.ok(!Number.isNaN(Date.parse(written.fetched_at)));
  assert.equal(
    readFileSync(gh.tokens, "utf8").trim(),
    "0",
    "gh was handed a token",
  );
});

test("record mode saves nothing when gh's read fails, and fails with it", () => {
  const into = join(scratch, "failed");
  const run = spawnSync(
    "node",
    [DOUBLE, "api", "--include", "--method", "GET", sidecar.path],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...ghServing(RECORDINGS, "502").env,
        GH_REPLAY_RECORD: into,
      },
    },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /HTTP 502/);
  assert.deepEqual(existsSync(into) ? readdirSync(into) : [], []);
});

const reconcile = (served, status) =>
  spawnSync("node", [RECONCILE, RECORDINGS], {
    encoding: "utf8",
    env: { ...process.env, ...ghServing(served, status).env },
  });

test("reconcile passes when GitHub serves what was recorded", () => {
  const run = reconcile(RECORDINGS);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /every recording matches what GitHub serves/);
});

test("reconcile fails, naming it, when a recorded item differs or a read fails", () => {
  const served = join(scratch, "drifted");
  mkdirSync(served);
  cpSync(RECORDINGS, served, { recursive: true });
  const file = join(served, listing.replace(/\.json$/, ".http"));
  const text = readFileSync(file, "utf8");
  const split = text.search(/\r?\n\r?\n/);
  const body = JSON.parse(text.slice(split).trim());
  const job = body.jobs.find((candidate) => candidate.name === "build-linux");
  job.conclusion = "failure";
  // A field GitHub rewrites is not a difference.
  body.jobs.find((candidate) => candidate.name === "build-macos").updated_at =
    "2027-01-01T00:00:00Z";
  writeFileSync(file, `${text.slice(0, split)}\r\n\r\n${JSON.stringify(body)}`);
  const drifted = reconcile(served);
  assert.equal(drifted.status, 1, drifted.stdout);
  assert.match(
    drifted.stderr,
    new RegExp(`item ${job.id} differs from its recording`),
  );
  assert.match(drifted.stderr, /reconcile: 1 difference\(s\)/);

  const failed = reconcile(RECORDINGS, "502");
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /gh failed/);
});

test("reconcile reports items that entered or left a page without failing", () => {
  const served = join(scratch, "grown");
  mkdirSync(served);
  cpSync(RECORDINGS, served, { recursive: true });
  const file = join(served, listing.replace(/\.json$/, ".http"));
  const text = readFileSync(file, "utf8");
  const split = text.search(/\r?\n\r?\n/);
  const body = JSON.parse(text.slice(split).trim());
  body.jobs.push({ ...body.jobs[0], id: 1 });
  writeFileSync(file, `${text.slice(0, split)}\r\n\r\n${JSON.stringify(body)}`);
  const run = reconcile(served);
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stdout,
    /1 item\(s\) entered and 0 left the page since it was recorded/,
  );
});

test("a response that is not what gh prints is refused by name, by reconcile and by replay", () => {
  const served = join(scratch, "unframed");
  mkdirSync(served);
  cpSync(RECORDINGS, served, { recursive: true });
  const file = join(served, plain.replace(/\.json$/, ".http"));
  const text = readFileSync(file, "utf8");
  // The body alone, as if the headers and the blank line after them were lost.
  writeFileSync(file, text.slice(text.search(/\r?\n\r?\n/)).trim());
  // A gh that printed it so, for reconcile: the replay double refuses to.
  const raw = mkdtempSync(join(scratch, "raw-gh-"));
  writeFileSync(
    join(raw, "gh"),
    `#!/usr/bin/env bash
if [ "\${!#}" = "$RAW_PATH" ]; then cat "$RAW_FILE"; exit 0; fi
GH_REPLAY_FIXTURES="$RAW_RECORDINGS" exec node "$RAW_DOUBLE" "$@"
`,
  );
  chmodSync(join(raw, "gh"), 0o755);
  const run = spawnSync("node", [RECONCILE, RECORDINGS], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${raw}:${process.env.PATH}`,
      RAW_PATH: sidecar.path,
      RAW_FILE: file,
      RAW_RECORDINGS: RECORDINGS,
      RAW_DOUBLE: DOUBLE,
    },
  });
  assert.equal(run.status, 1, run.stdout);
  assert.match(
    run.stderr,
    /GitHub's answer to .*41269793170\/jobs.* has no header\/body separator/,
  );
  // Every other recording was still checked.
  assert.match(run.stderr, /reconcile: 1 difference\(s\)/);

  const changed = join(served, listing.replace(/\.json$/, ".http"));
  const recordedChanged = readFileSync(changed, "utf8");
  writeFileSync(
    changed,
    recordedChanged.slice(recordedChanged.search(/\r?\n\r?\n/)).trim(),
  );
  const replayed = spawnSync(
    "node",
    [
      DOUBLE,
      "api",
      "--include",
      "--method",
      "GET",
      JSON.parse(readFileSync(join(served, listing), "utf8")).path,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GH_REPLAY_FIXTURES: served },
    },
  );
  assert.notEqual(replayed.status, 0);
  assert.match(replayed.stderr, /has no HTTP status line/);
  const status = spawnSync(
    "node",
    [DOUBLE, "api", "--include", "--method", "GET", "repos/o/n/actions/runs"],
    {
      encoding: "utf8",
      env: { ...process.env, GH_REPLAY_STATUS: "oops" },
    },
  );
  assert.equal(status.status, 2);
  assert.match(status.stderr, /must be an HTTP error status/);
});

test("reconcile refuses a directory with no recording rather than passing it", () => {
  const empty = join(scratch, "empty-release");
  mkdirSync(empty);
  const run = spawnSync("node", [RECONCILE, empty], {
    encoding: "utf8",
    env: { ...process.env, ...ghServing(RECORDINGS).env },
  });
  assert.equal(run.status, 1);
  assert.match(
    run.stderr,
    /no recording under .*empty-release, so nothing was reconciled/,
  );
});

test("reconcile reports an item that left a page without failing, and compares a response that is no listing whole", () => {
  const served = join(scratch, "shrunk");
  mkdirSync(served);
  cpSync(RECORDINGS, served, { recursive: true });
  const file = join(served, plain.replace(/\.json$/, ".http"));
  const text = readFileSync(file, "utf8");
  const split = text.search(/\r?\n\r?\n/);
  const body = JSON.parse(text.slice(split).trim());
  body.jobs.pop();
  writeFileSync(file, `${text.slice(0, split)}\r\n\r\n${JSON.stringify(body)}`);
  const shrunk = reconcile(served);
  assert.equal(shrunk.status, 0, shrunk.stderr);
  assert.match(
    shrunk.stdout,
    /0 item\(s\) entered and 1 left the page since it was recorded/,
  );

  // One release directory whose one recording is an object, not a listing:
  // the comparison's own head, made from the recorded comparison.
  const compare = readdirSync(RECORDINGS).find((name) =>
    /-compare-.*\.json$/.test(name),
  );
  const recordedText = readFileSync(
    join(RECORDINGS, compare.replace(/\.json$/, ".http")),
    "utf8",
  );
  const at = recordedText.search(/\r?\n\r?\n/);
  const {
    commits: _commits,
    files: _files,
    ...head
  } = JSON.parse(recordedText.slice(at).trim());
  const single = (dir, object) => {
    mkdirSync(dir);
    writeFileSync(join(dir, compare), readFileSync(join(RECORDINGS, compare)));
    writeFileSync(
      join(dir, compare.replace(/\.json$/, ".http")),
      `${recordedText.slice(0, at)}\r\n\r\n${JSON.stringify(object)}`,
    );
  };
  const release = join(scratch, "object-release");
  const same = join(scratch, "object-same");
  const changed = join(scratch, "object-changed");
  single(release, head);
  single(same, head);
  single(changed, { ...head, status: "diverged" });
  const run = (servedDir) =>
    spawnSync("node", [RECONCILE, release], {
      encoding: "utf8",
      env: { ...process.env, ...ghServing(servedDir).env },
    });
  assert.equal(run(same).status, 0);
  const differs = run(changed);
  assert.equal(differs.status, 1);
  assert.match(differs.stderr, /the response differs from its recording/);
});

test("a recorded error status is served as gh serves one, and a sidecar naming no API path is refused", () => {
  const served = join(scratch, "errored");
  mkdirSync(served);
  cpSync(RECORDINGS, served, { recursive: true });
  const file = join(served, plain.replace(/\.json$/, ".http"));
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      /^HTTP\/2\.0 200 OK/,
      "HTTP/2.0 502 Bad Gateway",
    ),
  );
  const replayed = spawnSync(
    "node",
    [DOUBLE, "api", "--include", "--method", "GET", sidecar.path],
    {
      encoding: "utf8",
      env: { ...process.env, GH_REPLAY_FIXTURES: served },
    },
  );
  assert.equal(replayed.status, 1);
  assert.match(replayed.stdout, /^HTTP\/2\.0 502/);

  const odd = join(scratch, "odd-path");
  mkdirSync(odd);
  writeFileSync(
    join(odd, plain),
    JSON.stringify({ ...sidecar, path: "--paginate" }),
  );
  writeFileSync(
    join(odd, plain.replace(/\.json$/, ".http")),
    readFileSync(join(RECORDINGS, plain.replace(/\.json$/, ".http"))),
  );
  const run = spawnSync("node", [RECONCILE, odd], {
    encoding: "utf8",
    env: { ...process.env, ...ghServing(RECORDINGS).env },
  });
  assert.equal(run.status, 1);
  assert.match(
    run.stderr,
    /its sidecar names no repos\/OWNER\/NAME\/ API path/,
  );
});

test("the double serves only an API path, never an option gh would read", () => {
  for (const request of ["--paginate", "repos/x", "user", "repos/a/b/x y"]) {
    const run = spawnSync(
      "node",
      [DOUBLE, "api", "--include", "--method", "GET", request],
      {
        encoding: "utf8",
        env: { ...process.env, GH_REPLAY_FIXTURES: RECORDINGS },
      },
    );
    assert.equal(run.status, 2, request);
    assert.match(
      run.stderr,
      /only 'api --include --method GET <API path>' is served/,
    );
  }
});
