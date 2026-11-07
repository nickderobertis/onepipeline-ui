// DO NOT MERGE: throwaway measurement. Runs rust-cache v2.9.2's own restore and save bundles
// against a dead cache address, so its real cleanup and real archive run and nothing can be
// stored; then sizes the result and reports what a re-run of the warm lines rebuilt.
//
//   node scripts/warm-demo.mjs state | save | snapshot | rebuilt
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const temp = process.env.RUNNER_TEMP;
const action = join(temp, "rust-cache");
const stateFile = join(temp, "rust-cache-state.json");
const fingerprints = join(temp, "fingerprints.json");
const INPUTS = { "INPUT_SHARED-KEY": process.env.DEMO_SHARED_KEY, "INPUT_SAVE-IF": "true" };

function dead(extra) {
  const { ACTIONS_RUNTIME_TOKEN: _token, ...env } = process.env;
  return {
    ...env,
    ...INPUTS,
    ACTIONS_CACHE_SERVICE_V2: "True",
    ACTIONS_CACHE_URL: "http://127.0.0.1:9/",
    ACTIONS_RESULTS_URL: "http://127.0.0.1:9/",
    ACTIONS_RUNTIME_TOKEN: "dead",
    GITHUB_ENV: join(temp, "dead-env"),
    GITHUB_OUTPUT: join(temp, "dead-output"),
    GITHUB_STATE: join(temp, "dead-state"),
    ...extra,
  };
}

function capture() {
  execFileSync("git", ["clone", "-q", "--depth", "1", "-b", "v2.9.2", "https://github.com/Swatinem/rust-cache", action]);
  for (const file of ["dead-env", "dead-output", "dead-state"]) writeFileSync(join(temp, file), "");
  const done = spawnSync(process.execPath, [join(action, "dist/restore.js")], { env: dead(), encoding: "utf8" });
  console.log(done.stdout.slice(-1500), done.stderr.slice(-500));
  const text = readFileSync(join(temp, "dead-state"), "utf8");
  const match = text.match(/^RUST_CACHE_CONFIG<<(\S+)\n([\s\S]*?)\n\1$/m);
  if (!match) throw new Error(`rust-cache saved no state: ${text.slice(0, 300)}`);
  writeFileSync(stateFile, match[2]);
  console.log("key", JSON.parse(match[2]).cacheKey);
}

function save() {
  const state = readFileSync(stateFile, "utf8");
  const done = spawnSync(process.execPath, [join(action, "dist/save.js")], {
    env: dead({ STATE_RUST_CACHE_CONFIG: state, RUNNER_DEBUG: "1" }),
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024 * 1024,
  });
  const lines = `${done.stdout}\n${done.stderr}`.split("\n");
  for (const line of lines)
    if (/\.\.\. |File Size|Cache Size|Archive Path|Failed to save|warning|Saved|error/i.test(line) && line.length < 300)
      console.log(line);
  const size = lines.map((line) => line.match(/File Size: (\d+)/)?.[1]).find(Boolean);
  console.log(`WARM-DEMO archive bytes (rust-cache's own tar): ${size ?? "not reported"}; exit ${done.status}`);
  if (!lines.some((line) => /Saving cache/.test(line))) throw new Error("rust-cache never reached its save");
}

function walk(dir, depth, found) {
  if (depth > 5 || !existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "deps" || entry.name === "build") continue;
    const path = join(dir, entry.name);
    if (entry.name === ".fingerprint") found.push(path);
    else walk(path, depth + 1, found);
  }
  return found;
}

function units() {
  const seen = {};
  for (const root of walk("target", 0, []))
    for (const unit of readdirSync(root)) {
      const dir = join(root, unit);
      let newest = 0;
      for (const file of readdirSync(dir)) newest = Math.max(newest, statSync(join(dir, file)).mtimeMs);
      seen[dir] = newest;
    }
  return seen;
}

function rebuilt() {
  const before = JSON.parse(readFileSync(fingerprints, "utf8"));
  const after = units();
  const moved = Object.keys(after).filter((unit) => before[unit] !== after[unit]);
  const workspace = /[/\\]\.fingerprint[/\\](onepipeline[-_]ui|build[-_]cache|e2e|contract|packaging)[^/\\]*$/;
  const dependencies = moved.filter((unit) => !workspace.test(unit));
  console.log(`WARM-DEMO units ${Object.keys(after).length}, rebuilt ${moved.length}, of them not this workspace's ${dependencies.length}`);
  const byTree = {};
  for (const unit of dependencies) {
    const tree = unit.split(/[/\\]\.fingerprint/)[0];
    (byTree[tree] ??= []).push(unit.split(/[/\\]/).at(-1));
  }
  for (const [tree, names] of Object.entries(byTree))
    console.log(`WARM-DEMO rebuilt dependency units under ${tree}: ${names.length}: ${names.slice(0, 40).join(" ")}`);
}

const verb = process.argv[2];
if (verb === "state") capture();
else if (verb === "save") save();
else if (verb === "snapshot") writeFileSync(fingerprints, JSON.stringify(units()));
else if (verb === "rebuilt") rebuilt();
else process.exit(2);
