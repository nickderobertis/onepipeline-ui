#!/usr/bin/env node
// The crate's supply-chain audit, split by who is responsible for a finding.
//
// A security advisory is published against a crate version whenever the
// database is updated, not when a change touches it. So an audit that fails on
// any advisory in the resolved graph blocks every change — a release included —
// the moment one appears against a version `main` already resolves, until
// someone merges past it by hand (RUSTSEC-2026-0433 against pulldown-cmark
// 0.13.5 did exactly that). The two halves below decide that apart:
//
//   check   The blocking audit, `just deps-check` and the `lint` job's
//           `deps-check` target. Bans, licenses and sources (`cargo deny`), yanked
//           crates, every other advisories-check error, and unused dependencies
//           (`cargo machete`) fail it as before. An advisory fails it only when
//           it matches a package version this change introduces — one the base's
//           Cargo.lock does not resolve. One matching a version the base already
//           resolves is printed and passes: it is the advisories report's.
//   report  Every advisory in the head's Cargo.lock, whatever the base resolved,
//           so an unrelated dependency update cannot hide one that was already
//           there. Exits non-zero while any remains. Informational: no check that
//           blocks a change or a release may run it or wait on it
//           (.github/required-contexts.mjs).
//   status  `report`, written to the job's step summary and log, and published
//           as the `advisories` commit status on --sha (the pull request's head)
//           through `gh`, so it reads as a red check of its own on the change
//           request without being one of the four jobs. --head-repo is the
//           repository the pull request's head lives in: when it is not
//           GITHUB_REPOSITORY the change request is a fork's, whose token cannot
//           post a status, so posting is skipped and the summary and log are where
//           the report is read. Exits non-zero when advisories remain or a status
//           this repository's token should have posted was refused.
//
// No advisory is ignored or downgraded in deny.toml to get there: the
// configuration still treats every advisory and yanked crate as a finding, and
// this script decides only which check owns it.
//
// The base is `git merge-base HEAD origin/main` — the commit a pull request's
// merge ref forks from, which `lint` checks out with full history — or --base.
// Packages are matched by name and version, as read from both Cargo.lock files.
// A base the script cannot resolve is a refusal, never "nothing was there".
//
// Usage: deps-audit.mjs check|report [--base <rev>]
//        deps-audit.mjs status --sha <commit> --head-repo <owner/name> [--base <rev>]
// Exit 0: nothing to report. 1: a finding (or a tool that did not run). 2: usage.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";

const CONTEXT = "advisories";
const FLAGS = { "--base": "base", "--sha": "sha", "--head-repo": "headRepo" };
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function usage(message) {
  console.error(`deps-audit: ${message}`);
  console.error(
    "ACTION: run 'deps-audit.mjs check|report [--base <rev>]' or 'deps-audit.mjs status --sha <commit> --head-repo <owner/name> [--base <rev>]'",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (!["check", "report", "status"].includes(mode ?? ""))
    usage(mode ? `'${mode}' is not check, report or status` : "name a mode");
  const options = { mode };
  while (rest.length > 0) {
    const flag = rest.shift();
    if (!Object.hasOwn(FLAGS, flag)) usage(`unknown argument '${flag}'`);
    const key = FLAGS[flag];
    const value = rest.shift();
    if (!value) usage(`${flag} needs a value`);
    options[key] = value;
  }
  if (mode === "status") {
    if (!options.sha) usage("status needs --sha <commit>");
    if (!/^[0-9a-f]{40}$/.test(options.sha))
      usage(`'${options.sha}' is not a full commit id`);
    if (!options.headRepo) usage("status needs --head-repo <owner/name>");
    if (!REPOSITORY.test(options.headRepo))
      usage(`'${options.headRepo}' is not an owner/name repository`);
  } else if (options.sha || options.headRepo)
    usage("only status takes --sha and --head-repo");
  return options;
}

function run(command, args, { inherit = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    console.error(`deps-audit: cannot run ${command}: ${result.error.message}`);
    console.error(`ACTION: install ${command} and re-run`);
    process.exit(1);
  }
  return result;
}

// `name version` for every package a Cargo.lock resolves.
function lockedPackages(text) {
  const packages = new Set();
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name && version) packages.add(`${name} ${version}`);
  }
  return packages;
}

