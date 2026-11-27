// What a hosted job's log says, read line by line: GitHub prefixes every line
// with its ISO timestamp, Nx's static output prints each task's output as one
// block after `> nx run <task>`, and cargo, nextest, node's test runner, Vitest
// and Playwright each print their own durations.

const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z) ?(.*)$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes are what cargo and nextest print under CARGO_TERM_COLOR=always.
const ANSI = /\u001b\[[0-9;]*m/g;

export function lines(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = STAMP.exec(raw);
    if (m) out.push({ t: Date.parse(m[1]), s: m[2].replace(ANSI, "") });
    else if (out.length)
      out.push({ t: out.at(-1).t, s: raw.replace(ANSI, "") });
  }
  return out;
}

function seconds(text) {
  // cargo: "1m 02s", "45.67s"; nextest: "12.345s".
  let total = 0;
  const m = /(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:([\d.]+)s)?/.exec(text.trim());
  if (!m) return null;
  total +=
    Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return total;
}

// The run's identity and each cache restore, from the step groups.
export function facts(log) {
  const out = { github_sha: null, selection: null, restores: [] };
  let group = null;
  for (let i = 0; i < log.length; i += 1) {
    const { s, t } = log[i];
    const g = /^##\[group\]Run (.*)$/.exec(s);
    if (g) group = { name: g[1], t };
    if (/git(?:\.exe"?)? log -1 --format=['"]?%H/.test(s)) {
      for (let j = i + 1; j < Math.min(i + 6, log.length); j += 1) {
        const sha = /^'?([0-9a-f]{40})'?$/.exec(log[j].s.trim());
        if (sha) {
          out.github_sha ??= sha[1];
          break;
        }
      }
    }
    const sel = /^ci-job: (\S+) runs (\d+) task\(s\): (.*)$/.exec(s);
    if (sel)
      out.selection = {
        job: sel[1],
        count: Number(sel[2]),
        tasks: sel[3] === "none" ? [] : sel[3].split(" "),
      };
    // actions/cache prints `Cache hit for: <key>`, then the size, then a
    // `restored from key` line: one restore opens on the hit (or the miss).
    const hit = /^Cache hit for( restore-key)?:\s*(\S+)/.exec(s);
    const miss =
      /^(No cache found\.|Cache not found for input keys: (.*))$/.exec(s);
    const size = /Cache Size: ~?(\d+) MB/.exec(s);
    if (hit || miss)
      out.restores.push({
        step: group?.name ?? null,
        hit: Boolean(hit),
        // A restore-key hit restores an older entry of the family: a partial match.
        partial: Boolean(hit?.[1]),
        key: hit ? hit[2] : (miss[2] ?? null),
        at: new Date(t).toISOString(),
      });
    else if (size && out.restores.length && out.restores.at(-1).size_mb == null)
      out.restores.at(-1).size_mb = Number(size[1]);
  }
  return out;
}

// Each Nx task's output block, with what cargo and the test runners printed in it.
export function tasks(log) {
  const blocks = [];
  let cur = null;
  for (const { s, t } of log) {
    // Static output under GitHub Actions opens each task as a log group with
    // its outcome: `##[group]✅ > nx run <task>` (❌ when it failed).
    const m =
      /^(?:##\[group\])?(?:(✅|❌|⏭️?|✔|✖)\s*)?> nx run (\S+?)(?:\s+(\[[^\]]+\]))?\s*$/u.exec(
        s.trim(),
      );
    if (m) {
      cur = {
        task: m[2],
        outcome: m[1] === "❌" ? "failed" : m[1] ? "passed" : null,
        note: m[3] ?? null,
        printed_at: new Date(t).toISOString(),
        cargo: [],
        compiling: 0,
        nextest: [],
        tests: [],
      };
      blocks.push(cur);
      continue;
    }
    if (!cur) continue;
    const fin =
      /Finished `([^`]+)` profile \[[^\]]*\] target\(s\) in (.+)$/.exec(s);
    if (fin) cur.cargo.push({ profile: fin[1], seconds: seconds(fin[2]) });
    if (/^\s*Compiling \S+ v/.test(s)) cur.compiling += 1;
    const sum = /^\s*Summary \[\s*([\d.]+)s\] (\d+) tests? run/.exec(s);
    if (sum)
      cur.nextest.push({ seconds: Number(sum[1]), tests: Number(sum[2]) });
    const pass =
      /^\s*(PASS|FAIL|SLOW|FLAKY)\s+(?:\[\s*([\d.]+)s\]|\[\s*([\d.]+)s\s*\])\s+(?:\(\s*\d+\/\s*\d+\)\s+)?(\S+)\s+(.+)$/.exec(
        s,
      );
    if (pass && pass[1] !== "SLOW")
      cur.tests.push({
        runner: "nextest",
        binary: pass[4],
        name: pass[5].trim(),
        seconds: Number(pass[2] ?? pass[3]),
      });
    const node = /^\s*[✔✖] (.+) \(([\d.]+)ms\)$/.exec(s);
    if (node)
      cur.tests.push({
        runner: "node",
        binary: null,
        name: node[1],
        seconds: Number(node[2]) / 1000,
        depth: s.search(/\S/),
      });
    const vitest =
      /^\s*[✓×] (\S+\.(?:test|spec)\.\w+) \((\d+) tests?[^)]*\) ([\d.]+)(ms|s)\s*$/.exec(
        s,
      );
    if (vitest)
      cur.tests.push({
        runner: "vitest-file",
        binary: null,
        name: vitest[1],
        seconds: Number(vitest[3]) / (vitest[4] === "ms" ? 1000 : 1),
      });
    const pw =
      /^\s*[✓✘]\s+\d+\s+(?:\[[^\]]+\]\s+›\s+)?(.+?) \(([\d.]+)(ms|s|m)\)\s*$/.exec(
        s,
      );
    if (pw && !vitest && !node)
      cur.tests.push({
        runner: "playwright",
        binary: null,
        name: pw[1],
        seconds:
          Number(pw[2]) / (pw[3] === "ms" ? 1000 : pw[3] === "m" ? 1 / 60 : 1),
      });
  }
  return blocks;
}
