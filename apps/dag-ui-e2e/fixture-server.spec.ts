import { Server } from "node:net";
import { expect, test } from "@playwright/test";
import { runs } from "./fixture-facts";
import { startFixtureServer } from "./fixture-server";
import { graphNodes } from "./observatory-locators";

/**
 * A journey's own read API holds the port it reports from the moment it reports it.
 *
 * Choosing a port by binding a probe and closing it hands the number to whichever
 * process binds next, and the server that was meant to have it binds seconds later,
 * after its corpus is written: a journey failed in CI with the fixture server
 * exiting 2, `cannot bind 127.0.0.1:…: Address already in use`. This journey is that
 * neighbour, made deterministic rather than left to the host: every port a listener
 * in this process gives up is taken again before the one who gave it up hears it is
 * closed — so a port chosen by probe-and-release is occupied by the time anyone
 * could use it — and the fixture server must still start and serve the view.
 */
test("a fixture server starts and serves its view though every port a probe releases is taken at once", async ({
  page,
}) => {
  const squatters = new Set<Server>();
  const close = Server.prototype.close;
  // llmlint: ignore-block[e2e_not_mocked] nothing is substituted: every close still runs Node's own, and the squatter is a real listener on the real port. Wrapping close is the one place the neighbour can act between a probe's release and the prober learning of it, which is what makes this race deterministic rather than a bet on the host's timing; a separate process cannot see that instant. The fixture server, its child, the read API and the browser are all real.
  Server.prototype.close = function squatOnClose(
    this: Server,
    done?: (err?: Error) => void,
  ): Server {
    const address = this.address();
    if (squatters.has(this) || address === null || typeof address !== "object")
      return close.call(this, done);
    const { port, address: host } = address;
    return close.call(this, (err?: Error) => {
      const squatter = new Server();
      squatters.add(squatter);
      squatter.once("error", () => done?.(err));
      squatter.listen(port, host, () => done?.(err));
    });
  };
  // llmlint: ignore-end[e2e_not_mocked]
  try {
    const server = await startFixtureServer("port-held", []);
    try {
      const health = await page.request.get(`${server.origin}/healthz`);
      expect(health.ok()).toBe(true);
      await page.goto(
        `${server.origin}/?list=runs&run=${runs().live}&view=graph`,
      );
      await expect(page.getByText("DAG Observatory")).toBeVisible();
      await expect(graphNodes(page).first()).toBeVisible();
    } finally {
      await server.stop();
    }
  } finally {
    Server.prototype.close = close;
    await Promise.all(
      [...squatters].map(
        (squatter) =>
          new Promise<void>((resolve) => close.call(squatter, () => resolve())),
      ),
    );
  }
});