// The base's Cargo.lock, as the set of what it resolves, and the commit read.
function basePackages(rev) {
  let commit = rev;
  if (!commit) {
    const merge = run("git", ["merge-base", "HEAD", "origin/main"]);
    if (merge.status !== 0) {
      console.error(merge.stderr.trim());
      console.error(
        "deps-audit: cannot resolve the base this change forks from (git merge-base HEAD origin/main)",
      );
      console.error(
        "ACTION: fetch main with history ('git fetch origin main'), or pass --base <rev>",
      );
      process.exit(1);
    }
    commit = merge.stdout.trim();
  }
  const verified = run("git", ["rev-parse", "--verify", `${commit}^{commit}`]);
  if (verified.status !== 0) {
    console.error(`deps-audit: the base '${commit}' is not a commit here`);
    console.error("ACTION: pass --base a commit this checkout has");
    process.exit(1);
  }
  commit = verified.stdout.trim();
  const shown = run("git", ["show", `${commit}:./Cargo.lock`]);
  // A base with no Cargo.lock resolves nothing, so every advisory is the
  // change's; any other failure to read it is a refusal.
  if (shown.status !== 0) {
    const listed = run("git", ["ls-tree", "--name-only", commit, "./"]);
    if (
      listed.status === 0 &&
      !listed.stdout.split("\n").some((p) => p.endsWith("Cargo.lock"))
    )
      return { commit, packages: new Set() };
    console.error(shown.stderr.trim());
    console.error(`deps-audit: cannot read Cargo.lock at the base ${commit}`);
    console.error("ACTION: fix the git error above and re-run");
    process.exit(1);
  }
  return { commit, packages: lockedPackages(shown.stdout) };
}

// cargo-deny's advisories check, read as JSON: every advisory it matched, and
// every other error it raised (yanked crates, an unreadable database, ...).
function advisoriesCheck() {
  const result = run("cargo", [
    "deny",
    "--locked",
    "--format",
    "json",
    "check",
    "advisories",
  ]);
  const advisories = [];
  const errors = [];
  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      errors.push(line.trim());
      continue;
    }
    const fields = entry.fields ?? {};
    if (entry.type === "log") {
      if (fields.level === "ERROR") errors.push(fields.message);
      continue;
    }
    if (entry.type !== "diagnostic" || fields.severity !== "error") continue;
    const krate = fields.graphs?.[0]?.Krate;
    if (fields.advisory && krate) {
      advisories.push({
        id: fields.advisory.id,
        title: fields.advisory.title ?? fields.message,
        kind: fields.code,
        name: krate.name,
        version: krate.version,
      });
    } else {
      const where = krate ? ` (${krate.name} ${krate.version})` : "";
      errors.push(`${fields.code ?? "error"}: ${fields.message}${where}`);
    }
  }
  // A failed run this reading found nothing in is not a pass.
  if (result.status !== 0 && advisories.length === 0 && errors.length === 0)
    errors.push(
      `cargo deny check advisories exited ${result.status} with nothing this script reads:\n${result.stderr.trim()}`,
    );
  // In id order, so every listing of the same graph reads the same.
  advisories.sort((a, b) =>
    `${a.id} ${a.name} ${a.version}`.localeCompare(
      `${b.id} ${b.name} ${b.version}`,
    ),
  );
  return { advisories, errors };
}

const describe = (a) =>
  `${a.id} ${a.name} ${a.version} (${a.kind}): ${a.title}`;

function check(options) {
  let failed = false;
  // Bans, licenses and sources, exactly as before: their own output, their own
  // verdict.
  const policy = run(
    "cargo",
    [
      "deny",
      "--locked",
      "--log-level",
      "error",
      "check",
      "bans",
      "licenses",
      "sources",
    ],
    { inherit: true },
  );
  if (policy.status !== 0) failed = true;

  const base = basePackages(options.base);
  const { advisories, errors } = advisoriesCheck();
  for (const error of errors) {
    console.error(`deps-audit: advisories check: ${error}`);
    failed = true;
  }
  const short = base.commit.slice(0, 12);
  for (const advisory of advisories) {
    if (base.packages.has(`${advisory.name} ${advisory.version}`)) {
      console.log(
        `deps-audit: pre-existing, not blocking: ${describe(advisory)} — the base ${short} already resolves ${advisory.name} ${advisory.version}; the advisories report carries it`,
      );
    } else {
      console.error(
        `deps-audit: introduced by this change: ${describe(advisory)} — the base ${short} does not resolve ${advisory.name} ${advisory.version}`,
      );
      failed = true;
    }
  }
  if (
    failed &&
    advisories.some((a) => !base.packages.has(`${a.name} ${a.version}`))
  )
    console.error(
      "ACTION: move the introduced crate to a patched version ('cargo update -p <crate>'), or drop it",
    );

  // machete prints the unused deps it finds on stdout, so keep it: hiding them
  // would leave a failing gate with no actionable detail.
  const machete = run("cargo", ["machete"], { inherit: true });
  if (machete.status !== 0) failed = true;
  return failed ? 1 : 0;
}

