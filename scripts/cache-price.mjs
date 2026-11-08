#!/usr/bin/env node
// SPIKE HARNESS — throwaway, never landed. Prices every compile line one OS leg
// of `.github/workflows/ci-cache.yml` warms (`scripts/ci-warm.sh <os> --plan`):
// the archive bytes it adds to that OS's Rust cache family, measured on a cold
// build as the family with and without the line, and the minutes a pull-request
// job pays for it if it leaves (spike-onepipeline-ui-coverage-and-cache of the
// plan coverage-cache-and-trim-2026-11-08).
//
// One command prices one OS leg:
//
//   node scripts/cache-price.mjs linux|windows|macos
//
// Off a runner it re-runs the `price (<os>)` job of this branch's latest
// cache-price.yml run on its draft, waits, and prints the job's CACHE-PRICE
// records. On the runner the workflow calls the phases itself:
//
//   --listed   right after rust-cache restores main's family (save-if: false):
//              the restored family recompressed as actions/cache saves it, and
//              where its bytes are, by profile directory and by crate
//   --price    `rm -rf target`, then every warm line cold in plan order, each
//              timed; then rust-cache v2.9.2's own save-time cleanup, reproduced
//              file for file (src/cleanup.ts), and the family archived whole and
//              without each line's units; then, on that cleaned tree, each line's
//              warm run beside its run with its own units gone
//
// Every figure is one line on stdout, `CACHE-PRICE <json>`:
//   family      raw and archive bytes of a family (listed, cold)
//   composition one profile directory's raw bytes, units, archive bytes it adds
//   crates      the crates with the most units in a family, and their bytes
//   cold        one line's cold seconds in plan order, and its units
//   claims      the units a line reaches, read from cargo's JSON (or its own dir)
//   marginal    archive bytes the cold family loses without one part
//   remainder   archive bytes shared by several lines, cargo home, unattributed
//   price       a line's warm seconds and its seconds with its own units gone
//   proof       the real `ci-warm.sh` over the cold build: did anything rebuild
//
// It saves nothing anywhere: no Actions cache, no artifact. Exit 0 when every
// phase ran, 1 on a failed phase, 2 on usage.
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

const REPO = 'nickderobertis/onepipeline-ui';
const WORKFLOW = 'cache-price.yml';
const OSES = ['linux', 'windows', 'macos'];
const UNIT = /-([0-9a-f]{16})(?=[./]|$)/;
const WHEEL_TARGET = 'x86_64-unknown-linux-gnu';

const root = process.cwd();
const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
const temp = process.env.RUNNER_TEMP || process.env.ONEPIPELINE_NODE_SCRATCH_DIR || '/tmp';
const os = { linux: 'linux', win32: 'windows', darwin: 'macos' }[process.platform];
const posix = (p) => p.split(sep).join('/');

function record(kind, fields) {
  console.log(`CACHE-PRICE ${JSON.stringify({ kind, os, ...fields })}`);
}

function shell(script, options = {}) {
  return spawnSync('bash', ['-c', script], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env },
  });
}

function timed(script) {
  const started = Date.now();
  const res = shell(script, { stdio: ['ignore', 'inherit', 'inherit'] });
  return { seconds: (Date.now() - started) / 1000, status: res.status };
}

/** Every regular file below `dir`, relative to `base`, with its size. */
function walk(dir, base, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, base, out);
    else if (entry.isFile() || entry.isSymbolicLink())
      out.push({ path: posix(relative(base, path)), bytes: lstatSync(path).size });
  }
  return out;
}
const sum = (files) => files.reduce((t, f) => t + f.bytes, 0);

/**
 * Archive bytes of target-relative and cargo-home-relative paths, compressed the
 * way actions/cache saves (tar --posix piped to zstd at its default level, all
 * threads, no --long).
 */
