import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function workspaceFixture(ref) {
  const root = resolve(".");
  const cwd = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(), "nx-inputs-"),
  );
  if (ref) {
    const archive = execFileSync("git", ["archive", ref], {
      maxBuffer: 64 * 1024 * 1024,
    });
    execFileSync("tar", ["-x", "-C", cwd], { input: archive });
  } else {
    for (const file of execFileSync("git", ["ls-files", "-z"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean)) {
      const dest = join(cwd, file);
      mkdirSync(dirname(dest), { recursive: true });
      if (lstatSync(file).isSymbolicLink())
        symlinkSync(readlinkSync(file), dest);
      else copyFileSync(file, dest);
    }
  }
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["add", "."], { cwd });
  symlinkSync(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
  return cwd;
}
export function taskHashes(cwd, ids = ["--ci"]) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [resolve(".github/tests/nx-cache/nx-task-hashes.mjs"), cwd, ...ids],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NX_DAEMON: "false",
          NX_ISOLATE_PLUGINS: "false",
        },
        maxBuffer: 32 * 1024 * 1024,
      },
    ),
  );
}
