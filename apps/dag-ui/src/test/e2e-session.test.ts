import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What `playwright.config.ts` accepts back out of `DAG_UI_E2E_SESSION`.
 *
 * That variable is the browser tier's one piece of shared state: the runner records
 * the ports and fixture directory it chose there, and every process the tier forks
 * — worker, teardown, and each `webServer` command — reads them back. The workspace
 * it carries is interpolated into a command Playwright runs through a shell, so it
 * is read across a trust boundary and is validated where it is parsed rather than
 * where it is used.
 *
 * Only refusals are driven here. Importing the config with nothing recorded is what
 * makes a run's ports and fixture directory, and a unit tier has no business doing
 * that; every case below is refused before the module reaches it.
 */
describe("the recorded browser-tier session", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /** Load the config the way a forked worker does, with `session` recorded. */
  async function loadWithSession(session: Record<string, unknown>) {
    vi.stubEnv("DAG_UI_E2E_SESSION", JSON.stringify(session));
    return await import("../../playwright.config");
  }

  const ports = {
    api: 40001,
    ui: 40002,
    offlineApi: 40003,
    offlineUi: 40004,
    stalledApi: 40005,
    stalledUi: 40006,
  };

  it("accepts the directory a run of this tier makes for itself", async () => {
    const workspace = join(tmpdir(), "dag-ui-e2e-fixture-Ab3xY9");
    const { FIXTURE_WORKSPACE, LOOPBACK } = await loadWithSession({
      ...ports,
      workspace,
    });
    expect(FIXTURE_WORKSPACE).toBe(workspace);
    // The address the whole file reads, so a server bound elsewhere is a mismatch
    // this tier can see rather than a readiness budget it waits out.
    expect(LOOPBACK).toBe("127.0.0.1");
  });

  it.each([
    [
      "a path outside the temp root",
      join("/etc", "dag-ui-e2e-fixture-Ab3xY9"),
      "directly under",
    ],
    [
      "a temp path this tier did not name",
      join(tmpdir(), "somebody-elses-directory"),
      "must be named",
    ],
    [
      "a name carrying a shell's own punctuation",
      join(tmpdir(), "dag-ui-e2e-fixture-a;$(id)"),
      "shell would read",
    ],
  ])("refuses %s", async (_case, workspace, because) => {
    await expect(loadWithSession({ ...ports, workspace })).rejects.toThrow(
      new RegExp(because),
    );
  });
});
