import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoPath } from "./repo-file";

/**
 * `scripts/visual-capture.sh` driven as lint's capture step drives it: two
 * destinations, two renders side by side, one exit status.
 *
 * Where a capture may write is decided before anything is built, so those journeys run
 * the script in place. The renders need Docker and the capture build, so those journeys
 * run the real script from a scratch copy of the layout it reads, the way a checkout
 * holds it, with Docker the one boundary stood in for: a `docker` on PATH that records
 * each container it is asked to run and remove, and holds or fails a render on request.
 * The two build steps the script calls first are stood in for too, since what they
 * build is the photograph's subject and no part of how the script runs the renders.
 */

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function scratch(under: string, prefix: string): string {
  mkdirSync(under, { recursive: true });
  const dir = realpathSync(mkdtempSync(join(under, prefix)));
  scratchDirs.push(dir);
  return dir;
}

function captureInPlace(env: Record<string, string>) {
  return spawnSync("bash", [repoPath("scripts/visual-capture.sh")], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("where a capture may write, decided before anything is made", () => {
  it("refuses a destination a symlink carries out of the tree, writing nothing there", () => {
    const outside = scratch(tmpdir(), "visual-capture-outside-");
    const root = scratch(repoPath("shots/local"), "symlink-");
    symlinkSync(outside, join(root, "out"));
    for (const name of ["SHOTS_OUT", "SHOTS_VERIFY"]) {
      const result = captureInPlace({
        SHOTS_OUT: join(root, "current/x86_64"),
        [name]: join(root, "out/deeper/x86_64"),
      });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain(`visual-capture: ${name} must name`);
      expect(result.stderr).toContain(
        `it resolves to ${outside}/deeper/x86_64`,
      );
      expect(result.stderr).toMatch(/^ACTION: set /m);
      expect(readdirSync(outside)).toEqual([]);
    }
  });

  it("refuses a destination outside the tree the container mounts, making nothing there", () => {
    const outside = scratch(tmpdir(), "visual-capture-outside-");
    const root = scratch(repoPath("shots/local"), "outside-");
    const absent = join(outside, "never-made");
    for (const name of ["SHOTS_OUT", "SHOTS_VERIFY"]) {
      const result = captureInPlace({
        SHOTS_OUT: join(root, "current"),
        [name]: absent,
      });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain(`visual-capture: ${name} must name`);
      expect(result.stderr).toContain(`it resolves to ${absent}`);
      expect(existsSync(absent)).toBe(false);
    }
  });

  it("refuses a destination that climbs out of the tree with ..", () => {
    const root = scratch(repoPath("shots/local"), "climb-");
    const result = captureInPlace({
      SHOTS_OUT: join(root, "current"),
      SHOTS_VERIFY: "shots/../../visual-capture-escape",
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("it climbs with '..'");
    expect(existsSync(repoPath("../visual-capture-escape"))).toBe(false);
  });

  it("refuses a second destination that is the first one", () => {
    const root = scratch(repoPath("shots/local"), "same-");
    const result = captureInPlace({ SHOTS_OUT: root, SHOTS_VERIFY: root });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain(
      "SHOTS_VERIFY names the same directory as SHOTS_OUT",
    );
  });

  it("refuses a second destination inside the first, making neither", () => {
    const root = scratch(repoPath("shots/local"), "nested-");
    const result = captureInPlace({
      SHOTS_OUT: join(root, "current"),
      SHOTS_VERIFY: join(root, "current/verify"),
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("nest, so one capture would be written");
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses a second destination that is the first one under another name", () => {
    const root = scratch(repoPath("shots/local"), "alias-");
    mkdirSync(join(root, "current"));
    symlinkSync(join(root, "current"), join(root, "alias"));
    const result = captureInPlace({
      SHOTS_OUT: join(root, "current"),
      SHOTS_VERIFY: join(root, "alias"),
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain(
      "SHOTS_VERIFY names the same directory as SHOTS_OUT",
    );
  });

  it("says what to do when a destination cannot be created", () => {
    const root = scratch(repoPath("shots/local"), "blocked-");
    mkdirSync(join(root, "sealed"));
    chmodSync(join(root, "sealed"), 0o555);
    try {
      const result = captureInPlace({
        SHOTS_OUT: join(root, "current"),
        SHOTS_VERIFY: join(root, "sealed/verify"),
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        `cannot create SHOTS_VERIFY's directory ${join(root, "sealed/verify")}`,
      );
      expect(result.stderr).toMatch(/^ACTION: make .* creatable/m);
    } finally {
      chmodSync(join(root, "sealed"), 0o755);
    }
  });
});

const DOCKER_DOUBLE = `#!/usr/bin/env bash
# docker, as the capture script uses it: info, run --cidfile ... and rm --force ID.
log="$DOCKER_DOUBLE_DIR/log"
case "$1" in
  info) exit 0 ;;
  rm)
    id="\${!#}"
    echo "rm $id" >> "$log"
    touch "$DOCKER_DOUBLE_DIR/$id.removed"
    exit 0 ;;
  run)
    shift
    cid=""; dest=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --cidfile) cid="$2"; shift 2 ;;
        --env) case "$2" in SHOTS_OUT=*) dest="\${2#SHOTS_OUT=}" ;; esac; shift 2 ;;
        *) shift ;;
      esac
    done
    id="container-$$"
    echo "$id" > "$cid"
    echo "run $id $dest" >> "$log"
    case "$DOCKER_DOUBLE_MODE:$dest" in
      fail-verify:*/verify/*) echo "render failed into $dest"; exit 1 ;;
      hold:*)
        # Held until removed, for a minute at most: a script that never removes
        # it leaves no process behind once the journey has failed.
        for _ in $(seq 600); do
          [ -f "$DOCKER_DOUBLE_DIR/$id.removed" ] && exit 137
          sleep 0.1
        done
        exit 124 ;;
      *) echo "rendered into $dest"; exit 0 ;;
    esac ;;
esac
echo "docker double: not a call the capture makes: $*" >&2
exit 64
`;

/** A checkout's worth of what the script reads, with Docker and the build stood in for. */
function layout() {
  const root = scratch(tmpdir(), "visual-capture-layout-");
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "apps/dag-ui-e2e"), { recursive: true });
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "docker"));
  mkdirSync(join(root, "tmp"));
  copyFileSync(
    repoPath("scripts/visual-capture.sh"),
    join(root, "scripts/visual-capture.sh"),
  );
  copyFileSync(
    repoPath("apps/dag-ui-e2e/package.json"),
    join(root, "apps/dag-ui-e2e/package.json"),
  );
  for (const step of ["workspace-install.sh", "nx.sh"])
    writeFileSync(join(root, "scripts", step), `echo "built by ${step}"\n`);
  writeFileSync(join(root, "bin/docker"), DOCKER_DOUBLE);
  chmodSync(join(root, "bin/docker"), 0o755);
  const env = (mode: string) => ({
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    TMPDIR: join(root, "tmp"),
    DOCKER_DOUBLE_DIR: join(root, "docker"),
    DOCKER_DOUBLE_MODE: mode,
    SHOTS_OUT: "shots/current/x86_64",
    SHOTS_VERIFY: "shots/verify/x86_64",
  });
  const runs = () =>
    existsSync(join(root, "docker/log"))
      ? readFileSync(join(root, "docker/log"), "utf8")
          .split("\n")
          .filter((line) => line.startsWith("run "))
          .map((line) => line.split(" ")[1] ?? "")
      : [];
  const removed = () =>
    readdirSync(join(root, "docker"))
      .filter((name) => name.endsWith(".removed"))
      .map((name) => name.replace(/\.removed$/, ""))
      .sort();
  return {
    root,
    env,
    runs,
    removed,
    script: join(root, "scripts/visual-capture.sh"),
  };
}

describe("two renders side by side", () => {
  it("renders both destinations and reports them in one line", () => {
    const capture = layout();
    const result = spawnSync("bash", [capture.script], {
      encoding: "utf8",
      env: capture.env("succeed"),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(capture.runs()).toHaveLength(2);
    expect(result.stdout).toContain(
      "[verify] rendered into /work/shots/verify/x86_64",
    );
    expect(result.stdout).toMatch(
      /capture in .*\/shots\/current\/x86_64, verify capture in .*\/shots\/verify\/x86_64$/m,
    );
  });

  it("fails when only the second render fails, naming it and what to do", () => {
    const capture = layout();
    const result = spawnSync("bash", [capture.script], {
      encoding: "utf8",
      env: capture.env("fail-verify"),
    });
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain("rendered into /work/shots/current/x86_64");
    expect(result.stdout).toContain(
      "[verify] render failed into /work/shots/verify/x86_64",
    );
    expect(result.stderr).toContain("the verify capture's playwright exited 1");
    expect(result.stderr).toMatch(/^ACTION: read the failing surface/m);
    expect(result.stdout).not.toContain("verify capture in");
  });

  it("asked to stop mid-render, removes both containers and its scratch, and exits as stopped", async () => {
    const capture = layout();
    const child = spawn("bash", [capture.script], {
      env: capture.env("hold"),
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    const deadline = Date.now() + 30_000;
    while (capture.runs().length < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const started = capture.runs().sort();
    expect(started).toHaveLength(2);
    expect(capture.removed()).toEqual([]);
    child.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise<"still running">((resolve) =>
        setTimeout(() => resolve("still running"), 20_000),
      ),
    ]);
    if (code === "still running") child.kill("SIGKILL");
    expect(code).toBe(143);
    expect(capture.removed()).toEqual(started);
    expect(readdirSync(join(capture.root, "tmp"))).toEqual([]);
  }, 60_000);
});