function archiveBytes(targetFiles, cargoFiles = []) {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tl = posix(join(temp, `cp-t-${stamp}.list`));
  const cl = posix(join(temp, `cp-c-${stamp}.list`));
  writeFileSync(tl, targetFiles.map((f) => `${f}\n`).join(''));
  writeFileSync(cl, cargoFiles.map((f) => `${f}\n`).join(''));
  const res = shell(
    `set -o pipefail; { tar --posix -cf - -T "$TL"; ( cd "$CR" && tar --posix -cf - -T "$CL" ); } | zstd -T0 -c | wc -c`,
    { env: { TL: tl, CL: cl, CR: posix(cargoHome) } },
  );
  rmSync(tl);
  rmSync(cl);
  if (res.status !== 0) {
    record('error', { what: 'archive', stderr: res.stderr.slice(-600) });
    return null;
  }
  return Number(res.stdout.trim());
}

// ---- rust-cache v2.9.2's save-time cleanup, as a filter over file lists ------

/** Non-workspace packages, as rust-cache's getPackagesOutsideWorkspaceRoot reads them. */
function packages() {
  const res = spawnSync('cargo', ['metadata', '--all-features', '--format-version', '1'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: '' },
  });
  const meta = JSON.parse(res.stdout);
  const save = new Set(['lib', 'cdylib', 'dylib', 'rlib', 'staticlib', 'proc-macro']);
  const rootPrefix = root;
  return meta.packages
    .filter((p) => !p.manifest_path.startsWith(rootPrefix))
    .map((p) => ({
      name: p.name,
      version: p.version,
      path: p.manifest_path,
      targets: p.targets.filter((t) => t.kind.some((k) => save.has(k))).map((t) => t.name),
    }));
}

/**
 * The target files rust-cache would keep: a port of cleanTargetDir and
 * cleanProfileTarget (src/cleanup.ts at v2.9.2) that reads the tree and deletes
 * nothing. A directory is a profile when it is `tests` or holds build,
 * .fingerprint or deps; in a profile everything but those three goes, and in
 * them every entry whose name, less a trailing `-<hash>`, is no dependency's.
 * rust-cache cleans build, then .fingerprint, then deps, each by opendir, and a
 * missing one throws out of the profile: what follows it is kept whole.
 */
function keptTarget(_files, pkgs) {
  const keepPkg = new Set(pkgs.flatMap((p) => [p.name, ...p.targets.map((t) => t.replace(/-/g, '_'))]));
  const keepDeps = new Set(
    pkgs.flatMap((p) => [p.name, ...p.targets].flatMap((n) => [n.replace(/-/g, '_'), `lib${n.replace(/-/g, '_')}`])),
  );
  const matches = (name, keep) => {
    if (keep.has(name)) return true;
    const i = name.lastIndexOf('-');
    return i !== -1 && keep.has(name.slice(0, i));
  };
  const entries = (rel) => readdirSync(join(root, rel), { withFileTypes: true });
  const isDir = (rel) => existsSync(join(root, rel)) && lstatSync(join(root, rel)).isDirectory();
  const kept = [];
  const profiles = new Set();
  const keepWhole = (rel) => {
    if (isDir(rel)) walk(join(root, rel), root, kept);
    else if (existsSync(join(root, rel))) kept.push({ path: rel, bytes: lstatSync(join(root, rel)).size });
  };
  const cleanTarget = (rel) => {
    for (const e of entries(rel)) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        const profile =
          e.name === 'tests' || ['build', '.fingerprint', 'deps'].some((d) => isDir(`${child}/${d}`));
        if (profile) cleanProfile(child);
        else cleanTarget(child);
      } else if (e.name === 'CACHEDIR.TAG') keepWhole(child);
    }
  };
  const cleanProfile = (rel) => {
    if (rel.split('/').at(-1) === 'tests') {
      // Nested target and trybuild directories are cleaned as targets; the rest goes.
      for (const n of ['target', 'trybuild']) if (isDir(`${rel}/${n}`)) cleanTarget(`${rel}/${n}`);
      return;
    }
    profiles.add(rel);
    const order = [
      ['build', keepPkg],
      ['.fingerprint', keepPkg],
      ['deps', keepDeps],
    ];
    for (let i = 0; i < order.length; i++) {
      const [sub, keep] = order[i];
      if (!isDir(`${rel}/${sub}`)) {
        // opendir throws: the rest of the profile's kept directories stay whole.
        for (const [later] of order.slice(i + 1)) keepWhole(`${rel}/${later}`);
        return;
      }
      for (const e of entries(`${rel}/${sub}`)) if (matches(e.name, keep)) keepWhole(`${rel}/${sub}/${e.name}`);
    }
  };
  if (isDir('target')) cleanTarget('target');
  return { kept, profiles: [...profiles].sort((a, b) => b.length - a.length) };
}

