/**
 * A process tree's CPU time, read off `/proc` — Linux's, which is why
 * `dag-ui-e2e:test-load` runs on Linux alone.
 *
 * The server's own user and system time, every live descendant's, and what
 * each of them has already reaped from children that exited, so a helper the
 * server ran and waited for is counted and nothing outside its tree is.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

/** Clock ticks a second, as the kernel counts `/proc/<pid>/stat` times in. */
const CLOCK_TICKS = Number(
  execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim(),
);

/** The process and every descendant of it, by pid, as `/proc` lists them now. */
function tree(pid: number): number[] {
  const found = [pid];
  for (let index = 0; index < found.length; index += 1) {
    const at = found[index];
    // A descendant that exits while it is being listed has no tasks left to
    // list, which is the one read here allowed to come back empty.
    let tasks: string[] = [];
    try {
      tasks = readdirSync(`/proc/${at}/task`);
    } catch {
      tasks = [];
    }
    for (const task of tasks) {
      let children = "";
      try {
        children = readFileSync(`/proc/${at}/task/${task}/children`, "utf8");
      } catch {
        children = "";
      }
      for (const child of children.split(" ").filter(Boolean))
        found.push(Number(child));
    }
  }
  return found;
}

/** One process's user, system and reaped children's times, in seconds. */
function ownSeconds(stat: string): number {
  // The command name can hold spaces and parentheses; the fields after the
  // last `)` are fixed.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  // utime, stime, cutime and cstime.
  const times = [11, 12, 13, 14].map((at) => Number(fields[at]));
  if (times.some((value) => !Number.isFinite(value)))
    throw new Error(`/proc stat is not one this harness can read: ${stat}`);
  return times.reduce((sum, value) => sum + value, 0) / CLOCK_TICKS;
}

/**
 * CPU seconds the tree rooted at `pid` has used so far.
 *
 * The root's own accounting must be readable — an unsupported host or an
 * inaccessible `/proc` throws rather than reading as a tree that used nothing.
 */
export function treeCpuSeconds(pid: number): number {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`no process to account for: ${pid}`);
  if (!Number.isFinite(CLOCK_TICKS) || CLOCK_TICKS <= 0)
    throw new Error("the kernel names no clock tick rate");
  let seconds = ownSeconds(readFileSync(`/proc/${pid}/stat`, "utf8"));
  for (const member of tree(pid).slice(1)) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${member}/stat`, "utf8");
    } catch {
      // Exited between being listed and being read: its parent's reaped
      // time counts it once its parent waits for it.
      continue;
    }
    seconds += ownSeconds(stat);
  }
  return seconds;
}
