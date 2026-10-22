import {
  apiErrorSchema,
  artifactContentSchema,
  runAgentsSchema,
  runDetailSchema,
  runStatusSchema,
  runTelemetryDocumentSchema,
  runTimelineSchema,
} from "@onepipeline-ui/dag-model";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { fixture, runs } from "./fixture-facts";
import { startFixtureServer } from "./fixture-server";

/**
 * Browser run controls and read panels, driven against the real read API over
 * runs the fixture harness recorded.
 *
 * These journeys write surfaces, queue replies and stop runs, so they use a
 * dedicated corpus: a run the acting session owns, one another session owns,
 * and one nothing drives. Writes move these runs to the top of the flat list;
 * journeys reading the shared live run therefore select it by id.
 *
 * This file sorts before dag-ui.spec.ts, whose final journeys remove the
 * shared corpus. Within this file, stopping the acting session's run comes
 * after the journeys that read and write its channel.
 */

/**
 * What the served API answers, read beside the browser to hold it to the same
 * bytes — and read through the contract's own parser, as the browser reads it,
 * so a journey never asserts against a shape the client would have refused.
 */
async function served<T>(
  page: Page,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await page.request.get(path);
  expect(response.ok()).toBe(true);
  return schema.parse(await response.json());
}

/** A refusal the API answered, as `{error: {code, message}}` and nothing else. */
async function refusedBy(
  response: { status(): number; json(): Promise<unknown> },
  status: number,
): Promise<{ code: string; message: string }> {
  expect(response.status()).toBe(status);
  return apiErrorSchema.parse(await response.json()).error;
}

const receipt = (page: Page, label: string): Locator =>
  page.getByRole("alert", { name: `${label} receipt` });
const refusal = (page: Page, label: string): Locator =>
  page.getByRole("alert", { name: `${label} refused` });

