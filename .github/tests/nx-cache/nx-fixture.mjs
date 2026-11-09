import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function workspaceFixture(ref) {
  const root = resolve(".");
  if (ref && !/^[a-f0-9]{40}$/.test(ref))
    throw new Error("workspaceFixture requires a full commit SHA");
  const baseline = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
    encoding: "utf8",
  }).trim();
  const objects = resolve(
    root,
    execFileSync("git", ["rev-parse", "--git-path", "objects"], {
      encoding: "utf8",
    }).trim(),
  );
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
  // Reuse immutable source objects read-only, anchoring both refs at the exact
  // baseline the suite keys. Each fixture writes new objects only to its own Git.
  mkdirSync(join(cwd, ".git/objects/info"), { recursive: true });
  writeFileSync(join(cwd, ".git/objects/info/alternates"), `${objects}\n`);
  for (const name of ["HEAD", "refs/remotes/origin/main"])
    execFileSync("git", ["update-ref", name, ref || baseline], { cwd });
  execFileSync("git", ["add", "."], { cwd });
  symlinkSync(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
  return cwd;
}
// The smallest edit that changes a file's bytes and leaves it readable as what it is.
export function probeEdit(file, original) {
  return file === "tsconfig.base.json"
    ? Buffer.from(
        original.toString().replace('"target": "ES2024"', '"target": "ES2023"'),
      )
    : Buffer.concat([original, Buffer.from("\n")]);
}

// What each file-rule probe's edit does to the tasks reading it, read in one process.
export function probeHashes(cwd, before) {
  mkdirSync(join(cwd, ".nx"), { recursive: true });
  const workspaceData = mkdtempSync(join(cwd, ".nx/hash-read-"));
  const hashes = join(workspaceData, "before.json");
  writeFileSync(hashes, JSON.stringify(before));
  try {
    return JSON.parse(
      execFileSync(
        process.execPath,
        [resolve(".github/tests/nx-cache/nx-probe-hashes.mjs"), cwd, hashes],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            NX_DAEMON: "false",
            NX_ISOLATE_PLUGINS: "false",
            NX_WORKSPACE_DATA_DIRECTORY: workspaceData,
          },
          maxBuffer: 32 * 1024 * 1024,
        },
      ),
    );
  } finally {
    rmSync(workspaceData, { recursive: true, force: true });
  }
}

export function taskHashes(cwd, ids = ["--ci"]) {
  // Nx's native file-hash archive keys reuse on mtime alone (seconds on Unix).
  // Each inspection must read current bytes, even for edits in the same second.
  mkdirSync(join(cwd, ".nx"), { recursive: true });
  const workspaceData = mkdtempSync(join(cwd, ".nx/hash-read-"));
  try {
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
            NX_WORKSPACE_DATA_DIRECTORY: workspaceData,
          },
          maxBuffer: 32 * 1024 * 1024,
        },
      ),
    );
  } finally {
    rmSync(workspaceData, { recursive: true, force: true });
  }
}
