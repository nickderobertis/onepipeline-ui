/**
 * The load harness's CPU accounting, held to CPU of a known size: a process
 * that burns its own and starts a child that burns more is counted for both,
 * a process tree's figure only grows, and a process that is not there is
 * refused rather than read as one that used nothing. No browser is opened.
 */

import { spawn } from "node:child_process";
import { expect, test } from "@playwright/test";
import { treeCpuSeconds } from "./load/cpu";

/** Busy-loop for `ms` of wall clock, which on an idle core is as much CPU. */
const burn = (ms: number) =>
  `const end = Date.now() + ${ms}; while (Date.now() < end) {}`;

test("a tree's CPU counts the process and its descendants, live and reaped", async () => {
  // The parent burns a second, then starts a child that burns a second while
  // the parent waits on it, then lingers so the tree can be read.
  const parent = spawn(process.execPath, [
    "-e",
    `${burn(1_000)};
     const { spawnSync } = require("node:child_process");
     spawnSync(process.execPath, ["-e", ${JSON.stringify(burn(1_000))}]);
     setTimeout(() => {}, 5_000);`,
  ]);
  try {
    const pid = parent.pid ?? 0;
    const first = treeCpuSeconds(pid);
    // Two seconds of CPU between them, the second second in a child the
    // parent has reaped by the time it lingers.
    await expect
      .poll(() => treeCpuSeconds(pid), {
        message: "the tree's CPU never reached what it burned",
        timeout: 15_000,
      })
      .toBeGreaterThan(1.6);
    expect(treeCpuSeconds(pid)).toBeGreaterThanOrEqual(first);
    // And not much more than it burned: nothing outside the tree is counted.
    expect(treeCpuSeconds(pid)).toBeLessThan(4);
  } finally {
    parent.kill("SIGTERM");
  }
});

test("a process that is not there is refused, never read as idle", () => {
  expect(() => treeCpuSeconds(0)).toThrow("no process to account for");
  expect(() => treeCpuSeconds(2 ** 30)).toThrow();
});
