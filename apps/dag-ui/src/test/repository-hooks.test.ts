import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { repoPath } from "./repo-file";

it("pushes without visual checks from a clone left configured by former bootstrap", () => {
  const scratch = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? tmpdir(),
      "repository-hooks-",
    ),
  );
  const checkout = join(scratch, "checkout");
  const remote = join(scratch, "remote.git");
  mkdirSync(checkout);
  function run(command: string, args: string[], trace?: string): string {
    const result = spawnSync(command, args, {
      cwd: checkout,
      encoding: "utf8",
      env: { ...process.env, CI: "", ...(trace ? { GIT_TRACE: trace } : {}) },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout + result.stderr;
  }
  try {
    run("git", ["init", "--bare", remote]);
    run("git", ["init"]);
    run("git", ["config", "user.name", "Hook journey"]);
    run("git", ["config", "user.email", "hooks@example.invalid"]);
    run("git", ["config", "core.hooksPath", ".githooks"]);
    if (existsSync(repoPath(".githooks"))) {
      cpSync(repoPath(".githooks"), join(checkout, ".githooks"), {
        recursive: true,
      });
    }
    cpSync(repoPath("shots/baseline"), join(checkout, "shots/baseline"), {
      recursive: true,
    });
    const baseline = join(checkout, "shots/baseline/x86_64.json");
    const original = readFileSync(baseline);
    mkdirSync(join(checkout, "apps/dag-ui/src"), { recursive: true });
    const guarded = join(checkout, "apps/dag-ui/src/journey.txt");
    writeFileSync(guarded, "first\n");
    run("git", ["add", "."]);
    run("git", ["commit", "-m", "test: first authored commit"]);
    run("git", ["remote", "add", "origin", remote]);
    function push(label: string): void {
      const trace = join(scratch, `${label}.trace`);
      run("git", ["push", "origin", "HEAD:refs/heads/journey"], trace);
      expect(
        run("git", [
          "--git-dir",
          remote,
          "rev-parse",
          "refs/heads/journey",
        ]).trim(),
      ).toBe(run("git", ["rev-parse", "HEAD"]).trim());
      expect(readFileSync(trace, "utf8")).not.toMatch(
        /pre-push|screencomp|visual-capture|docker|just gate/,
      );
      expect(readFileSync(baseline)).toEqual(original);
      expect(existsSync(join(checkout, "shots/review"))).toBe(false);
    }
    push("first");
    writeFileSync(guarded, "changed\n");
    run("git", ["add", "."]);
    run("git", ["commit", "-m", "test: changed guarded path"]);
    push("changed");
    push("up-to-date");
    // Full bootstrap provisions unrelated toolchains; expand its real recipe instead.
    const setup = run("just", [
      "--justfile",
      repoPath("justfile"),
      "--dry-run",
      "bootstrap",
    ]);
    expect(setup).toContain("scripts/nx.sh run-many -t bootstrap --parallel=1");
    expect(setup).not.toMatch(/enable-hooks|hooksPath|pre-push/);
    expect(run("git", ["config", "--get", "core.hooksPath"]).trim()).toBe(
      ".githooks",
    );
    push("after-setup");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
