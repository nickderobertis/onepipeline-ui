#!/usr/bin/env node
// SPIKE HARNESS — throwaway, never landed. Measures whether the crate's
// instrumented test tiers can each leave a coverage output Nx can cache, and
// whether a merge of those outputs holds the same 95% floor `_crate-coverage`
// holds today (spike-onepipeline-ui-coverage-and-cache of the plan
// coverage-cache-and-trim-2026-11-08).
//
// One command performs one measurement; every result is one line on stdout,
// `COVERAGE-SPIKE <json>`, and the files behind it land under --out (default
// target/coverage-spike/<measurement>):
//
//   node scripts/coverage-spike.mjs shapes       today's merge against shape (a)
//                                                 per-tier LCOV and shape (b)
//                                                 per-tier .profdata, one commit:
//                                                 totals, per-file differences,
//                                                 seconds and output bytes
//   node scripts/coverage-spike.mjs determinism  the instrumented suite twice on
//                                                 one commit, every line whose
//                                                 covered status differs
//   node scripts/coverage-spike.mjs cache-hit    real Nx over a scratch clone with
//                                                 the tiers made cacheable: a run
//                                                 with cached tiers beside a run
//                                                 with none, for a tier-own change
//                                                 and for a version-only change
//   node scripts/coverage-spike.mjs reuse        the last 30 merged pull requests:
//                                                 which tiers the proposed inputs
//                                                 leave unaffected
//
// Internal verbs the cache-hit prototype's Nx targets call:
//   node scripts/coverage-spike.mjs export <profile> after a tier's tests, leave
//                                                    its LCOV and .profdata
//   node scripts/coverage-spike.mjs merge-a|merge-b  merge every tier's output and
//                                                    hold it to 95%
//
// Exit 0: the measurement ran (a disagreement is a finding, not a failure).
// 1: a step failed (its output is above). 2: usage.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
process.chdir(ROOT);
const COV = join(ROOT, 'target', 'llvm-cov-target');
const FLOOR = 95;
// The five instrumented tiers `onepipeline-ui-coverage:coverage` depends on.
const TIERS = [
  ['onepipeline-ui', 'unit'],
  ['onepipeline-ui-e2e', 'e2e'],
  ['onepipeline-ui-repo-tooling', 'repo-tooling'],
  ['onepipeline-ui-npm-launcher', 'npm-launcher'],
  ['onepipeline-ui-versions', 'versions'],
];

function usage(message) {
  console.error(`coverage-spike: ${message}`);
  console.error(
    'ACTION: run node scripts/coverage-spike.mjs shapes|determinism|cache-hit|reuse [--out DIR]',
  );
  process.exit(2);
}

function record(kind, fields) {
  console.log(`COVERAGE-SPIKE ${JSON.stringify({ kind, ...fields })}`);
}

function fail(message, action) {
  console.error(`coverage-spike: ${message}`);
  console.error(`ACTION: ${action}`);
  process.exit(1);
}

// run COMMAND ARGS: inherit output, time it, fail on a non-zero status.
function run(cmd, args, opts = {}) {
  const started = process.hrtime.bigint();
  const res = spawnSync(cmd, args, {
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  if (res.status !== 0 && !opts.allowFail)
    fail(
      `${cmd} ${args.join(' ')} exited ${res.status ?? res.signal}${opts.capture ? `\n${res.stderr}` : ''}`,
      `reproduce with '${cmd} ${args.join(' ')}' and fix what it reports`,
    );
  return {
    seconds: Math.round(seconds * 10) / 10,
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

const sysroot = () =>
  execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim();
const host = () =>
  /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))[1];
const exe = process.platform === 'win32' ? '.exe' : '';
function llvmTool(name) {
  const path = join(sysroot(), 'lib', 'rustlib', host(), 'bin', name + exe);
  if (!existsSync(path))
    fail(`${path} is missing`, 'rustup component add llvm-tools');
  return path;
}

const bytes = (path) => (existsSync(path) ? statSync(path).size : 0);
const profraws = (tier) =>
  existsSync(COV)
    ? readdirSync(COV)
        .filter((f) => f.startsWith(`${tier}-`) && f.endsWith('.profraw'))
        .map((f) => join(COV, f))
    : [];

// The llvm-cov invocation `cargo llvm-cov report` makes, read from its -v
// output, so a per-tier export reads exactly the objects and filters today's
// report reads. Returns { objects: [...], flags: [...] } — everything after the
// subcommand but the format, profile and output.
function reportInvocation() {
  const res = run(
    'cargo',
    ['llvm-cov', 'report', '--locked', '-v', '--summary-only', '--json'],
    { capture: true },
  );
  const lines = res.stderr.split('\n').filter((l) => /llvm-cov\S*["`']? (export|report)/.test(l));
  if (!lines.length)
    fail(
      `cargo llvm-cov report -v printed no llvm-cov command:\n${res.stderr}`,
      'check the cargo-llvm-cov version against .github/ci-tool-versions',
    );
  const argv = splitCommand(lines.at(-1).replace(/^.*?Running `/, '').replace(/`\s*$/, ''));
  const sub = argv.findIndex((a) => a === 'export' || a === 'report');
  const rest = argv.slice(sub + 1);
  const keep = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-instr-profile' || a === '-format' || a === '-o') {
      i++;
      continue;
    }
    if (/^-(instr-profile|format|summary-only)/.test(a) || a === '-summary-only') continue;
    keep.push(a);
  }
  return keep;
}

// A POSIX-ish split of the one-line command cargo-llvm-cov prints.
function splitCommand(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let any = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = '';
      any = false;
    } else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

// Profiles -> one .profdata, as cargo-llvm-cov merges them.
function mergeProfdata(inputs, out) {
  mkdirSync(join(out, '..'), { recursive: true });
  return run(llvmTool('llvm-profdata'), ['merge', '-sparse', ...inputs, '-o', out]).seconds;
}

function exportLcov(profdata, invocation, out) {
  const res = run(
    llvmTool('llvm-cov'),
    ['export', '-format=lcov', `-instr-profile=${profdata}`, ...invocation],
    { capture: true },
  );
  // Repository-relative source paths, so a report cached on one machine merges
  // with one made on another checkout path.
  const prefix = ROOT.replaceAll('\\', '/') + '/';
  writeFileSync(
    out,
    res.stdout
      .split('\n')
      .map((l) => (l.startsWith('SF:') && l.slice(3).replaceAll('\\', '/').startsWith(prefix) ? `SF:${l.slice(3 + prefix.length)}` : l))
      .join('\n'),
  );
  return res.seconds;
}

// llvm-cov's own summary — the basis `--fail-under-lines` holds — from an
// `export -format=text -summary-only` document: every file's lines and covered.
function gateBasis(jsonText) {
  const data = JSON.parse(jsonText).data[0];
  const perFile = {};
  for (const f of data.files)
    perFile[relative(f.filename.replaceAll('\\', '/'))] = {
      lines: f.summary.lines.count,
      covered: f.summary.lines.covered,
    };
  const t = data.totals.lines;
  return { lines: t.count, covered: t.covered, percent: Math.round((t.covered / t.count) * 1e6) / 1e4, perFile };
}

function exportSummary(profdata, invocation) {
  return gateBasis(
    run(llvmTool('llvm-cov'), ['export', '-format=text', '-summary-only', `-instr-profile=${profdata}`, ...invocation], {
      capture: true,
    }).stdout,
  );
}

// LCOV -> Map(file -> Map(line -> hits)).
function readLcov(text) {
  const files = new Map();
  let lines = null;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('SF:')) {
      const sf = raw.slice(3).replaceAll('\\', '/');
      lines = files.get(sf) ?? new Map();
      files.set(sf, lines);
    } else if (raw.startsWith('DA:') && lines) {
      const [line, hits] = raw.slice(3).split(',');
      lines.set(Number(line), (lines.get(Number(line)) ?? 0) + Number(hits));
    } else if (raw === 'end_of_record') lines = null;
  }
  return files;
}

