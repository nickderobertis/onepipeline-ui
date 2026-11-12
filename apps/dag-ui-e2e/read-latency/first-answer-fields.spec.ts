/**
 * Each view's first answer on the release server carries every field the same request's
 * first answer carries when the server reads the run's journal whole, and every field the
 * first screen draws equals the complete document's or is marked loading.
 *
 * The reference is the same release server over the same corpus with
 * `ONEPIPELINE_UI_WHOLE_READ_BYTES` past the journal's length, so its first answer is
 * built from every record whole — what the server built a first answer from before it
 * read a long run as its heads. It is not the base commit's server: a field this tree
 * stopped serving for both readings alike would not be caught here, which is
 * `tests/e2e/baseline.rs`'s question over the routes it compares. Fed an answer with one
 * of the reference's fields taken out, the same comparison names that field, so it
 * cannot pass blind.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  addressOf,
  buildWorld,
  completeDocuments,
  NEVER,
  removeWorld,
  type Served,
  serve,
  stop,
  visibleOf,
  type World,
} from "./journey-world";
import { checkAnswer, type FirstView } from "./mark";

/** Far past any journal: the reference server reads every run whole. */
const WHOLE = { ONEPIPELINE_UI_WHOLE_READ_BYTES: "18446744073709551615" };

type Json = Record<string, unknown>;

/**
 * Every member path `value` holds, a list's items' members under `[]`: the fields an
 * answer carries, whatever values they hold.
 */
function fieldsOf(value: unknown, at = "", found = new Set<string>()) {
  if (Array.isArray(value)) {
    for (const item of value) fieldsOf(item, `${at}[]`, found);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, member] of Object.entries(value)) {
      const path = at === "" ? key : `${at}.${key}`;
      found.add(path);
      fieldsOf(member, path, found);
    }
  }
  return found;
}

/** The fields `reference` carries that `answer` does not, by path. */
const missingFrom = (answer: unknown, reference: unknown): string[] => {
  const carried = fieldsOf(answer);
  return [...fieldsOf(reference)].filter((path) => !carried.has(path));
};

/** `answer` without the field at `path`, a path as {@link fieldsOf} names one. */
function without(answer: unknown, path: string): unknown {
  const copy = structuredClone(answer);
  const drop = (value: unknown, steps: readonly string[]) => {
    const [step, ...rest] = steps;
    if (step === undefined) return;
    const list = step.endsWith("[]");
    const key = list ? step.slice(0, -2) : step;
    if (typeof value !== "object" || value === null) return;
    const held = value as Json;
    if (rest.length === 0 && !list) {
      delete held[key];
      return;
    }
    const next = held[key];
    for (const item of list && Array.isArray(next) ? next : [next])
      drop(item, rest);
  };
  // `a.b[].c` is `a`, then `b[]` (every item of `b`), then `c`.
  drop(copy, path.split("."));
  return copy;
}

/** The page's first `POST /api/v2/subscriptions`: the body it sent and the answer. */
async function firstRequest(
  page: Page,
  served: Served,
  view: FirstView,
  run: string,
  node: string | undefined,
): Promise<{ body: string; answer: unknown }> {
  let caught: { body: string; answer: unknown } | undefined;
  const taken = new Promise<void>((resolve) => {
    page.on("response", async (response) => {
      const request = response.request();
      if (
        caught === undefined &&
        new URL(response.url()).pathname === "/api/v2/subscriptions" &&
        request.method() === "POST"
      ) {
        caught = {
          body: request.postData() ?? "",
          answer: await response.json(),
        };
        resolve();
      }
    });
  });
  await page.goto(`${served.origin}${addressOf(run, view, node)}`);
  await Promise.race([
    taken,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`no first answer for ${view}`)), NEVER),
    ),
  ]);
  return caught as { body: string; answer: unknown };
}

/** The same request, sent to `served` as the page sent it. */
async function sameRequest(served: Served, body: string): Promise<unknown> {
  const response = await fetch(`${served.origin}/api/v2/subscriptions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  expect(response.status).toBe(201);
  return response.json();
}

let world: World;
test.beforeAll(() => {
  world = buildWorld();
});
test.afterAll(() => removeWorld(world));

test("each view's first answer carries every field a whole read's does, and each drawn field is the complete document's or marked loading", async ({
  browser,
}) => {
  const run = world.facts.openLiveRun;
  const node = world.facts.large.busiestNode;
  const served = await serve(world);
  const whole = await serve(world, WHOLE);
  try {
    for (const view of ["graph", "overall", "node"] as const) {
      const at = view === "node" ? node : undefined;
      // A context of its own per view, so each page's first answer is that view's.
      const context = await browser.newContext();
      const page = await context.newPage();
      const { body, answer } = await firstRequest(page, served, view, run, at);
      await context.close();
      const reference = await sameRequest(whole, body);
      expect(
        missingFrom(answer, reference),
        `${view}: fields a whole read's first answer carries`,
      ).toStrictEqual([]);
      expect(
        checkAnswer(
          visibleOf(answer),
          await completeDocuments(served, run, at),
          view === "overall" ? "run" : view === "node" ? "node" : undefined,
        ),
        `${view}: each drawn field against the complete document`,
      ).toStrictEqual([]);
      // Fed an answer missing any one of those fields, the same comparison names it.
      const fields = [...fieldsOf(reference)];
      expect(fields).toContain("initial.snapshot.visible.detail.run.state");
      for (const path of fields)
        expect(
          missingFrom(without(answer, path), reference),
          `${view}: an answer without ${path}`,
        ).toContain(path);
    }
  } finally {
    await stop(served);
    await stop(whole);
  }
});
