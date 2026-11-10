/**
 * The first answer and every later frame read through `@onepipeline-ui/dag-model`,
 * and every way a read can fail — the network boundary the only doubled party.
 */
import {
  frameCarriesWholeEvents,
  subscribedSchema,
  subscriptionFrameSchema,
  timelineEventsPageSchema,
  visibleViolations,
} from "@onepipeline-ui/dag-model";
import { READ_DEADLINE_MS } from "@onepipeline-ui/telemetry-client";
import { expect, type Page, test } from "@playwright/test";
import {
  addressOf,
  appendTo,
  buildWorld,
  completeDocuments,
  metricText,
  removeWorld,
  type Served,
  serve,
  stop,
  toolPayload,
  type World,
} from "./journey-world";

const HISTORY_LOADING = "The rest of this run's history is still loading";

let world: World;
test.beforeAll(() => {
  world = buildWorld();
});
test.afterAll(() => removeWorld(world));

type Wire = {
  first?: unknown;
  frames: { event: string; data: unknown }[];
  pages: string[];
};

async function record(page: Page): Promise<Wire> {
  const wire: Wire = { frames: [], pages: [] };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.eventSourceMessageReceived", (event) => {
    if (event.eventName !== "heartbeat")
      wire.frames.push({
        event: event.eventName,
        data: JSON.parse(event.data),
      });
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/timeline/events")) wire.pages.push(url.search);
  });
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (
      url.pathname === "/api/v2/subscriptions" &&
      response.request().method() === "POST"
    )
      wire.first = await response.json();
  });
  return wire;
}

for (const view of ["graph", "overall", "node"] as const)
  test(`every member of ${view}'s answer and frames is one the contract names`, async ({
    page,
  }) => {
    const served = await serve(world);
    try {
      const wire = await record(page);
      const node = view === "node" ? world.facts.large.busiestNode : undefined;
      await page.goto(
        `${served.origin}${addressOf(world.facts.openLiveRun, view, node)}`,
      );
      await expect
        .poll(() => wire.first !== undefined, { timeout: 60_000 })
        .toBe(true);
      await expect(page.getByText(HISTORY_LOADING)).toHaveCount(0, {
        timeout: 120_000,
      });
      await expect
        .poll(() => wire.frames.some(({ event }) => event === "detail.patch"), {
          timeout: 60_000,
        })
        .toBe(true);
      const parsed = subscribedSchema.parse(wire.first);
      expect(parsed.initial.type).toBe("snapshot");
      if (parsed.initial.type !== "snapshot") return;
      expect(visibleViolations(parsed.initial.snapshot.visible)).toStrictEqual(
        [],
      );
      const scope = view === "overall" ? "run" : "node";
      for (const { data } of wire.frames) {
        const frame = subscriptionFrameSchema.parse(data);
        if (frame.type === "detail.patch" || frame.type === "timeline.patch") {
          expect(frameCarriesWholeEvents(frame, scope), `${frame.type}`).toBe(
            false,
          );
        }
      }
      // Asked for nothing while the reader did nothing.
      expect(wire.pages).toStrictEqual([]);
    } finally {
      await stop(served);
    }
  });

test("a page request goes out only when the reader scrolls back", async ({
  page,
}) => {
  const served = await serve(world);
  try {
    const wire = await record(page);
    await page.goto(
      `${served.origin}${addressOf(world.facts.openLiveRun, "node", world.facts.large.busiestNode)}`,
    );
    const load = page.getByRole("button", { name: "Load earlier rows" });
    await load.waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1_000);
    expect(wire.pages).toStrictEqual([]);
    const answered = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/timeline/events"),
    );
    await load.click();
    const body = timelineEventsPageSchema.parse(await (await answered).json());
    expect(body.rows.length).toBeGreaterThan(0);
    expect(wire.pages).toHaveLength(1);
  } finally {
    await stop(served);
  }
});