function report(options) {
  const base = basePackages(options.base);
  const { advisories, errors } = advisoriesCheck();
  for (const error of errors)
    console.error(`deps-audit: advisories check: ${error}`);
  for (const advisory of advisories) {
    const origin = base.packages.has(`${advisory.name} ${advisory.version}`)
      ? `already resolved at the base ${base.commit.slice(0, 12)}`
      : "introduced by this change";
    console.log(`deps-audit: advisory ${describe(advisory)} — ${origin}`);
  }
  if (advisories.length === 0 && errors.length === 0)
    console.log("deps-audit: no advisory matches the resolved graph");
  else if (advisories.length > 0)
    console.error(
      `ACTION: ${advisories.length} advisor${advisories.length === 1 ? "y matches" : "ies match"} the resolved graph; move each crate to a patched version`,
    );
  return {
    advisories,
    errors,
    code: advisories.length + errors.length > 0 ? 1 : 0,
  };
}

function status(options) {
  const { advisories, errors, code } = report(options);
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    console.error("deps-audit: status needs GITHUB_REPOSITORY (owner/name)");
    console.error("ACTION: run it from Actions, or set GITHUB_REPOSITORY");
    return 1;
  }
  const named = advisories.map((a) => `${a.id} ${a.name} ${a.version}`);
  let description;
  if (advisories.length > 0) description = named.join(", ");
  else if (errors.length > 0)
    description = "the advisories check did not run; see the log";
  else description = "no advisory matches the resolved graph";
  // GitHub refuses a description over 140 characters; the job log and its step
  // summary carry the whole list.
  if (description.length > 140) description = `${description.slice(0, 137)}...`;
  const fork = options.headRepo.toLowerCase() !== repository.toLowerCase();
  const where = fork
    ? `\n\nThis pull request comes from the fork ${options.headRepo}, whose token cannot post the \`${CONTEXT}\` status: this summary is the report.`
    : "";
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary)
    appendFileSync(
      summary,
      `### Advisories (informational, never required)${where}\n\n${
        advisories.length > 0
          ? advisories
              .map((a) => `- \`${a.id}\` ${a.name} ${a.version}: ${a.title}`)
              .join("\n")
          : description
      }\n`,
    );
  if (process.env.GITHUB_ACTIONS)
    for (const a of advisories)
      console.log(
        `::warning title=${a.id} in ${a.name} ${a.version}::${a.title}`,
      );
  if (fork) {
    console.log(
      `deps-audit: ${options.headRepo} is a fork of ${repository}; its token cannot post the ${CONTEXT} status, so the report above and the step summary are where it is read`,
    );
    return code;
  }
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const runId = process.env.GITHUB_RUN_ID;
  const args = [
    "api",
    "--method",
    "POST",
    `repos/${repository}/statuses/${options.sha}`,
    "-f",
    `state=${code === 0 ? "success" : "failure"}`,
    "-f",
    `context=${CONTEXT}`,
    "-f",
    `description=${description}`,
  ];
  if (runId)
    args.push("-f", `target_url=${server}/${repository}/actions/runs/${runId}`);
  const posted = run("gh", args);
  if (posted.status !== 0) {
    console.error(posted.stderr.trim());
    console.error(
      `deps-audit: could not post the ${CONTEXT} status on ${options.sha}`,
    );
    console.error("ACTION: give the job's token 'statuses: write'");
    return 1;
  }
  console.log(
    `deps-audit: posted ${CONTEXT}=${code === 0 ? "success" : "failure"} on ${options.sha}`,
  );
  return code;
}

const options = parseArgs(process.argv.slice(2));
if (!existsSync("Cargo.lock"))
  usage("no Cargo.lock in the working directory; run it from the crate root");
if (options.mode === "check") process.exit(check(options));
if (options.mode === "report") process.exit(report(options).code);
process.exit(status(options));
