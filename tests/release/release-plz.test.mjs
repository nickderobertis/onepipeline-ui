// The `release-plz` job's own steps, read out of .github/workflows/release-plz.yml
// and run in order over a scratch repository: each step's `if:` evaluated by
// GitHub's expression grammar against what the earlier steps wrote to
// $GITHUB_OUTPUT, and each `run:` handed to bash with the step's own `env:`,
// exactly as a runner would. The `uses:` steps provision a runner (checkout,
// cache, tool install) and are what this host already has.
//
// RELEASE_PLZ_DRY_RUN is the job's rehearsal switch (its header says what it
// changes), so release-plz plans the tag and the Release and prepares the bump
// in the working tree, and nothing reaches a remote or a registry: the scratch
// repository's `origin` is a local bare repository the journey reads back, and
// `gh` is the double in ./doubles.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parse } from "yaml";
import { evaluate, interpolate } from "../../.github/workflow-graph.mjs";
import { githubDouble, ROOT, registryDoubles, scratch } from "./support.mjs";

const workflow = parse(
  readFileSync(join(ROOT, ".github/workflows/release-plz.yml"), "utf8"),
);
const job = workflow.jobs["release-plz"];
// tests/e2e/semver_check.rs drives this step's recipe through every answer it
// can give; it builds two releases of a real crate, which a scratch one is not.
const SEMVER_STEP = "Read the public surface against the baseline";

const dirs = [];
let forge;
before(async () => {
  const dir = scratch("forge");
  dirs.push(dir);
  forge = await registryDoubles(dir);
});
after(async () => {
  await forge?.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const forgeCalls = () => {
  const log = join(forge.state, "forge.log");
  return existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean)
    : [];
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// A crate released once as v0.1.0, with a `feat` commit on top of the tag, and
// this repository's own release-plz configuration.
function scratchRepository() {
  const dir = scratch("release-plz");
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(dir, "init", "-q", "-b", "main", repo);
  git(repo, "config", "user.email", "journey@example.com");
  git(repo, "config", "user.name", "Release journey");
  writeFileSync(
    join(repo, "Cargo.toml"),
    '[package]\nname = "scratch-crate"\nversion = "0.1.0"\nedition = "2021"\nlicense = "MIT"\ndescription = "A crate the release-plz journey releases."\n',
  );
  writeFileSync(join(repo, "src/lib.rs"), "pub fn first() {}\n");
  writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n");
  copyFileSync(join(ROOT, "release-plz.toml"), join(repo, "release-plz.toml"));
  execFileSync("cargo", ["generate-lockfile", "--offline", "--quiet"], {
    cwd: repo,
  });
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "feat: the first release");
  git(repo, "tag", "v0.1.0");
  writeFileSync(
    join(repo, "src/lib.rs"),
    "pub fn first() {}\npub fn second() {}\n",
  );
  git(repo, "commit", "-qam", "feat: add a second function");
  // The remote a real run would push to, as a bare copy whose refs are read
  // back; the fetch URL names a GitHub repository, so release-plz reads its
  // forge — the GitHub API double — for it.
  git(dir, "clone", "-q", "--bare", repo, join(dir, "remote.git"));
  git(
    repo,
    "remote",
    "add",
    "origin",
    "https://github.com/nickderobertis/scratch-crate.git",
  );
  git(repo, "remote", "set-url", "--push", "origin", join(dir, "remote.git"));
  return { dir, repo, remote: join(dir, "remote.git") };
}

function runJob({ dir, repo }, { token, headCommit }) {
  const gh = githubDouble(dir, "unused");
  writeFileSync(join(gh.state, "prs"), "7\n");
  const secrets = token === undefined ? {} : { RELEASE_PLZ_TOKEN: token };
  const steps = {};
  const ran = [];
  const output = [];
  for (const step of job.steps) {
    const context = {
      github: {
        event: { head_commit: { message: headCommit } },
        repository: "nickderobertis/scratch-crate",
      },
      secrets,
      steps,
      env: workflow.env,
      vars: {},
    };
    if (
      step.if !== undefined &&
      !evaluate(String(step.if), context)
        .coerceString()
        .match(/^true$/)
    )
      continue;
    if (!step.run || step.name === SEMVER_STEP) continue;
    ran.push(step.name ?? step.id);
    const outputs = join(dir, `output-${ran.length}`);
    writeFileSync(outputs, "");
    const env = Object.fromEntries(
      Object.entries({ ...workflow.env, ...step.env }).map(([k, v]) => [
        k,
        String(interpolate(v, context) ?? ""),
      ]),
    );
    const result = spawnSync(
      "bash",
      ["-e", "-c", interpolate(step.run, context)],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([k]) => !k.startsWith("GITHUB_"),
            ),
          ),
          ...env,
          PATH: `${gh.bin}:${join(ROOT, ".tools/bin")}:${process.env.PATH}`,
          GH_DOUBLE_STATE: gh.state,
          GITHUB_OUTPUT: outputs,
          GITHUB_REPOSITORY: "nickderobertis/scratch-crate",
          ...forge.forgeEnv,
          RUNNER_TEMP: join(dir, `runner-temp-${ran.length}`),
          RELEASE_PLZ_DRY_RUN: "true",
        },
      },
    );
    output.push(`== ${step.name ?? step.id}\n${result.stdout}${result.stderr}`);
    assert.equal(result.status, 0, output.join("\n"));
    if (step.id)
      steps[step.id] = {
        outputs: Object.fromEntries(
          readFileSync(outputs, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => line.split(/=(.*)/s).slice(0, 2)),
        ),
      };
  }
  return { ran, output: output.join("\n"), steps, gh };
}