// Shape (a)'s merge: a line is instrumented if any report lists it and covered
// if any report's hits for it are non-zero; hits add.
function mergeLcov(texts) {
  const merged = new Map();
  for (const text of texts)
    for (const [file, lines] of readLcov(text)) {
      const into = merged.get(file) ?? new Map();
      merged.set(file, into);
      for (const [line, hits] of lines) into.set(line, (into.get(line) ?? 0) + hits);
    }
  return merged;
}

function totals(files) {
  const perFile = {};
  let total = 0;
  let covered = 0;
  for (const [file, lines] of files) {
    const t = lines.size;
    let c = 0;
    for (const hits of lines.values()) if (hits > 0) c++;
    perFile[relative(file)] = { lines: t, covered: c };
    total += t;
    covered += c;
  }
  return {
    lines: total,
    covered,
    percent: total ? Math.round((covered / total) * 1e6) / 1e4 : 0,
    perFile,
  };
}

const relative = (file) =>
  file.startsWith(ROOT.replaceAll('\\', '/') + '/')
    ? file.slice(ROOT.length + 1)
    : file.replace(/^.*?\/(src|tests|build\.rs)/, '$1');

// Every file whose line count or covered count differs between two totals.
function differences(a, b) {
  const out = [];
  for (const file of new Set([...Object.keys(a.perFile), ...Object.keys(b.perFile)])) {
    const x = a.perFile[file] ?? { lines: 0, covered: 0 };
    const y = b.perFile[file] ?? { lines: 0, covered: 0 };
    if (x.lines !== y.lines || x.covered !== y.covered)
      out.push({ file, base: x, other: y });
  }
  return out.sort((p, q) => p.file.localeCompare(q.file));
}

// Every line whose covered status differs between two merged LCOV maps.
function lineDifferences(a, b) {
  const out = [];
  for (const file of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(file) ?? new Map();
    const y = b.get(file) ?? new Map();
    for (const line of new Set([...x.keys(), ...y.keys()])) {
      const cx = x.has(line) ? (x.get(line) > 0 ? 'covered' : 'missed') : 'absent';
      const cy = y.has(line) ? (y.get(line) > 0 ? 'covered' : 'missed') : 'absent';
      if (cx !== cy) out.push({ file: relative(file), line, first: cx, second: cy });
    }
  }
  return out.sort((p, q) => p.file.localeCompare(q.file) || p.line - q.line);
}

const summary = (t) => ({
  lines: t.lines,
  covered: t.covered,
  percent: t.percent,
  floor: t.percent >= FLOOR ? 'pass' : 'fail',
});

function tierTest(tier) {
  return run('just', ['_tier-test-covered', tier]).seconds;
}

// The instrumented build every tier shares, as ci-warm.sh spells it: a filter
// matching no test, so the tier timings below are test time alone.
function buildInstrumented() {
  return run('cargo', [
    'llvm-cov',
    'nextest',
    '--locked',
    '--no-report',
    '-E',
    'none()',
    '--no-tests=pass',
  ]).seconds;
}

function todayReport(out) {
  // Exactly `_crate-coverage`, timed; then the same merge written as LCOV.
  const gate = run('just', ['_crate-coverage'], { allowFail: true, capture: true });
  process.stdout.write(gate.stdout.split('\n').filter((l) => l.startsWith('TOTAL')).join('\n') + '\n');
  // TOTAL  regions missed cover  functions missed executed  lines missed cover ...
  const total = gate.stdout.split('\n').find((l) => l.startsWith('TOTAL'))?.trim().split(/\s+/) ?? [];
  run('cargo', ['llvm-cov', 'report', '--locked', '--lcov', '--output-path', out]);
  const summaryPath = out.replace(/\.lcov$/, '-summary.json');
  run('cargo', ['llvm-cov', 'report', '--locked', '--json', '--summary-only', '--output-path', summaryPath]);
  return {
    gate_basis: gateBasis(readFileSync(summaryPath, 'utf8')),
    seconds: gate.seconds,
    status: gate.status,
    text_total: total.length >= 10 ? { lines: Number(total[7]), missed: Number(total[8]), cover: total[9] } : null,
  };
}

