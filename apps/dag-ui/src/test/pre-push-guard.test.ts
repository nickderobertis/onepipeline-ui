import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoPath } from "./repo-file";

/**
 * The pre-push visual guard's answer on a host whose architecture no lane declares.
 *
 * `.githooks/pre-push` classifies a capture against `shots/baseline/<arch>.json`, and
 * `screencomp.toml`'s `[capture].arches` names the only lanes that have one. A host
 * outside them has nothing to classify against, so the guard cannot evaluate the push:
 * it says so and lets the push go, unless `SCREENCOMP_GUARD_REQUIRE` asks it to refuse
 * — the same terms as its other could-not-evaluate ending, a missing `screencomp`.
 *
 * The hook itself runs unaltered, from the repository root the way git runs it. What
 * is controlled is the host: a `uname` on `PATH` reports the machine, and `PATH` is
 * otherwise the system's own directories, so no `screencomp` a developer installed
 * under their home decides which ending is reached.
 */

const root = repoPath(".");
const hosts = mkdtempSync(join(tmpdir(), "pre-push-guard-"));
afterAll(() => rmSync(hosts, { recursive: true, force: true }));

/** A `PATH` whose `uname -m` answers `machine`, and which carries no `screencomp`. */
function hostPath(machine: string): string {
  const bin = mkdtempSync(join(hosts, `${machine}-`));
  const uname = join(bin, "uname");
  writeFileSync(uname, `#!/bin/sh\necho ${machine}\n`);
  chmodSync(uname, 0o700);
  return `${bin}:/usr/bin:/bin`;
}

/** The guard's exit status and what it told the pusher, on `machine`. */
function push(machine: string, require?: string) {
  const env: Record<string, string> = { PATH: hostPath(machine) };
  if (require !== undefined) env.SCREENCOMP_GUARD_REQUIRE = require;
  const run = spawnSync("/bin/bash", [".githooks/pre-push"], {
    cwd: root,
    env,
    input: "",
    encoding: "utf8",
  });
  return { status: run.status, stderr: run.stderr };
}

describe("the pre-push guard on a host with no declared lane", () => {
  it("says it did not evaluate the push, names the lanes, and lets it go", () => {
    const { status, stderr } = push("aarch64");
    expect(stderr).toContain(
      "this host's architecture (arm64) has no lane in [capture].arches",
    );
    expect(stderr).toContain("did NOT evaluate this push");
    expect(stderr).toContain("Declared: [x86_64]");
    expect(status).toBe(0);
  });

  it("refuses the push when SCREENCOMP_GUARD_REQUIRE demands an evaluation", () => {
    const { status, stderr } = push("aarch64", "1");
    expect(stderr).toContain("did NOT evaluate this push");
    expect(status).toBe(1);
  });

  it("reads SCREENCOMP_GUARD_REQUIRE=0 as not requiring one", () => {
    expect(push("aarch64", "0").status).toBe(0);
  });

  it("refuses a SCREENCOMP_GUARD_REQUIRE it cannot read either way", () => {
    const { status, stderr } = push("aarch64", "maybe");
    expect(stderr).toContain("SCREENCOMP_GUARD_REQUIRE is 'maybe'");
    expect(status).toBe(1);
  });

  it("still refuses a CPU it has no lane spelling for", () => {
    const { status, stderr } = push("riscv64");
    expect(stderr).toContain("unsupported arch riscv64");
    expect(status).toBe(1);
  });
});

describe("the pre-push guard over a screencomp.toml it cannot read lanes from", () => {
  /** The committed hook, run from a checkout whose screencomp.toml says `config`. */
  function pushWith(config: string) {
    const checkout = mkdtempSync(join(hosts, "checkout-"));
    mkdirSync(join(checkout, ".githooks"));
    copyFileSync(
      repoPath(".githooks/pre-push"),
      join(checkout, ".githooks/pre-push"),
    );
    writeFileSync(join(checkout, "screencomp.toml"), config);
    const run = spawnSync("/bin/bash", [".githooks/pre-push"], {
      cwd: checkout,
      env: { PATH: hostPath("aarch64") },
      input: "",
      encoding: "utf8",
    });
    return { status: run.status, stderr: run.stderr };
  }

  it.each([
    ["declares no arches at all", "[capture]\n"],
    ["declares them twice", 'arches = ["x86_64"]\narches = ["arm64"]\n'],
    ["declares an empty list", "arches = []\n"],
    ["declares something that is not a lane name", 'arches = ["x86 64/v2"]\n'],
    [
      "declares arches only under another table",
      '[other]\narches = ["arm64"]\n',
    ],
  ])(
    "refuses a screencomp.toml that %s, rather than call the host undeclared",
    (_, config) => {
      const { status, stderr } = pushWith(`[capture]\n${config}`);
      expect(stderr).toContain("which is not one list of lane");
      expect(stderr).not.toContain("has no lane");
      expect(status).toBe(1);
    },
  );

  it("reads the lanes from [capture] alone, not an arches key under another table", () => {
    const { status, stderr } = pushWith(
      '[capture]\narches = ["x86_64"]\n\n[other] # not a lane list\narches = ["arm64"]\n',
    );
    expect(stderr).toContain(
      "this host's architecture (arm64) has no lane in [capture].arches",
    );
    expect(stderr).toContain("Declared: [x86_64]");
    expect(status).toBe(0);
  });
});

describe("the pre-push guard on a declared lane", () => {
  it("goes on to evaluate, reaching the missing-screencomp ending instead", () => {
    const { status, stderr } = push("x86_64");
    expect(stderr).not.toContain("has no lane");
    expect(stderr).toContain("screencomp is NOT on PATH");
    expect(status).toBe(0);
    expect(push("x86_64", "1").status).toBe(1);
  });
});