/** The cargo-home files rust-cache saves: registry cleaned, bin without what predates it. */
function keptCargo(files, pkgs, oldBins) {
  const names = new Set(pkgs.map((p) => p.name));
  const sys = new Set(pkgs.filter((p) => p.name.endsWith('-sys')).map((p) => `${p.name}-${p.version}`));
  const crates = new Set(pkgs.map((p) => `${p.name}-${p.version}.crate`));
  return files.filter((f) => {
    const parts = f.path.split('/');
    if (parts[0] === 'bin') return !oldBins.has(parts[1]);
    if (parts[0] === 'registry') {
      if (parts[1] === 'index') {
        if (parts[3] === '.git') return true;
        // the index .cache keeps entries named like a dependency
        return parts.length > 3 && names.has(parts.at(-1));
      }
      if (parts[1] === 'src') return sys.has(parts[3]);
      if (parts[1] === 'cache') return crates.has(parts[3]);
      return true;
    }
    if (parts[0] === 'git') return true;
    return false;
  });
}

function cargoFiles() {
  const out = [];
  for (const name of ['bin', 'registry', 'git']) walk(join(cargoHome, name), cargoHome, out);
  return out;
}

function oldBins() {
  const path = join(temp, 'cargo-bin-before');
  return new Set(existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean) : []);
}

/** `<profile dir>#<unit hash>` for a kept target file, or null. */
function unitKey(path, profiles) {
  for (const p of profiles)
    if (path.startsWith(`${p}/`)) {
      const entry = path.slice(p.length + 1).split('/')[1] ?? '';
      const m = UNIT.exec(entry);
      return m ? `${p}#${m[1]}` : `${p}#(no unit)`;
    }
  return null;
}

function composition(label, kept, cargo, profiles, whole) {
  const byProfile = new Map();
  for (const f of kept) {
    const p = profiles.find((x) => f.path.startsWith(`${x}/`)) ?? '(other)';
    if (!byProfile.has(p)) byProfile.set(p, []);
    byProfile.get(p).push(f);
  }
  const allT = kept.map((f) => f.path);
  const allC = cargo.map((f) => f.path);
  for (const [p, fs] of [...byProfile].sort((a, b) => sum(b[1]) - sum(a[1]))) {
    const gone = new Set(fs.map((f) => f.path));
    const without = archiveBytes(allT.filter((x) => !gone.has(x)), allC);
    const units = new Set(fs.map((f) => unitKey(f.path, profiles)));
    record('composition', {
      family: label,
      dir: p,
      units: units.size,
      raw_bytes: sum(fs),
      archive_bytes_added: whole === null || without === null ? null : whole - without,
    });
  }
  for (const part of ['registry', 'git', 'bin']) {
    const gone = cargo.filter((f) => f.path.startsWith(`${part}/`));
    if (!gone.length) continue;
    const without = archiveBytes(allT, allC.filter((x) => !x.startsWith(`${part}/`)));
    record('composition', {
      family: label,
      dir: `~/.cargo/${part}`,
      raw_bytes: sum(gone),
      archive_bytes_added: whole === null || without === null ? null : whole - without,
    });
  }
  // The crates with the most units: several builds of one crate are what a
  // family made of several profiles and flag sets holds.
  const crates = new Map();
  for (const f of kept) {
    const m = /\/(?:deps|build|\.fingerprint)\/(?:lib)?([^/]+?)-[0-9a-f]{16}/.exec(f.path);
    if (!m) continue;
    const c = crates.get(m[1]) ?? { units: new Set(), bytes: 0 };
    c.units.add(unitKey(f.path, profiles));
    c.bytes += f.bytes;
    crates.set(m[1], c);
  }
  record('crates', {
    family: label,
    top: [...crates]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, 20)
      .map(([name, c]) => ({ crate: name, units: c.units.size, raw_bytes: c.bytes })),
  });
}

