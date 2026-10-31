/**
 * The file a fixture server publishes beside its runs root, so a spec names what it
 * wrote rather than a copy of it.
 *
 * A module of its own, importing nothing, because both sides of that file import it:
 * `serve-fixture.mjs`, which writes it and runs on import, and `fixture-facts.ts`,
 * which reads it and chooses the tier's ports on import.
 */
export const FIXTURE_FACTS_NAME = "fixture-facts.json";

/**
 * The file a serving fixture names its own pid in, inside its workspace, so the
 * global teardown — which Playwright runs before it stops its web servers — can
 * stop that server and wait for it before removing the workspace it writes into.
 */
export const SERVING_PID_NAME = "serve-fixture.pid";

/**
 * The file a serving fixture names the binary it copied its server from in, inside
 * its workspace, so a journey can hold the fixture to the build step that made it.
 */
export const SERVED_FROM_NAME = "serve-fixture.served-from";