// One full sweep of today's tiers, then today's report and both shapes' outputs
// derived from the same profiles, so all three read one set of runs.
function sweep(out, { label, time = true }) {
  mkdirSync(out, { recursive: true });
  rmSync(join(out, 'a'), { recursive: true, force: true });
  rmSync(join(out, 'b'), { recursive: true, force: true });
  mkdirSync(join(out, 'a'), { recursive: true });
  mkdirSync(join(out, 'b'), { recursive: true });
  const build = buildInstrumented();
  record('build', { label, seconds: build });
  const tiers = {};
  for (const [project, tier] of TIERS) {
    const seconds = tierTest(tier);
    const raw = profraws(tier);
    tiers[tier] = {
      project,
      test_seconds: seconds,
      profraw_files: raw.length,
      profraw_bytes: raw.reduce((s, f) => s + bytes(f), 0),
    };
  }
  const invocation = reportInvocation();
  for (const [, tier] of TIERS) {
    const profdata = join(out, 'b', `${tier}.profdata`);
    const merge = mergeProfdata(profraws(tier), profdata);
    const lcov = join(out, 'a', `${tier}.lcov`);
    const exp = exportLcov(profdata, invocation, lcov);
    Object.assign(tiers[tier], {
      shape_b_extra_seconds: merge,
      shape_b_output_bytes: bytes(profdata),
      shape_a_extra_seconds: Math.round((merge + exp) * 10) / 10,
      shape_a_output_bytes: bytes(lcov),
    });
    record('tier', { label, tier, ...tiers[tier] });
  }
  const today = todayReport(join(out, 'today.lcov'));
  const todayTotals = totals(readLcov(readFileSync(join(out, 'today.lcov'), 'utf8')));
  record('today', {
    label,
    gate_seconds: today.seconds,
    gate_status: today.status,
    gate_text_total: today.text_total,
    gate_basis: summary(today.gate_basis),
    lcov_basis: summary(todayTotals),
  });

  // Shape (a): merge the five LCOV files.
  let started = process.hrtime.bigint();
  const aFiles = mergeLcov(TIERS.map(([, t]) => readFileSync(join(out, 'a', `${t}.lcov`), 'utf8')));
  const aTotals = totals(aFiles);
  const aSeconds = Number(process.hrtime.bigint() - started) / 1e9;
  writeLcov(aFiles, join(out, 'a-merged.lcov'));
  // Shape (b): merge the five .profdata files and export once over the objects.
  started = process.hrtime.bigint();
  const merged = join(out, 'b-merged.profdata');
  mergeProfdata(TIERS.map(([, t]) => join(out, 'b', `${t}.profdata`)), merged);
  exportLcov(merged, invocation, join(out, 'b-merged.lcov'));
  const bSeconds = Number(process.hrtime.bigint() - started) / 1e9;
  const bTotals = totals(readLcov(readFileSync(join(out, 'b-merged.lcov'), 'utf8')));
  const bGate = exportSummary(merged, invocation);
  // Shape (a) carries lines alone: llvm-cov's summary counts each function's
  // lines (a closure's lines in it and in the function around it, an
  // instantiation group at its best instantiation), which no line file holds.
  record('shape', { label, shape: 'a', merge_seconds: round(aSeconds), gate_basis: null, lcov_basis: summary(aTotals) });
  record('shape', { label, shape: 'b', merge_seconds: round(bSeconds), gate_basis: summary(bGate), lcov_basis: summary(bTotals) });
  for (const [shape, t] of [['a', aTotals], ['b', bTotals]])
    record('differences', { label, basis: 'lcov', base: 'today', shape, files: differences(todayTotals, t) });
  record('differences', { label, basis: 'gate', base: 'today', shape: 'b', files: differences(today.gate_basis, bGate) });
  record('differences', {
    label,
    basis: 'gate against lcov',
    base: 'today gate',
    shape: 'today lcov',
    files: differences(today.gate_basis, todayTotals),
  });
  writeFileSync(
    join(out, 'totals.json'),
    JSON.stringify({ label, build, tiers, today: todayTotals, todayGate: today.gate_basis, a: aTotals, b: bTotals, bGate }, null, 1),
  );
  return { todayTotals, todayGate: today.gate_basis, aTotals, bTotals, bGate, aFiles, tiers, time };
}

const round = (n) => Math.round(n * 10) / 10;

function writeLcov(files, out) {
  let text = '';
  for (const [file, lines] of files) {
    text += `SF:${file}\n`;
    let hit = 0;
    for (const [line, hits] of [...lines].sort((p, q) => p[0] - q[0])) {
      text += `DA:${line},${hits}\n`;
      if (hits > 0) hit++;
    }
    text += `LF:${lines.size}\nLH:${hit}\nend_of_record\n`;
  }
  writeFileSync(out, text);
}

function head() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function measureShapes(out) {
  record('commit', { measurement: 'shapes', commit: head(), platform: process.platform });
  sweep(out, { label: 'shapes' });
}

function measureDeterminism(out) {
  record('commit', { measurement: 'determinism', commit: head(), platform: process.platform });
  const first = sweep(join(out, 'first'), { label: 'first' });
  const second = sweep(join(out, 'second'), { label: 'second' });
  const todayFirst = readLcov(readFileSync(join(out, 'first', 'today.lcov'), 'utf8'));
  const todaySecond = readLcov(readFileSync(join(out, 'second', 'today.lcov'), 'utf8'));
  const lines = lineDifferences(todayFirst, todaySecond);
  writeFileSync(join(out, 'line-differences.json'), JSON.stringify(lines, null, 1));
  record('determinism', {
    first: summary(first.todayTotals),
    second: summary(second.todayTotals),
    percent_moved: round((second.todayTotals.percent - first.todayTotals.percent) * 1e4) / 1e4,
    floor_changed: summary(first.todayTotals).floor !== summary(second.todayTotals).floor,
    lines_differing: lines.length,
    lines,
  });
  // Per tier too: which tier's own report moves, under the chosen shape.
  for (const [, tier] of TIERS) {
    const a = readLcov(readFileSync(join(out, 'first', 'a', `${tier}.lcov`), 'utf8'));
    const b = readLcov(readFileSync(join(out, 'second', 'a', `${tier}.lcov`), 'utf8'));
    const diff = lineDifferences(a, b);
    record('determinism-tier', { tier, lines_differing: diff.length, lines: diff.slice(0, 50) });
  }
}

