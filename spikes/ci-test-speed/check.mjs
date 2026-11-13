// The harness's trust boundary: every command-line value and every document it
// reads back (from GitHub, its cache or a recorder) is checked here before use,
// and a bad one stops the command with what was wrong and what to do.

export class Refusal extends Error {}

export function refuse(what, action) {
  throw new Refusal(`${what}. ACTION: ${action}`);
}

// Run `main`, turning a Refusal into exit 2 (a usage or input error) with its
// message on stderr; anything else is a crash and keeps its stack.
export async function cli(main) {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(error.message);
    process.exit(2);
  }
}

export function options(argv) {
  const value = (name) => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--"))
      refuse(`--${name} has no value`, `pass --${name} <value>`);
    return v;
  };
  return {
    flag: (name) => argv.includes(`--${name}`),
    string: (name, fallback = null) => value(name) ?? fallback,
    int(name, fallback, { min = 0 } = {}) {
      const v = value(name);
      if (v === null) return fallback;
      if (!/^\d+$/.test(v) || Number(v) < min)
        refuse(
          `--${name} ${JSON.stringify(v)} is not an integer of at least ${min}`,
          `pass --${name} as a whole number ≥ ${min}`,
        );
      return Number(v);
    },
    date(name, fallback) {
      const v = value(name) ?? fallback;
      const t = Date.parse(v);
      if (!Number.isFinite(t))
        refuse(
          `--${name} ${JSON.stringify(v)} is not a date`,
          `pass --${name} as an ISO 8601 time such as 2026-11-09T00:00:00Z`,
        );
      return t;
    },
    list(name, fallback, allowed = null) {
      const items = (value(name) ?? fallback).split(",").filter(Boolean);
      if (!items.length)
        refuse(`--${name} names nothing`, `pass --${name} a,b`);
      for (const x of items)
        if (allowed && !allowed.includes(x))
          refuse(
            `--${name} names ${JSON.stringify(x)}, which is not one of ${allowed.join(", ")}`,
            `pass --${name} with only ${allowed.join(", ")}`,
          );
      return items;
    },
  };
}

const iso = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));

// An `nx-cache-entries-<job>` executions document: its tasks, each named, with
// a result and finite start and finish times.
export function executionsDoc(doc, where) {
  if (!doc || !Array.isArray(doc.tasks))
    refuse(
      `${where} is not an executions document (no tasks array)`,
      "re-fetch the run's nx-cache-entries artifact, or remove it from the cache",
    );
  for (const t of doc.tasks)
    if (
      typeof t?.task !== "string" ||
      typeof t.result !== "string" ||
      !iso(t.started_at) ||
      !iso(t.finished_at)
    )
      refuse(
        `${where} holds a task record without a name, result or valid times: ${JSON.stringify(t).slice(0, 160)}`,
        "re-fetch the artifact; a truncated download leaves such a record",
      );
  return doc;
}

// A `measure.mjs --json` document: a run with jobs, each with a finite wall clock.
export function measurementDoc(doc, where) {
  if (!doc || !Number.isInteger(doc.run) || !Array.isArray(doc.jobs))
    refuse(
      `${where} is not a measure.mjs --json document`,
      "pass the files measure.mjs --json wrote",
    );
  for (const j of doc.jobs)
    if (
      typeof j?.job !== "string" ||
      !Number.isFinite(j.wall_minutes) ||
      !Array.isArray(j.tasks)
    )
      refuse(
        `${where} has a job without a name, wall clock or tasks`,
        "re-run measure.mjs for that run",
      );
  return doc;
}

// A `replay.mjs --json` document: one row per PR.
export function replayDoc(doc, where) {
  if (
    !Array.isArray(doc) ||
    doc.some((r) => !Number.isInteger(r?.pr) || typeof r.jobs !== "object")
  )
    refuse(
      `${where} is not a replay.mjs --json document`,
      "pass the file replay.mjs --json wrote",
    );
  return doc;
}

// GitHub's job listing rows and runs read back from the cache.
export function jobsList(jobs, where) {
  if (
    !Array.isArray(jobs) ||
    jobs.some(
      (j) =>
        !Number.isInteger(j?.id) ||
        typeof j.name !== "string" ||
        !Array.isArray(j.steps),
    )
  )
    refuse(
      `${where} is not a list of jobs with ids, names and steps`,
      "remove it from the cache and re-run online",
    );
  return jobs;
}
