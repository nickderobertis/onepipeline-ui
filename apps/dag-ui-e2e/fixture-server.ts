import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_FACTS_NAME } from "./fixtures/facts-file";

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
const LOOPBACK = "127.0.0.1";

export interface FixtureServer {
  readonly origin: string;
  readonly workspace: string;
  /** What the corpus published about itself, unparsed: each caller holds its own shape. */
  readonly facts: unknown;
  readonly stop: () => Promise<void>;
}

/** A port the kernel says is free now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, LOOPBACK, () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("the kernel named no port")),
      );
    });
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
  const port = await freePort();
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
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  const origin = `http://${LOOPBACK}:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`the ${name} fixture server exited ${child.exitCode}`);
    const ready = await fetch(`${origin}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    if (Date.now() > deadline)
      throw new Error(`the ${name} fixture server never answered on ${origin}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    origin,
    workspace,
    facts: JSON.parse(
      readFileSync(join(workspace, FIXTURE_FACTS_NAME), "utf8"),
    ),
    stop: async () => {
      child.kill("SIGTERM");
      await exited(child);
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