// ---- the Nx prototype -------------------------------------------------------

// `export <profile>`: the line the prototype appends to `_tier-test-covered`,
// after the tier's tests: this tier's own profiles merged and exported, leaving
// target/coverage-tiers/<tier>.lcov (shape a) and .profdata (shape b), the
// prototype target's only outputs.
function exportVerb(tier) {
  if (!TIERS.some(([, t]) => t === tier)) usage(`'${tier}' is not an instrumented tier`);
  const out = join(ROOT, 'target', 'coverage-tiers');
  mkdirSync(out, { recursive: true });
  rmSync(join(out, `${tier}.lcov`), { force: true });
  rmSync(join(out, `${tier}.profdata`), { force: true });
  const profdata = join(out, `${tier}.profdata`);
  const merge = mergeProfdata(profraws(tier), profdata);
  const exp = exportLcov(profdata, reportInvocation(), join(out, `${tier}.lcov`));
  record('tier', {
    tier,
    export_seconds: round(merge + exp),
    lcov_bytes: bytes(join(out, `${tier}.lcov`)),
    profdata_bytes: bytes(profdata),
  });
}

// `merge-a`: shape (a)'s combined step — the five LCOV files only, no build.
function mergeAVerb() {
  const out = join(ROOT, 'target', 'coverage-tiers');
  const missing = TIERS.filter(([, t]) => !existsSync(join(out, `${t}.lcov`))).map(([, t]) => t);
  if (missing.length)
    fail(`no LCOV for ${missing.join(', ')}`, 'run every tier first; the combined step depends on each');
  const t = totals(mergeLcov(TIERS.map(([, x]) => readFileSync(join(out, `${x}.lcov`), 'utf8'))));
  writeFileSync(join(out, 'merged-a.json'), JSON.stringify(t, null, 1));
  record('merged', { shape: 'a', ...summary(t) });
  if (t.percent < FLOOR) process.exit(1);
}

// `merge-b`: shape (b)'s combined step — build the instrumented objects
// (uncached), merge the five .profdata files and report over those objects.
function mergeBVerb() {
  const out = join(ROOT, 'target', 'coverage-tiers');
  const build = buildInstrumented();
  const merged = join(out, 'merged-b.profdata');
  mergeProfdata(TIERS.map(([, x]) => join(out, `${x}.profdata`)), merged);
  // reportInvocation reads the profiles in target/llvm-cov-target, which a
  // replayed tier never wrote; give it one empty run's worth if there is none.
  const inv = reportInvocationFromObjects();
  exportLcov(merged, inv, join(out, 'merged-b.lcov'));
  const t = totals(readLcov(readFileSync(join(out, 'merged-b.lcov'), 'utf8')));
  const g = exportSummary(merged, inv);
  writeFileSync(join(out, 'merged-b.json'), JSON.stringify(t, null, 1));
  writeFileSync(join(out, 'merged-b-gate.json'), JSON.stringify(g, null, 1));
  record('merged', { shape: 'b', build_seconds: build, ...summary(t), gate_basis: summary(g) });
  if (g.percent < FLOOR) process.exit(1);
}

// The objects cargo-llvm-cov would read, without needing any profile on disk:
// write a placeholder profile for one run of a test matching nothing if none
// exists, then read the invocation, then drop the placeholder.
function reportInvocationFromObjects() {
  const any = existsSync(COV) && readdirSync(COV).some((f) => f.endsWith('.profraw'));
  if (any) return reportInvocation();
  run('cargo', ['llvm-cov', 'nextest', '--locked', '--no-report', '-E', 'none()', '--no-tests=pass'], {
    env: { LLVM_PROFILE_FILE_NAME: 'placeholder-%p-%m.profraw' },
  });
  // nextest with no test runs no binary, so no profile: run one binary's --list.
  const deps = join(COV, 'debug', 'deps');
  const bin = readdirSync(deps).find((f) => f.startsWith('contract-') && !f.includes('.'));
  run(join(deps, bin), ['--list'], {
    capture: true,
    env: { LLVM_PROFILE_FILE: join(COV, 'placeholder-%p-%m.profraw') },
  });
  const inv = reportInvocation();
  for (const f of readdirSync(COV)) if (f.startsWith('placeholder-')) rmSync(join(COV, f));
  return inv;
}

// The prototype's project configuration, applied to a scratch clone: each tier's
// `test` becomes cacheable with its own two coverage files as its only outputs,
// keyed on today's inputs plus this harness; the aggregate gets one target per
// shape, uncached, depending on every tier.
function prototype(clone) {
  for (const [project] of TIERS) {
    const path = projectJson(clone, project);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    const t = json.targets.test;
    const tier = TIERS.find(([p]) => p === project)[1];
    t.cache = true;
    // The command stays `just _tier-test-covered <tier>` (the repository's own
    // tests hold it there); the recipe exports.
    t.outputs = [
      `{workspaceRoot}/target/coverage-tiers/${tier}.lcov`,
      `{workspaceRoot}/target/coverage-tiers/${tier}.profdata`,
    ];
    t.inputs = [...t.inputs, '{workspaceRoot}/scripts/coverage-spike.mjs'];
    // dependsOn stays (the repository's tests hold it); the sweep excludes task
    // dependencies, because the clone is provisioned by hand.
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  }
  const covPath = join(clone, 'tests', 'tiers', 'coverage', 'project.json');
  const cov = JSON.parse(readFileSync(covPath, 'utf8'));
  for (const shape of ['a', 'b'])
    cov.targets[`coverage-${shape}`] = {
      cache: false,
      command: `node scripts/coverage-spike.mjs merge-${shape}`,
      dependsOn: TIERS.map(([projects]) => ({ projects: [projects], target: 'test' })),
    };
  writeFileSync(covPath, JSON.stringify(cov, null, 2) + '\n');
  const justfile = join(clone, 'justfile');
  const text = readFileSync(justfile, 'utf8');
  const recipe = `      || { echo "the $1 tier failed — the failing tests are listed above" >&2; exit 1; }\n`;
  if (!text.includes(recipe)) fail('the justfile no longer has the _tier-test-covered body this prototype extends', 'update prototype()');
  writeFileSync(justfile, text.replace(recipe, `${recipe}    @node scripts/coverage-spike.mjs export "$1"\n`));
}

