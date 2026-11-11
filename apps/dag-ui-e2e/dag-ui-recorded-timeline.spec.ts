import {
  API_V2_PATHS,
  parseRunTimeline,
  subscribedSchema,
} from "@onepipeline-ui/dag-model";
import { expect, type Locator, type Page, test } from "@playwright/test";
import corpus from "./fixtures/timeline-recorded.json" with { type: "json" };
import { loadAllEarlierRows, loadRunRecords } from "./observatory-locators";
import { SERVED_UI_URL } from "./playwright.config";

const nodeUrl = `/?run=${corpus.run_id}&node=${corpus.node}`;

/**
 * The instant a timeline's plot ends at, read as a reader reads it: the
 * crosshair's time with the pointer at the plot's right edge.
 */
async function plotEnd(page: Page, timeline: Locator): Promise<number> {
  await timeline.scrollIntoViewIfNeeded();
  const plot = timeline.getByLabel(
    "Timeline plot. Scroll to zoom or drag to select a range.",
  );
  const box = await plot.boundingBox();
  if (box === null) throw new Error("a plot drawn nowhere");
  await page.mouse.move(box.x + box.width - 0.5, box.y + box.height / 2);
  const crosshair = timeline.getByLabel("Timeline crosshair");
  await expect(crosshair).toBeVisible();
  const [stamp = ""] = ((await crosshair.textContent()) ?? "")
    .trim()
    .split(" ");
  await page.mouse.move(box.x + box.width / 2, box.y - 40);
  return Date.parse(stamp);
}

/** How far one pixel of a plot `width` wide spans, over `span` milliseconds. */
const pixelOf = (span: number, width: number) => Math.ceil(span / width) + 1;

/**
 * The name a record's row is opened by: a tool call's one line as the server
 * described it, and any other record's kind.
 */
const rowLabel = (event: {
  readonly kind: string;
  readonly description?: string | undefined;
}): string =>
  event.kind === "turn-activity" && event.description
    ? event.description
    : event.kind;

test("recorded worker and drafter retain their records, intervals and kind-specific panels", async ({
  page,
  request,
}) => {
  const response = await request.get(
    `${SERVED_UI_URL}/api/v2/runs/${corpus.run_id}/timeline?scope=node&node=${corpus.node}`,
  );
  expect(response.ok()).toBe(true);
  const served = parseRunTimeline(await response.json());
  await page.goto(nodeUrl);
  const worker = page.getByRole("region", { name: "Dispatch 1", exact: true });
  const drafter = page.getByRole("region", {
    name: "Change request drafter",
    exact: true,
  });
  await expect(worker).toBeVisible();
  await expect(drafter).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Dispatch 2", exact: true }),
  ).toHaveCount(0);
  for (const kind of [
    "session-opened",
    "graph-started",
    "member-started",
    "member-heartbeat",
    "turn-activity",
    "gate-run",
    "session-closed",
  ]) {
    const recorded = served.spans
      .flatMap((span) => span.events)
      .find((event) => event.kind === kind);
    const label = recorded === undefined ? kind : rowLabel(recorded);
    await expect(
      worker
        .getByRole("button", { name: `Open ${label}`, exact: true })
        .first(),
    ).toBeAttached();
  }
  for (const kind of ["graph-started", "member-started", "turn-started"]) {
    await expect(
      drafter
        .getByRole("button", { name: `Open ${kind}`, exact: true })
        .first(),
    ).toBeAttached();
  }
  for (const group of [worker, drafter]) {
    const stamps = await group
      .getByRole("article")
      .filter({
        has: page.getByRole("button", {
          name: /^Open (?:node-|session-|graph-|member-|turn-|gate-)/,
        }),
      })
      .getByRole("time")
      .evaluateAll((times) =>
        times.map((time) => Date.parse(time.getAttribute("datetime") ?? "")),
      );
    expect(stamps.length).toBeGreaterThan(0);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  }
  for (const kind of ["gate-run", "session-closed", "node-dispatched"]) {
    const record = served.spans
      .flatMap((span) => span.events)
      .find((event) => event.kind === kind);
    const expectedFields: Readonly<Record<string, readonly string[]>> = {
      "gate-run": ["Gate", "Result", "Duration (seconds)"],
      "session-closed": ["Branch"],
      "node-dispatched": ["Attempt", "Persona"],
    };
    expect(Object.keys(record?.fields ?? {})).toEqual(expectedFields[kind]);
    expect(record?.fields).toBeDefined();
    await worker
      .getByRole("button", { name: `Open ${kind}`, exact: true })
      .first()
      .click();
    const panel = page.getByRole("region", { name: "Timeline item detail" });
    await expect(panel).not.toContainText(/still running/i);
    for (const key of Object.keys(record?.fields ?? {}))
      await expect(
        panel.getByRole("term").filter({ hasText: key }),
      ).toBeVisible();
    const labels = await panel.getByRole("term").allTextContents();
    expect(labels).toEqual([
      "Recorded at",
      ...Object.keys(record?.fields ?? {}),
    ]);
    await page
      .getByRole("button", { name: "Close detail", exact: true })
      .click();
  }
  await expect(
    page.getByRole("tab", { name: "Agents", exact: true }),
  ).toHaveCount(0);
  const timeline = page.getByRole("region", {
    name: "Node timeline",
    exact: true,
  });
  for (const role of ["worker", "pr-author"]) {
    const span = served.spans.find((span) => span.agent_role === role);
    expect(span?.ended_at).not.toBeNull();
    const row = page
      .getByRole("button", { name: new RegExp(`^Open ${role} \\(`) })
      .first();
    await expect(row.getByRole("time")).toHaveAttribute(
      "datetime",
      span?.started_at ?? "",
    );
  }
  for (const expanded of [false, true]) {
    if (expanded)
      await timeline.getByRole("button", { name: "Expand timeline" }).click();
    for (const role of ["worker", "pr-author"]) {
      const span = served.spans.find((span) => span.agent_role === role);
      if (span === undefined || span.ended_at === null)
        throw new Error("closed session");
      await timeline
        .getByRole("button", { name: new RegExp(`^${role} \\(`) })
        .focus();
      const tooltip = page.getByRole("tooltip");
      await expect(tooltip).toContainText(
        `Start: ${new Date(span.started_at).toISOString()}`,
      );
      await expect(tooltip).toContainText(
        `End: ${new Date(span.ended_at).toISOString()}`,
      );
    }
  }
});

