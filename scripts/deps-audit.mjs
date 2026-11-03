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
//           resolves is summarized on one line and passes: it is the advisories
//           report's.
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
//           this repository's token should have posted was refused. The Actions
//           context it posts with (GITHUB_REPOSITORY, GITHUB_SERVER_URL,
//           GITHUB_RUN_ID) is validated before anything runs.
//
// No advisory is ignored or downgraded in deny.toml to get there: the
// configuration still treats every advisory and yanked crate as a finding, and
// this script decides only which check owns it.
//
// The head is the checked-out tree: on a pull request that is GitHub's merge of
// the branch onto its base, so an advisory a fix on the base has since removed
// is not in it; on `main` it is the pushed commit. The base is
// `git merge-base HEAD origin/main` — the commit a pull request's merge ref is
// built on, which `lint` checks out with full history — or --base.
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
// What Actions sets for the run link a status points at.
const SERVER_URL = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?$/;
const RUN_ID = /^[0-9]+$/;
// llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] GitHub's REST documentation for commit statuses is the one source of this limit and nothing machine-readable publishes it; only an authenticated POST tests it, which the offline gate cannot send. Drift is loud rather than silent: a description GitHub refuses fails the post, and the step prints gh's refusal.
const DESCRIPTION_LIMIT = 140;
// llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]
// The records cargo-deny's JSON output is made of.
const RECORDS = new Set(["diagnostic", "log", "summary"]);
const SEVERITIES = new Set(["error", "warning", "note", "help"]);
const LOG_LEVELS = new Set(["TRACE", "DEBUG", "INFO", "WARN", "ERROR"]);
// The tables cargo writes into a Cargo.lock.
const LOCK_TABLES = new Set(["[[package]]", "[metadata]", "[[patch.unused]]"]);

const isObject = (value) => typeof value === "object" && value !== null;
const token = (value) =>
  typeof value === "string" && /^\S+$/.test(value) ? value : "";
const text = (value, fallback) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : fallback;

// A run that cannot go on: what stopped it and what to do, printed once by
// whoever catches it — `status` posts it as a red status first.
class Refusal extends Error {
  constructor(message, action) {
    super(message);
    this.action = action;
  }
  print() {
    console.error(`deps-audit: ${this.message}`);
    console.error(`ACTION: ${this.action}`);
  }
}

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
  if (result.error)
    throw new Refusal(
      `cannot run ${command}: ${result.error.message}`,
      `install ${command} and re-run`,
    );
  return result;
}

