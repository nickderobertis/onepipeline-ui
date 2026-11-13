// Read-only GitHub access for the CI test-speed spike, through the host's `gh`
// login. Every response is kept under a cache directory, so a measurement can be
// re-run offline from what an earlier run fetched, and every network read first
// checks the core quota: below the floor the read is refused rather than made.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const REPO = "nickderobertis/onepipeline-ui";
const FLOOR = Number(process.env.SPIKE_CORE_FLOOR ?? 2500);

let checked = 0;
let remaining = null;

function gh(args, binary = false) {
  return execFileSync("gh", args, {
    encoding: binary ? "buffer" : "utf8",
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// One quota read per 25 REST reads keeps the guard cheap and still stops well
// before the floor: no single measurement makes 25 reads between checks.
function guard() {
  if (remaining === null || checked >= 25) {
    remaining = JSON.parse(gh(["api", "rate_limit"])).resources.core.remaining;
    checked = 0;
  }
  if (remaining < FLOOR) {
    throw new Error(
      `GitHub core quota is ${remaining}, below the ${FLOOR} floor: stopping reads. ACTION: wait for the hourly reset, or re-run with --offline against the cache`,
    );
  }
  checked += 1;
  remaining -= 1;
}

export class Cache {
  constructor(dir, offline = false) {
    this.dir = dir;
    this.offline = offline;
  }
  path(key) {
    return join(this.dir, key.replace(/[^A-Za-z0-9._-]+/g, "_"));
  }
  // `local` marks a computation on this host rather than a GitHub read: it
  // runs offline too, and spends no quota.
  read(key, fetch, binary = false, local = false) {
    const file = this.path(key);
    if (existsSync(file)) return readFileSync(file, binary ? null : "utf8");
    if (local) {
      const body = fetch();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
      return body;
    }
    if (this.offline)
      throw new Error(`offline and ${key} is not cached under ${this.dir}`);
    guard();
    const body = fetch();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
    return body;
  }
  // A REST GET, parsed as JSON.
  json(path, tag = "") {
    return JSON.parse(this.read(`rest${path}${tag}`, () => gh(["api", path])));
  }
  // Every page of a paginated REST list, concatenated under `field`.
  // `tag` names a cached copy apart (a run's artifact list grows per attempt).
  pages(path, field, tag = "") {
    const out = [];
    for (let page = 1; page < 50; page += 1) {
      const sep = path.includes("?") ? "&" : "?";
      const body = this.json(`${path}${sep}per_page=100&page=${page}`, tag);
      out.push(...body[field]);
      if (body[field].length < 100) break;
    }
    return out;
  }
  // A job's whole log as text.
  log(jobId) {
    return this.read(`log-${jobId}.txt`, () =>
      gh([
        "api",
        "--allow-escape-sequences",
        `repos/${REPO}/actions/jobs/${jobId}/logs`,
      ]),
    );
  }
  // An artifact's zip, as bytes.
  artifact(id) {
    return this.read(
      `artifact-${id}.zip`,
      () => gh(["api", `repos/${REPO}/actions/artifacts/${id}/zip`], true),
      true,
    );
  }
}