function projectJson(clone, project) {
  const map = {
    'onepipeline-ui': 'project.json',
    'onepipeline-ui-e2e': 'tests/tiers/e2e/project.json',
    'onepipeline-ui-repo-tooling': 'tests/tiers/repo-tooling/project.json',
    'onepipeline-ui-npm-launcher': 'tests/tiers/npm-launcher/project.json',
    'onepipeline-ui-versions': 'tests/tiers/versions/project.json',
  };
  return join(clone, map[project]);
}

function nxEnv(cacheDir) {
  const env = {
    NX_CACHE_DIRECTORY: cacheDir,
    NX_DAEMON: 'false',
    NX_NO_CLOUD: 'true',
    NX_SKIP_NX_CACHE: '',
    NX_TUI: 'false',
    // Never the CI recording proxy: this harness writes no remote cache.
    NX_SELF_HOSTED_REMOTE_CACHE_SERVER: '',
    NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: '',
    GITHUB_ACTIONS: '',
  };
  return env;
}

// One Nx sweep of the five tiers and one shape's aggregate in the clone, reading
// which tasks Nx replayed from its terminal output.
function nxSweep(clone, cacheDir, { label, skipCache = false }) {
  // A fresh runner: no tier output left from an earlier run, so anything not
  // run is restored from the cache rather than left in place; and, as after
  // rust-cache's restore, no build of the workspace crate itself, so the
  // objects a report reads are this commit's alone.
  rmSync(join(clone, 'target', 'coverage-tiers'), { recursive: true, force: true });
  run('cargo', ['clean', '--quiet', '-p', 'onepipeline-ui', '--target-dir', 'target/llvm-cov-target'], {
    cwd: clone,
    allowFail: true,
  });
  for (const f of existsSync(join(clone, 'target', 'llvm-cov-target'))
    ? readdirSync(join(clone, 'target', 'llvm-cov-target'))
    : [])
    if (f.endsWith('.profraw')) rmSync(join(clone, 'target', 'llvm-cov-target', f));
  const args = [
    'nx',
    'run-many',
    '-t',
    'test',
    '-p',
    TIERS.map(([p]) => p).join(','),
    '--parallel=1',
    '--outputStyle=static',
    '--excludeTaskDependencies',
  ];
  if (skipCache) args.push('--skip-nx-cache');
  // A tier failing here is recorded with the tests that failed, and the sweep
  // run again, up to three attempts: a task that passed is then replayed from
  // the cache in a cached sweep, which the record of the retry says.
  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = run('npx', args, { cwd: clone, env: nxEnv(cacheDir), capture: true, allowFail: attempt < 3 });
    if (res.status === 0) break;
    const plain = res.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    record('nx-sweep-retry', {
      label,
      attempt,
      failed_tasks: [...plain.matchAll(/^- (\S+:test)\s*$/gm)].map((m) => m[1]),
      failed_tests: [...new Set([...plain.matchAll(/^\s+FAIL \[[^\]]*\] \([^)]*\) (\S+ \S+)/gm)].map((m) => m[1]))],
    });
  }
  process.stdout.write(res.stdout.split('\n').filter((l) => /COVERAGE-SPIKE|local cache|Nx read the output|Successfully ran|nx run /.test(l)).join('\n') + '\n');
  const replayed = TIERS.filter(([p]) =>
    new RegExp(`nx run ${p}:test\\s+\\[(local cache|existing outputs match the cache)`).test(res.stdout),
  ).map(([, t]) => t);
  const ran = TIERS.map(([, t]) => t).filter((t) => !replayed.includes(t));
  const tierRecords = res.stdout
    .split('\n')
    .filter((l) => l.startsWith('COVERAGE-SPIKE '))
    .map((l) => JSON.parse(l.slice(15)))
    .filter((r) => r.kind === 'tier');
  const results = {};
  for (const shape of ['a', 'b']) {
    const m = run(
      'npx',
      ['nx', 'run', `onepipeline-ui-coverage:coverage-${shape}`, '--excludeTaskDependencies', '--outputStyle=static'],
      { cwd: clone, env: nxEnv(cacheDir), capture: true, allowFail: true },
    );
    const line = m.stdout.split('\n').find((l) => l.startsWith('COVERAGE-SPIKE ') && l.includes('"merged"'));
    const merged = line ? JSON.parse(line.slice(15)) : { error: m.stdout.slice(-2000) + m.stderr.slice(-2000) };
    const read = (name) => {
      const path = join(clone, 'target', 'coverage-tiers', name);
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    };
    results[shape] = {
      merged,
      perFile: read(`merged-${shape}.json`),
      gate: shape === 'b' ? read('merged-b-gate.json') : null,
      seconds: m.seconds,
      status: m.status,
    };
  }
  const outputs = {};
  for (const [, t] of TIERS)
    outputs[t] = {
      lcov_bytes: bytes(join(clone, 'target', 'coverage-tiers', `${t}.lcov`)),
      profdata_bytes: bytes(join(clone, 'target', 'coverage-tiers', `${t}.profdata`)),
    };
  results.replayed = replayed;
  record('nx-sweep', {
    label,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone, encoding: 'utf8' }).trim(),
    skip_cache: skipCache,
    seconds: res.seconds,
    replayed,
    ran,
    tiers: tierRecords,
    outputs,
    a: results.a.merged,
    b: results.b.merged,
  });
  return results;
}