// ---- phases ------------------------------------------------------------------

function listed() {
  const pkgs = packages();
  const { kept, profiles } = keptTarget(walk(join(root, 'target'), root), pkgs);
  const cargo = keptCargo(cargoFiles(), pkgs, oldBins());
  const whole = archiveBytes(kept.map((f) => f.path), cargo.map((f) => f.path));
  record('family', {
    family: 'listed',
    raw_bytes: sum(kept) + sum(cargo),
    archive_bytes: whole,
    target_files: kept.length,
    profiles,
  });
  composition('listed', kept, cargo, profiles, whole);
}

/** The warm lines, as the plan lists them, and how each line's units are read. */
function lines() {
  const plan = shell(`bash scripts/ci-warm.sh ${os} --plan`);
  if (plan.status !== 0) throw new Error(`ci-warm.sh --plan failed: ${plan.stderr}`);
  const msrv = shell(`sed -n 's/^rust-version *= *"\\([^"]*\\)".*/\\1/p' Cargo.toml`).stdout.trim();
  const installBuildDir = os === 'linux' ? 'target' : 'target/install-smoke/build';
  // The JSON spelling of each line: the same cargo invocation with JSON messages,
  // run after the line itself, so every unit it names is already fresh. A line
  // writing only to a target directory of its own is read by that directory.
  const claims = {
    'just _crate-lint': { json: 'cargo clippy --all-targets --locked --quiet --message-format=json -- -D warnings' },
    'nx dag-ui-build-cache:lint': {
      json: 'cargo clippy --locked --quiet --test build-cache --message-format=json -- -D warnings',
    },
    'just _tier-test': { json: 'cargo nextest run --locked --no-run --cargo-message-format json' },
    'just _crate-install-build': {
      json: `cargo build --locked --bin onepipeline-api --target-dir target/install-smoke/target --config 'build.build-dir="${installBuildDir}"' --message-format=json`,
    },
    'just _crate-msrv': {
      json: `RUSTFLAGS="-D warnings" cargo +${msrv} check --locked --all-targets --quiet --message-format=json`,
    },
    'just _crate-doc': {
      json: 'RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --locked --quiet --message-format=json',
    },
    'just _tier-test-covered': { dirs: ['target/llvm-cov-target'] },
    'nx dag-ui:build-api-server': {
      json: 'CARGO_BUILD_BUILD_DIR=target cargo build --locked --quiet --bin onepipeline-api --target-dir target/dag-ui-api --message-format=json',
    },
    'nx dag-ui-read-latency:compile-release-server': {
      json: 'cargo build --release --locked --features bundled-ui --bin onepipeline-api --message-format=json',
    },
    'test tests/e2e/linked_report.rs': {
      json: `cargo auditable build --offline --locked --bin onepipeline-api --config 'build.build-dir="target"' --target-dir target/auditable --message-format=json`,
    },
    'just _crate-wheel-smoke': { dirs: [`target/wheel-${WHEEL_TARGET}`] },
  };
  // The job a pull request pays a line in (scripts/ci-job.sh's target lists).
  const jobs = {
    linux: {
      'just _crate-lint': 'lint',
      'nx dag-ui-build-cache:lint': 'lint',
      'just _crate-msrv': 'lint',
    },
    windows: {},
    macos: {},
  };
  const defaultJob = { linux: 'test-linux', windows: 'test-windows', macos: 'test-macos' }[os];
  return plan.stdout
    .trim()
    .split('\n')
    .map((l) => {
      const [id, command] = l.split('\t');
      if (!claims[id]) throw new Error(`no claim spelling for warm line '${id}'; add one`);
      return { id, command, ...claims[id], job: jobs[os][id] ?? defaultJob };
    });
}