test("raises a surface, claims it, and answers it with a reply composed by shortcut and sent as typed", async ({
  page,
}) => {
  await page.goto(`/?run=${runs().supervised}&view=channel`);
  const queue = page.getByRole("region", { name: "Channel queue" });
  await expect(queue.getByRole("region", { name: "Surfaces" })).toContainText(
    "No surfaces yet.",
  );

  // Surface: a kind under the engine's grammar and a message.
  const surface = page.getByRole("region", { name: "Surface" });
  await surface.getByLabel("Kind").fill("finding");
  await surface
    .getByLabel("Message")
    .fill("the gate went red on the same hunk");
  await surface.getByRole("button", { name: "Raise surface" }).click();
  await expect(receipt(page, "Surface")).toContainText('"state": "queued"');
  const conversation = queue.getByRole("region", { name: "Surfaces" });
  await expect(conversation).toContainText("finding");
  await expect(conversation).toContainText("from proposal");
  await expect(conversation).toContainText("non-blocking");
  await expect(conversation).toContainText(/\d+(ms|s) old/);
  await expect(conversation).toContainText(
    "the gate went red on the same hunk",
  );

  // Next: the channel's one consumer. A non-blocking surface is read and done —
  // the receipt confirms consumption; the question remains in the conversation.
  await queue.getByRole("button", { name: "Next" }).click();
  const next = receipt(page, "Next");
  await expect(next).toContainText('"status": "surface"');
  await expect(next).toContainText(
    '"message": "the gate went red on the same hunk"',
  );
  await expect(queue.getByRole("region", { name: "Surfaces" })).toContainText(
    "the gate went red on the same hunk",
  );

  // An edit by shortcut: a blocking finding, which the engine raises as a
  // surface holding the node it names — and claims into the pending slot.
  const composer = page.getByRole("region", { name: "Reply" });
  // The engine's graph edits are available through the shortcut composer; the
  // commands that edit no graph — a review pass, a readjustment, a decline of
  // review comments, a withdrawal of a sent note — are spelled by the grammar
  // and offered no shortcut.
  const shortcut = composer.getByLabel("Shortcut");
  await expect(
    shortcut.getByRole("option", { name: "rework", exact: true }),
  ).toHaveCount(1);
  await expect(
    shortcut.getByRole("option", { name: "retitle", exact: true }),
  ).toHaveCount(1);
  for (const unoffered of ["decline", "review", "readjust", "withdraw-note"]) {
    await expect(
      shortcut.getByRole("option", { name: unoffered, exact: true }),
    ).toHaveCount(0);
  }
  await shortcut.selectOption("finding");
  await composer.getByLabel("Message").fill("stop and read this first");
  await composer.getByLabel("Blocking").check();
  await composer.getByLabel("Node id").fill("build");
  await composer.getByRole("button", { name: "Compose envelope" }).click();
  const editor = composer.getByLabel("Envelope (sent as typed)");
  await expect(editor).toHaveValue(
    '{\n  "version": 3,\n  "commands": [\n    {\n      "op": "finding",\n      "message": "stop and read this first",\n      "blocking": true,\n      "id": "build"\n    }\n  ]\n}',
  );
  await composer.getByRole("button", { name: "Send reply" }).click();
  const applied = receipt(page, "Reply");
  await expect(applied).toContainText('"state": "applied"');
  await expect(applied).toContainText('"commands": "applied"');
  await expect(conversation).toContainText("stop and read this first");
  await expect(conversation).toContainText("blocking");
  await expect(conversation).toContainText("node build");
  await queue.getByRole("button", { name: "Next" }).click();
  await expect(conversation).toContainText("stop and read this first");

  // The composer: a verdict by shortcut, rendered into the editor and sent as
  // the bytes there — with a space typed after the shortcut composed it, so the
  // envelope on the wire is provably the editor's text and not a re-encoding.
  await composer.getByLabel("Shortcut").selectOption("continue");
  await composer.getByLabel("Message").fill("carry on; the hunk is fine");
  await composer.getByRole("button", { name: "Compose envelope" }).click();
  await expect(editor).toHaveValue(
    '{\n  "message": "carry on; the hunk is fine"\n}',
  );
  await editor.press("End");
  await editor.type(" ");
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().includes("/channel/reply"),
  );
  await composer.getByRole("button", { name: "Send reply" }).click();
  expect((await sent).postData()).toBe(
    '{\n  "message": "carry on; the hunk is fine"\n} ',
  );
  const replied = receipt(page, "Reply");
  await expect(replied).toContainText('"state": "delivered"');
  await expect(replied).toContainText('"verdict": "delivered"');
  await expect(queue.getByRole("region", { name: "Replies" })).toContainText(
    "carry on; the hunk is fine",
  );

  // A refusal is the engine's own words: what the API answers for these bytes
  // is what the page shows, unaltered.
  const malformed = '{"nonsense": 1}';
  const error = await refusedBy(
    await page.request.post(`/api/v2/runs/${runs().supervised}/channel/reply`, {
      data: malformed,
      headers: { "content-type": "application/json" },
    }),
    422,
  );
  expect(error.code).toBe("refused");
  await editor.fill(malformed);
  await composer.getByRole("button", { name: "Send reply" }).click();
  const refused = refusal(page, "Reply");
  await expect(refused).toContainText("422 refused");
  await expect(refused).toContainText(error.message);

  // And a shortcut whose form cannot compose an envelope the grammar reads says
  // which field, before anything is sent.
  await composer.getByLabel("Shortcut").selectOption("drop");
  await composer.getByLabel("Node id").fill("");
  await composer.getByRole("button", { name: "Compose envelope" }).click();
  await expect(
    composer.getByRole("alert", { name: "Envelope not composed" }),
  ).toContainText("commands.0.id");
});