test("Overall ends at settlement and keeps the late completion as a marker", async ({
  page,
  request,
}) => {
  const response = await request.get(
    `${SERVED_UI_URL}/api/v2/runs/${corpus.run_id}/timeline?scope=run`,
  );
  const served = parseRunTimeline(await response.json());
  const settlement = corpus.records.find(
    (record) => record.kind === "node-settled",
  );
  expect(served.spans.find((span) => span.kind === "run")?.ended_at).toBe(
    settlement?.ts,
  );
  await page.goto(`/?run=${corpus.run_id}&view=overall`);
  const executionEnd = settlement?.ts;
  if (executionEnd === undefined) throw new Error("settlement");
  // The plot ends at the settlement: the crosshair at its right edge reads it.
  const overall = page.getByRole("region", {
    name: "Graph timeline",
    exact: true,
  });
  const ended = await plotEnd(page, overall);
  const started = Date.parse(
    served.spans.find((span) => span.kind === "run")?.started_at ?? "",
  );
  const width = (await overall.boundingBox())?.width ?? 1;
  expect(Math.abs(ended - Date.parse(executionEnd))).toBeLessThanOrEqual(
    pixelOf(Date.parse(executionEnd) - started, width),
  );
  // The fixed journal has pre-worker, post-drafter and post-publication
  // silence. Assert each interval, including the settlement closing the last.
  const recordedAt = (kind: string, persona?: string) => {
    const record = corpus.records.find(
      (record) =>
        record.kind === kind &&
        (persona === undefined ||
          ("persona" in record.labels && record.labels.persona === persona)),
    );
    if (record === undefined) throw new Error(`recorded ${kind}`);
    return new Date(record.ts).toISOString();
  };
  const expectedIdle = [
    [recordedAt("run-started"), recordedAt("graph-started", "engineer")],
    [recordedAt("graph-settled", "pr-author"), recordedAt("gate-run")],
    [recordedAt("session-closed"), recordedAt("node-settled")],
  ];
  const graph = page.getByRole("region", {
    name: "Graph timeline",
    exact: true,
  });
  const idle = graph.getByRole("button", { name: /^Idle · / });
  await expect(idle).toHaveCount(expectedIdle.length);
  for (const [index, interval] of (await idle.all()).entries()) {
    await interval.focus();
    await expect(page.getByRole("tooltip")).toContainText(
      `Start: ${expectedIdle[index]?.[0]}`,
    );
    await expect(page.getByRole("tooltip")).toContainText(
      `End: ${expectedIdle[index]?.[1]}`,
    );
  }
  await loadRunRecords(page);
  const late = page.getByRole("region", { name: "Records after execution" });
  await expect(late).toBeVisible();
  await late.getByRole("button", { name: /completion-requested/ }).click();
  await expect(
    page.getByRole("region", { name: "Timeline item detail" }),
  ).toContainText("Recorded late closure");
  await expect(
    page.getByRole("tab", { name: "Agents", exact: true }),
  ).toHaveCount(0);
});