function claimsOf(line) {
  const stream = join(temp, `cp-json-${process.pid}.jsonl`);
  const fd = openSync(stream, 'w');
  const started = Date.now();
  const res = spawnSync('bash', ['-c', line.json], { cwd: root, stdio: ['ignore', fd, 'inherit'], env: process.env });
  closeSync(fd);
  const hashes = new Map(); // `<profile dir>#hash`
  let fresh = 0;
  let rebuilt = 0;
  for (const text of readFileSync(stream, 'utf8').split('\n')) {
    if (!text.startsWith('{')) continue;
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      continue;
    }
    if (m.reason !== 'compiler-artifact' && m.reason !== 'build-script-executed') continue;
    for (const p of [...(m.filenames ?? []), ...(m.out_dir ? [m.out_dir] : [])]) {
      const rel = posix(relative(root, p));
      const mm = /^(.*?)\/(deps|build|\.fingerprint)\/([^/]+)/.exec(rel);
      if (!mm) continue;
      const u = UNIT.exec(mm[3]);
      if (u) hashes.set(`${mm[1]}#${u[1]}`, true);
    }
    if (m.reason === 'compiler-artifact') {
      if (m.fresh) fresh++;
      else if (!String(m.package_id).startsWith('path+')) rebuilt++;
    }
  }
  rmSync(stream);
  record('claims', {
    line: line.id,
    units: hashes.size,
    fresh_artifacts: fresh,
    rebuilt_non_workspace_artifacts: rebuilt,
    seconds: (Date.now() - started) / 1000,
    status: res.status,
  });
  return new Set(hashes.keys());
}