function git(clone, ...args) {
  return execFileSync('git', args, { cwd: clone, encoding: 'utf8' }).trim();
}

// Every function a .profdata names, with its structural hash.
function profileFunctions(profdata) {
  const text = run(llvmTool('llvm-profdata'), ['show', '--all-functions', profdata], { capture: true }).stdout;
  const out = new Map();
  let name = null;
  for (const line of text.split('\n')) {
    const fn = /^  (\S.*):$/.exec(line);
    if (fn) name = fn[1];
    const h = /^    Hash: (0x[0-9a-f]+)/.exec(line);
    if (h && name) out.set(name, h[1]);
  }
  return out;
}

// A legacy-mangled Rust symbol without its trailing `17h<hash>E`, which the
// crate's -C metadata — and so its version — decides.
const stripHash = (name) => name.replace(/17h[0-9a-f]{16}E$/, 'E');

// Shape (b) across a version-only change: the cached tiers' profiles name the
// old build's symbols. Rename each to the new build's symbol of the same
// unhashed name, where that name is one function on each side with one
// structural hash, and report what that recovers.
function remapCheck(out, { replayed, ranDir, freshDir, oldDir, invocation, coldGate }) {
  const fresh = new Map();
  for (const [, t] of TIERS) for (const [n, h] of profileFunctions(join(freshDir, `${t}.profdata`))) fresh.set(n, h);
  const byStripNew = new Map();
  for (const [n, h] of fresh) {
    const k = stripHash(n);
    byStripNew.set(k, [...(byStripNew.get(k) ?? []), [n, h]]);
  }
  const lines = [];
  const stats = { old_functions: 0, renamed: 0, same_name: 0, ambiguous: 0, hash_changed: 0, absent: 0 };
  const inputs = [];
  for (const t of replayed) {
    const old = profileFunctions(join(oldDir, `${t}.profdata`));
    const byStripOld = new Map();
    for (const [n] of old) byStripOld.set(stripHash(n), (byStripOld.get(stripHash(n)) ?? 0) + 1);
    for (const [n, h] of old) {
      stats.old_functions++;
      if (fresh.has(n)) {
        stats.same_name++;
        continue;
      }
      const cands = byStripNew.get(stripHash(n)) ?? [];
      if (!cands.length) stats.absent++;
      else if (cands.length > 1 || byStripOld.get(stripHash(n)) > 1) stats.ambiguous++;
      else if (cands[0][1] !== h) stats.hash_changed++;
      else {
        stats.renamed++;
        lines.push(`${n} ${cands[0][0]}`);
      }
    }
  }
  const map = join(out, 'remap.txt');
  writeFileSync(map, [...new Set(lines)].join('\n') + '\n');
  for (const t of replayed) {
    const renamed = join(out, `remapped-${t}.profdata`);
    run(llvmTool('llvm-profdata'), ['merge', '-sparse', `--remapping-file=${map}`, join(oldDir, `${t}.profdata`), '-o', renamed]);
    inputs.push(renamed);
  }
  for (const [, t] of TIERS) if (!replayed.includes(t)) inputs.push(join(ranDir, `${t}.profdata`));
  const merged = join(out, 'remapped-merged.profdata');
  mergeProfdata(inputs, merged);
  const g = exportSummary(merged, invocation);
  const files = differences(coldGate, g);
  record('remap-check', { ...stats, remapped_gate: summary(g), no_cache_gate: summary(coldGate), agree: files.length === 0, files });
}

function measureCacheHit(out) {
  const commit = head();
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim())
    fail('the checkout has uncommitted changes', 'commit them: the scratch clone is cut from HEAD');
  record('commit', { measurement: 'cache-hit', commit, platform: process.platform });
  const clone = join(out, 'clone');
  const cacheDir = join(out, 'nx-cache');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  run('git', ['clone', '--quiet', '--shared', '--no-checkout', ROOT, clone]);
  git(clone, 'checkout', '--quiet', '--detach', commit);
  git(clone, 'config', 'user.email', 'spike@example.invalid');
  git(clone, 'config', 'user.name', 'coverage spike');
  // Provision the clone as the tiers' dependsOn would: workspace packages,
  // the sibling CLI and pinned node in .tools, and the built browser view.
  run('bash', ['scripts/workspace-install.sh'], { cwd: clone });
  cpSync(join(ROOT, '.tools'), join(clone, '.tools'), { recursive: true });
  cpSync(join(ROOT, 'apps', 'dag-ui', 'dist'), join(clone, 'apps', 'dag-ui', 'dist'), { recursive: true });
  // The instrumented build, copied so the clone does not compile from cold.
  if (existsSync(COV))
    cpSync(COV, join(clone, 'target', 'llvm-cov-target'), {
      recursive: true,
      filter: (src) => !src.endsWith('.profraw'),
    });
  prototype(clone);
  git(clone, 'commit', '--quiet', '-am', 'spike: cacheable tiers (prototype)');
  const c0 = git(clone, 'rev-parse', 'HEAD');

  // C0: populate the cache with every tier (no hit possible: the cache is empty).
  nxSweep(clone, cacheDir, { label: 'c0-populate' });
  const keep = (dir) => {
    mkdirSync(dir, { recursive: true });
    for (const [, t] of TIERS)
      cpSync(join(clone, 'target', 'coverage-tiers', `${t}.profdata`), join(dir, `${t}.profdata`));
  };
  keep(join(out, 'c0-profdata'));

  // C1: a change only repo-tooling's inputs read.
  const own = 'scripts/release-status.sh';
  writeFileSync(join(clone, own), readFileSync(join(clone, own), 'utf8') + '# spike: a tier-own change\n');
  git(clone, 'commit', '--quiet', '-am', 'spike: touch a file only repo-tooling reads');
  const hit1 = nxSweep(clone, cacheDir, { label: 'c1-cached' });
  const cold1 = nxSweep(clone, cacheDir, { label: 'c1-no-cache', skipCache: true });
  compare('c1', hit1, cold1);

  // C2: a version-only change, which the version-free inputs leave out of every
  // tier's key but npm-launcher's and versions'.
  git(clone, 'checkout', '--quiet', c0);
  run('cargo', ['set-version', '--bump', 'patch'], { cwd: clone, allowFail: true, capture: true });
  if (!git(clone, 'status', '--porcelain')) bumpVersionByHand(clone);
  run('cargo', ['update', '--workspace', '--offline'], { cwd: clone, capture: true });
  git(clone, 'commit', '--quiet', '-am', 'spike: version-only change');
  const hit2 = nxSweep(clone, cacheDir, { label: 'c2-cached' });
  keep(join(out, 'c2-cached-profdata'));
  const cold2 = nxSweep(clone, cacheDir, { label: 'c2-no-cache', skipCache: true });
  keep(join(out, 'c2-no-cache-profdata'));
  compare('c2', hit2, cold2);
  if (cold2.b.gate && hit2.replayed.length) {
    // Run in the clone, whose objects are the ones the version moved.
    writeFileSync(join(out, 'c2-no-cache-gate.json'), JSON.stringify(cold2.b.gate));
    const res = run(
      'node',
      ['scripts/coverage-spike.mjs', 'remap-check', '--out', out, '--replayed', hit2.replayed.join(',')],
      { cwd: clone, capture: true, allowFail: true },
    );
    process.stdout.write(res.stdout.split('\n').filter((l) => l.startsWith('COVERAGE-SPIKE ')).join('\n') + '\n');
    if (res.status !== 0) record('remap-check', { error: res.stderr.slice(-2000) });
  }
}

