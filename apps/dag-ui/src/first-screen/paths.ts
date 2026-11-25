/**
 * The read API's routes the page's entry asks for before the app loads.
 *
 * Spelled here rather than imported from `@onepipeline-ui/dag-model`, whose index
 * loads every payload schema, because the first-screen chunk parses no payload and
 * everything it loads counts against a run's first second.
 * `src/test/first-screen-paths.test.ts` holds each route to `API_V2_PATHS`, the
 * one source the rest of the app reads, so a route that moved fails there.
 */

/** Where the entry subscribes the view its address names. */
export const FIRST_SUBSCRIPTIONS_PATH = "/api/v2/subscriptions";

/** Where the entry reads the transcript of the conversation its address opens. */
export function firstConversationPath(
  runId: string,
  conversationId: string,
): string {
  return `/api/v2/runs/${encodeURIComponent(runId)}/conversations/${encodeURIComponent(conversationId)}`;
}
