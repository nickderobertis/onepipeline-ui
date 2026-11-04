// The judged tier reaching a verdict on a host whose Codex sign-in may not use
// the configured model — the host the gate-time budget was measured on.
//
// The toolchain is installed into a fresh tool directory the way session setup
// and CI install it, `scripts/setup-llmlint.sh`, and is then the only llmlint and
// oneharness on PATH. The repository's own judged-lint recipe, `just
// lint-llm-diff`, runs over a scratch copy of what that recipe reads, with the
// committed `oneharness.toml` copied byte for byte and no `ONEHARNESS_*`
// override. The paid harnesses are the one boundary doubled, at their own
// executables: `codex` answers with codex's recorded refusal (HTTP 400, the model
// not supported for a ChatGPT account), and `claude` answers a verdict.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";

const ROOT = resolve(".");
// The oneharness release this repository adopts: the one whose fallback chain
// falls through a model codex refuses for its account.
export const ONEHARNESS_ADOPTED = "0.26.1";
const REFUSAL = join(
  ROOT,
  ".github/fixtures/judge/codex-model-unsupported-for-account.jsonl",
);

// Under the system's temporary directory and nowhere else: llmlint layers every
// llmlint.yml it finds walking up from the workspace, so a scratch directory
// inside another project would judge with that project's rules too.
const scratch = mkdtempSync(join(tmpdir(), "onepipeline-ui-judge-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const home = join(scratch, "home");
const toolDir = join(scratch, "uv-tools");
const bin = join(home, ".local/bin");
const doubles = join(scratch, "doubles");
const calls = join(scratch, "calls");
const workspace = join(scratch, "workspace");
// The programs the recipe needs that are not the toolchain under test, each on
// its own: node's own bin directory also holds globally installed codex and
// claude, which must not be on PATH. node is copied rather than linked, because
// Nx puts the directory of node's resolved executable on its tasks' PATH, ahead
// of everything here.
const programs = join(scratch, "programs");

// Everything a run inherits, without anything that would steer llmlint,
// oneharness or Nx, and with this scratch home.
function environment(path) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(GITHUB_ACTIONS$|LLMLINT_|ONEHARNESS_|NX_|CLAUDE_|CODEX_|OPENAI_|ANTHROPIC_)/.test(
          key,
        ),
    ),
  );
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    UV_TOOL_DIR: toolDir,
    UV_TOOL_BIN_DIR: bin,
    // The download cache is a cache: sharing it costs nothing the install does
    // not check, and keeps the install from fetching every wheel again.
    UV_CACHE_DIR: execFileSync("uv", ["cache", "dir"], {
      encoding: "utf8",
    }).trim(),
    PATH: path,
    DOUBLE_CALLS: calls,
    DOUBLE_REFUSAL: REFUSAL,
  };
}
const basePath = () => [programs, "/usr/bin", "/bin"].join(":");

const CODEX = `#!/usr/bin/env bash
# codex, signed in with an account that may not use the configured model.
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then echo "codex-cli 0.145.0"; exit 0; fi
printf '%s\\n' "$*" > "$(mktemp "$DOUBLE_CALLS/codex.XXXXXX")"
sed 's/01a1471e-4505-7401-8904-bfebc49d6a71/019fb99f-9a2f-7c31-9f0d-2f4c8b6d1e77/' "$DOUBLE_REFUSAL"
exit 1
`;
const CLAUDE = `#!/usr/bin/env bash
# claude, signed in and answering: every rule it is asked about holds.
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then echo "2.1.220 (Claude Code)"; exit 0; fi
schema="" prev=""
for arg in "$@"; do
  [ "$prev" = "--json-schema" ] && schema="$arg"
  prev="$arg"
done
printf '%s\\n' "$*" > "$(mktemp "$DOUBLE_CALLS/claude.XXXXXX")"
[ -n "$schema" ] || { echo '{"type":"result","subtype":"success","is_error":false,"session_id":"s","result":"ok"}'; exit 0; }
printf '%s' "$schema" | jq -c '
  (.properties | keys) as $rules
  | {type: "result", subtype: "success", is_error: false, session_id: "s", result: "judged",
     structured_output: ($rules | map({key: ., value: {name: ., rationale: "holds", holds: true}}) | from_entries)}'
`;

// What the recipe reads, as tests/e2e/judged_tier.rs copies it, with the rules
// local rather than fetched.
const COPIED = [
  "justfile",
  "nx.json",
  "project.json",
  "judged-diff/project.json",
  "package.json",
  "bun.lock",
  ".gitignore",
  "oneharness.toml",
  "scripts/nx.sh",
  "scripts/nx-remote-cache.mjs",
  "scripts/workspace-install.sh",
];
const RULES = `rules:
  - name: no_todo
    description: "Files contain no TODO markers."
`;

