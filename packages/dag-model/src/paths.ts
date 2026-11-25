/**
 * The v2 API's routes, with no dependency: the one source of every path the view
 * reads, kept apart from the schemas so a chunk that loads no zod — the first
 * screen's — can name a route without spelling a copy of it.
 */

// Const assertions preserve route/query literals for consumers; widening these
// shared constants to `string` would discard the closed transport vocabulary.
export const API_V2_PATHS = {
  runs: "/api/v2/runs",
  run: (runId: string) => `/api/v2/runs/${encodeURIComponent(runId)}`,
  timeline: (runId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/timeline`,
  conversation: (runId: string, conversationId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/conversations/${encodeURIComponent(conversationId)}`,
  artifact: (runId: string, artifactId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
  /**
   * A run's timeline rows on demand, one page at a time (schema 28): what the
   * first answer and its later frames leave out of a span's `events`.
   */
  timelineEvents: (runId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/timeline/events`,
  /**
   * Every row of one node's own timeline, as newline-delimited JSON: lines of
   * `nodeStreamLineSchema` (`./index`), read as they arrive.
   */
  timelineNodeStream: (runId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/timeline/node-stream`,
  events: "/api/v2/events",
  /**
   * The post-launch verbs, wrapped: every route below `events` is a thin call
   * into `onepipeline::verbs`, one row of the contract's verb table each. A run
   * is reached by these once a plan is running — launching one and driving its
   * planning stage are outside this API, so no path here starts anything.
   */
  projects: "/api/v2/projects",
  /**
   * One project's group. The id is `<source>:<native>` and is **path-encoded on
   * the wire** — `local-md%3Aproject` — which `encodeURIComponent` spells for it,
   * so the route reads the id back through its own parser rather than splitting
   * a path segment on the colon.
   */
  project: (projectId: string) =>
    `/api/v2/projects/${encodeURIComponent(projectId)}`,
  stop: (runId: string) => `/api/v2/runs/${encodeURIComponent(runId)}/stop`,
  /** Shut down every run on the host. */
  shutdown: "/api/v2/shutdown",
  unwatched: "/api/v2/unwatched",
  host: "/api/v2/host",
  status: (runId: string) => `/api/v2/runs/${encodeURIComponent(runId)}/status`,
  results: (runId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/results`,
  goals: "/api/v2/goals",
  runGoals: (runId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/goals`,
  transcript: (runId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/transcript`,
  telemetry: (runId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/telemetry`,
  /**
   * The agents a run, one of its nodes, or a project launched — every oneharness
   * session, read off each run's own pointer file. The project's is the union
   * over its runs, under the same path-encoded id as `project`.
   */
  agents: (runId: string) => `/api/v2/runs/${encodeURIComponent(runId)}/agents`,
  nodeAgents: (runId: string, nodeId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/agents`,
  projectAgents: (projectId: string) =>
    `/api/v2/projects/${encodeURIComponent(projectId)}/agents`,
  /**
   * A tab's subscription: `POST` creates one for the sidebar and at most one
   * visible run view and answers its initial snapshot; `DELETE` of one retires
   * it, so a view the tab no longer shows is no longer read.
   */
  subscriptions: "/api/v2/subscriptions",
  subscription: (subscriptionId: string) =>
    `/api/v2/subscriptions/${encodeURIComponent(subscriptionId)}`,
} as const;
