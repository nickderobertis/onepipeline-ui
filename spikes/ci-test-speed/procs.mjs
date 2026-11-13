// The recorder's files (recorder/record.sh), read back as one list of process
// lifetimes in epoch milliseconds: { key, pid, ppid, start, end, comm, argv,
// cpu, sleeps, waits }. `ppid` is null where the platform records none.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const read = (dir, name) =>
  existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null;

// comp_t: a 13-bit mantissa and a 3-bit base-8 exponent.
const comp = (v) => (v & 0x1fff) * 8 ** (v >> 13);

function linuxAcct(buf) {
  const out = [];
  for (let o = 0; o + 64 <= buf.length; o += 64) {
    if (buf[o + 1] !== 3) continue;
    const comm = buf
      .subarray(o + 48, o + 64)
      .toString("latin1")
      .replace(/\0.*$/s, "");
    out.push({
      pid: buf.readUInt32LE(o + 16),
      ppid: buf.readUInt32LE(o + 20),
      btime: buf.readUInt32LE(o + 24) * 1000,
      etime: (buf.readFloatLE(o + 28) / 100) * 1000,
      cpu:
        ((comp(buf.readUInt16LE(o + 32)) + comp(buf.readUInt16LE(o + 34))) /
          100) *
        1000,
      comm,
    });
  }
  return out;
}

function linux(dir) {
  const clock = read(dir, "clock-start.txt");
  const trace = read(dir, "trace.txt");
  if (!clock || !trace) return null;
  const [epochNs, monoNs] = clock.trim().split(/\s+/).map(BigInt);
  const offset = epochNs - monoNs;
  const ms = (ns) => Number((BigInt(ns) + offset) / 1000000n);
  const stop = read(dir, "clock-stop.txt");
  const end = stop
    ? Number(BigInt(stop.trim().split(/\s+/)[0]) / 1000000n)
    : null;
  const byPid = new Map();
  const inst = (pid) => {
    const list = byPid.get(pid);
    return list?.at(-1);
  };
  const fresh = (pid, start, ppid) => {
    const p = {
      pid,
      ppid,
      start,
      end: null,
      comm: null,
      argv: null,
      sleeps: [],
      waits: [],
      exec: false,
    };
    if (!byPid.has(pid)) byPid.set(pid, []);
    byPid.get(pid).push(p);
    return p;
  };
  let begin = null;
  for (const line of trace.split("\n")) {
    const sp = line.indexOf(" ");
    const kind = line.slice(0, sp);
    const rest = line.slice(sp + 1);
    if (kind === "READY") begin = ms(rest.trim());
    else if (kind === "F") {
      const [ns, parent, child] = rest.split(" ");
      fresh(Number(child), ms(ns), Number(parent));
    } else if (kind === "X") {
      const m = /^(\d+) (\d+) (.*)$/.exec(rest);
      if (!m) continue;
      const pid = Number(m[2]);
      const p = inst(pid) ?? fresh(pid, ms(m[1]), null);
      p.argv = m[3];
      p.exec = true;
      p.comm = m[3].split(" ")[0].split("/").pop();
    } else if (kind === "Q") {
      const [ns, pid, ...comm] = rest.split(" ");
      const p = inst(Number(pid));
      if (p && p.end === null) {
        p.end = ms(ns);
        p.comm = comm.join(" ") || p.comm;
        p.exited = true;
      }
    } else if (kind === "S" || kind === "T") {
      const [ns, pid, , dur] = rest.split(" ");
      const p = inst(Number(pid));
      if (!p) continue;
      const e = ms(ns);
      (kind === "S" ? p.sleeps : p.waits).push([e - Number(dur) / 1e6, e]);
    }
  }
  const procs = [];
  for (const list of byPid.values())
    for (const p of list) {
      // A thread is forked like a process but never execs or exits as a
      // process: only what exec'd or exited as its own process is one.
      if (!p.exec && !p.exited) continue;
      p.start ??= begin;
      p.end ??= end;
      procs.push(p);
    }
  const acctBuf = existsSync(join(dir, "pacct"))
    ? readFileSync(join(dir, "pacct"))
    : null;
  if (acctBuf) {
    const acct = linuxAcct(acctBuf);
    const index = new Map();
    for (const a of acct) {
      if (!index.has(a.pid)) index.set(a.pid, []);
      index.get(a.pid).push(a);
    }
    for (const p of procs) {
      const cands = index.get(p.pid) ?? [];
      const best = cands.find(
        (a) => Math.abs(a.btime + a.etime - p.end) < 2500,
      );
      if (best) p.cpu = best.cpu;
    }
  }
  return { platform: "linux", tree: true, begin, end, procs };
}

