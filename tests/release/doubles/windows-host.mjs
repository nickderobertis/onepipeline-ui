import { execFileSync } from "node:child_process";
// A Windows runner, as far as the release's staged verification can tell, on a
// Linux host: scripts/verify-staged-release.mjs runs unmodified, under a Node
// that reports `win32`, so it takes every branch build-windows takes. What a
// Linux host lacks to answer those branches is stood in for, each by the thing
// the Windows runner would have and no more:
//
//   SystemRoot\System32\tar.exe  the host's tar (Windows' is bsdtar)
//   python                       python3, whose venv also has Windows' Scripts\
//   npm                          the real npm, writing the .bin a Windows npm
//                                writes (npm's own bin-links switch: the sh
//                                shim, .cmd and .ps1), with the modes Git Bash
//                                reads off NTFS, which has no executable bit:
//                                a file is executable only by an .exe, .com or
//                                .bat name or a `#!` or `MZ` first two bytes
//   cmd.exe (comspec)            what Node runs a `shell: true` spawn with on
//                                Windows: it runs cmd-shim's .cmd by reading the
//                                script it points at, and anything else with sh
//
// Every .cmd cmd.exe ran is appended to CMD_LOG, so a journey can tell the
// launcher's .cmd was what Node spawned.
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const which = (command) =>
  execFileSync("sh", ["-c", `command -v ${command}`], {
    encoding: "utf8",
  }).trim();

function script(path, body) {
  writeFileSync(path, `#!/usr/bin/env node\n${body}`);
  chmodSync(path, 0o755);
}

// Git Bash's reading of an NTFS file's executable bit.
export function gitBashModes(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const head = readFileSync(path).subarray(0, 2).toString("latin1");
    const executable =
      /\.(exe|com|bat)$/i.test(name) || head === "#!" || head === "MZ";
    chmodSync(path, executable ? 0o755 : 0o644);
  }
}

// `node` arguments and environment that run a script on this Windows host.
export function windowsHost(dir) {
  const bin = join(dir, "bin");
  const systemRoot = join(dir, "Windows");
  const cmdLog = join(dir, "cmd.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(systemRoot, "System32"), { recursive: true });
  writeFileSync(cmdLog, "");
  symlinkSync(which("tar"), join(systemRoot, "System32", "tar.exe"));
  const self = JSON.stringify(import.meta.url);
  script(
    join(bin, "python"),
    `const { spawnSync } = require("node:child_process");
const { symlinkSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const run = spawnSync(${JSON.stringify(which("python3"))}, args, { stdio: "inherit" });
if (run.status === 0 && args[0] === "-m" && args[1] === "venv")
  symlinkSync("bin", join(args[2], "Scripts"));
process.exit(run.status ?? 1);
`,
  );
  script(
    join(bin, "npm"),
    `const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const run = spawnSync(${JSON.stringify(which("npm"))}, args, {
  stdio: "inherit",
  env: { ...process.env, __TESTING_BIN_LINKS_PLATFORM__: "win32" },
});
const prefix = args[args.indexOf("--prefix") + 1];
const binDir = prefix && join(prefix, "node_modules", ".bin");
(async () => {
  if (run.status === 0 && args.includes("--prefix") && existsSync(binDir))
    (await import(${self})).gitBashModes(binDir);
  process.exit(run.status ?? 1);
})();
`,
  );
  const comspec = join(bin, "cmd.exe");
  script(
    comspec,
    `const { spawn } = require("node:child_process");
const { appendFileSync, readFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
// Node hands a shell: true spawn to comspec as /d /s /c "<command line>", or
// as -c <command line> when comspec's path is not a backslashed cmd.exe.
const args = process.argv.slice(2);
const line = args[0] === "-c" ? args[1] : args[3].replace(/^"([^]*)"$/, "$1");
const [first, ...rest] = line.split(" ");
let child;
if (/\\.cmd$/i.test(first)) {
  appendFileSync(${JSON.stringify(cmdLog)}, first + "\\n");
  const shim = readFileSync(first, "utf8");
  const target = [...shim.matchAll(/"%dp0%\\\\([^"]+)"/g)].at(-1)[1];
  const js = resolve(dirname(first), target.replaceAll("\\\\", "/"));
  const prog = shim.includes('"%_prog%"') ? ["node", js] : [js];
  child = spawn(prog[0], [...prog.slice(1), ...rest.filter(Boolean)], { stdio: "inherit" });
} else {
  child = spawn("/bin/sh", ["-c", line], { stdio: "inherit" });
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`,
  );
  return {
    node: [
      "--import",
      'data:text/javascript,Object.defineProperty(process,"platform",{value:"win32"})',
    ],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SystemRoot: systemRoot,
      comspec,
      ONEPIPELINE_NODE_SCRATCH_DIR: dir,
    },
    cmdLog,
  };
}

export const cmdRuns = (host) =>
  readFileSync(host.cmdLog, "utf8").split("\n").filter(Boolean);