const FAILURE_VIEWPORTS = [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const;

async function recovers(page: Page, served: Served) {
  const tryAgain = page.getByRole("button", { name: "Try again" }).first();
  await expect(tryAgain).toBeVisible();
  await expect(tryAgain).toBeInViewport();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await tryAgain.click();
  await expect(metricText(page, "Status")).toHaveText(/\S/u, {
    timeout: 60_000,
  });
  void served;
}

for (const [name, viewport] of FAILURE_VIEWPORTS) {
  // llmlint: ignore-block[e2e_not_mocked, tests_mirror_real_usage] the task's acceptance criteria make the network boundary this journey's only doubled party, standing in for a slow host and a third-party proxy; the server, the release build and the corpus are real, and nothing in the page or the client is replaced. A held, failed, 524 or unanswered first answer and a stream never opened are what a host or proxy does to a real read, and `progress.failed` is the contract's field as the server sets it when its complete read fails, which `tests/e2e/live.rs`'s `a_complete_read_that_fails_keeps_the_screen_says_why_and_a_later_tab_retries` causes for real on the server; here the browser's handling of that served field is what is held.
  test.describe(`at ${name} width`, () => {
    test.use({ viewport });
    const url = (served: Served) =>
      `${served.origin}${addressOf(world.facts.openLiveRun, "overall")}`;

    test("no view reads as complete while the first answer is held", async ({
      page,
    }) => {
      const served = await serve(world);
      try {
        await page.route(
          "**/api/v2/subscriptions",
          () => new Promise(() => undefined),
        );
        await page.goto(url(served));
        await expect(page.getByText("Loading execution history")).toBeVisible();
        await expect(metricText(page, "Status")).toHaveCount(0);
      } finally {
        await stop(served);
      }
    });

    for (const [label, status] of [
      ["a failure", 500],
      ["a 524", 524],
    ] as const)
      test(`${label} names what failed and Try again recovers`, async ({
        page,
      }) => {
        const served = await serve(world);
        try {
          await page.route("**/api/v2/subscriptions", (route) =>
            route.request().method() === "POST"
              ? route.fulfill({ status, body: "upstream timed out" })
              : route.continue(),
          );
          await page.goto(url(served));
          await expect(page.getByRole("alert")).toContainText("did not load", {
            timeout: 60_000,
          });
          await recovers(page, served);
        } finally {
          await stop(served);
        }
      });

    test("a first answer never given fails at the client's deadline, recoverably", async ({
      page,
    }) => {
      const served = await serve(world);
      try {
        await page.route("**/api/v2/subscriptions", (route) =>
          route.request().method() === "POST"
            ? new Promise(() => undefined)
            : route.continue(),
        );
        const started = Date.now();
        await page.goto(url(served));
        const alert = page.getByRole("alert");
        await expect(alert).toContainText("did not load", {
          timeout: READ_DEADLINE_MS + 15_000,
        });
        const waited = Date.now() - started;
        expect(waited).toBeGreaterThanOrEqual(READ_DEADLINE_MS - 1_000);
        expect(waited).toBeLessThan(READ_DEADLINE_MS + 15_000);
        await recovers(page, served);
      } finally {
        await stop(served);
      }
    });

    test("a stream never opened fails at the client's deadline, recoverably", async ({
      page,
    }) => {
      const served = await serve(world);
      try {
        await page.route(
          "**/api/v2/events**",
          () => new Promise(() => undefined),
        );
        const started = Date.now();
        await page.goto(url(served));
        const alert = page.getByRole("alert").first();
        await expect(alert).toBeVisible({ timeout: READ_DEADLINE_MS + 15_000 });
        const waited = Date.now() - started;
        expect(waited).toBeGreaterThanOrEqual(READ_DEADLINE_MS - 1_000);
        await recovers(page, served);
      } finally {
        await stop(served);
      }
    });
  });
}

test("progress.failed shows the error and keeps the held screen", async ({
  page,
}) => {
  const served = await serve(world);
  try {
    await page.route("**/api/v2/subscriptions", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const answer = await route.fetch();
      const body = (await answer.json()) as {
        initial: {
          snapshot: {
            visible: { detail: { progress: Record<string, unknown> } };
          };
        };
      };
      body.initial.snapshot.visible.detail.progress.failed =
        "the complete read failed";
      return route.fulfill({ response: answer, json: body });
    });
    await page.goto(
      `${served.origin}${addressOf(world.facts.openLiveRun, "overall")}`,
    );
    await expect(page.getByRole("alert").first()).toContainText(
      "did not load",
      { timeout: 60_000 },
    );
    await expect(page.getByRole("alert").first()).toContainText(
      "the complete read failed",
    );
    await expect(metricText(page, "Status")).toHaveText(/\S/u);
  } finally {
    await stop(served);
  }
});

// llmlint: ignore-end[e2e_not_mocked, tests_mirror_real_usage]

test("a failed page says so at its control, and Try again takes the page", async ({
  page,
}) => {
  const served = await serve(world);
  try {
    let refusing = true;
    // llmlint: ignore[e2e_not_mocked] the acceptance criteria require a failed page to recover at its control: the proxy's 524 is doubled at the network boundary, the journey's only doubled party, and Try again then takes the real server's page.
    await page.route("**/timeline/events**", (route) =>
      refusing ? route.fulfill({ status: 524, body: "" }) : route.continue(),
    );
    await page.goto(
      `${served.origin}${addressOf(world.facts.openLiveRun, "node", world.facts.large.busiestNode)}`,
    );
    const load = page.getByRole("button", { name: "Load earlier rows" });
    await load.waitFor({ timeout: 60_000 });
    await load.click();
    const failed = page
      .getByRole("alert")
      .filter({ hasText: "Earlier rows did not load" });
    await expect(failed).toBeVisible();
    refusing = false;
    await failed.getByRole("button", { name: "Try again" }).click();
    await expect(failed).toHaveCount(0);
    await expect(load).toBeEnabled();
  } finally {
    await stop(served);
  }
});

test("a settled run whose stream sends nothing later reads as loaded, with no error", async ({
  page,
}) => {
  const served = await serve(world);
  try {
    const { smallRun } = world.facts;
    await page.goto(`${served.origin}${addressOf(smallRun, "overall")}`);
    await expect(metricText(page, "Turns")).toHaveText(/^\d+$/u, {
      timeout: 60_000,
    });
    // Past the one deadline, with no later frame: still no error.
    await page.waitForTimeout(READ_DEADLINE_MS + 2_000);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await metricText(page, "Turns").textContent()).toMatch(/^\d+$/u);
  } finally {
    await stop(served);
  }
});

test("a transient append during a read of the wire leaves no whole events", async ({
  page,
}) => {
  const served = await serve(world);
  try {
    const wire = await record(page);
    const run = world.facts.openLiveRun;
    await page.goto(`${served.origin}${addressOf(run, "overall")}`);
    await expect(metricText(page, "Turns")).toHaveText(/^\d+$/u, {
      timeout: 120_000,
    });
    appendTo(
      world,
      run,
      world.facts.large.busiestNode,
      "turn-activity",
      "wire-stream",
      0,
      toolPayload(1),
    );
    await expect
      .poll(() => wire.frames.length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    for (const { event, data } of wire.frames) {
      if (event !== "timeline.patch") continue;
      const frame = subscriptionFrameSchema.parse(data);
      if (!("ops" in frame)) throw new Error("a timeline.patch with no ops");
      expect(frameCarriesWholeEvents(frame, "run")).toBe(false);
    }
    await completeDocuments(served, run);
  } finally {
    await stop(served);
  }
});