for (const terminal of corpus.terminations) {
  test(`Overall closes open work at ${terminal.kind}, before every late command`, async ({
    page,
    request,
  }) => {
    const run = `${corpus.run_id}-${terminal.kind}`;
    const response = await request.get(
      `${SERVED_UI_URL}/api/v2/runs/${run}/timeline?scope=run`,
    );
    const served = parseRunTimeline(await response.json());
    const end = corpus.records.find(
      (record) => record.kind === "node-settled",
    )?.ts;
    expect(served.spans.find((span) => span.kind === "run")?.ended_at).toBe(
      end,
    );
    expect(served.spans.every((span) => span.ended_at !== null)).toBe(true);
    await page.goto(`/?run=${run}&view=overall`);
    await loadRunRecords(page);
    const late = page.getByRole("region", { name: "Records after execution" });
    for (const kind of [
      "completion-requested",
      "planner-replied",
      "edit-committed",
    ]) {
      await expect(
        late.getByRole("button", { name: new RegExp(kind) }),
      ).toBeVisible();
    }
    const graph = page.getByRole("region", {
      name: "Graph timeline",
      exact: true,
    });
    if (end === undefined) throw new Error("execution end");
    // The plot ends at the terminal record: the crosshair at its right edge
    // reads it.
    const ended = await plotEnd(page, graph);
    const started = Date.parse(
      served.spans.find((span) => span.kind === "run")?.started_at ?? "",
    );
    const width = (await graph.boundingBox())?.width ?? 1;
    expect(Math.abs(ended - Date.parse(end))).toBeLessThanOrEqual(
      pixelOf(Date.parse(end) - started, width),
    );
    await late.getByRole("button", { name: /completion-requested/ }).click();
    await expect(
      page.getByRole("region", { name: "Timeline item detail" }),
    ).not.toContainText(/still running/i);
    await page.keyboard.press("Escape");
    await late.getByRole("button", { name: /planner-replied/ }).click();
    const replyPanel = page.getByRole("region", {
      name: "Timeline item detail",
    });
    await expect(replyPanel.getByRole("term")).toHaveText([
      "Recorded at",
      "Author",
      "Completion",
      "Reason",
    ]);
    await expect(replyPanel).toContainText("Recorded late closure");
    await expect(replyPanel).not.toContainText(/still running/i);
    await page.keyboard.press("Escape");
    await graph.getByRole("button", { name: "Expand timeline" }).click();
    const runLevel = page.getByRole("region", {
      name: "Run-level timeline",
      exact: true,
    });
    await runLevel
      .getByRole("button", {
        name: new RegExp(`^Run-level · ${terminal.kind}, marker$`),
      })
      .click();
    const terminalFields: Readonly<Record<string, readonly string[]>> = {
      "run-stopped": ["Owner", "Forced"],
      "host-shutdown": ["Scope", "Owner", "Teardown"],
      "driver-exited": ["Settlement"],
    };
    const terminalPanel = page.getByRole("region", {
      name: "Timeline item detail",
    });
    await expect(terminalPanel.getByRole("term")).toHaveText([
      "Recorded at",
      ...(terminalFields[terminal.kind] ?? []),
    ]);
    expect(
      await terminalPanel.getByRole("definition").allTextContents(),
    ).not.toContain("");
    await expect(terminalPanel).not.toContainText(/still running/i);
  });
}

test("a node's unloaded history is hatched over exactly the rows its window left out, and goes once they are read", async ({
  page,
  request,
}) => {
  const replay = await import("./fixtures/timeline-retries.json", {
    with: { type: "json" },
  });
  const fixture = replay.default;
  const served = parseRunTimeline(
    await (
      await request.get(
        `${SERVED_UI_URL}/api/v2/runs/${fixture.run_id}/timeline?scope=node&node=${fixture.node}`,
      )
    ).json(),
  );
  const answered = page.waitForResponse((response) => {
    if (new URL(response.url()).pathname !== API_V2_PATHS.subscriptions)
      return false;
    return response.request().postDataJSON()?.view?.scope === "node";
  });
  await page.goto(`/?run=${fixture.run_id}&node=${fixture.node}`);
  const subscribed = subscribedSchema.parse(await (await answered).json());
  if (
    subscribed.initial.type !== "snapshot" ||
    subscribed.initial.snapshot.visible.type !== "timeline"
  )
    throw new Error("the node was not answered with a timeline snapshot");
  const window = parseRunTimeline(subscribed.initial.snapshot.visible.timeline);
  const held = new Set(
    window.spans.flatMap((span) => span.events.map((event) => event.id)),
  );
  // What the window left out, as the complete document lists it.
  const missing = served.spans
    .flatMap((span) => span.events)
    .filter((event) => !held.has(event.id))
    .map((event) => Date.parse(event.at));
  expect(missing.length).toBeGreaterThan(0);
  const plot = page
    .getByRole("region", { name: "Node timeline" })
    .getByLabel(/^Timeline plot/u)
    .first();
  // llmlint: ignore-block[e2e_uses_accessible_selectors] a hatch is a drawn overlay with no role of its own; its words are read by text below, and its bounds are the data attributes the plot draws it from.
  const hatches = page.locator(".history-hatch");
  // The app's own plot, once it has replaced the first screen's.
  await expect(page.locator(".first-plot")).toHaveCount(0);
  await expect(hatches.first()).toBeVisible();
  const bounds = await hatches.evaluateAll((elements) =>
    elements.map((element): [number, number] => [
      Number(element.getAttribute("data-from")),
      Number(element.getAttribute("data-to")),
    ]),
  );
  // llmlint: ignore-end[e2e_uses_accessible_selectors]
  for (const hatch of await hatches.all())
    await expect(hatch).toContainText("Still loading");
  // Every left-out row falls inside a hatch, so nothing unloaded reads as empty.
  for (const at of missing)
    expect(
      bounds.some(([from, to]) => at >= from && at <= to),
      `a row at ${new Date(at).toISOString()} outside every hatch ${JSON.stringify(bounds)}`,
    ).toBe(true);
  // Each hatch ends where the window's own rows begin, so nothing held is covered.
  const heldStarts = new Set(
    window.spans.flatMap((span) =>
      span.events.length === 0 ? [] : [Date.parse(span.events[0]?.at ?? "")],
    ),
  );
  for (const [, to] of bounds) expect(heldStarts.has(to)).toBe(true);
  // And it is drawn on the plot, inside its width.
  const area = await plot.boundingBox();
  if (area === null) throw new Error("no plot");
  for (const hatch of await hatches.all()) {
    const box = await hatch.boundingBox();
    if (box === null) throw new Error("a hatch with no box");
    expect(box.width).toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(area.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width + 1);
  }
  // Read back through the page's own control, nothing is left unloaded.
  await loadAllEarlierRows(page);
  await expect(hatches).toHaveCount(0);
});