const remoteRefs = (remote) =>
  git(remote, "for-each-ref", "--format=%(refname) %(objectname)");

test("release-plz is the job's one job, and its guard decides as the old guard job did", () => {
  assert.deepEqual(Object.keys(workflow.jobs), ["release-plz"]);
  const guard = job.steps[0];
  assert.equal(guard.id, "guard");
  assert.equal(
    guard.uses,
    undefined,
    "the guard runs before anything is checked out",
  );
  for (const step of job.steps.slice(1))
    assert.match(
      String(step.if),
      /steps\.guard\.outputs\.enabled == 'true'/,
      step.name ?? step.uses,
    );

  // The three cases the old `guard` job decided: no secret, an empty one, and
  // one that is set.
  for (const [name, token, enabled] of [
    ["RELEASE_PLZ_TOKEN is not set", undefined, "false"],
    ["RELEASE_PLZ_TOKEN is set but empty", "", "false"],
    ["RELEASE_PLZ_TOKEN is set", "a-pat", "true"],
  ]) {
    const scratchRepo = scratchRepository();
    const before = remoteRefs(scratchRepo.remote);
    const { ran, steps, output, gh } = runJob(scratchRepo, {
      token,
      headCommit: "feat: add a second function",
    });
    assert.equal(steps.guard.outputs.enabled, enabled, name);
    if (enabled === "false") {
      assert.deepEqual(
        ran,
        [guard.name],
        `${name}: nothing after the guard runs`,
      );
      assert.match(
        output,
        /RELEASE_PLZ_TOKEN not set; skipping release automation/,
      );
      assert.deepEqual(gh.calls(), []);
    } else assert.ok(ran.length > 1, name);
    assert.equal(
      remoteRefs(scratchRepo.remote),
      before,
      `${name}: no remote written`,
    );
  }
});

test("on an eligible push the job prepares the version bump, and writes no remote", () => {
  const scratchRepo = scratchRepository();
  const before = remoteRefs(scratchRepo.remote);
  const { ran, output, steps, gh } = runJob(scratchRepo, {
    token: "a-pat",
    headCommit: "feat: add a second function",
  });
  assert.deepEqual(ran, [
    "Is release automation switched on",
    "Tag and publish a merged version bump",
    "Use the latest release tag as the version baseline",
    "Open or update the release PR",
    "Auto-merge the release PR when the gate is green",
  ]);
  assert.equal(steps.baseline.outputs.ref, "v0.1.0");
  // The bump release-pr would propose, in the working tree: a new version and
  // the changelog section for the commits since v0.1.0.
  const manifest = readFileSync(join(scratchRepo.repo, "Cargo.toml"), "utf8");
  const bumped = manifest.match(/^version = "([^"]+)"$/m)[1];
  assert.notEqual(bumped, "0.1.0", "the version was bumped");
  const changelog = readFileSync(
    join(scratchRepo.repo, "CHANGELOG.md"),
    "utf8",
  );
  assert.ok(changelog.includes(`## [${bumped}]`), changelog);
  assert.match(changelog, /add a second function/);
  assert.ok(
    forgeCalls().every((call) => call.startsWith("GET ")),
    forgeCalls().join("\n"),
  );
  assert.match(output, /Would enable auto-merge on release PR #7/);
  assert.ok(
    gh.calls().every((call) => call[0] === "pr" && call[1] === "list"),
    JSON.stringify(gh.calls()),
  );
  assert.equal(remoteRefs(scratchRepo.remote), before);
  assert.equal(git(scratchRepo.repo, "tag", "--list"), "v0.1.0");
});

test("on the release PR's merge the job plans the tag and the GitHub Release, and writes neither", () => {
  const scratchRepo = scratchRepository();
  const { repo, remote } = scratchRepo;
  // The release PR, merged: the bumped version, no tag for it yet.
  writeFileSync(
    join(repo, "Cargo.toml"),
    readFileSync(join(repo, "Cargo.toml"), "utf8").replace(
      'version = "0.1.0"',
      'version = "0.2.0"',
    ),
  );
  execFileSync("cargo", ["generate-lockfile", "--offline", "--quiet"], {
    cwd: repo,
  });
  writeFileSync(
    join(repo, "CHANGELOG.md"),
    "# Changelog\n\n## [0.2.0] - 2026-10-17\n\n### Added\n\n- add a second function\n",
  );
  git(repo, "commit", "-qam", "chore: release v0.2.0");
  const before = remoteRefs(remote);
  const { ran, output, gh } = runJob(scratchRepo, {
    token: "a-pat",
    headCommit: "chore: release v0.2.0",
  });
  // The release commit is not new work: no second release PR, no auto-merge.
  assert.deepEqual(ran, [
    "Is release automation switched on",
    "Tag and publish a merged version bump",
    "Use the latest release tag as the version baseline",
  ]);
  // release-plz asked the forge whether this commit came from a release PR,
  // then planned the tag and the Release and skipped both.
  assert.match(output, /creation of tag 'v0\.2\.0'/);
  assert.match(output, /creation of git release/);
  assert.ok(
    forgeCalls().some((call) =>
      /^GET \/repos\/nickderobertis\/scratch-crate\/commits\/[0-9a-f]+\/pulls$/.test(
        call,
      ),
    ),
    forgeCalls().join("\n"),
  );
  assert.ok(
    forgeCalls().every((call) => call.startsWith("GET ")),
    forgeCalls().join("\n"),
  );
  assert.deepEqual(gh.calls(), []);
  assert.equal(remoteRefs(remote), before, "no tag reached the remote");
  assert.equal(git(repo, "tag", "--list"), "v0.1.0", "no tag was created");
});
