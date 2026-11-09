import { Server } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { runs } from "./fixture-facts";
import { startFixtureServer } from "./fixture-server";
import { graphNodes } from "./observatory-locators";

/**
 * A journey's own read API is reached on a port nothing else can take while the
 * journey runs — from the moment its origin is reported, across a stop and a
 * rebuild, until it is stopped for good.
 *
 * Choosing a port by binding a probe and closing it hands the number to whichever
 * process binds next, and the server that was meant to have it binds seconds later,
 * after its corpus is written: a journey failed in CI with the fixture server
 * exiting 2, `cannot bind 127.0.0.1:…: Address already in use`. A restart that lets
 * the port go and binds it again has the same gap. These journeys are the neighbour
 * that takes it, made deterministic rather than left to the host.
 */

/**
 * A neighbour on this host: every port a listener in this process gives up is
 * taken before the one who gave it up hears it is closed, and `take` tries for a
 * port by number, as any other process could. `leave` lets every port go again.
 */
function neighbour(): {
    take: (port: number) => Promise<boolean>;
    leave: () => Promise<void>;
} {
    const squatters = new Set<Server>();
    const close = Server.prototype.close;
    const squat = (port: number, host: string): Promise<boolean> =>
        new Promise((resolve) => {
            const squatter = new Server();
            squatter.once("error", () => resolve(false));
            squatter.listen(port, host, () => {
                squatters.add(squatter);
                resolve(true);
            });
        });
    // llmlint: ignore-block[e2e_not_mocked] nothing is substituted: every close still runs Node's own, and the squatter is a real listener on the real port. Wrapping close is the one place the neighbour can act between a release and the releaser learning of it, which is what makes this race deterministic rather than a bet on the host's timing; a separate process cannot see that instant. The fixture server, its child, the read API and the browser are all real.
    Server.prototype.close = function squatOnClose(
        this: Server,
        done?: (err?: Error) => void,
    ): Server {
        const address = this.address();
        if (
            squatters.has(this) ||
            address === null ||
            typeof address !== "object"
        )
            return close.call(this, done);
        const { port, address: host } = address;
        return close.call(this, (err?: Error) => {
            void squat(port, host).then(() => done?.(err));
        });
    };
    // llmlint: ignore-end[e2e_not_mocked]
    return {
        take: (port) => squat(port, "127.0.0.1"),
        leave: async () => {
            Server.prototype.close = close;
            await Promise.all(
                [...squatters].map(
                    (squatter) =>
                        new Promise<void>((resolve) =>
                            close.call(squatter, () => resolve()),
                        ),
                ),
            );
        },
    };
}

/** The live run's graph, opened on `origin`: the view and its data from there. */
async function servesView(page: Page, origin: string): Promise<void> {
    const health = await page.request.get(`${origin}/healthz`);
    expect(health.ok()).toBe(true);
    await page.goto(`${origin}/?list=runs&run=${runs().live}&view=graph`);
    await expect(page.getByText("DAG Observatory")).toBeVisible();
    await expect(graphNodes(page).first()).toBeVisible();
}

test("a fixture server starts and serves its view though every port a probe releases is taken at once", async ({
    page,
}) => {
    const taking = neighbour();
    try {
        const server = await startFixtureServer("port-held", []);
        try {
            await servesView(page, server.origin);
        } finally {
            await server.stop();
        }
    } finally {
        await taking.leave();
    }
});

test("a fixture server stopped and rebuilt serves its view on the same origin though every port it could give up is taken", async ({
    page,
}) => {
    const taking = neighbour();
    try {
        const server = await startFixtureServer("port-kept", []);
        try {
            const port = Number(new URL(server.origin).port);
            await servesView(page, server.origin);
            await server.stopServing();
            // Stopped, the origin answers nothing, and the neighbour asks for its
            // port by number — holding it, if it is given it, through the rebuild.
            expect(
                await fetch(`${server.origin}/healthz`).then(
                    () => "answered",
                    () => "unanswered",
                ),
            ).toBe("unanswered");
            const took = await taking.take(port);
            await server.serveRebuilt();
            await servesView(page, server.origin);
            expect(took, "the origin's port was free while stopped").toBe(
                false,
            );
        } finally {
            await server.stop();
        }
    } finally {
        await taking.leave();
    }
});

/** `GET /api/human-items`, as far as the next journey reads it. */
const listedStamps = z.looseObject({
    items: z.array(
        z.looseObject({ item: z.looseObject({ created_at: z.string() }) }),
    ),
});

/**
 * The screenshot tier gates on image hashes and an item's detail prints when it was
 * raised, so a world built for a capture has to read the capture's clock through the
 * real server; a journey's world, which names none, keeps the engine's own stamps.
 */
test("a human-items world reads the clock a capture names, and the engine's without one", async ({
    request,
}) => {
    const raisedAt = async (env: Record<string, string>): Promise<number[]> => {
        const server = await startFixtureServer(
            "restamped-world",
            ["--human-items-world", "realistic"],
            env,
        );
        try {
            const response = await request.get(
                `${server.origin}/api/human-items`,
            );
            expect(response.status()).toBe(200);
            const { items } = listedStamps.parse(await response.json());
            return items.map(({ item }) => Date.parse(item.created_at));
        } finally {
            await server.stop();
        }
    };
    const instant = "2099-09-23T09:00:00.000Z";
    const hour = 3_600_000;

    const captured = await raisedAt({ DAG_UI_FIXTURE_NOW: instant });
    expect(captured.length).toBeGreaterThan(0);
    for (const stamp of captured) {
        expect(stamp).toBeLessThan(Date.parse(instant));
        expect(stamp).toBeGreaterThan(Date.parse(instant) - hour);
    }
    expect(await raisedAt({ DAG_UI_FIXTURE_NOW: instant })).toEqual(captured);

    const started = Date.now();
    for (const stamp of await raisedAt({}))
        expect(Math.abs(stamp - started)).toBeLessThan(hour);
});