function price() {
  const plan = lines();
  rmSync(join(root, 'target'), { recursive: true, force: true });
  // Cold, in plan order, each line exactly as ci-warm.sh runs it.
  const cold = new Map();
  for (const line of plan) {
    const before = new Set(walk(join(root, 'target'), root).map((f) => f.path));
    const run = timed(line.command);
    const after = walk(join(root, 'target'), root);
    const created = after.filter((f) => !before.has(f.path));
    cold.set(line.id, run.seconds);
    record('cold', {
      line: line.id,
      job: line.job,
      seconds: run.seconds,
      status: run.status,
      files_created: created.length,
      raw_bytes_created: sum(created),
    });
    if (run.status !== 0) throw new Error(`cold line ${line.id} failed`);
  }
  // The real recipe over that cold build: what it still compiles is what the
  // spellings above did not.
  const proof = timed(`bash scripts/ci-warm.sh ${os}`);
  record('proof', { what: 'ci-warm.sh over the cold build', seconds: proof.seconds, status: proof.status });

  const pkgs = packages();
  const files = walk(join(root, 'target'), root);
  const { kept, profiles } = keptTarget(files, pkgs);
  const cargo = keptCargo(cargoFiles(), pkgs, oldBins());
  // Which units each line reaches.
  const reach = new Map();
  for (const line of plan) {
    let units;
    if (line.json) units = claimsOf(line);
    else {
      units = new Set();
      for (const f of kept)
        if (line.dirs.some((d) => f.path.startsWith(`${d}/`))) units.add(unitKey(f.path, profiles));
      record('claims', { line: line.id, units: units.size, by: `its own directory ${line.dirs.join(', ')}` });
    }
    reach.set(line.id, units);
  }
  const reachedBy = new Map();
  for (const f of kept) {
    const k = unitKey(f.path, profiles);
    if (!reachedBy.has(k)) reachedBy.set(k, plan.filter((l) => reach.get(l.id).has(k)).map((l) => l.id));
  }
  const allT = kept.map((f) => f.path);
  const allC = cargo.map((f) => f.path);
  const whole = archiveBytes(allT, allC);
  record('family', {
    family: 'cold',
    raw_bytes: sum(kept) + sum(cargo),
    archive_bytes: whole,
    target_files: kept.length,
    raw_bytes_before_cleanup: sum(files),
    profiles,
  });
  composition('cold', kept, cargo, profiles, whole);
  const without = (pred) => {
    const size = archiveBytes(allT.filter((p) => !pred(p)), allC);
    return whole === null || size === null ? null : whole - size;
  };
  const only = new Map(plan.map((l) => [l.id, []]));
  const unattributed = [];
  const shared = [];
  for (const f of kept) {
    const by = reachedBy.get(unitKey(f.path, profiles));
    if (by.length === 1) only.get(by[0]).push(f);
    else if (by.length === 0) unattributed.push(f);
    else shared.push(f);
  }
  let rows = 0;
  for (const line of plan) {
    const fs = only.get(line.id);
    const set = new Set(fs.map((f) => f.path));
    const saved = fs.length ? without((p) => set.has(p)) : 0;
    rows += saved ?? 0;
    record('marginal', {
      part: line.id,
      job: line.job,
      units_reached: reach.get(line.id).size,
      units_only_this_line: new Set(fs.map((f) => unitKey(f.path, profiles))).size,
      raw_bytes: sum(fs),
      archive_bytes_saved: saved,
    });
  }
  // Lines that share units leave together or not at all: for every set of
  // lines that some units are reached by exactly, the units reached only from
  // inside that set, and what the family loses without them.
  const sets = [...new Set(shared.map((f) => reachedBy.get(unitKey(f.path, profiles)).join(' + ')))];
  const insideSet = new Map();
  for (const key of sets) {
    const members = new Set(key.split(' + '));
    const fs = kept.filter((f) => {
      const by = reachedBy.get(unitKey(f.path, profiles));
      return by.length > 0 && by.every((id) => members.has(id));
    });
    insideSet.set(key, fs);
    const set = new Set(fs.map((f) => f.path));
    record('marginal-set', {
      lines: key,
      jobs: [...new Set(plan.filter((l) => members.has(l.id)).map((l) => l.job))],
      raw_bytes: sum(fs),
      archive_bytes_saved: without((p) => set.has(p)),
    });
  }
  const sharedSet = new Set(shared.map((f) => f.path));
  const unSet = new Set(unattributed.map((f) => f.path));
  const sharedSaved = shared.length ? without((p) => sharedSet.has(p)) : 0;
  const unSaved = unattributed.length ? without((p) => unSet.has(p)) : 0;
  const cargoOnly = archiveBytes(allT, []);
  const groups = new Map();
  for (const f of shared) {
    const key = reachedBy.get(unitKey(f.path, profiles)).join(' + ');
    groups.set(key, (groups.get(key) ?? 0) + f.bytes);
  }
  record('remainder', {
    family_archive_bytes: whole,
    rows_archive_bytes: rows,
    shared_units_archive_bytes_alone: sharedSaved,
    shared_raw_bytes: sum(shared),
    shared_groups_raw_bytes: Object.fromEntries([...groups].sort((a, b) => b[1] - a[1])),
    unattributed_units_archive_bytes: unSaved,
    unattributed_raw_bytes: sum(unattributed),
    cargo_home_archive_bytes: whole === null || cargoOnly === null ? null : whole - cargoOnly,
    // What no single removal accounts for: compression across parts.
    residual_archive_bytes:
      whole === null || cargoOnly === null
        ? null
        : whole - rows - (sharedSaved ?? 0) - (unSaved ?? 0) - (whole - cargoOnly),
  });

  // Prices, on the tree rust-cache would save: delete what its cleanup deletes,
  // then each line warm (the workspace crates compile, as on a pull request) and
  // with its own units gone, cleaning again between runs.
  const keptSet = new Set(allT);
  const clean = () => {
    for (const f of walk(join(root, 'target'), root))
      if (!keptSet.has(f.path) && !f.path.endsWith('CACHEDIR.TAG')) rmSync(join(root, f.path), { force: true });
  };
  for (const line of plan) {
    clean();
    const warm = timed(line.command);
    clean();
    for (const f of only.get(line.id)) rmSync(join(root, f.path), { force: true });
    const dropped = timed(line.command);
    record('price', {
      line: line.id,
      job: line.job,
      warm_seconds: warm.seconds,
      without_own_units_seconds: dropped.seconds,
      added_seconds: dropped.seconds - warm.seconds,
      cold_in_plan_order_seconds: cold.get(line.id),
      status: [warm.status, dropped.status],
    });
  }
  for (const [key, fs] of insideSet) {
    const members = plan.filter((l) => key.split(' + ').includes(l.id));
    const script = members.map((l) => l.command).join(' && ');
    clean();
    const warm = timed(script);
    clean();
    for (const f of fs) rmSync(join(root, f.path), { force: true });
    const dropped = timed(script);
    record('price-set', {
      lines: key,
      jobs: [...new Set(members.map((l) => l.job))],
      warm_seconds: warm.seconds,
      without_set_units_seconds: dropped.seconds,
      added_seconds: dropped.seconds - warm.seconds,
      status: [warm.status, dropped.status],
    });
  }
  // The whole family gone: every line cold in plan order, as above, against
  // every line warm.
  clean();
  const allWarm = timed(`bash scripts/ci-warm.sh ${os}`);
  record('price', {
    line: '(whole family)',
    warm_seconds: allWarm.seconds,
    cold_seconds: [...cold.values()].reduce((a, b) => a + b, 0),
    status: [allWarm.status],
  });
}