/** Every page of a run's history the page asks for, as it asks. */
function historyAsks(page: Page): URL[] {
  const asked: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/timeline/events")) asked.push(url);
  });
  return asked;
}

/** The retries fixture's node, opened and drawn by the app itself. */
async function openRetriesNode(page: Page) {
  const replay = await import("./fixtures/timeline-retries.json", {
    with: { type: "json" },
  });
  const fixture = replay.default;
  await page.goto(`/?run=${fixture.run_id}&node=${fixture.node}`);
  // llmlint: ignore[e2e_uses_accessible_selectors] the first screen's plot carries the same name as the app's; its class is the only thing telling the two apart, and the journey waits for the app's.
  await expect(page.locator(".first-plot")).toHaveCount(0);
  const plot = page
    .getByRole("region", { name: "Node timeline" })
    .getByLabel(/^Timeline plot/u)
    .first();
  await expect(plot).toBeVisible();
  return { fixture, plot };
}

test("zooming a node's plot asks for that stretch of its rows, and a failed stretch recovers by Try again", async ({
  page,
}) => {
  const asked = historyAsks(page);
  let failed = 0;
  // llmlint: ignore-block[e2e_not_mocked, tests_mirror_real_usage] the network boundary is the only doubled party: the first stretch read is answered 503 as a failing host answers it, and every other read reaches the real server.
  await page.route("**/timeline/events?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("from") && failed === 0) {
      failed += 1;
      return route.fulfill({ status: 503, body: "unavailable" });
    }
    return route.continue();
  });
  // llmlint: ignore-end[e2e_not_mocked, tests_mirror_real_usage]
  const { fixture, plot } = await openRetriesNode(page);
  expect(asked.filter((url) => url.searchParams.has("from"))).toHaveLength(0);
  // llmlint: ignore[e2e_uses_accessible_selectors] the plot's spans are positioned SVG geometry that no role or name carries; the journey only finds where one is drawn and then zooms there with the pointer, as a person does.
  const shape = plot.locator('[data-timeline-shape="span"]').first();
  const bounds = await shape.boundingBox();
  if (bounds === null) throw new Error("the node's plot has no span drawn");
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -240);
  await page.keyboard.up("Control");
  await expect
    .poll(() => asked.filter((url) => url.searchParams.has("from")).length)
    .toBeGreaterThan(0);
  const stretch = asked.find((url) => url.searchParams.has("from"));
  expect(stretch?.searchParams.get("scope")).toBe("node");
  expect(stretch?.searchParams.get("node")).toBe(fixture.node);
  expect(Date.parse(stretch?.searchParams.get("from") ?? "")).toBeLessThan(
    Date.parse(stretch?.searchParams.get("to") ?? ""),
  );
  // The failed read says so at the transcript's control, and Try again reads it.
  const alert = page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("alert");
  await expect(alert).toContainText("Earlier rows did not load");
  const before = asked.length;
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect
    .poll(() =>
      asked
        .slice(before)
        .some(
          (url) =>
            url.searchParams.get("from") === stretch?.searchParams.get("from"),
        ),
    )
    .toBe(true);
  await expect(alert).toHaveCount(0);
});

test("scrolling a node's transcript up to its top asks for the rows before it and draws them", async ({
  page,
}) => {
  const asked = historyAsks(page);
  await openRetriesNode(page);
  const transcript = page.getByRole("region", { name: "Node transcript" });
  const rows = transcript.getByRole("article");
  await expect(rows.first()).toBeVisible();
  const shown = await rows.count();
  const paged = () =>
    asked.filter(
      (url) =>
        !url.searchParams.has("from") &&
        !url.searchParams.has("span") &&
        url.searchParams.get("scope") === "node",
    ).length;
  expect(paged()).toBe(0);
  // Scrolled as a person scrolls, with the wheel over the transcript: down into
  // the rows it opens on, then back up to its top.
  await transcript.hover();
  await expect(async () => {
    await page.mouse.wheel(0, 600);
    expect(
      await transcript.evaluate((element) => element.scrollTop),
    ).toBeGreaterThan(120);
  }).toPass();
  expect(paged()).toBe(0);
  await expect(async () => {
    await page.mouse.wheel(0, -2000);
    expect(paged()).toBeGreaterThan(0);
  }).toPass();
  await expect.poll(() => rows.count()).toBeGreaterThan(shown);
});

