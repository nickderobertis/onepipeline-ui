import { type AddressInfo, Server } from "node:net";
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
  Server.prototype.close = function squatOnClose(
    this: Server,
    done?: (err?: Error) => void,
  ): Server {
    const address = this.address();
    if (squatters.has(this) || address === null || typeof address !== "object")
      return close.call(this, done);
    const { port, address: host } = address as AddressInfo;
    return close.call(this, (err?: Error) => {
      const squatter = new Server();
      squatters.add(squatter);
      squatter.once("error", () => done?.(err));
      squatter.listen(port, host, () => done?.(err));
    });
  };
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
