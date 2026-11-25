import { API_V2_PATHS } from "@onepipeline-ui/dag-model";
import { describe, expect, it } from "vitest";
import {
  FIRST_SUBSCRIPTIONS_PATH,
  firstConversationPath,
} from "../first-screen/paths";

/**
 * The drift gate for the routes the first-screen chunk asks for.
 *
 * `first-screen/paths.ts` spells them without the package whose index loads every
 * schema, so each is held here to `API_V2_PATHS`, which every other read takes: a
 * route that moved there, or an id the two would encode differently, fails here.
 */
describe("the first screen's routes", () => {
  it("subscribes where the app subscribes", () => {
    expect(FIRST_SUBSCRIPTIONS_PATH).toBe(API_V2_PATHS.subscriptions);
  });

  it.each([
    ["dag-ui-live", "3f9a1c2e-4b5d-4e6f-8a7b-9c0d1e2f3a4b"],
    ["a run with spaces", "session:with%colon"],
    ["ünïcode-run", "a&b=c+d"],
  ])("reads run %j's conversation %j where the app reads it", (run, id) => {
    expect(firstConversationPath(run, id)).toBe(
      API_V2_PATHS.conversation(run, id),
    );
  });
});
