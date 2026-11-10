/**
 * A live run receiving records before its first answer, during the rest and after
 * it: the page ends on the corpus's values, with none lost, repeated, moved back or
 * left marked loading, and a restart's `reset` and a second tab hold the same.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  addressOf,
  appendTo,
  buildWorld,
  completeDocuments,
  copyWorld,
  metricText,
  removeWorld,
  type Served,
  serve,
  stop,
  toolPayload,
  type World,
} from "./journey-world";

const HISTORY_LOADING = "The rest of this run's history is still loading";

let base: World;
test.beforeAll(() => {
  base = buildWorld();
});
test.afterAll(() => removeWorld(base));

const STREAM = "live-journey-stream";
const SESSION = "live-journey-session";

/** A writer into `world`'s open run, one stream of its own. */
function writerOf(world: World) {
  let seq = 0;
  const run = world.facts.openLiveRun;
  const node = world.facts.large.busiestNode;
  const member = { member: "worker", persona: "worker", session: SESSION };
  const stamped = (kind: string, payload: object, labels: object = member) => {
    appendTo(world, run, node, kind, STREAM, seq, payload, labels);
    seq += 1;
  };
  let rows = 0;
  let turn = 0;
  return {
    run,
    node,
    /** One activity row with text a person can find; its text is returned. */
    row() {
      rows += 1;
      const payload = toolPayload(1000 + rows);
      stamped("turn-activity", { ...payload, detail: `live row ${rows}` });
      return `live row ${rows}`;
    },
    turn() {
      turn += 1;
      stamped("turn-started", {
        turn,
        role: "assistant",
        instruction: "continue",
        started_at: new Date().toISOString(),
        model: "a-model",
      });
      stamped(
        "turn-completed",
        {
          turn,
          role: "assistant",
          usage: { input_tokens: 5, output_tokens: 50, cost_usd: 1.25 },
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
        },
        member,
      );
    },
    settle() {
      appendTo(
        world,
        run,
        node,
        "node-settled",
        "live-settle-stream",
        0,
        { status: "done", outcome: "merged" },
        {},
        "pipeline",
      );
    },
    newSpan() {
      appendTo(
        world,
        run,
        node,
        "change-check",
        `${STREAM}-evidence`,
        0,
        { name: "ci", status: "success", state: "success" },
        member,
        "vcs",
      );
    },
    pointer() {
      const historyId = "01a00d0f-c094-7660-b26c-8a53baaf9c11";
      appendFileSync(
        join(world.runsRoot, run, "oneharness-sessions.jsonl"),
        `${JSON.stringify({
          schema_version: "1.0",
          history_id: historyId,
          history_dir: join(world.workspace, "history"),
          history_project: "load-history-project",
          history_session: "live-pointer-session",
          history_file: join(
            world.workspace,
            "history/load-history-project/live-pointer-session.jsonl",
          ),
          name: "live-pointer-session",
          project: "/tmp/load",
          harness: "claude-code",
          harness_id: "claude-code",
          started: new Date().toISOString(),
          labels: {
            "onepipeline.attempt": "1",
            "onepipeline.node": node,
            "onepipeline.project": "local-md:load-project-00",
            "onepipeline.run_id": run,
            "onepipeline.scope": "worker",
            role: "engineer",
          },
        })}\n`,
      );
    },
  };
}

/** Open every collapsed run of rows, as a reader does to read its middle. */
async function expandRows(page: Page): Promise<void> {
  const control = page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("button", { name: /^Show \d+ more/u });
  while ((await control.count()) > 0)
    await control
      .first()
      .click()
      .catch(() => undefined);
}

const openNode = (page: Page, served: Served, world: World) =>
  page.goto(
    `${served.origin}${addressOf(world.facts.openLiveRun, "node", world.facts.large.busiestNode)}`,
  );

test("records appended before, during and after the rest reach a node's timeline, none lost or repeated", async ({
  page,
}) => {
  const world = copyWorld(base);
  try {
    const write = writerOf(world);
    const before = write.row();
    const served = await serve(world, {
      ONEPIPELINE_UI_COMPLETE_READ_HOLD_MS: "4000",
    });
    try {
      await openNode(page, served, world);
      const transcript = page.getByRole("region", { name: "Node transcript" });
      await expandRows(page);
      await expect(transcript.getByText(before)).toHaveCount(1, {
        timeout: 60_000,
      });
      const during = write.row();
      await expect(transcript.getByText(during)).toHaveCount(1, {
        timeout: 60_000,
      });
      await expect(page.getByText(HISTORY_LOADING)).toHaveCount(0, {
        timeout: 120_000,
      });
      const after = write.row();
      await expect
        .poll(
          async () => {
            await expandRows(page);
            return transcript.getByText(after).count();
          },
          { timeout: 60_000 },
        )
        .toBe(1);
      await expect(transcript.getByText(before)).toHaveCount(1);
      await expect(transcript.getByText(during)).toHaveCount(1);
    } finally {
      await stop(served);
    }
  } finally {
    removeWorld(world);
  }
});

