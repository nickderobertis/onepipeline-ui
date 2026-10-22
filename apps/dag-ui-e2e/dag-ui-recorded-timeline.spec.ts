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
      .getByText(clock, { exact: false })
      .last(),
  ).toContainText(clock);
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
    await expect(graph.getByText(clock, { exact: false }).last()).toContainText(
      clock,
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
  const activityButtons = page
    .getByRole("region", { name: "Dispatch 2", exact: true })
    .getByRole("button", { name: "Open turn-activity", exact: true });
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
  const narrowed = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/timeline") &&
      url.searchParams.get("scope") === "node" &&
      url.searchParams.get("filter") === "planner"
    );
  });
  await page
    .getByRole("group", { name: "Level of detail" })
    .getByRole("button", { name: "Decisions" })
    .click();
  const filtered = parseRunTimeline(await (await narrowed).json());
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
  for (const kind of [
    "node-dispatched",
    "node-settled",
    "graph-started",
    "member-started",
    "turn-activity",
  ])
    await expect(
      page.getByRole("button", { name: `Open ${kind}`, exact: true }),
    ).toHaveCount(0);
  await page
    .getByRole("group", { name: "Level of detail" })
    .getByRole("button", { name: "Detailed activity" })
    .click();
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
      detail.getByRole("heading", { name: kind, exact: true }),
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
