import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
 * `dag-ui-e2e-NAME-RUN` under the temp root, empty: one path per corpus name and
 * run, named after this run's fixture workspace so two runs on one host never
 * share it.
 */
function sameWorkspace(name: string): string {
  const run = basename(FIXTURE_WORKSPACE).replace(/^dag-ui-e2e-fixture-/, "");
  const workspace = join(tmpdir(), `dag-ui-e2e-${name}-${run}`);
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace);
  return workspace;
}

/**
 * Start a read API over the corpus `corpusArgs` selects, the view beside it, and
 * wait until it answers. `name` says which corpus in the workspace's name and in
 * every failure.
 */
export async function startFixtureServer(
  name: string,
  corpusArgs: readonly string[],
  /** Beside the fixture server's own environment: what this journey's server is told. */
  env: Readonly<Record<string, string>> = {},
  /**
   * The same workspace path every time this name is started in a run, emptied
   * first, rather than a fresh one: for a corpus that keeps what it built for the
   * next journey to copy, which is the same bytes only at the same path.
   */
  { samePath = false }: { readonly samePath?: boolean } = {},
): Promise<FixtureServer> {
  // `dag-ui-e2e-…` directly under the temp root: the one shape
  // `serve-fixture.mjs` agrees to remove and rebuild.
  const workspace = samePath
    ? sameWorkspace(name)
    : mkdtempSync(join(tmpdir(), `dag-ui-e2e-${name}-`));
  // The journey's origin is a listener this process takes before anything is
  // served and holds until `stop`, relaying each connection to the read API
  // serving at the time. A restart is then a new child behind the same held
  // port rather than a release and a rebind of it — which is the gap anything
  // else on the host could take the port in, and the journey then reads
  // somebody else's server or none. Each child binds a port of its own the
  // kernel chooses, and names it once it holds it.
  let upstream: string | undefined;
  const relayed = new Set<Socket>();
  const front = createServer((client) => {
    relayed.add(client);
    client.once("close", () => relayed.delete(client));
    // Stopped: the connection closes on the caller, a read that fails, as an
    // origin with nothing behind it answers.
    if (upstream === undefined) {
      client.destroy();
      return;
    }
    const [host, port] = upstream.split(":");
    const server = connect(Number(port), host);
    relayed.add(server);
    server.once("close", () => relayed.delete(server));
    const sever = () => {
      client.destroy();
      server.destroy();
    };
    client.on("error", sever);
    server.on("error", sever);
    client.pipe(server);
    server.pipe(client);
  });
  const origin = await new Promise<string>((resolve, reject) => {
    front.once("error", reject);
    front.listen(0, "127.0.0.1", () => {
      const address = front.address();
      if (address === null || typeof address !== "object")
        reject(new Error(`the ${name} origin has no port`));
      else resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  const originPort = new URL(origin).port;
  const serve = async (): Promise<ChildProcess> => {
    const child = spawn(
      process.execPath,
      [
        FIXTURE_COMMAND,
        "--workspace",
        workspace,
        "--port",
        "0",
        "--origin-port",
        originPort,
        "--ui",
        ...corpusArgs,
      ],
      {
        stdio: ["ignore", "pipe", "inherit"],
        // The main fixture retained the built server before any journeys started.
        // Cargo install can move its output away while this tier is still running.
        env: { ...process.env, CARGO_TARGET_DIR: FIXTURE_WORKSPACE, ...env },
      },
    );
    upstream = await announced(child, name);
    // Ready once it answers through the origin the journey reads.
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null)
        throw new Error(`the ${name} fixture server exited ${child.exitCode}`);
      const ready = await fetch(`${origin}/healthz`).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) return child;
      if (Date.now() > deadline)
        throw new Error(
          `the ${name} fixture server never answered on ${origin}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  let child: ChildProcess | undefined = await serve();
  const halt = async (): Promise<void> => {
    const running = child;
    child = undefined;
    upstream = undefined;
    if (running === undefined) return;
    running.kill("SIGTERM");
    await exited(running);
    // Whatever was still relayed to the stopped server ends with it.
    for (const socket of relayed) socket.destroy();
  };
  return {
    origin,
    workspace,
    facts: JSON.parse(
      readFileSync(join(workspace, FIXTURE_FACTS_NAME), "utf8"),
    ),
    stop: async () => {
      await halt();
      await new Promise<void>((resolve) => front.close(() => resolve()));
      rmSync(workspace, { recursive: true, force: true });
    },
    stopServing: halt,
    serveRebuilt: async () => {
      if (child === undefined) child = await serve();
    },
  };
}