// A transcript already at its top scrolls no further, so the browser reports no
// scroll for a reader who wheels or keys up there again: the ask has to come from
// that gesture itself, or a reader who reached the top while a page could not be
// asked (CI run 42978308166) is left with no way to the rows before it.
for (const [how, gesture] of [
  ["wheels up", (page: Page) => page.mouse.wheel(0, -600)],
  ["presses Home", (page: Page) => page.keyboard.press("Home")],
] as const)
  test(`a reader already at the transcript's top who ${how} is shown the rows before it`, async ({
    page,
  }) => {
    const asked = historyAsks(page);
    await openRetriesNode(page);
    const transcript = page.getByRole("region", { name: "Node transcript" });
    const rows = transcript.getByRole("article");
    await expect(rows.first()).toBeVisible();
    const shown = await rows.count();
    const paged = () =>
      asked.filter(
        (url) =>
          !url.searchParams.has("from") &&
          !url.searchParams.has("span") &&
          url.searchParams.get("scope") === "node",
      ).length;
    // Opened at its top, with nothing asked yet.
    expect(await transcript.evaluate((element) => element.scrollTop)).toBe(0);
    expect(paged()).toBe(0);
    await transcript.hover();
    await transcript.focus();
    await gesture(page);
    await expect.poll(paged).toBeGreaterThan(0);
    await expect.poll(() => rows.count()).toBeGreaterThan(shown);
  });

test("retries, equal timestamps and repeated relays keep every record under its served identity", async ({
  page,
  request,
}) => {
  const replay = await import("./fixtures/timeline-retries.json", {
    with: { type: "json" },
  });
  const fixture = replay.default;
  const response = await request.get(
    `${SERVED_UI_URL}/api/v2/runs/${fixture.run_id}/timeline?scope=node&node=${fixture.node}`,
  );
  const served = parseRunTimeline(await response.json());
  const own = served.spans.find((span) => span.kind === "node");
  if (own === undefined) throw new Error("node timeline");
  await page.goto(`/?run=${fixture.run_id}&node=${fixture.node}`);
  const groups = [
    "Dispatch 1",
    "Change request drafter",
    "Dispatch 2",
    "Review reply drafter",
  ];
  for (const name of groups)
    await expect(
      page.getByRole("region", { name, exact: true }),
    ).toBeAttached();
  await expect(
    page.getByRole("region", { name: "Dispatch 3", exact: true }),
  ).toHaveCount(0);
  // A node's first answer holds each span's latest rows, so the ones before them
  // are read through the page's own control before every record is counted.
  await loadAllEarlierRows(page);
  for (const button of await page
    .getByRole("button", { name: /more .* events/ })
    .all())
    await button.click();
  const headings = await page
    .getByRole("heading", { level: 3 })
    .filter({
      hasText: /^(Dispatch \d+|Change request drafter|Review reply drafter)$/,
    })
    .allTextContents();
  expect(headings).toEqual(groups);
  for (const name of groups) {
    const group = page.getByRole("region", { name, exact: true });
    const stamps = await group
      .getByRole("article")
      .filter({
        has: page.getByRole("button", {
          name: /^Open (?:node-|session-|graph-|member-|turn-|gate-)/,
        }),
      })
      .getByRole("time")
      .evaluateAll((times) =>
        times.map((time) => Date.parse(time.getAttribute("datetime") ?? "")),
      );
    expect(stamps.length).toBeGreaterThan(0);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  }
  const identity = fixture.records.find(
    (record) => record.kind === "session-opened",
  );
  if (identity === undefined) throw new Error("recorded session opening");
  expect(
    own.events.filter(
      (event) => event.stream === identity.stream && event.seq === identity.seq,
    ),
  ).toHaveLength(1);
  for (const [index, name] of ["Dispatch 1", "Dispatch 2"].entries()) {
    const group = page.getByRole("region", { name, exact: true });
    for (const kind of [
      "session-opened",
      "graph-started",
      "member-started",
      "member-heartbeat",
      "turn-activity",
      "gate-run",
      "session-closed",
    ]) {
      const labels = own.events
        .filter(
          (event) =>
            event.kind === kind &&
            event.persona === "engineer" &&
            (index === 1
              ? event.stream?.endsWith("-retry")
              : !event.stream?.endsWith("-retry")),
        )
        .map(rowLabel);
      for (const label of new Set(labels.length === 0 ? [kind] : labels))
        await expect(
          group.getByRole("button", { name: `Open ${label}`, exact: true }),
        ).toHaveCount(labels.filter((each) => each === label).length);
    }
  }
  for (const name of ["Change request drafter", "Review reply drafter"]) {
    await expect(
      page
        .getByRole("region", { name, exact: true })
        .getByRole("button", { name: "Open session-opened", exact: true }),
    ).toHaveCount(1);
  }
  const tied = own.events.filter(
    (event) =>
      event.kind === "turn-activity" && event.stream?.endsWith("-retry"),
  );
  expect(tied[0]?.at).toBe(tied[1]?.at);
  expect(tied[0]?.journal_order).toBeLessThan(tied[1]?.journal_order ?? 0);
  const activityButtons = page
    .getByRole("region", { name: "Dispatch 2", exact: true })
    .getByRole("button", {
      name: `Open ${tied[0] === undefined ? "turn-activity" : rowLabel(tied[0])}`,
      exact: true,
    });
  for (const index of [0, 1]) {
    await activityButtons.nth(index).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("event"))
      .toBe(tied[index]?.record_id);
    await page.keyboard.press("Escape");
  }
  const failure = own.events.find((event) => event.kind === "member-died");
  expect(failure?.fields).toBeDefined();
  await page
    .getByRole("button", { name: "Open member-died", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Timeline item detail" })
      .getByRole("term"),
  ).toHaveText(["Recorded at", ...Object.keys(failure?.fields ?? {})]);
  await page.keyboard.press("Escape");
  const outside = own.events.find((event) => event.kind === "node-ready");
  expect(outside).toBeDefined();
  await expect(
    page.getByRole("button", { name: "Open node-ready", exact: true }),
  ).toHaveCount(1);
  for (const name of groups)
    await expect(
      page
        .getByRole("region", { name, exact: true })
        .getByRole("button", { name: "Open node-ready", exact: true }),
    ).toHaveCount(0);
});

