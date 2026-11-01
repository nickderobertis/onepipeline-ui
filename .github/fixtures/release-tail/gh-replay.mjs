#!/usr/bin/env node
// The stand-in for `gh` behind onevcs's `ONEVCS_GH` seam, which onevcs states is
// the supported way to replay recorded responses: it is invoked as
// `gh api --include --method GET <request>` and prints the status line, the
// headers and the body as `gh` does, exiting non-zero on an error status.
//
// Replay (`GH_REPLAY_FIXTURES`): each response is a recording under that
// directory — `<name>.http`, gh's own output for the request, beside
// `<name>.json`, the sidecar naming the request's API path, the release or run
// it was fetched from and any change it is served with. A request with no
// recording is answered 404, as GitHub answers a path it does not have.
//
// Record (`GH_REPLAY_RECORD`): each request is asked of the real `gh`, read-only
// and under gh's own login, and its answer saved under that directory with a sidecar naming
// `GH_REPLAY_SOURCE` (a JSON object: the repository and release recorded).
//
// Either way every request is appended to `GH_REPLAY_LOG`, one JSON line each, so
// a test counts what was asked from the double's own record. `GH_REPLAY_STATUS`
// answers every request with that error status instead.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

// Written synchronously: `process.exit` drops whatever an asynchronous write to
// a pipe has not flushed yet, which cut a 1.8 MB listing at 64 KiB.
function writeAll(fd, text) {
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset);
    } catch (error) {
      // A non-blocking pipe that is full: wait for the reader, then go on.
      if (error.code !== "EAGAIN") throw error;
    }
  }
}
const out = (text) => writeAll(1, text);
const err = (text) => writeAll(2, text);

const args = process.argv.slice(2);
const request = args.at(-1);
if (
  args.length !== 5 ||
  args[0] !== "api" ||
  args[1] !== "--include" ||
  args[2] !== "--method" ||
  args[3] !== "GET"
) {
  err(
    `gh-replay: only 'api --include --method GET <request>' is served, got: ${args.join(" ")}\n`,
  );
  process.exit(2);
}
if (process.env.GH_REPLAY_LOG)
  appendFileSync(process.env.GH_REPLAY_LOG, `${JSON.stringify({ request })}\n`);

const errorStatus = process.env.GH_REPLAY_STATUS;
if (errorStatus && !/^[45]\d\d$/.test(errorStatus)) {
  err(
    `gh-replay: GH_REPLAY_STATUS must be an HTTP error status (400-599), got: ${errorStatus}\n`,
  );
  process.exit(2);
}
if (errorStatus) {
  out(
    `HTTP/2.0 ${errorStatus} Error\r\nContent-Type: application/json; charset=utf-8\r\n\r\n` +
      `{"message":"Server Error","status":"${errorStatus}"}`,
  );
  err(`gh: Server Error (HTTP ${errorStatus})\n`);
  process.exit(1);
}

// The recording's name: stable for a request, readable in a listing.
const name = (path) =>
  `${path
    .replace(/^https:\/\/api\.github\.com\//, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .slice(
      0,
      80,
    )}-${createHash("sha256").update(path).digest("hex").slice(0, 8)}`;

const record = process.env.GH_REPLAY_RECORD;
if (record) {
  mkdirSync(record, { recursive: true });
  // The real `gh` reads with its own login: the token onevcs hands it is the
  // recording session's placeholder, never a credential this script holds.
  const { GH_TOKEN: _token, GITHUB_TOKEN: _placeholder, ...env } = process.env;
  const real = spawnSync("gh", args, {
    encoding: "utf8",
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (real.status === 0) {
    const file = name(request);
    writeFileSync(join(record, `${file}.http`), real.stdout);
    writeFileSync(
      join(record, `${file}.json`),
      `${JSON.stringify(
        {
          path: request,
          fetched_from: JSON.parse(process.env.GH_REPLAY_SOURCE ?? "{}"),
          fetched_at: new Date().toISOString(),
          served_with: null,
        },
        null,
        2,
      )}\n`,
    );
  }
  out(real.stdout);
  err(real.stderr);
  process.exit(real.status ?? 1);
}

const fixtures = process.env.GH_REPLAY_FIXTURES;
if (!fixtures || !existsSync(fixtures)) {
  err("gh-replay: GH_REPLAY_FIXTURES names no directory\n");
  process.exit(2);
}
const sidecar = readdirSync(fixtures)
  .filter((file) => file.endsWith(".json"))
  .map((file) => {
    const entry = JSON.parse(readFileSync(join(fixtures, file), "utf8"));
    if (typeof entry?.path !== "string")
      throw new Error(`gh-replay: the sidecar ${file} names no API path`);
    // The recording is the sidecar's own neighbour, whatever the sidecar says.
    return { ...entry, file };
  })
  .find((entry) => entry.path === request);
if (!sidecar) {
  out(
    'HTTP/2.0 404 Not Found\r\nContent-Type: application/json; charset=utf-8\r\n\r\n{"message":"Not Found","status":"404"}',
  );
  err(`gh: Not Found (HTTP 404): no recording of ${request}\n`);
  process.exit(1);
}
const recorded = readFileSync(
  join(fixtures, sidecar.file.replace(/\.json$/, ".http")),
  "utf8",
);
try {
  out(servedWith(recorded, sidecar.served_with));
} catch (error) {
  err(`${error.message}\n`);
  process.exit(1);
}

// A recording is served as it was recorded, but for the one change its sidecar
// names: `served_with.jobs` rewrites the named jobs' fields in a jobs listing.
export function servedWith(response, change) {
  if (!change) return response;
  // A recording is gh's output: a status line and headers, a blank line, then
  // a JSON body. One that is not cannot be served changed.
  const framing = response.match(/\r?\n\r?\n/);
  if (!framing)
    throw new Error(
      `gh-replay: the recording of ${request} has no header/body separator`,
    );
  const head = response.slice(0, framing.index);
  const separator = framing[0];
  const body = JSON.parse(response.slice(framing.index + separator.length));
  if (
    !Array.isArray(body?.jobs) ||
    !body.jobs.every((job) => job && typeof job === "object")
  )
    throw new Error(
      `gh-replay: the recording of ${request} is not a jobs listing, so it has no job to change`,
    );
  for (const [id, fields] of Object.entries(change.jobs ?? {})) {
    const job = body.jobs.find((candidate) => String(candidate.id) === id);
    if (!job)
      throw new Error(`gh-replay: no job ${id} in ${request} to change`);
    Object.assign(job, fields);
  }
  return `${head}${separator}${JSON.stringify(body)}`;
}
