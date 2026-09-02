import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);

/**
 * Where the build under test writes, so a refused run cannot be confused with one
 * that quietly overwrote the bundle the browser journeys serve.
 */
const outDir = mkdtempSync(join(tmpdir(), "dag-ui-config-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

/**
 * Load the real config the way a real Vite invocation does, with `named` in the
 * environment, and answer what Vite said and how it ended.
 *
 * `vite build` rather than a dev server because config resolution is the first
 * thing either does and this one then exits on its own: what is under test is
 * whether a bad value stops Vite at all, and a server would have to be started,
 * waited for and stopped to ask the same question.
 *
 * Nothing is built here, so nothing is slow: the config throws while Vite is
 * still reading it, and both cases together take about half a second. The budget
 * below is for `npx` and Vite's own startup on a host running other work, and a
 * value this refuses still fails in that half second.
 */
async function loadConfigWith(named: string): Promise<string> {
  try {
    await run(
      "npx",
      ["vite", "build", "--config", "vite.config.ts", "--outDir", outDir],
      {
        cwd: import.meta.dirname
          ? join(import.meta.dirname, "../..")
          : process.cwd(),
        env: { ...process.env, DAG_UI_API_URL: named },
      },
    );
  } catch (refused) {
    // Narrowed rather than asserted: `execFile` rejects with an `Error` carrying
    // the child's output, which its types do not describe, and a cast here would
    // turn a rejection of some other shape — a missing `npx`, say — into an
    // assertion on `undefined` instead of the failure it is.
    if (
      refused instanceof Error &&
      "stdout" in refused &&
      "stderr" in refused
    ) {
      return `${String(refused.stdout)}${String(refused.stderr)}`;
    }
    throw refused;
  }
  throw new Error(`vite loaded a config pointed at ${named}`);
}

describe("the config Vite really loads", () => {
  // The happy path is driven a hundred times over by the browser tier, which
  // starts three Vite origins against the fixture server's own URL; what has
  // never been driven is a value Vite is handed and must refuse.
  it("refuses to start against a proxy target that is not a URL", async () => {
    expect(await loadConfigWith("127.0.0.1:8765")).toContain(
      "DAG_UI_API_URL is not a URL: 127.0.0.1:8765",
    );
  }, 30_000);

  it("refuses to start against a scheme the read API is not served over", async () => {
    expect(await loadConfigWith("ftp://reads.example.invalid")).toContain(
      "DAG_UI_API_URL names ftp: and the read API is served over http or https",
    );
  }, 30_000);
});