function bumpVersionByHand(clone) {
  const path = join(clone, 'Cargo.toml');
  const text = readFileSync(path, 'utf8');
  const next = text.replace(/^version = "(\d+)\.(\d+)\.(\d+)"/m, (_, a, b, c) => `version = "${a}.${b}.${Number(c) + 1}"`);
  if (next === text) fail('could not find the package version in Cargo.toml', 'check Cargo.toml');
  writeFileSync(path, next);
}

function compare(label, hit, cold) {
  for (const [shape, basis] of [
    ['a', 'perFile'],
    ['b', 'perFile'],
    ['b', 'gate'],
  ]) {
    const x = hit[shape][basis];
    const y = cold[shape][basis];
    if (!x || !y) {
      record('cache-hit-compare', { label, shape, basis: basis === 'gate' ? 'gate' : 'lcov', error: 'a merge wrote no totals' });
      continue;
    }
    const files = differences(y, x);
    record('cache-hit-compare', {
      label,
      shape,
      basis: basis === 'gate' ? 'gate' : 'lcov',
      cached: summaryOf(x),
      no_cache: summaryOf(y),
      agree: files.length === 0,
      files,
    });
  }
}
const summaryOf = (t) => ({ lines: t.lines, covered: t.covered, percent: t.percent });

// ---- reuse over real pull requests -----------------------------------------

