/**
 * The file a fixture server publishes beside its runs root, so a spec names what it
 * wrote rather than a copy of it.
 *
 * A module of its own, importing nothing, because both sides of that file import it:
 * `serve-fixture.mjs`, which writes it and runs on import, and `fixture-facts.ts`,
 * which reads it and chooses the tier's ports on import.
 */
export const FIXTURE_FACTS_NAME = "fixture-facts.json";
