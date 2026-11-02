#!/usr/bin/env node
// Re-fetch every response the release-tail replay serves and diff it against
// its recording, so a recording that no longer says what GitHub says is found
// rather than trusted.
//
//   node .github/fixtures/release-tail/reconcile.mjs [RELEASE_DIR]
//
// RELEASE_DIR defaults to every release directory beside this script. Each
// `<name>.json` sidecar names the API path; this asks the real `gh` for it,
// read-only (`gh api --include --method GET`), and compares the bodies. Ignored,
// and only these: the response headers (dates, ETags, rate-limit counters), the
// fields GitHub rewrites on objects that have not otherwise changed (VOLATILE),
// the one change a sidecar's `served_with` names, the email addresses no
// recording keeps (replaced in GitHub's answer as they were in the recording,
// sidecar.mjs), and, in a listing, items that
// entered or left the page since it was recorded — a later release or a newly
// closed pull request — which are reported, not failed. Exit 0: every recording
// matches; 1: a recording differs, or a read failed (each named on stderr).
//
// To record a release afresh, run publish's last step with ONEVCS_GH naming
// gh-replay.mjs and GH_REPLAY_RECORD naming the new release's directory
// (gh-replay.mjs's header says how), then name the one change in its sidecar.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactEmails, redaction, servedWithChange } from "./sidecar.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const VOLATILE = new Set([
  "updated_at",
  "pushed_at",
  "download_count",
  "reactions",
  "comments",
  "review_comments",
  "commits_url",
  "author_association",
]);

const strip = (value) => {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !VOLATILE.has(key))
        .map(([key, inner]) => [key, strip(inner)]),
    );
  return value;
};
// gh's output: a status line and headers, a blank line, then a JSON body.
function bodyOf(text, what) {
  const status = Number(text.match(/^HTTP\/[\d.]+ (\d{3})\b/)?.[1]);
  if (!status) throw new Error(`${what} has no HTTP status line`);
  if (status >= 300)
    throw new Error(`${what} is HTTP ${status}, not a served page`);
  const framing = text.match(/\r?\n\r?\n/);
  if (!framing) throw new Error(`${what} has no header/body separator`);
  return JSON.parse(text.slice(framing.index + framing[0].length));
}
// The list a listing page carries, under whichever key GitHub names it, or
// null for a response that is not a listing. A list that holds anything but
// objects is not one GitHub serves.
function listOf(body, what) {
  const list = Array.isArray(body)
    ? body
    : (body?.workflow_runs ??
      body?.jobs ??
      (Array.isArray(body?.commits) ? body.commits : null));
  if (list === null || list === undefined) return null;
  if (
    !Array.isArray(list) ||
    !list.every((item) => item && typeof item === "object")
  )
    throw new Error(`${what} carries a listing that is not a list of objects`);
  return list;
}
const key = (item) => item.id ?? item.sha ?? JSON.stringify(item);

const dirs = process.argv[2]
  ? [process.argv[2]]
  : readdirSync(here)
      .map((name) => join(here, name))
      .filter((path) => statSync(path).isDirectory());
let differs = 0;
let checked = 0;
for (const dir of dirs)
  for (const file of readdirSync(dir).filter((name) =>
    name.endsWith(".json"),
  )) {
    const sidecar = JSON.parse(readFileSync(join(dir, file), "utf8"));
    checked += 1;
    // What reaches gh is an API path of this kind, never an option or a URL.
    if (
      typeof sidecar?.path !== "string" ||
      !/^repos\/[\w.-]+\/[\w.-]+\//.test(sidecar.path)
    ) {
      differs += 1;
      console.error(
        `reconcile: ${file}: its sidecar names no repos/OWNER/NAME/ API path`,
      );
      continue;
    }
    // A recording or an answer that is not what gh prints is a difference,
    // named, rather than a crash that leaves the others unchecked.
    try {
      const change = servedWithChange(sidecar, file);
      redaction(sidecar, file);
      const recorded = bodyOf(
        readFileSync(join(dir, file.replace(/\.json$/, ".http")), "utf8"),
        `the recording of ${sidecar.path}`,
      );
      for (const [id, fields] of Object.entries(change?.jobs ?? {})) {
        const job = Array.isArray(recorded.jobs)
          ? recorded.jobs.find((candidate) => String(candidate.id) === id)
          : undefined;
        if (!job)
          throw new Error(
            `its served_with names job ${id}, which the recording lacks`,
          );
        for (const name of Object.keys(fields)) delete job[name];
      }
      const fetched = spawnSync(
        "gh",
        ["api", "--include", "--method", "GET", sidecar.path],
        {
          encoding: "utf8",
          maxBuffer: 256 * 1024 * 1024,
        },
      );
      if (fetched.status !== 0) {
        differs += 1;
        console.error(
          `reconcile: ${sidecar.path}: gh failed: ${fetched.stderr.trim()}`,
        );
        continue;
      }
      const fresh = bodyOf(
        redactEmails(fetched.stdout),
        `GitHub's answer to ${sidecar.path}`,
      );
      for (const [id, fields] of Object.entries(change?.jobs ?? {}))
        for (const name of Object.keys(fields))
          delete fresh.jobs?.find((job) => String(job.id) === id)?.[name];
      const [was, now] = [
        listOf(recorded, `the recording of ${sidecar.path}`),
        listOf(fresh, `GitHub's answer to ${sidecar.path}`),
      ];
      if (was && now) {
        const current = new Map(now.map((item) => [key(item), item]));
        const changed = was.filter(
          (item) =>
            current.has(key(item)) &&
            JSON.stringify(strip(item)) !==
              JSON.stringify(strip(current.get(key(item)))),
        );
        const gone = was.filter((item) => !current.has(key(item))).length;
        const added = now.filter(
          (item) => !was.some((old) => key(old) === key(item)),
        ).length;
        if (gone || added)
          console.log(
            `reconcile: ${sidecar.path}: ${added} item(s) entered and ${gone} left the page since it was recorded`,
          );
        for (const item of changed) {
          differs += 1;
          console.error(
            `reconcile: ${sidecar.path}: item ${key(item)} differs from its recording`,
          );
        }
      } else if (
        JSON.stringify(strip(recorded)) !== JSON.stringify(strip(fresh))
      ) {
        differs += 1;
        console.error(
          `reconcile: ${sidecar.path}: the response differs from its recording`,
        );
      }
    } catch (error) {
      differs += 1;
      console.error(`reconcile: ${sidecar.path}: ${error.message}`);
    }
  }

if (checked === 0) {
  console.error(
    `reconcile: no recording under ${dirs.join(", ")}, so nothing was reconciled`,
  );
  console.error(
    "ACTION: name a release directory holding <name>.http recordings and their .json sidecars",
  );
  process.exit(1);
}
if (differs) {
  console.error(`reconcile: ${differs} difference(s)`);
  console.error(
    "ACTION: re-record the release (see this script's header) or explain the difference",
  );
  process.exit(1);
}
console.log("reconcile: every recording matches what GitHub serves");