const git = (args) =>
  execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
let base;

before(() => {
  for (const dir of [home, bin, doubles, calls, programs])
    mkdirSync(dir, { recursive: true });
  for (const name of ["just", "uv"]) {
    const found = execFileSync("bash", ["-c", `command -v ${name}`], {
      encoding: "utf8",
    }).trim();
    symlinkSync(
      execFileSync("readlink", ["-f", found], { encoding: "utf8" }).trim(),
      join(programs, name),
    );
  }
  copyFileSync(process.execPath, join(programs, "node"));
  chmodSync(join(programs, "node"), 0o755);
  for (const [name, text] of [
    ["codex", CODEX],
    ["claude", CLAUDE],
  ]) {
    writeFileSync(join(doubles, name), text);
    chmodSync(join(doubles, name), 0o755);
  }
  for (const name of COPIED) {
    mkdirSync(dirname(join(workspace, name)), { recursive: true });
    copyFileSync(join(ROOT, name), join(workspace, name));
  }
  const config = readFileSync(join(ROOT, "llmlint.yml"), "utf8").split(
    "\nplugins:\n",
  )[0];
  writeFileSync(join(workspace, "llmlint.yml"), `${config}\n${RULES}`);
  for (const manifest of ["Cargo.toml", "Cargo.lock"])
    writeFileSync(join(workspace, manifest), "");
  symlinkSync(join(ROOT, "node_modules"), join(workspace, "node_modules"));
  git(["init", "--quiet"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  git([
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--quiet",
    "-m",
    "the base",
  ]);
  base = git(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(workspace, "CHANGED.md"), "the change under judgement\n");
  git(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  git([
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--quiet",
    "-m",
    "the change",
  ]);
});

test("the installer puts the adopted oneharness beside llmlint in a fresh tool directory", () => {
  const install = spawnSync("bash", [join(ROOT, "scripts/setup-llmlint.sh")], {
    cwd: ROOT,
    encoding: "utf8",
    env: environment(basePath()),
  });
  assert.equal(install.status, 0, install.stderr);
  const llmlint = join(bin, "llmlint");
  const beside = join(
    dirname(
      execFileSync("readlink", ["-f", llmlint], { encoding: "utf8" }).trim(),
    ),
    "oneharness",
  );
  const version = spawnSync(beside, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.match(
    version.stdout,
    new RegExp(`\\b${ONEHARNESS_ADOPTED.replaceAll(".", "\\.")}\\b`),
  );
  // Installed here, not found elsewhere: the binary is the fresh tool venv's.
  assert.ok(beside.startsWith(`${toolDir}/`), beside);
});

test("with codex refusing the configured model, the committed chain judges through claude-code", () => {
  assert.equal(
    readFileSync(join(workspace, "oneharness.toml"), "utf8"),
    readFileSync(join(ROOT, "oneharness.toml"), "utf8"),
  );
  const path = [doubles, bin, basePath()].join(":");
  const run = spawnSync("just", ["lint-llm-diff", base, "--skip-nx-cache"], {
    cwd: workspace,
    encoding: "utf8",
    env: environment(path),
  });
  const printed = `${run.stdout}\n${run.stderr}`;
  assert.equal(run.status, 0, printed);
  const made = readdirSync(calls);
  const asked = (prefix) =>
    made
      .filter((name) => name.startsWith(prefix))
      .map((name) => readFileSync(join(calls, name), "utf8"));
  // codex was asked to judge with the committed model, and refused; claude-code
  // then gave the verdict. oneharness may also ask codex for its model catalog
  // (`codex app-server`) first, which is not the judge call.
  assert.ok(
    asked("codex.").some(
      (call) => /^exec\b/.test(call) && /--model gpt-6\.1-sol\b/.test(call),
    ),
    `codex was never asked to judge with gpt-6.1-sol:\n${asked("codex.").join("")}\n${printed}`,
  );
  assert.ok(
    asked("claude.").some((call) => /--model claude-opus-4-8\b/.test(call)),
    `claude-code was never asked to judge:\n${printed}`,
  );
  assert.match(printed, /^1 rules: 1 passed, 0 failed, 0 skipped$/m);
  // Only the doubles answered: a real codex or claude leaves its state here.
  for (const state of [".codex", ".claude.json", ".claude"])
    assert.ok(
      !existsSync(join(home, state)),
      `a real harness ran and wrote ${state}`,
    );
});