test("composes review replies, applies rework and reports retitle delivery refusal", async ({
  page,
}) => {
  // Review edits change the graph and its watch debts; keep them off the
  // shared corpus that the other supervising journeys drive.
  const server = await startFixtureServer("review", ["--review-corpus"]);
  try {
    const run = z
      .object({ runs: z.object({ supervised: z.string().min(1) }) })
      .parse(server.facts).runs.supervised;
    await page.goto(`${server.origin}/?run=${run}&view=channel`);
    const composer = page.getByRole("region", { name: "Reply" });
    await composer.getByLabel("Shortcut").selectOption("rework");
    await composer.getByLabel("Node id", { exact: true }).fill("review-draft");
    await composer
      .getByLabel("Reason", { exact: true })
      .fill("Review found a missing check");
    await composer.getByLabel("Instruction").fill("Add the missing check");
    const cannotCompose = async (
      label: string,
      valid: string,
      problem: string,
    ) => {
      await composer.getByLabel(label, { exact: true }).fill("");
      await composer.getByRole("button", { name: "Compose envelope" }).click();
      await expect(
        composer.getByRole("alert", { name: "Envelope not composed" }),
      ).toContainText(problem);
      await composer.getByLabel(label, { exact: true }).fill(valid);
    };
    await cannotCompose("Node id", "review-draft", "commands.0.id");
    await cannotCompose(
      "Reason",
      "Review found a missing check",
      "commands.0.reason",
    );
    await cannotCompose(
      "Instruction",
      "Add the missing check",
      "commands.0.instruction",
    );
    const comments = [
      {
        id: "review-1",
        url: "https://github.com/example/repo/pull/1#discussion_r1",
      },
    ];
    await composer.getByLabel("Review comments (JSON, optional)").fill("{");
    await composer.getByRole("button", { name: "Compose envelope" }).click();
    await expect(composer).toContainText("comments:");
    await composer
      .getByLabel("Review comments (JSON, optional)")
      .fill('[{"id":"review-1"}]');
    await composer.getByRole("button", { name: "Compose envelope" }).click();
    await expect(
      composer.getByRole("alert", { name: "Envelope not composed" }),
    ).toContainText("commands.0.comments.0.url");
    await composer
      .getByLabel("Review comments (JSON, optional)")
      .fill(JSON.stringify(comments));
    await composer
      .getByLabel("Title", { exact: true })
      .fill("fix: add review coverage");
    await composer
      .getByLabel("Replacement node id (optional)")
      .fill("review-draft-rework");
    const send = async (command: unknown, semanticRefusal?: string) => {
      await composer.getByRole("button", { name: "Compose envelope" }).click();
      const expected = { version: 3, commands: [command] };
      const editor = composer.getByLabel("Envelope (sent as typed)");
      await expect(editor).toHaveValue(JSON.stringify(expected, null, 2));
      const answered = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes(`/runs/${run}/channel/reply`),
      );
      await composer.getByRole("button", { name: "Send reply" }).click();
      const response = await answered;
      expect(response.request().postDataJSON()).toEqual(expected);
      if (semanticRefusal !== undefined) {
        // A retitle with no host session passes the engine's reply schema and
        // graph validation, then refuses delivery. Schema errors cannot satisfy
        // this specific downstream refusal (the manager's agreed boundary).
        const error = await refusedBy(response, 422);
        expect(error.code).toBe("refused");
        expect(error.message).toBe(semanticRefusal);
        await expect(refusal(page, "Reply")).toContainText(semanticRefusal);
      } else {
        expect(response.status()).toBe(200);
        await expect(receipt(page, "Reply")).toContainText(
          '"state": "applied"',
        );
      }
    };
    await composer.getByLabel("Shortcut").selectOption("retitle");
    await composer.getByLabel("Node id", { exact: true }).fill("review-draft");
    await composer
      .getByLabel("Title", { exact: true })
      .fill("fix: cover the review findings");
    await composer
      .getByLabel("Reason", { exact: true })
      .fill("Describe the reviewed scope");
    await cannotCompose("Node id", "review-draft", "commands.0.id");
    await cannotCompose(
      "Title",
      "fix: cover the review findings",
      "commands.0.title",
    );
    await cannotCompose(
      "Reason",
      "Describe the reviewed scope",
      "commands.0.reason",
    );
    await send(
      {
        op: "retitle",
        id: "review-draft",
        title: "fix: cover the review findings",
        reason: "Describe the reviewed scope",
      },
      "refused: retitle: node 'review-draft' has no session on the run's record to address its change request through",
    );
    // Declining is answered by replies the run drafts rather than composed from
    // a form, so no shortcut names it; typed into the editor, it reaches the
    // engine as a decline, which refuses it past its schema — the comment was
    // never read on this run — rather than as an unknown op.
    const shortcutOption = (name: string) =>
      composer
        .getByLabel("Shortcut")
        .getByRole("option", { name, exact: true });
    await expect(shortcutOption("retitle")).toHaveCount(1);
    await expect(shortcutOption("decline")).toHaveCount(0);
    const declineRefusal =
      "refused: decline: node 'review-draft': comment review-1 was not read for it — run `onepipeline review` and decline a comment it surfaced";
    const decline = {
      version: 3,
      commands: [
        {
          op: "decline",
          id: "review-draft",
          comments,
          reason: "Out of scope for this change",
        },
      ],
    };
    await composer
      .getByLabel("Envelope (sent as typed)")
      .fill(JSON.stringify(decline));
    const declined = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/runs/${run}/channel/reply`),
    );
    await composer.getByRole("button", { name: "Send reply" }).click();
    const declineResponse = await declined;
    expect(declineResponse.request().postDataJSON()).toEqual(decline);
    const declineError = await refusedBy(declineResponse, 422);
    expect(declineError.code).toBe("refused");
    expect(declineError.message).toBe(declineRefusal);
    await expect(refusal(page, "Reply")).toContainText(declineRefusal);
    await composer.getByLabel("Shortcut").selectOption("rework");
    await composer
      .getByLabel("Title", { exact: true })
      .fill("fix: add review coverage");
    await composer
      .getByLabel("Reason", { exact: true })
      .fill("Review found a missing check");
    await send({
      op: "rework",
      id: "review-draft",
      reason: "Review found a missing check",
      instruction: "Add the missing check",
      comments,
      title: "fix: add review coverage",
      replacement: "review-draft-rework",
    });
    await composer
      .getByLabel("Node id", { exact: true })
      .fill("review-draft-optional");
    await composer.getByLabel("Review comments (JSON, optional)").fill("");
    await composer.getByLabel("Title", { exact: true }).fill("");
    await composer.getByLabel("Replacement node id (optional)").fill("");
    await send({
      op: "rework",
      id: "review-draft-optional",
      reason: "Review found a missing check",
      instruction: "Add the missing check",
    });
  } finally {
    await server.stop();
  }
});

test("refuses to stop a run another session owns, naming the owner, and forces it only behind a confirm that names them", async ({
  page,
}) => {
  await page.goto(`/?run=${runs().elsewhere}&view=overall`);
  await expect(
    page.getByRole("region", { name: "Graph timeline" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText(`Stop ${runs().elsewhere}?`);
  // The first confirm offers no force: a forced stop is never the default.
  await expect(confirm.getByRole("button", { name: /Force/ })).toHaveCount(0);
  await confirm.getByRole("button", { name: "Stop run" }).click();

  const refused = refusal(page, "Stop");
  await expect(refused).toContainText("409 not_owner");
  const said = (await refused.textContent()) ?? "";
  const message =
    /run \S+ belongs to \[codex:[0-9a-f]+\], not to this session/.exec(
      said,
    )?.[0] ?? "";
  expect(message).not.toBe("");
  const owner = /\[codex:[0-9a-f]+\]/.exec(message)?.[0] ?? "";
  expect(owner).not.toBe("");
  // The run is untouched: still driven, and the second confirm names the owner
  // it would override.
  await expect(page.getByLabel("Liveness ACTIVE")).toBeVisible();
  await page.getByRole("button", { name: "Force stop…" }).click();
  const second = page.getByRole("dialog");
  await expect(second).toContainText(
    `Force-stop ${runs().elsewhere}, overriding ${owner}?`,
  );
  await expect(second).toContainText(message);
  await second
    .getByRole("button", { name: `Force stop, overriding ${owner}` })
    .click();
  const forced = receipt(page, "Stop");
  await expect(forced).toContainText('"forced": true');
  await expect(forced).toContainText(`"owner": "${owner}"`);
  await expect(forced).toContainText('"stopped": true');
  await expect(page.getByRole("button", { name: "Force stop…" })).toHaveCount(
    0,
  );
});

test("stops a run the acting session owns on one confirm", async ({ page }) => {
  await page.goto(`/?run=${runs().supervised}&view=overall`);
  await expect(
    page.getByRole("region", { name: "Graph timeline" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Stop run" })
    .click();
  const stopped = receipt(page, "Stop");
  await expect(stopped).toContainText('"stopped": true');
  await expect(stopped).toContainText('"owner": "[mine]"');
  await expect(stopped).toContainText('"forced": false');
  await expect(page.getByRole("button", { name: "Force stop…" })).toHaveCount(
    0,
  );
  // The run's own record says so now: the stop is journalled, and the
  // liveness reads what the engine makes of a stopped run — on the status
  // read's next landing, which on a loaded host is seconds away.
  await expect(page.getByLabel("Liveness DRIVER DEAD")).toBeVisible({
    timeout: 60_000,
  });
});

/**
 * Every agent a run launched, off the run's own pointer file — the file the
 * engine has every oneharness under its launches append to — grouped by which
 * launch each session was written under, and each opening to its transcript in
 * the store oneharness itself kept it in. Held to the served API on both sides:
 * the sessions the listing serves are the ones the fixture's pointer file names,
 * and the count beside the run is the number of them.
 */
test("observer and worker harness sessions open from their timelines", async ({
  page,
}) => {
  const listing = await served(
    page,
    `/api/v2/runs/${runs().live}/agents`,
    runAgentsSchema,
  );
  expect(listing.sessions).toHaveLength(fixture().agents.live);
  const observer = listing.sessions.find(
    (session) => session.labels["onepipeline.scope"] === "observer",
  );
  expect(observer).toBeDefined();
  const timeline = await served(
    page,
    `/api/v2/runs/${runs().live}/timeline?scope=run`,
    runTimelineSchema,
  );
  const observed = timeline.spans.find(
    (span) => span.harness_scope === "observer",
  );
  if (observed?.ended_at == null)
    throw new Error("observer with its own recorded end");
  expect(Date.parse(observed.ended_at) - Date.parse(observed.started_at)).toBe(
    42_000,
  );
  const worked = timeline.spans.find((span) => span.harness_scope === "node");
  expect(worked).toBeDefined();
  expect(worked?.ended_at).toBe(worked?.started_at);
  expect(worked?.label).toContain("no recorded end");
  await page.goto(`/?run=${runs().live}&view=overall`);
  const graph = page.getByRole("region", {
    name: "Graph timeline",
    exact: true,
  });
  await graph.getByRole("button", { name: "Expand timeline" }).click();
  const runLevel = page.getByRole("region", {
    name: "Run-level timeline",
    exact: true,
  });
  await runLevel.getByRole("button", { name: "Expand timeline" }).click();
  await runLevel
    .getByRole("button", { name: /^Run-level · observer/ })
    .first()
    .click();
  await expect(
    page.getByRole("region", { name: "Timeline item detail" }),
  ).toContainText("Oneharness conversation");
  await expect(
    page.getByRole("tab", { name: "Agents", exact: true }),
  ).toHaveCount(0);
  const node = fixture().agents.worker.node;
  await page.goto(`/?run=${runs().live}&node=${node}`);
  const worker = listing.sessions.find(
    (session) => session.labels["onepipeline.scope"] === "node",
  );
  if (worker === undefined) throw new Error("worker session");
  await page
    .getByRole("button", {
      name: `Open node (${worker.name} · no recorded end)`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", { name: "Timeline item detail" }),
  ).toContainText(fixture().agents.worker.text);
  const transcript = await served(
    page,
    `/api/v2/runs/${runs().live}/artifacts/${fixture().agents.worker.history_id}`,
    artifactContentSchema,
  );
  expect(transcript.content).toContain(fixture().agents.worker.text);
  await expect(
    page.getByRole("region", { name: "Review reply drafter", exact: true }),
  ).toContainText("replier-dashboard");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", {
      name: "Open review-reply (replier-dashboard · no recorded end)",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", { name: "Timeline item detail" }),
  ).toContainText("the review reply is drafted");
  await page.goto(`/?run=${runs().live}&node=foundation`);
  await expect(page.getByRole("button", { name: /^Open node \(/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("tab", { name: "Agents", exact: true }),
  ).toHaveCount(0);
});

/** Each SDK field is visible in labelled fieldsets and lists, including exact numeric readings. */
async function expectStructuredFields(
  fields: Locator,
  value: unknown,
  label = "Record",
): Promise<void> {
  if (value === null || value === undefined)
    await expect(
      fields.getByText("Not recorded", { exact: true }),
    ).toBeVisible();
  else if (Array.isArray(value)) {
    if (value.length === 0)
      await expect(fields.getByText("None", { exact: true })).toBeVisible();
    for (const [index, item] of value.entries())
      await expectStructuredFields(
        fields.getByRole("listitem", {
          name: `${label}.${index}`,
          exact: true,
        }),
        item,
        `${label}.${index}`,
      );
  } else if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const field = fields.getByRole("group", {
        name: `${label}.${key}`,
        exact: true,
      });
      await expect(
        field.getByText(key.replaceAll("_", " "), { exact: true }).first(),
      ).toBeVisible();
      await expectStructuredFields(field, item, `${label}.${key}`);
    }
  } else
    await expect(
      fields.getByText(
        typeof value === "boolean" ? (value ? "Yes" : "No") : String(value),
        { exact: true },
      ),
    ).toBeVisible();
}

test("preserves Reads facts as structured fields in Overall and run details", async ({
  page,
}) => {
  for (const runId of [
    runs().live,
    runs().history,
    runs().outcomes,
    runs().legacy,
  ]) {
    const detail = await served(
      page,
      `/api/v2/runs/${runId}?include_conversations=false`,
      runDetailSchema,
    );
    const telemetry = await served(
      page,
      `/api/v2/runs/${runId}/telemetry`,
      runTelemetryDocumentSchema,
    );
    const statusResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/v2/runs/${runId}/status`,
    );
    await page.goto(`/?run=${runId}&view=overall`);
    const status = runStatusSchema.parse(await (await statusResponse).json());
    await expect(
      page.getByRole("region", { name: "Node statuses", exact: true }),
    ).toHaveCount(0);
    await page.getByText("Run details", { exact: true }).click();
    const header = page.getByRole("group", {
      name: "Run details",
      exact: true,
    });
    await expect(header).toContainText(status.summary);
    await expect(header).toContainText(
      `Unread surfaces${status.unread_surfaces.count}`,
    );
    await expect(header).toContainText(
      `Oldest unread (seconds)${status.unread_surfaces.oldest_seconds ?? "None"}`,
    );
    await expectStructuredFields(
      page.getByRole("region", { name: "Node statuses", exact: true }),
      status.node_status,
    );
    await page.getByText("Run details", { exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Node statuses", exact: true }),
    ).toHaveCount(0);
    await page.getByText("Run details", { exact: true }).click();
    await expect(header).toContainText(status.summary);
    await page.getByText("Run details", { exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "Reads", exact: true }),
    ).toHaveCount(0);
    await page.getByText("Timing and usage", { exact: true }).click();
    await expectStructuredFields(
      page.getByRole("group", { name: "Timing and usage", exact: true }),
      telemetry.telemetry,
    );
    await page.getByText("Recorded results", { exact: true }).click();
    await expectStructuredFields(
      page.getByRole("group", { name: "Recorded results", exact: true }),
      detail.graph?.result,
    );
    await page
      .getByText("Goal and repository identities", { exact: true })
      .click();
    await expectStructuredFields(
      page.getByRole("group", {
        name: "Goal and repository identities",
        exact: true,
      }),
      {
        goal: detail.graph?.plan.goal,
        repositories: [
          ...new Set(
            detail.graph?.plan.tasks.flatMap((task: { repo?: string }) =>
              task.repo ? [task.repo] : [],
            ) ?? [],
          ),
        ],
      },
    );
    await page.getByText("Provider health", { exact: true }).click();
    await expectStructuredFields(
      page.getByRole("group", { name: "Provider health", exact: true }),
      detail.provider_health,
    );
  }
});
