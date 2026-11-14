/**
 * The rest-arrived check against the real release server and a real browser, on
 * the run shape `measure-run.spec.ts` measures: a run small enough that its rest
 * is published within moments of its first answer, so a listener attached after
 * the first screen can miss it. The rest is made to arrive before the late
 * listener attaches, so the same check refuses what it heard every time.
 */
import { expect, test } from "@playwright/test";
import {
  addressOf,
  buildWorld,
  NEVER,
  observe,
  removeWorld,
  type Served,
  serve,
  stop,
  type World,
} from "./journey-world";
import { listenForRest, restArrivedAt } from "./rest-arrived";

let world: World;
let served: Served;
test.beforeAll(async () => {
  world = buildWorld();
  served = await serve(world);
});
test.afterAll(async () => {
  await stop(served);
  removeWorld(world);
});

test("the rest is heard only by a listener attached before the page opens", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = await context.newPage();
    await observe(page);
    // Where the measurement listens: before navigation.
    const early = await listenForRest(page, context);
    await page.goto(
      `${served.origin}${addressOf(
        world.facts.openLiveRun,
        "node",
        world.facts.large.busiestNode,
      )}`,
      { waitUntil: "commit" },
    );
    // The first screen's answer is in, and the server has published the rest's
    // `complete` progress, before anything else listens: the order a slow runner
    // met, held every time rather than hoped for.
    await expect
      .poll(() => page.evaluate("window.__firstAnswer !== undefined"), {
        timeout: NEVER,
      })
      .toBe(true);
    await expect
      .poll(() => early.served()?.complete, { timeout: NEVER })
      .toBe(true);
    // Where the measurement used to listen: once the first screen was found.
    const late = await listenForRest(page, context);
    await expect(restArrivedAt(page, "node", late, NEVER)).rejects.toThrow(
      "node drew no loading value, but the server's progress was undefined",
    );
    expect(await restArrivedAt(page, "node", early, NEVER)).not.toBeNull();
    expect(early.served()).toMatchObject({ complete: true });
    expect(early.served()?.failed).toBeUndefined();
  } finally {
    await context.close();
  }
});
