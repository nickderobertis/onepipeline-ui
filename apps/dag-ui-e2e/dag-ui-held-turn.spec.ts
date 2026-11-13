import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { exited, startFixtureServer } from "./fixture-server";
import harnessBinaries from "./fixtures/harness-binaries.json" with {
  type: "json",
};

/**
 * A reply that reaches a node whose turn is still open, sent through the page's
 * own composer against the served binary.
 *
 * Nothing is stood in for but the paid model turn: the read API is the binary
 * this tier built, the driver is the `onepipeline` the lock pins adopting the
 * run, and the member is `oneagentgraph`'s two-party conversation, whose every
 * turn is the harness double `tests/e2e/server.rs` holds its own turn with. The
 * double holds the first agent turn open until this journey writes `turn.go`
 * and then `turn.settle`, so the reply below lands while the turn is live.
 */

const factsSchema = z.object({
  run: z.string().min(1),
  node: z.string().min(1),
  session: z.string().min(1),
  host: z.string().min(1),
  fakes: z.string().min(1),
  environment: z.record(z.string(), z.string()),
});

/** The engine the lock pins, as `just bootstrap` provisions it for this tier. */
const ENGINE = join(
  import.meta.dirname,
  "..",
  "..",
  ".tools",
  "bin",
  "onepipeline",
);

const AMENDMENT = "keep the diff to src/new.rs";
const NOTE = "the reviewer asked for a smaller diff; stop editing src/old.rs";

const receipt = (page: Page, label: string): Locator =>
  page.getByRole("alert", { name: `${label} receipt` });

/** Wait for `path` to exist, as the double writes it when a turn opens. */
async function appeared(path: string, what: string): Promise<void> {
  await expect
    .poll(() => existsSync(path), { message: what, timeout: 60_000 })
    .toBe(true);
}

test.skip(
  process.platform === "win32",
  "the harness double is a POSIX shell program, as the Rust journey's is",
);

test("a reply to a node whose turn is open is answered with the amend applied and the note queued, and the channel shows it applied", async ({
  page,
}) => {
  const server = await startFixtureServer("held-turn", ["--held-turn-corpus"]);
  const facts = factsSchema.parse(server.facts);
  const release = () => {
    writeFileSync(join(facts.fakes, "turn.go"), "go");
    writeFileSync(join(facts.fakes, "turn.settle"), "go");
  };
  // The adopted driver, started here and so the one process this journey may
  // signal. What this suite's own dispatch exported for its harness, graph and
  // run is left out, as the Rust journey leaves it out.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !["ONEPIPELINE_", "ONEAGENTGRAPH_", "ONEHARNESS_"].some((prefix) =>
          name.startsWith(prefix),
        ),
    ),
  );
  let driver: ChildProcess | undefined;
  try {
    driver = spawn(ENGINE, ["adopt", facts.run, "--attach"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...inherited,
        ...facts.environment,
        ONEPIPELINE_RUNS_DIR: join(server.workspace, "runs"),
        ONEPIPELINE_LAUNCHER_SESSION: facts.session,
        HOSTNAME: facts.host,
        // Nor the operator's harnesses, which the engine's provider reading
        // probes for up to a minute each wherever it finds one on `PATH`.
        PATH: (process.env.PATH ?? "")
          .split(delimiter)
          .filter(
            (dir) => !harnessBinaries.some((bin) => existsSync(join(dir, bin))),
          )
          .join(delimiter),
      },
    });
    await appeared(
      join(facts.fakes, "turn-0.opened"),
      "the adopted run's worker turn to open",
    );

    await page.goto(`${server.origin}/?run=${facts.run}&view=channel`);
    const composer = page.getByRole("region", { name: "Reply" });
    await composer.getByLabel("Envelope (sent as typed)").fill(
      JSON.stringify({
        version: 3,
        commands: [
          { op: "amend", id: facts.node, text: AMENDMENT },
          {
            op: "note",
            id: facts.node,
            addressee: "worker",
            deliver: "turn-end",
            text: NOTE,
          },
        ],
      }),
    );
    await composer.getByRole("button", { name: "Send reply" }).click();

    // Answered at hand-off, while the turn the note waits on is still open:
    // the amend committed, and the note queued in the conversation's inbox.
    const answered = receipt(page, "Reply");
    await expect(answered).toContainText('"state": "applied"');
    await expect(answered).toContainText('"commands": "applied"');
    await expect(answered).toContainText(
      new RegExp(`"notes": \\{\\s*"${facts.node}": "queued"\\s*\\}`),
    );
    expect(existsSync(join(facts.fakes, "turn-1.opened"))).toBe(false);

    // The reconciler's own answer to that envelope, in the channel's queue:
    // applied, with each command's result — the note's `queued` among them —
    // rather than an envelope the page calls not applied.
    const outcomes = page
      .getByRole("region", { name: "Channel queue" })
      .getByRole("region", { name: "Command outcomes" });
    const outcome = outcomes.getByRole("listitem").first();
    await expect(outcome).toContainText("envelope");
    await expect(outcome).toContainText("applied");
    await expect(outcome).not.toContainText("not applied");
    await expect(outcome).toContainText('"op": "amend"');
    await expect(outcome).toContainText('"outcome": "applied"');
    await expect(outcome).toContainText('"op": "note"');
    await expect(outcome).toContainText('"outcome": "queued"');

    // The turn ends and the conversation takes the note, so the run the
    // driver adopted settles and the driver lets go of it.
    release();
    const driving = driver;
    await expect
      .poll(() => driving.exitCode !== null || driving.signalCode !== null, {
        message: "the adopted driver to let go of the settled run",
        timeout: 90_000,
      })
      .toBe(true);
  } finally {
    release();
    if (
      driver !== undefined &&
      driver.exitCode === null &&
      driver.signalCode === null
    ) {
      driver.kill("SIGTERM");
      await exited(driver);
    }
    await server.stop();
  }
});
