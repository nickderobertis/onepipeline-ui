import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { runs } from "./fixture-facts";

/**
 * The first screen draws only an answer it has checked, read the way a person opening
 * a run's address meets it: the served page, the real read API's answer to its
 * `POST /api/v2/subscriptions`, altered in flight one field at a time.
 *
 * Every field the first screen draws, as `apps/dag-ui/src/first-screen/fields.json`
 * declares them (the list that app's unit test holds its check to), in the answers
 * Graph and a node receive, is given a value of the wrong type, a value of its type it
 * never holds where there is one, and is taken out where the contract requires it. A
 * field the served answer holds nothing of is grafted in from that file's exemplar
 * first, so every field is altered in a served answer. Each time the page must say
 * the answer failed its contract, naming that field, and must never have drawn a first
 * screen from it; the answer as served draws each view's first screen. One server and
 * one settled run serve every pass.
 */

declare global {
  interface Window {
    /** Set once a first screen is drawn from an answer, by the observer below. */
    __firstScreenDrawn?: boolean;
  }
}

/**
 * A first screen drawn from an answer, by the roles and names a person's assistive
 * technology reads it by: Graph's canvas, Overall's metrics and a node's timeline. The
 * screen that stands while the answer is out names none of them.
 */
// llmlint: ignore-block[e2e_uses_accessible_selectors] whether a first screen was ever drawn, even for a frame before the app replaced it, is visible only to an observer inside the page, which Playwright's locators are not; that observer selects by exactly the ARIA role and accessible names `getByRole` would, written as the attribute selectors `querySelector` takes.
const DRAWN =
  '[role="group"][aria-label="DAG execution graph"], section[aria-label="Run metrics"], section[aria-label="Node timeline"]';
// llmlint: ignore-end[e2e_uses_accessible_selectors]

type Json = Record<string | number, unknown>;
type Path = readonly (string | number)[];

/** One field the first screen draws, as `fields.json` declares it. */
interface Listed {
  readonly field: string;
  readonly required: boolean;
  readonly wrong: unknown;
  readonly unfit?: unknown;
  readonly names?: string;
}

/** Every field the first screen draws, and an answer that holds each of them. */
const LISTED = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../dag-ui/src/first-screen/fields.json"),
    "utf8",
  ),
) as { fields: Listed[]; exemplar: unknown };

/** How the page names the field at `path`: `answer`, then its keys and indices. */
const namedPath = (path: Path): string =>
  path.reduce<string>(
    (named, step) =>
      typeof step === "number" ? `${named}[${step}]` : `${named}.${step}`,
    "answer",
  );

const isHolder = (value: unknown): value is Json =>
  typeof value === "object" && value !== null;

/**
 * A copy of the served `answer` holding `field`, and where it holds it: where the
 * served answer holds what the field sits under, there — a list's first item, a
 * record's first entry — and where it holds none of it, the exemplar's, grafted in.
 */
function holding(answer: unknown, field: string): { answer: Json; path: Path } {
  const copy = structuredClone(answer) as Json;
  const steps = field.replace(/\[0\]/gu, ".[0]").split(".").slice(1);
  const path: (string | number)[] = [];
  let at: Json = copy;
  let exemplar: unknown = LISTED.exemplar;
  for (const [index, step] of steps.entries()) {
    const example = exemplar as Json;
    const key =
      step === "[0]"
        ? 0
        : step === "*"
          ? (Object.keys(at)[0] ?? (Object.keys(example)[0] as string))
          : step;
    const next = step === "*" ? Object.values(example)[0] : example[key];
    const last = index === steps.length - 1;
    if (last ? at[key] === undefined : !isHolder(at[key]))
      at[key] = structuredClone(next);
    path.push(key);
    if (!last) {
      at = at[key] as Json;
      exemplar = next;
    }
  }
  return { answer: copy, path };
}

/** `answer` with the value at `path` replaced, or removed where `value` is `undefined`. */
function altered(answer: Json, path: Path, value: unknown): Json {
  let at: Json = answer;
  for (const step of path.slice(0, -1)) at = at[step] as Json;
  const last = path[path.length - 1] as string | number;
  if (value === undefined) delete at[last];
  else at[last] = value;
  return answer;
}

