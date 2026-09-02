import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

/** A port the kernel says is free, for a server this test is about to start. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const held = createServer();
    held.listen(0, "127.0.0.1", () => {
      const { port } = held.address() as AddressInfo;
      held.close(() => resolve(port));
    });
  });
}

/**
 * Read `url` once the server behind it is answering, or fail saying what the
 * server said instead.
 *
 * A connection refused is "not started yet" and nothing else here can tell those
 * apart, so the deadline is what separates a slow start from a server that never
 * came up — and everything it printed goes into the failure, because a Vite that
 * refused its config prints the reason and then this would otherwise report only
 * that nothing answered.
 */
async function readThrough(url: string, said: string[]): Promise<Response> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await fetch(url);
    } catch (refused) {
      if (Date.now() > deadline) {
        throw new Error(`nothing answered ${url}: ${said.join("")}`, {
          cause: refused,
        });
      }
      await new Promise((wait) => setTimeout(wait, 100));
    }
  }
}

/** The app's own directory, which every invocation here runs from. */
const app = join(import.meta.dirname, "../..");

/**
 * A server that answers `/healthz` and records the path each request arrived on.
 *
 * The recording is the assertion: what a proxy target's *path* does is decide
 * what the API is asked for, and the only place that is observable is at the API.
 */
function recordingApi(): Promise<{
  port: number;
  asked: string[];
  close: () => void;
}> {
  const asked: string[] = [];
  const api = createServer((request, response) => {
    asked.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
  });
  return new Promise((resolve) => {
    api.listen(0, "127.0.0.1", () => {
      resolve({
        port: (api.address() as AddressInfo).port,
        asked,
        close: () => api.close(),
      });
    });
  });
}

describe("the proxy the config really builds", () => {
  // The refusals above stop Vite; this is the other half — what a value this
  // accepts does to a read the browser makes. Driven through the dev server
  // rather than `preview` because the two are handed the same `proxy` object and
  // this one needs no bundle built to start.
  //
  // The default is not driven here: proving it would mean binding 127.0.0.1:8765
  // itself, and on a host where somebody is already serving their own runs there
  // that is either a refused bind or somebody else's server answering. What can
  // drift about it is the literal, and `tests/contract.rs` reconciles that against
  // `onepipeline_ui::cli::default_bind`.
  it("sends a read to the origin it was given, and never to its path", async () => {
    const api = await recordingApi();
    // Chosen here rather than read back out of Vite's own output: a readiness
    // check that parses a subprocess's stdout is waiting on a log line, and the
    // question this needs answered is whether the proxy is serving yet. Asking
    // the port that is what polling it below does.
    const uiPort = await freePort();
    const ui = spawn(
      "npx",
      [
        "vite",
        "--config",
        "vite.config.ts",
        "--host",
        "127.0.0.1",
        "--port",
        String(uiPort),
        "--strictPort",
      ],
      {
        cwd: app,
        env: {
          ...process.env,
          // A path nothing should ever see: a proxy target carrying one would
          // prepend it to every read, and the API would answer none of them.
          DAG_UI_API_URL: `http://127.0.0.1:${api.port}/a/path/nobody/asked/for`,
        },
      },
    );
    const said: string[] = [];
    ui.stdout.on("data", (chunk: Buffer) => said.push(chunk.toString()));
    ui.stderr.on("data", (chunk: Buffer) => said.push(chunk.toString()));

    try {
      const answered = await readThrough(
        `http://127.0.0.1:${uiPort}/healthz`,
        said,
      );
      expect(answered.status).toBe(200);
      expect(await answered.json()).toEqual({ status: "ok" });
      // The whole claim: the path on the target was dropped, so the API was asked
      // for what the browser asked for.
      expect(api.asked).toEqual(["/healthz"]);
    } finally {
      // Started here, so signalled here — by the handle, never by a pattern.
      ui.kill();
      api.close();
    }
  }, 60_000);
});