function macos(dir) {
  const path = join(dir, "acct");
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  const procs = [];
  for (let o = 0; o + 40 <= buf.length; o += 40) {
    const comm = buf
      .subarray(o, o + 10)
      .toString("latin1")
      .replace(/\0.*$/s, "");
    const btime = buf.readUInt32LE(o + 16) * 1000;
    const etime = (comp(buf.readUInt16LE(o + 14)) / 64) * 1000;
    const cpu =
      ((comp(buf.readUInt16LE(o + 10)) + comp(buf.readUInt16LE(o + 12))) / 64) *
      1000;
    procs.push({
      pid: null,
      ppid: null,
      start: btime,
      end: btime + etime,
      comm,
      argv: comm,
      cpu,
      sleeps: [],
      waits: [],
    });
  }
  const clock = read(dir, "clock-start.txt");
  const stop = read(dir, "clock-stop.txt");
  const ns = (s) =>
    s ? Number(BigInt(s.trim().split(/\s+/)[0]) / 1000000n) : null;
  return {
    platform: "macos",
    tree: false,
    begin: ns(clock),
    end: ns(stop),
    procs,
  };
}

function windows(dir) {
  const xml = read(dir, "events.xml");
  if (!xml) return null;
  const byPid = new Map();
  const procs = [];
  const data = (ev, name) =>
    new RegExp(`<Data Name='${name}'>([^<]*)</Data>`).exec(ev)?.[1] ?? null;
  for (const ev of xml.split("</Event>")) {
    const id = /<EventID>(\d+)<\/EventID>/.exec(ev)?.[1];
    const at = /SystemTime='([^']+)'/.exec(ev)?.[1];
    if (!id || !at) continue;
    const t = Date.parse(at);
    if (id === "4688") {
      const exe = data(ev, "NewProcessName") ?? "";
      const p = {
        pid: Number.parseInt(data(ev, "NewProcessId"), 16),
        ppid: Number.parseInt(data(ev, "ProcessId"), 16),
        start: t,
        end: null,
        comm: exe
          .split("\\")
          .pop()
          .replace(/\.exe$/i, "")
          .toLowerCase(),
        argv: (data(ev, "CommandLine") ?? exe)
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, "&"),
        sleeps: [],
        waits: [],
      };
      procs.push(p);
      if (!byPid.has(p.pid)) byPid.set(p.pid, []);
      byPid.get(p.pid).push(p);
    } else if (id === "4689") {
      const pid = Number.parseInt(data(ev, "ProcessId"), 16);
      const p = byPid.get(pid)?.findLast((q) => q.end === null && q.start <= t);
      if (p) p.end = t;
    }
  }
  const startTxt = read(dir, "clock-start.txt");
  const stopTxt = read(dir, "clock-stop.txt");
  const begin = startTxt ? Number(startTxt.trim()) : null;
  const end = stopTxt ? Number(stopTxt.trim()) : null;
  for (const p of procs) p.end ??= end;
  const samples = read(dir, "samples.csv");
  if (samples) {
    const cpu = new Map();
    for (const line of samples.split("\n")) {
      const [, pid, , ms, started] = line.trim().split(",");
      if (!started) continue;
      const k = `${pid}@${started}`;
      cpu.set(k, Math.max(cpu.get(k) ?? 0, Number(ms)));
    }
    for (const p of procs) {
      for (const [k, v] of cpu) {
        const [pid, started] = k.split("@");
        if (Number(pid) === p.pid && Math.abs(Number(started) - p.start) < 1500)
          p.cpu = v;
      }
    }
  }
  return { platform: "windows", tree: true, begin, end, procs };
}

export function recorded(dir) {
  return linux(dir) ?? macos(dir) ?? windows(dir);
}