/** The page, with each first answer passed through whatever `alter` holds then. */
async function opened(page: Page) {
  const held: {
    alter?: (answer: unknown) => unknown;
    received?: unknown;
  } = {};
  await page.addInitScript((selector: string) => {
    window.__firstScreenDrawn = false;
    new MutationObserver(() => {
      if (document.querySelector(selector) !== null)
        window.__firstScreenDrawn = true;
    }).observe(document, { childList: true, subtree: true });
  }, DRAWN);
  // llmlint: ignore-block[e2e_not_mocked, tests_mirror_real_usage] the acceptance criteria require the served first answer altered in flight, one field missing or of the wrong type at a time, to show the page refusing each; the real server's answer is fetched and only that one field is changed, and with nothing to alter the answer passes through untouched, as `read-latency/first-screen-marks.spec.ts` feeds its answers.
  await page.route("**/api/v2/subscriptions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    const answer: unknown = await response.json();
    // Only a page's first answer: the app subscribes again as a person moves.
    const alter = held.alter;
    held.alter = undefined;
    held.received ??= answer;
    await route.fulfill({
      response,
      json: alter === undefined ? answer : alter(answer),
    });
  });
  // llmlint: ignore-end[e2e_not_mocked, tests_mirror_real_usage]
  return held;
}

/** How many pages take the alterations at once: each is one load of its own. */
const LANES = 4;

test("an answer missing or mistyping any field the first screen draws shows its contract failure, and no first screen", async ({
  context,
  page,
}) => {
  test.setTimeout(600_000);
  const held = await opened(page);
  const run = runs().history;
  const addresses: Record<string, string> = {
    graph: `/?run=${run}&view=graph`,
    overall: `/?run=${run}&view=overall`,
  };
  const answers: Record<string, unknown> = {};

  // As served, each view's first screen is drawn from its answer.
  const draws = async (view: string) => {
    held.received = undefined;
    await page.goto(addresses[view] as string);
    await expect
      .poll(() => page.evaluate(() => window.__firstScreenDrawn))
      .toBe(true);
    answers[view] = held.received;
  };
  await draws("graph");
  const tasks = (
    answers.graph as {
      initial: {
        snapshot: {
          visible: { detail: { graph: { plan: { tasks: { id: string }[] } } } };
        };
      };
    }
  ).initial.snapshot.visible.detail.graph.plan.tasks;
  const node = tasks[0]?.id;
  expect(node, "the run has a node to open").toBeDefined();
  addresses.node = `/?run=${run}&view=graph&node=${encodeURIComponent(node as string)}`;
  await draws("node");
  await draws("overall");

  // Every field once: a detail's in Graph's answer, a timeline's in the node's.
  const passes: {
    view: string;
    name: string;
    answer: Json;
    pass: string;
  }[] = [];
  for (const field of LISTED.fields) {
    const view = field.field.includes(".visible.timeline") ? "node" : "graph";
    const { answer, path } = holding(answers[view], field.field);
    const name = field.names ?? namedPath(path);
    const pass = (value: unknown, what: string) =>
      passes.push({
        view,
        name,
        answer: altered(structuredClone(answer), path, value),
        pass: what,
      });
    pass(field.wrong, "of the wrong type");
    if (field.unfit !== undefined)
      pass(field.unfit, "holding a value it never holds");
    if (field.required) pass(undefined, "missing");
  }
  // The node's rows and the spans' nested members are among what is altered.
  const names = passes.map((pass) => pass.name);
  expect(names).toContain(
    "answer.initial.snapshot.visible.timeline.spans[0].events[0].at",
  );
  expect(names).toContain(
    "answer.initial.snapshot.visible.timeline.spans[0].reasons[0].ahead",
  );
  expect(names).toContain("answer.initial.snapshot.visible.detail.run.state");

  // Each lane a page of its own, taking every LANES-th alteration in turn.
  const lanes = [
    { page, held },
    ...(await Promise.all(
      Array.from({ length: LANES - 1 }, async () => {
        const lane = await context.newPage();
        return { page: lane, held: await opened(lane) };
      }),
    )),
  ];
  await Promise.all(
    lanes.map(async (lane, at) => {
      const alert = lane.page
        .getByRole("alert")
        .filter({ hasText: "This run's history did not load" });
      for (const { view, name, answer, pass } of passes.filter(
        (_, index) => index % LANES === at,
      )) {
        lane.held.alter = () => answer;
        await lane.page.goto(addresses[view] as string);
        await expect(
          alert,
          `${view}'s answer with ${name} ${pass} shows the contract failure`,
        ).toContainText(
          `The first answer failed contract validation: ${name} `,
        );
        expect(
          await lane.page.evaluate(() => window.__firstScreenDrawn),
          `no first screen is drawn from ${view}'s answer with ${name} ${pass}`,
        ).toBe(false);
      }
    }),
  );
});
