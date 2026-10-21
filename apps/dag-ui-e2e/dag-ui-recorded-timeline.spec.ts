import { parseRunTimeline } from "@onepipeline-ui/dag-model";
import { expect, test } from "@playwright/test";
import corpus from "./fixtures/timeline-recorded.json" with { type: "json" };
import { SERVED_UI_URL } from "./playwright.config";

const nodeUrl = `/?run=${corpus.run_id}&node=${corpus.node}`;

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
    await expect(
      worker.getByRole("button", { name: `Open ${kind}`, exact: true }).first(),
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
      .locator("article time[datetime]")
      .evaluateAll((times) =>
        times.map((time) => Date.parse(time.getAttribute("datetime") ?? "")),
      );
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
    await expect(panel).not.toContainText("Still running");
    for (const key of Object.keys(record?.fields ?? {}))
      await expect(panel.locator("dt", { hasText: key })).toBeVisible();
    const labels = await panel.locator("dt").allTextContents();
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
    await expect(row.locator("time")).toHaveAttribute(
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
  const clock = await page.evaluate(
    (stamp) =>
      new Date(stamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    executionEnd,
  );
  await expect(
    page
      .getByRole("region", { name: "Graph timeline", exact: true })
      .getByTestId("timeline-axis")
      .locator("span")
      .last(),
  ).toContainText(clock);
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
    const ticks = graph.getByTestId("timeline-axis");
    if (end === undefined) throw new Error("execution end");
    const clock = await page.evaluate(
      (stamp) =>
        new Date(stamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      end,
    );
    await expect(ticks.locator("span").last()).toContainText(clock);
    await late.getByRole("button", { name: /completion-requested/ }).click();
    await expect(
      page.getByRole("region", { name: "Timeline item detail" }),
    ).not.toContainText("Still running");
  });
}

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
  for (const button of await page
    .getByRole("button", { name: /more .* events/ })
    .all())
    await button.click();
  const headings = await page
    .locator(".transcript-dispatch > h3")
    .allTextContents();
  expect(headings).toEqual(groups);
  for (const name of groups) {
    const group = page.getByRole("region", { name, exact: true });
    const stamps = await group
      .locator("article time[datetime]")
      .evaluateAll((times) =>
        times.map((time) => Date.parse(time.getAttribute("datetime") ?? "")),
      );
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
      const expected = own.events.filter(
        (event) =>
          event.kind === kind &&
          event.persona === "engineer" &&
          (index === 1
            ? event.stream?.endsWith("-retry")
            : !event.stream?.endsWith("-retry")),
      ).length;
      await expect(
        group.getByRole("button", { name: `Open ${kind}`, exact: true }),
      ).toHaveCount(expected);
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
  const outside = own.events.find((event) => event.kind === "node-ready");
  expect(outside).toBeDefined();
  await expect(
    page
      .getByRole("button", { name: "Open node-ready", exact: true })
      .first()
      .locator(
        "xpath=ancestor::section[contains(@class,'transcript-dispatch')]",
      ),
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
    await expect(panel).not.toContainText("Still running");
    expect(await panel.locator("dd").allTextContents()).not.toContain("");
    for (const unrelated of ["Token", "Worktree", "Config"])
      await expect(panel.locator("dt", { hasText: unrelated })).toHaveCount(0);
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
  for (const span of late) {
    const tooltipId = `timeline-detail-${span.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    await expect(
      node.locator(`button[aria-describedby="${tooltipId}"]`),
    ).toHaveCount(0);
  }
  const publication = node.getByRole("button", { name: /Publication, span/ });
  await publication.focus();
  await expect(page.getByRole("tooltip")).toContainText(
    `End: ${new Date(end).toISOString()}`,
  );
});