test("every served record fact appears in its panel without empty or unrelated rows", async ({
  page,
  request,
}) => {
  const response = await request.get(
    `${SERVED_UI_URL}/api/v2/runs/${corpus.run_id}/timeline?scope=node&node=${corpus.node}`,
  );
  const timeline = parseRunTimeline(await response.json());
  const events =
    timeline.spans.find((span) => span.kind === "node")?.events ?? [];
  const seen = new Set<string>();
  for (const event of events) {
    if (
      seen.has(event.kind) ||
      (event.fields === undefined && event.kind !== "member-heartbeat")
    )
      continue;
    seen.add(event.kind);
    await page.goto(
      `${nodeUrl}&event=${encodeURIComponent(event.record_id ?? event.id)}`,
    );
    const panel = page.getByRole("region", { name: "Timeline item detail" });
    await expect(panel).toContainText("Recorded at");
    for (const field of Object.keys(event.fields ?? {}))
      await expect(
        panel.getByText(field, { exact: true }).first(),
      ).toBeVisible();
    await expect(panel).not.toContainText(/still running/i);
    expect(await panel.getByRole("definition").allTextContents()).not.toContain(
      "",
    );
    for (const unrelated of ["Token", "Worktree", "Config"])
      await expect(
        panel.getByRole("term").filter({ hasText: unrelated }),
      ).toHaveCount(0);
  }
  expect(seen.size).toBeGreaterThanOrEqual(13);
});

test("Overall excludes work that starts after execution and clips work crossing its end", async ({
  page,
  request,
}) => {
  const run = `${corpus.run_id}-clipping`;
  const response = await request.get(
    `${SERVED_UI_URL}/api/v2/runs/${run}/timeline?scope=run`,
  );
  const served = parseRunTimeline(await response.json());
  const ended = served.spans.find((span) => span.kind === "run")?.ended_at;
  if (ended === undefined || ended === null) throw new Error("execution ended");
  const end = Date.parse(ended);
  const late = served.spans.filter((span) => Date.parse(span.started_at) > end);
  expect(late.length).toBeGreaterThan(0);
  const crossing = served.spans.find(
    (span) =>
      span.kind === "publication" &&
      Date.parse(span.started_at) < end &&
      span.ended_at !== null &&
      Date.parse(span.ended_at) > end,
  );
  expect(crossing).toBeDefined();
  await page.goto(`/?run=${run}&view=overall`);
  await page
    .getByRole("region", { name: "Graph timeline", exact: true })
    .getByRole("button", { name: "Expand timeline" })
    .click();
  const node = page.getByRole("region", {
    name: `${corpus.node} timeline`,
    exact: true,
  });
  await node.getByRole("button", { name: "Expand timeline" }).click();
  // Late gate records remain markers. Only verifications that began during
  // execution can contribute a bar to this row.
  expect(late.every((span) => span.kind === "verification")).toBe(true);
  await expect(
    node.getByRole("button", { name: /Verification, span/ }),
  ).toHaveCount(
    served.spans.filter(
      (span) =>
        span.kind === "verification" && Date.parse(span.started_at) <= end,
    ).length,
  );
  const publication = node.getByRole("button", { name: /Publication, span/ });
  await publication.focus();
  await expect(page.getByRole("tooltip")).toContainText(
    `End: ${new Date(end).toISOString()}`,
  );
});