// `name version` for every package a Cargo.lock resolves, or why it cannot be
// read. Cargo writes the file in one fixed shape, so a table cargo does not
// write, no `[[package]]` at all (a lockfile always resolves its own crate), or
// a package without exactly one quoted name and one quoted version is a
// lockfile this cannot vouch for, never one to read the rest of: a package
// dropped here would turn a pre-existing advisory into an introduced one.
function lockedPackages(text) {
  const packages = new Set();
  const tables = text.match(/^\[.*$/gm) ?? [];
  const unknown = tables.find((table) => !LOCK_TABLES.has(table.trim()));
  if (unknown !== undefined)
    return { error: `'${unknown.trim()}' is not a table cargo writes there` };
  const blocks = text.split(/^\[\[package\]\][ \t]*\r?$/m).slice(1);
  for (const [index, block] of blocks.entries()) {
    const body = block.split(/^\[/m)[0];
    const values = (key) =>
      [
        ...body.matchAll(
          new RegExp(`^${key}[ \\t]*=[ \\t]*"([^"\\s]+)"[ \\t]*\\r?$`, "gm"),
        ),
      ].map((match) => match[1]);
    const names = values("name");
    const versions = values("version");
    if (names.length !== 1 || versions.length !== 1)
      return {
        error: `[[package]] number ${index + 1} has ${names.length} quoted name and ${versions.length} quoted version fields, not one of each`,
      };
    packages.add(`${names[0]} ${versions[0]}`);
  }
  if (packages.size === 0) return { error: "it lists no [[package]]" };
  return { packages };
}

function basePackages(rev) {
  let commit = rev;
  if (!commit) {
    const merge = run("git", ["merge-base", "HEAD", "origin/main"]);
    if (merge.status !== 0) {
      console.error(merge.stderr.trim());
      throw new Refusal(
        "cannot resolve the base this change forks from (git merge-base HEAD origin/main)",
        "fetch main with history ('git fetch origin main'), or pass --base <rev>",
      );
    }
    commit = merge.stdout.trim();
  }
  const verified = run("git", ["rev-parse", "--verify", `${commit}^{commit}`]);
  if (verified.status !== 0)
    throw new Refusal(
      `the base '${commit}' is not a commit here`,
      "pass --base a commit this checkout has",
    );
  commit = verified.stdout.trim();
  // A base with no Cargo.lock resolves nothing, so every advisory is the
  // change's; one it has and that cannot be read is a refusal.
  const listed = run("git", [
    "ls-tree",
    "--name-only",
    commit,
    "--",
    "Cargo.lock",
  ]);
  if (listed.status === 0 && listed.stdout.trim() === "")
    return { commit, packages: new Set() };
  const shown = run("git", ["show", `${commit}:./Cargo.lock`]);
  const read =
    shown.status === 0
      ? lockedPackages(shown.stdout)
      : { error: `${listed.stderr}${shown.stderr}`.trim() };
  if (read.error)
    throw new Refusal(
      `cannot read Cargo.lock at the base ${commit}: ${read.error}`,
      "pass --base a commit whose Cargo.lock cargo wrote, or fix the git error above",
    );
  return { commit, packages: read.packages };
}

// cargo-deny's advisories check, read as JSON: every advisory it matched, and
// every other error it raised (yanked crates, an unreadable database, ...).
// Every line it prints must be one of its records, and every run must end with
// the summary record whose error count matches the errors printed and the exit
// status: output this cannot read, or a verdict its own count does not explain,
// is an error, never nothing found.
//
// `cargo` is rustup's proxy wherever rustup installed it, and the first call
// under a rust-toolchain.toml whose toolchain is not installed yet installs it,
// printing its progress (`info: syncing channel updates ...`) on the same stderr
// cargo-deny writes its records to. The `advisories` job installs no toolchain
// before this runs, so every report on `main` read that progress as output it
// could not parse and failed with no advisory to show. So the toolchain is
// resolved first, by a call whose output is shown and not read, and the call
// read below prints only what cargo-deny does.
function advisoriesCheck() {
  const toolchain = spawnSync("cargo", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (toolchain.error)
    throw new Refusal(
      `cannot run cargo: ${toolchain.error.message}`,
      "install cargo and re-run",
    );
  if (toolchain.status !== 0)
    throw new Refusal(
      `'cargo --version' exited ${toolchain.status} resolving the toolchain cargo-deny runs under (its output is above), so the advisories check did not run`,
      "install the toolchain rust-toolchain.toml pins ('rustup toolchain install' from the crate root), or let rustup install it on first use ('rustup set auto-install enable'), then re-run",
    );
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
  let counted;
  let diagnosed = 0;
  for (const raw of `${result.stdout}\n${result.stderr}`.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      errors.push(`unparseable output: ${line}`);
      continue;
    }
    if (
      !isObject(entry) ||
      !RECORDS.has(entry.type) ||
      !isObject(entry.fields)
    ) {
      errors.push(`a record this cannot read: ${line}`);
      continue;
    }
    const fields = entry.fields;
    if (entry.type === "summary") {
      counted = fields.advisories?.errors;
      if (!Number.isInteger(counted))
        errors.push(`a summary without an advisories error count: ${line}`);
      continue;
    }
    if (entry.type === "log") {
      if (!LOG_LEVELS.has(fields.level))
        errors.push(`a log record with a level this cannot read: ${line}`);
      else if (fields.level === "ERROR")
        errors.push(text(fields.message, line));
      continue;
    }
    if (!SEVERITIES.has(fields.severity)) {
      errors.push(`a diagnostic with a severity this cannot read: ${line}`);
      continue;
    }
    if (fields.severity !== "error") continue;
    diagnosed += 1;
    const graph = Array.isArray(fields.graphs) ? fields.graphs[0] : undefined;
    const krate = isObject(graph?.Krate) ? graph.Krate : undefined;
    // An advisory is classified only on fields that read as what they name:
    // anything else fails the run as an unreadable diagnostic rather than being
    // matched, or not, on a value that is not there.
    if (isObject(fields.advisory)) {
      const advisory = {
        id: token(fields.advisory.id),
        title: text(fields.advisory.title ?? fields.message, ""),
        kind: token(fields.code),
        name: token(krate?.name),
        version: token(krate?.version),
      };
      if (advisory.id && advisory.kind && advisory.name && advisory.version)
        advisories.push(advisory);
      else
        errors.push(`an advisory diagnostic this cannot read: ${line.trim()}`);
    } else {
      const where = krate
        ? ` (${text(krate.name, "?")} ${text(krate.version, "?")})`
        : "";
      errors.push(
        `${text(fields.code, "error")}: ${text(fields.message, line.trim())}${where}`,
      );
    }
  }
  const exited = `cargo deny check advisories exited ${result.status}`;
  if (errors.length === 0) {
    if (counted === undefined)
      errors.push(`${exited} without the summary it ends with`);
    else if (counted !== diagnosed)
      errors.push(
        `${exited} counting ${counted} errors, where ${diagnosed} were printed`,
      );
    else if ((result.status !== 0) !== diagnosed > 0)
      errors.push(`${exited} having printed ${diagnosed} errors`);
  }
  // In id order, so every listing of the same graph reads the same.
  advisories.sort((a, b) =>
    `${a.id} ${a.name} ${a.version}`.localeCompare(
      `${b.id} ${b.name} ${b.version}`,
    ),
  );
  return { advisories, errors };
}

const key = (a) => `${a.name} ${a.version}`;
const named = (a) => `${a.id} ${a.name} ${a.version}`;
const describe = (a) => `${named(a)} (${a.kind}): ${a.title}`;
const ALL_CLEAR = "no advisory matches the resolved graph";
const ADVISORIES_CHECK_ACTION =
  "ACTION: fix the cargo-deny error above — an advisory database it cannot open or fetch is refreshed by 'cargo deny fetch' — and re-run";

function check(options) {
  let failed = false;
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
  if (policy.status !== 0) {
    failed = true;
    console.error(
      "ACTION: fix the bans, licenses or sources finding cargo-deny printed above (deny.toml says what is allowed); if it printed none, run 'cargo deny check bans licenses sources' to see why it failed",
    );
  }

  const base = basePackages(options.base);
  const { advisories, errors } = advisoriesCheck();
  for (const error of errors)
    console.error(`deps-audit: advisories check: ${error}`);
  if (errors.length > 0) {
    failed = true;
    console.error(ADVISORIES_CHECK_ACTION);
  }
  const short = base.commit.slice(0, 12);
  const preExisting = advisories.filter((a) => base.packages.has(key(a)));
  const introduced = advisories.filter((a) => !base.packages.has(key(a)));
  // What passes is one line; the advisories report lists each of them.
  if (preExisting.length > 0)
    console.log(
      `deps-audit: pre-existing, not blocking: ${preExisting.map(named).join(", ")} — the base ${short} already resolves ${preExisting.length === 1 ? "it" : "each"}; \`just advisories-report\` lists ${preExisting.length === 1 ? "it" : "them"}`,
    );
  for (const advisory of introduced)
    console.error(
      `deps-audit: introduced by this change: ${describe(advisory)} — the base ${short} does not resolve ${advisory.name} ${advisory.version}`,
    );
  if (introduced.length > 0) {
    failed = true;
    console.error(
      "ACTION: move the introduced crate to a patched version ('cargo update -p <crate>'), or drop it",
    );
  }

  // machete prints the unused deps it finds on stdout, so keep it: hiding them
  // would leave a failing gate with no actionable detail.
  const machete = run("cargo", ["machete"], { inherit: true });
  if (machete.status !== 0) {
    failed = true;
    console.error(
      "ACTION: remove the unused dependency cargo-machete named above from Cargo.toml; if it named none, run 'cargo machete' to see why it failed",
    );
  }
  return failed ? 1 : 0;
}

// The report's findings, printed; `quiet` leaves the all-clear line to a caller
// that concludes with its own.
function report(options, { quiet = false } = {}) {
  const base = basePackages(options.base);
  const { advisories, errors } = advisoriesCheck();
  for (const error of errors)
    console.error(`deps-audit: advisories check: ${error}`);
  if (errors.length > 0) console.error(ADVISORIES_CHECK_ACTION);
  for (const advisory of advisories) {
    const origin = base.packages.has(key(advisory))
      ? `already resolved at the base ${base.commit.slice(0, 12)}`
      : "introduced by this change";
    console.error(`deps-audit: advisory ${describe(advisory)} — ${origin}`);
  }
  if (advisories.length === 0 && errors.length === 0 && !quiet)
    console.log(`deps-audit: ${ALL_CLEAR}`);
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

// The status description: as many advisories as fit whole in GitHub's limit,
// then how many more the run's summary names. Showing none always fits.
function statusDescription(advisories, errors) {
  if (advisories.length === 0)
    return errors.length > 0
      ? "the advisories check did not run; see the log"
      : ALL_CLEAR;
  const names = advisories.map(named);
  let shown = names.length;
  const fitting = () => {
    const rest = names.length - shown;
    const more = rest > 0 ? [`${rest} more in the run's summary`] : [];
    return [...names.slice(0, shown), ...more].join(", ");
  };
  while (fitting().length > DESCRIPTION_LIMIT) shown -= 1;
  return fitting();
}

// A workflow command's property and message, escaped as Actions reads them.
// Neither can hold a line break: `text` and `token` already refused or folded it.
const escapeData = (value) => value.replace(/%/g, "%25");
const escapeProperty = (value) =>
  escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");

function actionsContext() {
  const refuse = (message, action) => {
    console.error(`deps-audit: ${message}`);
    console.error(`ACTION: ${action}`);
    process.exit(1);
  };
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository)
    refuse(
      "status needs GITHUB_REPOSITORY (owner/name)",
      "run it from Actions, or set GITHUB_REPOSITORY",
    );
  if (!REPOSITORY.test(repository))
    refuse(
      `GITHUB_REPOSITORY '${repository}' is not an owner/name repository`,
      "set GITHUB_REPOSITORY to owner/name",
    );
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  if (!SERVER_URL.test(server))
    refuse(
      `GITHUB_SERVER_URL '${server}' is not an https origin`,
      "set GITHUB_SERVER_URL to the server's https origin, or unset it",
    );
  const runId = process.env.GITHUB_RUN_ID;
  if (runId && !RUN_ID.test(runId))
    refuse(
      `GITHUB_RUN_ID '${runId}' is not a run id`,
      "set GITHUB_RUN_ID to the numeric run id, or unset it",
    );
  return { repository, server, runId };
}

function status(options) {
  const { repository, server, runId } = actionsContext();
  // A report that could not run is posted red too: an absent status would read
  // as one still pending, and a stale one as the last commit's answer.
  let outcome;
  try {
    outcome = report(options, { quiet: true });
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    error.print();
    outcome = { advisories: [], errors: [error.message], code: 1 };
  }
  const { advisories, errors, code } = outcome;
  const description = statusDescription(advisories, errors);
  const fork = options.headRepo.toLowerCase() !== repository.toLowerCase();
  const where = fork
    ? `\n\nThis pull request comes from the fork ${options.headRepo}, whose token cannot post the \`${CONTEXT}\` status: this summary is the report.`
    : "";
  // A summary that cannot be written fails the step, after the status is
  // posted: the log still carries the report.
  let summaryFailed = false;
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary)
    try {
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
    } catch (error) {
      summaryFailed = true;
      console.error(
        `deps-audit: cannot write the step summary GITHUB_STEP_SUMMARY names: ${error.message}`,
      );
      console.error(
        "ACTION: point GITHUB_STEP_SUMMARY at a writable file, or unset it",
      );
    }
  if (process.env.GITHUB_ACTIONS)
    for (const a of advisories)
      console.log(
        `::warning title=${escapeProperty(`${a.id} in ${a.name} ${a.version}`)}::${escapeData(a.title)}`,
      );
  const verdict = code === 0 ? ALL_CLEAR : description;
  if (fork) {
    console.log(
      `deps-audit: ${verdict}; ${options.headRepo} is a fork of ${repository}, whose token cannot post the ${CONTEXT} status, so this log and the step summary are the report`,
    );
    return summaryFailed ? 1 : code;
  }
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
    `deps-audit: posted ${CONTEXT}=${code === 0 ? "success" : "failure"} on ${options.sha}: ${verdict}`,
  );
  return summaryFailed ? 1 : code;
}

const options = parseArgs(process.argv.slice(2));
if (!existsSync("Cargo.lock"))
  usage("no Cargo.lock in the working directory; run it from the crate root");
try {
  if (options.mode === "check") process.exit(check(options));
  if (options.mode === "report") process.exit(report(options).code);
  process.exit(status(options));
} catch (error) {
  if (!(error instanceof Refusal)) throw error;
  error.print();
  process.exit(1);
}