test("a node settling during the rest is not moved back when a complete read that began behind arrives", async ({
  page,
}) => {
  const world = copyWorld(base);
  try {
    const write = writerOf(world);
    const served = await serve(world, {
      ONEPIPELINE_UI_COMPLETE_READ_HOLD_MS: "4000",
    });
    try {
      await page.goto(
        `${served.origin}${addressOf(world.facts.openLiveRun, "graph")}`,
      );
      await expect(
        page.getByRole("region", { name: "Run header" }),
      ).toBeVisible({ timeout: 60_000 });
      write.settle();
      const settled = page.getByRole("article", {
        name: `${world.facts.large.busiestNode}: done`,
      });
      await expect(settled).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(HISTORY_LOADING)).toHaveCount(0, {
        timeout: 120_000,
      });
      await expect(settled).toBeVisible();
      await expect(
        page.getByRole("article", {
          name: `${world.facts.large.busiestNode}: running`,
        }),
      ).toHaveCount(0);
    } finally {
      await stop(served);
    }
  } finally {
    removeWorld(world);
  }
});

test("after the rest, Turns reaches the page equal to a fresh document and usage is labelled as of its fold", async ({
  page,
}) => {
  const world = copyWorld(base);
  try {
    const write = writerOf(world);
    const served = await serve(world, {
      ONEPIPELINE_UI_TELEMETRY_REFOLD_MS: "800",
    });
    try {
      await page.goto(
        `${served.origin}${addressOf(world.facts.openLiveRun, "overall")}`,
      );
      const turns = metricText(page, "Turns");
      await expect(turns).toHaveText(/^\d+$/u, { timeout: 120_000 });
      write.turn();
      write.newSpan();
      write.pointer();
      write.row();
      await expect
        .poll(
          async () => {
            const complete = await completeDocuments(
              served,
              world.facts.openLiveRun,
            );
            return (
              (await turns.textContent()) ===
              String((complete.detail.run as { turns: number }).turns)
            );
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      const complete = await completeDocuments(served, world.facts.openLiveRun);
      const usage = (
        complete.detail.telemetry as { usage: { total: { cost_usd: number } } }
      ).usage.total.cost_usd;
      expect(usage).toBeGreaterThan(0);
      // Timing and usage, as of their fold.
      const timing = page.getByRole("group", { name: "Timing and usage" });
      await timing.getByText("Timing and usage").click();
      await expect
        .poll(() => timing.textContent(), { timeout: 30_000 })
        .toContain("cost usd");
    } finally {
      await stop(served);
    }
  } finally {
    removeWorld(world);
  }
});

test("usage is labelled as of its fold, then drawn as loading once the fold is held past overdue", async ({
  page,
}) => {
  const world = copyWorld(base);
  try {
    const write = writerOf(world);
    const served = await serve(world, {
      ONEPIPELINE_UI_TELEMETRY_REFOLD_MS: "1500",
      ONEPIPELINE_UI_TELEMETRY_FOLD_HOLD_MS: "600000",
    });
    try {
      await page.goto(
        `${served.origin}${addressOf(world.facts.openLiveRun, "overall")}`,
      );
      await expect(metricText(page, "Turns")).toHaveText(/^\d+$/u, {
        timeout: 120_000,
      });
      const timing = page.getByRole("group", { name: "Timing and usage" });
      await timing.getByText("Timing and usage").click();
      write.turn();
      await expect(timing).toContainText("updating", { timeout: 30_000 });
      await expect(timing).toContainText("as of");
      const stop_at = Date.now() + 60_000;
      while (Date.now() < stop_at) {
        write.row();
        if (((await timing.textContent()) ?? "").includes("Loading…")) break;
        await page.waitForTimeout(500);
      }
      await expect(timing).toContainText("Loading…", { timeout: 10_000 });
    } finally {
      await stop(served);
    }
  } finally {
    removeWorld(world);
  }
});

test("a reset after a server restart and a second tab on the view hold the same values", async ({
  page,
  context,
}) => {
  const world = copyWorld(base);
  try {
    const write = writerOf(world);
    const served = await serve(world);
    let restarted: Served | undefined;
    try {
      const address = `${served.origin}${addressOf(world.facts.openLiveRun, "overall")}`;
      await page.goto(address);
      const turns = metricText(page, "Turns");
      await expect(turns).toHaveText(/^\d+$/u, { timeout: 120_000 });
      const held = await turns.textContent();
      await stop(served);
      write.turn();
      restarted = await serve(world, {}, served.port);
      await expect
        .poll(
          async () => {
            const text = await turns.textContent();
            return text !== null && text !== held && /^\d+$/u.test(text);
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      const final = await turns.textContent();
      const second = await context.newPage();
      await second.goto(address);
      await expect(metricText(second, "Turns")).toHaveText(final ?? "", {
        timeout: 120_000,
      });
      write.row();
      write.turn();
      await expect
        .poll(() => turns.textContent(), { timeout: 60_000 })
        .not.toBe(final);
      await expect
        .poll(
          async () =>
            (await metricText(second, "Turns").textContent()) ===
            (await turns.textContent()),
          {
            timeout: 60_000,
          },
        )
        .toBe(true);
    } finally {
      if (restarted !== undefined) await stop(restarted);
      else await stop(served);
    }
  } finally {
    removeWorld(world);
  }
});
