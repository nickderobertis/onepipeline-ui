import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  liveActivityListSchema,
  runTimelineSchema,
} from "@onepipeline-ui/dag-model";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { runs } from "./fixture-facts";
import { startFixtureServer } from "./fixture-server";
import { VIEWPORTS } from "./viewports";

/** Read the stream's current activity, then close exactly this subscription. */
async function currentActivity(origin: string, run: string) {
  const response = await fetch(`${origin}/api/v2/events?run_id=${run}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("the server opens a stream");
  let buffered = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("the stream ended before activity");
      buffered += decoder.decode(chunk.value, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        if (!frame.includes("event: activity.changed")) continue;
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        const activity = z
          .object({ activity: liveActivityListSchema })
          .parse(JSON.parse(data ?? "null")).activity;
        const latest = activity.at(-1);
        if (latest === undefined) throw new Error("the stream lists activity");
        return latest;
      }
    }
  } finally {
    await reader.cancel();
  }
}

for (const viewport of VIEWPORTS) {
  test(`run header fits and links its precise activity at ${viewport.name}`, async ({
    page,
  }) => {
    const server = await startFixtureServer("header", []);
    try {
      const command =
        "just check && cargo test --locked --all-targets --features bundled-ui -- --test-threads=1 && printf '%s' 'checking a long shell command in the run header'";
      execFileSync(process.execPath, [
        join(import.meta.dirname, "fixtures/serve-fixture.mjs"),
        "--workspace",
        server.workspace,
        "--record-activity",
        "Bash",
        "--activity-detail",
        command,
      ]);
      const namedActivity = await currentActivity(server.origin, runs().live);
      await page.setViewportSize(viewport);
      const forbidden: string[] = [];
      page.on("request", (request) => {
        if (
          /\/(watch|adopt)(?:\?|$)|\/api\/v2\/unwatched(?:\?|$)/.test(
            request.url(),
          )
        )
          forbidden.push(request.url());
      });
      await page.goto(`${server.origin}/?list=runs&run=${runs().live}`);
      const header = page.getByRole("region", { name: "Run header" });
      await expect(
        header.getByRole("button", { name: "Stop", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: /^(Watch|Watching|Adopt|Shut down this run|Shut down all my runs)$/,
        }),
      ).toHaveCount(0);
      await expect(page.getByLabel(/unwatched$/)).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Shut down the entire host" }),
      ).toBeAttached();
      const activity = header.getByRole("button", {
        name: `dashboard: Bash ${command}`,
        exact: true,
      });
      await expect(activity).toHaveAttribute(
        "title",
        `dashboard: Bash ${command}`,
      );
      const tabBox = await page
        .getByRole("tablist", { name: "DAG views" })
        .boundingBox();
      const headerBox = await header.boundingBox();
      const controls = await header.getByRole("button").all();
      const runId = header.getByRole("heading", {
        name: runs().live,
        exact: true,
      });
      const liveness = header.getByLabel(/^Liveness /);
      const members = [runId, liveness, ...controls];
      const memberBoxes = await Promise.all(
        members.map(async (member) => {
          const box = await member.boundingBox();
          if (box === null) throw new Error("header member is visible");
          return box;
        }),
      );
      if (tabBox === null || headerBox === null)
        throw new Error("header and tabs are visible");
      for (const box of memberBoxes) {
        expect(
          box.x < tabBox.x + tabBox.width &&
            box.x + box.width > tabBox.x &&
            box.y < tabBox.y + tabBox.height &&
            box.y + box.height > tabBox.y,
        ).toBe(false);
      }
      const activityBox = await activity.boundingBox();
      expect(activityBox).not.toBeNull();
      expect(
        (activityBox?.x ?? 0) + (activityBox?.width ?? 0),
      ).toBeLessThanOrEqual(headerBox.x + headerBox.width);
      const clipping = await activity.evaluate((element) => ({
        clipped: element.scrollWidth > element.clientWidth,
        ellipsis: getComputedStyle(element).textOverflow,
        nowrap: getComputedStyle(element).whiteSpace,
      }));
      expect(clipping.clipped).toBe(true);
      expect(clipping.ellipsis).toBe("ellipsis");
      expect(clipping.nowrap).toBe("nowrap");
      expect(
        new Set(memberBoxes.map((box) => Math.round(box.y + box.height / 2)))
          .size,
      ).toBe(1);
      await activity.click();
      await expect(page).toHaveURL(/node=dashboard/);
      expect(new URL(page.url()).searchParams.get("event")).toBe(
        namedActivity.event_id,
      );
      const response = await page.request.get(
        `${server.origin}/api/v2/runs/${runs().live}/timeline?scope=node&node=dashboard`,
      );
      const timeline = runTimelineSchema.parse(await response.json());
      const namedEvent = timeline.spans
        .flatMap((span) => span.events ?? [])
        .find((event) => event.id === namedActivity.event_id);
      expect(namedEvent?.kind).toBe("turn-activity");
      const detail = page.getByRole("region", { name: "Timeline item detail" });
      await expect(
        detail.getByRole("heading", { name: "turn-activity", exact: true }),
      ).toBeVisible();
      await expect(detail.getByRole("time").first()).toHaveAttribute(
        "datetime",
        namedEvent?.at ?? "",
      );
      expect(forbidden).toEqual([]);
    } finally {
      await server.stop();
    }
  });
}

test("Stop is offered only before a run has ended", async ({ page }) => {
  const server = await startFixtureServer("header-states", []);
  try {
    await page.goto(`${server.origin}/?run=${runs().live}`);
    await expect(
      page
        .getByRole("region", { name: "Run header" })
        .getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    const module = pathToFileURL(
      join(import.meta.dirname, "fixtures/runs.mjs"),
    ).href;
    const failed = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {writeFailedHeaderRun} from ${JSON.stringify(module)}; console.log(writeFailedHeaderRun(process.argv[1]));`,
        join(server.workspace, "runs"),
      ],
      { encoding: "utf8" },
    ).trim();
    for (const [run, state] of [
      [runs().history, "settled"],
      [failed, "ended-failed"],
      [runs().sibling, "ended-stopped"],
    ] as const) {
      const response = await page.request.get(
        `${server.origin}/api/v2/runs/${run}`,
      );
      expect((await response.json()).run.state).toBe(state);
      await page.goto(`${server.origin}/?run=${run}`);
      await expect(
        page.getByRole("region", { name: "Run header" }).getByRole("heading"),
      ).toHaveText(run);
      await expect(
        page
          .getByRole("region", { name: "Run header" })
          .getByRole("button", { name: "Stop", exact: true }),
      ).toHaveCount(0);
    }
  } finally {
    await server.stop();
  }
});