test("late edit panels show populated edit facts without adding work", async ({
  page,
  request,
}) => {
  const run = `${corpus.run_id}-run-stopped`;
  const response = await request.get(
    `${SERVED_UI_URL}/api/v2/runs/${run}/timeline?scope=run`,
  );
  const timeline = parseRunTimeline(await response.json());
  const event = timeline.spans
    .flatMap((span) => span.events)
    .find((event) => event.kind === "edit-committed");
  expect(event?.fields).toEqual({
    Author: "planner",
    Operations: [{ kind: "task-amended", node: corpus.node }],
    "Operation kinds": ["task-amended"],
  });
  await page.goto(`/?run=${run}&view=overall`);
  await loadRunRecords(page);
  await page
    .getByRole("region", { name: "Records after execution" })
    .getByRole("button", { name: /edit-committed/ })
    .click();
  const panel = page.getByRole("region", { name: "Timeline item detail" });
  await expect(panel.getByRole("term")).toHaveText([
    "Recorded at",
    "Author",
    "Operations",
    "Operation kinds",
  ]);
  const values = await panel.getByRole("definition").allTextContents();
  expect(values).not.toContain("");
  expect(values.slice(1)).toEqual([
    "planner",
    JSON.stringify([{ kind: "task-amended", node: corpus.node }]),
    JSON.stringify(["task-amended"]),
  ]);
  await expect(panel).not.toContainText(/still running/i);
});

test("harness-only intervals and points open transcripts without consuming work or idle", async ({
  page,
}) => {
  const graph = page.getByRole("region", {
    name: "Graph timeline",
    exact: true,
  });
  const idleLabels = () =>
    graph
      .getByRole("button", { name: /^Idle · / })
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      );
  await page.goto(`/?run=${corpus.run_id}&view=overall`);
  await expect(
    graph.getByRole("button", { name: /^Idle · / }).first(),
  ).toBeVisible();
  const baseline = await idleLabels();
  const run = `${corpus.run_id}-harnesses`;
  await page.goto(`/?run=${run}&view=overall`);
  await expect(
    graph.getByRole("button", { name: /^Idle · / }).first(),
  ).toBeVisible();
  expect(await idleLabels()).toEqual(baseline);
  await graph.getByRole("button", { name: "Expand timeline" }).click();
  const runLevel = page.getByRole("region", {
    name: "Run-level timeline",
    exact: true,
  });
  const runRow = page.getByRole("listitem").filter({ has: runLevel });
  await expect(runRow.getByText(/^0ms recorded · .+ idle$/)).toBeVisible();
  await runLevel.getByRole("button", { name: "Expand timeline" }).click();
  const observer = runLevel.getByRole("button", {
    name: /^Run-level · observer/,
  });
  await observer.focus();
  const first = corpus.records.at(0);
  if (first === undefined) throw new Error("recorded run start");
  const started = Date.parse(first.ts) + 1000;
  await expect(page.getByRole("tooltip")).toContainText(
    `Start: ${new Date(started).toISOString()}`,
  );
  await expect(page.getByRole("tooltip")).toContainText(
    `End: ${new Date(started + 42_000).toISOString()}`,
  );
  await observer.click();
  await expect(
    page.getByRole("region", { name: "Timeline item detail" }),
  ).toContainText("timeline-observer transcript");
  await page.goto(`/?run=${run}&node=${corpus.node}`);
  await page
    .getByRole("button", {
      name: "Open node (timeline-worker · no recorded end)",
      exact: true,
    })
    .click();
  const panel = page.getByRole("region", { name: "Timeline item detail" });
  await expect(panel).toContainText("timeline-worker transcript");
  await expect(panel).not.toContainText(/still running/i);
  await expect(panel).toContainText("no recorded end");
});

test("filtering every dispatch boundary and graph record preserves served groups and numbering", async ({
  page,
}) => {
  const retries = (
    await import("./fixtures/timeline-retries.json", { with: { type: "json" } })
  ).default;
  const run = `${retries.run_id}-filtered`;
  const endpoint = `/api/v2/runs/${run}/timeline?scope=node&node=${retries.node}`;
  const detailedResponse = await page.request.get(endpoint);
  const detailed = parseRunTimeline(await detailedResponse.json());
  const groups = [
    "Dispatch 1",
    "Change request drafter",
    "Dispatch 2",
    "Review reply drafter",
  ];
  const headings = () =>
    page.getByRole("heading", { level: 3 }).filter({
      hasText: /^(Dispatch \d+|Change request drafter|Review reply drafter)$/,
    });
  await page.goto(`/?run=${run}&node=${retries.node}`);
  await expect(headings()).toHaveText(groups);
  // The node's timeline under the decisions profile, as the subscription the
  // switch makes is answered with it.
  const narrowed = page.waitForResponse((response) => {
    if (new URL(response.url()).pathname !== API_V2_PATHS.subscriptions)
      return false;
    const view = response.request().postDataJSON()?.view;
    return view?.scope === "node" && view?.filter === "planner";
  });
  await page
    .getByRole("group", { name: "Level of detail" })
    .getByRole("button", { name: "Decisions" })
    .click();
  const subscribed = subscribedSchema.parse(await (await narrowed).json());
  if (
    subscribed.initial.type !== "snapshot" ||
    subscribed.initial.snapshot.visible.type !== "timeline"
  )
    throw new Error("the switch was not answered with a timeline snapshot");
  const filtered = parseRunTimeline(
    subscribed.initial.snapshot.visible.timeline,
  );
  const events = filtered.spans.flatMap((span) => span.events);
  expect(events.some((event) => event.kind === "gate-run")).toBe(true);
  expect(
    events.some(
      (event) =>
        ["node-dispatched", "node-settled"].includes(event.kind) ||
        /^(graph-|member-|turn-)/.test(event.kind),
    ),
  ).toBe(false);
  const ownership = (timeline: typeof filtered) =>
    timeline.spans
      .filter((span) => span.kind === "dispatch")
      .map((span) => ({ id: span.id, group: span.dispatch_group }));
  expect(ownership(filtered)).toEqual(ownership(detailed));
  expect(ownership(filtered).every((span) => span.group !== undefined)).toBe(
    true,
  );
  await expect(headings()).toHaveText(groups);
  for (const label of ["Dispatch 1", "Dispatch 2"])
    await expect(
      page
        .getByRole("region", { name: label, exact: true })
        .getByRole("button", { name: "Open gate-run", exact: true }),
    ).toHaveCount(1);
  const activityLabels = detailed.spans
    .flatMap((span) => span.events)
    .filter((event) => event.kind === "turn-activity")
    .map(rowLabel);
  for (const label of new Set([
    "node-dispatched",
    "node-settled",
    "graph-started",
    "member-started",
    ...activityLabels,
  ]))
    await expect(
      page.getByRole("button", { name: `Open ${label}`, exact: true }),
    ).toHaveCount(0);
  await page
    .getByRole("group", { name: "Level of detail" })
    .getByRole("button", { name: "Detailed activity" })
    .click();
  // Back on the detailed reading, the records before its window are asked for again.
  await loadAllEarlierRows(page);
  await expect(
    page.getByRole("button", { name: "Open node-dispatched", exact: true }),
  ).toHaveCount(2);
  await expect(headings()).toHaveText(groups);
});