// ---- driver ------------------------------------------------------------------

function gh(args) {
  const res = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (res.status !== 0) {
    console.error(`gh ${args.join(' ')} failed: ${res.stderr}`);
    console.error(`ACTION: check 'gh auth status' and that this branch's draft has a ${WORKFLOW} run`);
    process.exit(1);
  }
  return res.stdout;
}

function drive(platform, { rerun }) {
  const branch = spawnSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).stdout.trim();
  const runs = JSON.parse(gh(['run', 'list', '-R', REPO, '-w', WORKFLOW, '-b', branch, '-L', '1', '--json', 'databaseId']));
  if (!runs.length) {
    console.error(`coverage-spike: no ${WORKFLOW} run on ${branch}`);
    console.error(`ACTION: publish this branch as a draft; its push is ${WORKFLOW}'s only trigger`);
    process.exit(1);
  }
  const run = String(runs[0].databaseId);
  const jobName = `price (${platform})`;
  let job = JSON.parse(gh(['run', 'view', run, '-R', REPO, '--json', 'jobs'])).jobs.find((j) => j.name === jobName);
  if (!job) {
    console.error(`run ${run} has no job '${jobName}'`);
    console.error(`ACTION: add ${platform} to ${WORKFLOW}'s matrix and push the draft`);
    process.exit(1);
  }
  if (rerun) gh(['run', 'rerun', run, '-R', REPO, '--job', String(job.databaseId)]);
  spawnSync('gh', ['run', 'watch', run, '-R', REPO, '--interval', '120', '--exit-status'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  job = JSON.parse(gh(['run', 'view', run, '-R', REPO, '--json', 'jobs'])).jobs.find((j) => j.name === jobName);
  const log = gh(['api', `repos/${REPO}/actions/jobs/${job.databaseId}/logs`]);
  for (const text of log.split('\n')) {
    const at = text.indexOf('CACHE-PRICE {');
    if (at >= 0) console.log(text.slice(at));
  }
  console.log(`run ${run}, job ${job.databaseId}, ${job.conclusion}`);
  process.exit(job.conclusion === 'success' ? 0 : 1);
}

const args = process.argv.slice(2);
try {
  if (args[0] === '--listed' && args.length === 1) listed();
  else if (args[0] === '--price' && args.length === 1) price();
  else if (OSES.includes(args[0]) && (args.length === 1 || (args.length === 2 && args[1] === '--no-rerun')))
    drive(args[0], { rerun: args[1] !== '--no-rerun' });
  else {
    console.error(`cache-price: usage: cache-price.mjs ${OSES.join('|')} [--no-rerun] | --listed | --price`);
    console.error('ACTION: name the OS leg to price');
    process.exit(2);
  }
} catch (error) {
  console.error(`cache-price: ${error.message}`);
  console.error('ACTION: fix the phase named above; its output precedes this line');
  process.exit(1);
}