// For each of the last 30 merged pull requests: which instrumented tiers the
// proposed inputs (each tier's `test` inputs today, plus this harness) leave
// unaffected, comparing the head its last test-linux run tested with the base
// that run's selection compared against (its nx-cache-entries-test-linux
// artifact's executions.json); and, from the same artifact, each tier's seconds
// in that run where it ran. A tier is unaffected when no changed file is one of
// its resolved input files (`nx show target inputs`, read at HEAD) and no runtime
// input it declares prints differently at head than at base.
const REPO = 'nickderobertis/onepipeline-ui';
function measureReuse(out) {
  mkdirSync(out, { recursive: true });
  const query = `query{repository(owner:"nickderobertis",name:"onepipeline-ui"){pullRequests(states:MERGED,first:45,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title mergedAt baseRefOid headRefOid mergeCommit{oid} commits(last:1){nodes{commit{checkSuites(first:10){nodes{workflowRun{databaseId workflow{name}}}}}}}}}}}`;
  const prs = JSON.parse(execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`], { encoding: 'utf8' }))
    .data.repository.pullRequests.nodes.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
    .slice(0, 30);
  const inputs = {};
  for (const [project, tier] of TIERS) {
    const res = run('npx', ['nx', 'show', 'target', 'inputs', `${project}:test`, '--json'], {
      capture: true,
      env: { NX_DAEMON: 'false' },
    });
    const json = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    inputs[tier] = { files: new Set([...json.files, 'scripts/coverage-spike.mjs']), runtime: json.runtime ?? [] };
  }
  const scratch = join(out, 'checkout');
  rmSync(scratch, { recursive: true, force: true });
  run('git', ['clone', '--quiet', '--shared', '--no-checkout', ROOT, scratch]);
  // Each pull request's own head, which squash merging leaves off main.
  run('git', [
    'fetch',
    '--quiet',
    `https://github.com/${REPO}.git`,
    ...prs.map((p) => `+refs/pull/${p.number}/head:refs/pr/${p.number}`),
  ], { cwd: scratch });
  const runtimeAt = new Map();
  const runtime = (commit, command) => {
    const key = `${commit} ${command}`;
    if (!runtimeAt.has(key)) {
      git(scratch, 'checkout', '--quiet', '--force', '--detach', commit);
      // The proposed inputs are today's: run today's script over that tree.
      const argv = splitCommand(command).map((a) =>
        a === 'scripts/nx-version-free-inputs.mjs' ? join(ROOT, a) : a,
      );
      const res = spawnSync(argv[0], argv.slice(1), { cwd: scratch, encoding: 'utf8' });
      runtimeAt.set(key, `${res.status}:${res.stdout}`);
    }
    return runtimeAt.get(key);
  };
  const rows = [];
  for (const pr of prs) {
    // The last CI run on the head that carries test-linux's executions.
    const runs = pr.commits.nodes
      .flatMap((c) => c.commit.checkSuites.nodes)
      .map((s) => s.workflowRun)
      .filter((r) => r && r.workflow.name === 'CI')
      .map((r) => r.databaseId)
      .sort((a, b) => b - a);
    let executions = null;
    let runId = null;
    for (const id of runs) {
      const dir = join(out, 'artifacts', String(pr.number));
      rmSync(dir, { recursive: true, force: true });
      const res = spawnSync('gh', ['run', 'download', String(id), '-R', REPO, '-n', 'nx-cache-entries-test-linux', '-D', dir], {
        encoding: 'utf8',
      });
      if (res.status === 0 && existsSync(join(dir, 'executions.json'))) {
        executions = JSON.parse(readFileSync(join(dir, 'executions.json'), 'utf8'));
        runId = id;
        break;
      }
    }
    const head = executions?.head_sha ?? pr.headRefOid;
    const base = executions?.selection?.base_sha ?? git(scratch, 'merge-base', pr.headRefOid, pr.baseRefOid);
    const changed = git(scratch, 'diff', '--name-only', base, head).split('\n').filter(Boolean);
    const tasks = executions ? Object.values(executions).find(Array.isArray) : [];
    const seconds = (task) => {
      const t = tasks.find((x) => x.task === task && x.result === 'executed');
      return t ? Math.round((Date.parse(t.finished_at) - Date.parse(t.started_at)) / 1000) : null;
    };
    const affected = {};
    const ranToday = {};
    for (const [project, tier] of TIERS) {
      const files = changed.filter((f) => inputs[tier].files.has(f));
      const commands = inputs[tier].runtime.filter((c) => runtime(base, c) !== runtime(head, c));
      affected[tier] = files.length || commands.length ? { files: files.slice(0, 5), file_count: files.length, runtime: commands } : null;
      ranToday[tier] = seconds(`${project}:test`);
    }
    const unaffected = TIERS.map(([, t]) => t).filter((t) => !affected[t]);
    const reusable = unaffected.filter((t) => ranToday[t] !== null);
    const rust = changed.filter((f) => /^src\/.*\.rs$/.test(f) || f === 'build.rs');
    const row = {
      pr: pr.number,
      title: pr.title,
      run: runId ? `https://github.com/${REPO}/actions/runs/${runId}` : null,
      tier: executions?.selection?.mode ?? null,
      base,
      head,
      changed_files: changed.length,
      rust_sources_changed: rust.length > 0,
      unaffected,
      ran_today_seconds: ranToday,
      reusable_ran_today: reusable,
      reusable_seconds: reusable.reduce((s, t) => s + ranToday[t], 0),
      coverage_seconds: seconds('onepipeline-ui-coverage:coverage'),
      affected: Object.fromEntries(Object.entries(affected).filter(([, v]) => v)),
    };
    rows.push(row);
    record('reuse', row);
  }
  record('reuse-summary', {
    prs: rows.length,
    prs_with_artifact: rows.filter((r) => r.run).length,
    tier_runs: rows.length * TIERS.length,
    unaffected_tier_runs: rows.reduce((s, r) => s + r.unaffected.length, 0),
    prs_with_any_unaffected: rows.filter((r) => r.unaffected.length).length,
    prs_changing_rust_sources: rows.filter((r) => r.rust_sources_changed).length,
    per_tier_unaffected: Object.fromEntries(TIERS.map(([, t]) => [t, rows.filter((r) => r.unaffected.includes(t)).length])),
    tier_runs_today: rows.reduce((s, r) => s + Object.values(r.ran_today_seconds).filter((x) => x !== null).length, 0),
    tier_seconds_today: rows.reduce((s, r) => s + Object.values(r.ran_today_seconds).reduce((a, x) => a + (x ?? 0), 0), 0),
    reusable_tier_runs: rows.reduce((s, r) => s + r.reusable_ran_today.length, 0),
    reusable_seconds: rows.reduce((s, r) => s + r.reusable_seconds, 0),
  });
  writeFileSync(join(out, 'reuse.json'), JSON.stringify(rows, null, 1));
  rmSync(scratch, { recursive: true, force: true });
}

// ---- entry ------------------------------------------------------------------

const [verb, ...rest] = process.argv.slice(2);
let outArg = null;
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--out') {
    outArg = rest[++i];
    if (!outArg) usage('--out needs a directory');
  } else positional.push(rest[i]);
}
const out = resolve(outArg ?? join(ROOT, 'target', 'coverage-spike', verb ?? ''));
switch (verb) {
  case 'shapes':
    measureShapes(out);
    break;
  case 'determinism':
    measureDeterminism(out);
    break;
  case 'cache-hit':
    measureCacheHit(out);
    break;
  case 'reuse':
    measureReuse(out);
    break;
  case 'export':
    if (positional.length !== 1) usage('export needs one profile');
    exportVerb(positional[0]);
    break;
  case 'remap-check': {
    const at = rest.indexOf('--replayed');
    if (at < 0 || !outArg) usage('remap-check needs --out DIR --replayed T,T');
    remapCheck(out, {
      replayed: rest[at + 1].split(','),
      ranDir: join(out, 'c2-cached-profdata'),
      freshDir: join(out, 'c2-no-cache-profdata'),
      oldDir: join(out, 'c0-profdata'),
      invocation: reportInvocationFromObjects(),
      coldGate: JSON.parse(readFileSync(join(out, 'c2-no-cache-gate.json'), 'utf8')),
    });
    break;
  }
  case 'merge-a':
    mergeAVerb();
    break;
  case 'merge-b':
    mergeBVerb();
    break;
  default:
    usage(verb ? `unknown measurement '${verb}'` : 'name a measurement');
}
void copyFileSync;
void tmpdir;