for (const scope of ["node", "run"] as const) {
  test(`restores a legacy ${scope} event bookmark when producer identity is present`, async ({
    page,
    request,
  }) => {
    const query =
      scope === "node" ? `scope=node&node=${corpus.node}` : "scope=run";
    const response = await request.get(
      `${SERVED_UI_URL}/api/v2/runs/${corpus.run_id}/timeline?${query}`,
    );
    expect(response.ok()).toBe(true);
    const timeline = parseRunTimeline(await response.json());
    const kind = scope === "node" ? "turn-activity" : "completion-requested";
    const event = timeline.spans
      .filter((span) => scope === "node" || span.node_id === undefined)
      .flatMap((span) => span.events)
      .find((event) => event.kind === kind && event.record_id !== event.id);
    if (event?.record_id === undefined)
      throw new Error("producer-addressed event");
    const bookmark = new URLSearchParams({
      run: corpus.run_id,
      event: event.id,
    });
    if (scope === "node") bookmark.set("node", corpus.node);
    else bookmark.set("view", "overall");
    await page.goto(`/?${bookmark}`);
    const detail = page.getByRole("region", { name: "Timeline item detail" });
    await expect(
      detail.getByRole("heading", { name: rowLabel(event), exact: true }),
    ).toBeVisible();
    await expect(detail.getByRole("time").first()).toHaveAttribute(
      "datetime",
      event.at,
    );
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("event")).toBe(false);
  });
}

test("keeps the reading cursor when an open event's timeline is expanded", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(nodeUrl);
  const worker = page.getByRole("region", { name: "Dispatch 1", exact: true });
  const timeline = page.getByRole("region", {
    name: "Node timeline",
    exact: true,
  });
  const cursor = timeline.getByLabel("Timeline cursor", { exact: true });
  await expect(cursor).toBeVisible();
  // Scrolling to the top reads earlier rows, which move the reading: this journey is
  // about the cursor over a transcript already held, so it holds it first.
  await loadAllEarlierRows(page);
  const initialReading = await cursor.getAttribute("style");
  await worker
    .getByRole("button", { name: "Open gate-run", exact: true })
    .first()
    .click();
  const detail = page.getByRole("region", { name: "Timeline item detail" });
  await expect(
    detail.getByRole("heading", { name: "gate-run", exact: true }),
  ).toBeVisible();
  const transcript = page.getByRole("region", { name: "Node transcript" });
  // Opening the event smooth-scrolls the transcript to it, and a wheel that lands
  // mid-animation is absorbed by it. A reader wheels after the reading has come to
  // rest, so wait until the scroll holds still across two frames.
  await transcript.evaluate(
    (element) =>
      new Promise<void>((settled) => {
        let last = -1;
        const check = () => {
          if (element.scrollTop === last) settled();
          else {
            last = element.scrollTop;
            requestAnimationFrame(() => requestAnimationFrame(check));
          }
        };
        check();
      }),
  );
  const bounds = await transcript.boundingBox();
  if (bounds === null) throw new Error("node transcript has no bounds");
  // Wheel over the reading's exposed left edge beside the drawer.
  await page.mouse.move(bounds.x + 10, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, -20_000);
  await expect(
    worker.getByRole("heading", { name: "Dispatch 1", exact: true }),
  ).toBeInViewport();
  await expect(cursor).toHaveAttribute("style", initialReading ?? "");
  // Keyboard activation reaches the control even where the detail overlaps it.
  await timeline.getByRole("button", { name: "Expand timeline" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    timeline.getByRole("button", { name: "Collapse timeline" }),
  ).toBeVisible();
  await expect(cursor).toHaveAttribute("style", initialReading ?? "");
  await expect(detail).toBeVisible();
});
