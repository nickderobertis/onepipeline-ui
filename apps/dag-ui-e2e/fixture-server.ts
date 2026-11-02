import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_FACTS_NAME } from "./fixtures/facts-file";
import { FIXTURE_WORKSPACE } from "./playwright.config";

/**
 * A read API of a journey's own, over a corpus written for it alone.
 *
 * The main corpus is shared by every journey and photographed by the gallery, so a
 * journey that changes what a server holds — a shutdown — or needs runs nothing else
 * should count, starts one of these instead: `serve-fixture.mjs` over a fresh
 * workspace, the view beside it with `--ui`, started before the journey and stopped
 * after it.
 */

const FIXTURE_COMMAND = join(import.meta.dirname, "fixtures/serve-fixture.mjs");

export interface FixtureServer {
  readonly origin: string;
  readonly workspace: string;
  /** What the corpus published about itself, unparsed: each caller holds its own shape. */
  readonly facts: unknown;
  readonly stop: () => Promise<void>;
  /** Stop the server and leave its origin unanswered until `serveRebuilt`. */
  readonly stopServing: () => Promise<void>;
  /**
   * Start the server again on the same origin and wait until it answers. The
   * corpus is written afresh, as on any start: `serve-fixture.mjs` removes and
   * rebuilds the workspace, so nothing written into it since is kept.
   */
  readonly serveRebuilt: () => Promise<void>;
}

/**
 * What `onepipeline-api serve` prints once it holds its port, ending in the
 * address the kernel gave it — so a server asked for port `0` names the port it
 * took, and a caller that reads this line never chooses one another process
 * could take first.
 */
const ANNOUNCED =
  /^onepipeline-api: serving .* on http:\/\/(127\.0\.0\.1:\d+)$/;

/**
 * Forward `child`'s stdout to this process's and resolve with the address it
 * announces, or reject once it exits without announcing one.
 */
function announced(child: ChildProcess, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdout = child.stdout;
    if (stdout === null) {
      reject(new Error(`the ${name} fixture server has no stdout to read`));
      return;
    }
    let pending = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (text: string) => {
      process.stdout.write(text);
      pending += text;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const address = ANNOUNCED.exec(pending.slice(0, end).trimEnd())?.[1];
        pending = pending.slice(end + 1);
        if (address !== undefined) resolve(address);
      }
    });
    child.once("exit", (code) =>
      reject(new Error(`the ${name} fixture server exited ${code}`)),
    );
  });
}

/** Wait for `child` to exit, however it ends. */
export const exited = (child: ChildProcess): Promise<void> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", () => resolve()));

/**
 * Start a read API over the corpus `corpusArgs` selects, the view beside it, and
 * wait until it answers. `name` says which corpus in the workspace's name and in
 * every failure.
 */
export async function startFixtureServer(
  name: string,
  corpusArgs: readonly string[],
): Promise<FixtureServer> {
  // `dag-ui-e2e-…` directly under the temp root: the one shape
  // `serve-fixture.mjs` agrees to remove and rebuild.
  const workspace = mkdtempSync(join(tmpdir(), `dag-ui-e2e-${name}-`));
  // The first start asks for any free port and is told which one it took: the
  // server binds it before it says so, so nothing else can take it in between.
  // A restart asks for that port again, because the journey's page is on it.
  const serve = async (
    port: number,
  ): Promise<{ child: ChildProcess; origin: string }> => {
    const child = spawn(
      process.execPath,
      [
        FIXTURE_COMMAND,
        "--workspace",
        workspace,
        "--port",
        String(port),
        "--ui",
        ...corpusArgs,
      ],
      {
        stdio: ["ignore", "pipe", "inherit"],
        // The main fixture retained the built server before any journeys started.
        // Cargo install can move its output away while this tier is still running.
        env: { ...process.env, CARGO_TARGET_DIR: FIXTURE_WORKSPACE },
      },
    );
    const origin = `http://${await announced(child, name)}`;
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null)
        throw new Error(`the ${name} fixture server exited ${child.exitCode}`);
      const ready = await fetch(`${origin}/healthz`).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) return { child, origin };
      if (Date.now() > deadline)
        throw new Error(
          `the ${name} fixture server never answered on ${origin}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const first = await serve(0);
  const { origin } = first;
  const port = Number(new URL(origin).port);
  let child: ChildProcess | undefined = first.child;
  const halt = async (): Promise<void> => {
    const running = child;
    child = undefined;
    if (running === undefined) return;
    running.kill("SIGTERM");
    await exited(running);
  };
  return {
    origin,
    workspace,
    facts: JSON.parse(
      readFileSync(join(workspace, FIXTURE_FACTS_NAME), "utf8"),
    ),
    stop: async () => {
      await halt();
      rmSync(workspace, { recursive: true, force: true });
    },
    stopServing: halt,
    serveRebuilt: async () => {
      if (child === undefined) child = (await serve(port)).child;
    },
  };
}
