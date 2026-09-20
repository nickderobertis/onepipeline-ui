import { API_V2_PATHS, API_V2_QUERY } from "@onepipeline-ui/dag-model";
import { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { vi } from "vitest";
import {
  channelQueue,
  HISTORY_RUN,
  harnessTranscript,
  LIVE_RUN,
  LONG_SESSION,
  longConversation,
  nodeAgents,
  projectAgents,
  projectList,
  receipt,
  runAgents,
  runDetail,
  runList,
  runScopeTimeline,
  runStatus,
  runTimeline,
  unwatched,
} from "./fixtures";

/**
 * The browser `EventSource` the telemetry client opens, implemented over a real
 * `EventTarget` so the client's own listeners and `MessageEvent`s run unchanged.
 * jsdom ships no `EventSource`, and this is the browser boundary the client
 * deliberately takes as an injectable factory — not a layer of the app under test.
 */
export class FakeEventSource extends EventTarget {
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    super();
  }

  close(): void {
    this.closed = true;
  }

  /** Deliver one server-sent frame exactly as the browser would. */
  emit(event: string, data: unknown, lastEventId = "1"): void {
    this.dispatchEvent(
      new MessageEvent(event, { data: JSON.stringify(data), lastEventId }),
    );
  }

  /** Drop the stream the way a browser reports a lost connection. */
  fail(): void {
    this.onerror?.(new Event("error"));
  }
}

export interface TelemetryHarness {
  readonly client: TelemetryClient;
  readonly sources: FakeEventSource[];
  readonly fetch: ReturnType<typeof vi.fn>;
}

type Responder = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** True for the run-list path the packages publish, whatever it is. */
export const isRunList = (url: URL): boolean =>
  url.pathname === API_V2_PATHS.runs;

/**
 * The runs a `?select=` names, or `undefined` for a page read.
 *
 * A selection and a page are two answers to different questions on one route, so
 * everything here that answers the run list has to tell them apart the way the
 * server does.
 */
export const selectedRuns = (url: URL): string[] | undefined => {
  const select = url.searchParams.get(API_V2_QUERY.select);
  return select === null ? undefined : select.split(",");
};

/**
 * The selection answer for a list, under the server's own rules: the rows for the
 * runs named, in the order the list serves them, the ones it could not find in
 * `missing`, and no cursor.
 */
export const selectionOf = (
  list: { runs: { run_id: string }[] },
  named: readonly string[],
): Record<string, unknown> => {
  const runs = list.runs.filter(({ run_id }) => named.includes(run_id));
  const missing = named.filter(
    (runId) => !runs.some(({ run_id }) => run_id === runId),
  );
  return {
    ...list,
    runs,
    next_cursor: undefined,
    ...(missing.length > 0 ? { missing } : {}),
  };
};

/**
 * True for a single run's detail path, whatever run it names — the run route itself
 * and nothing beneath it, so a route added under `/runs/<id>/` is not mistaken for
 * the detail read.
 */
export const isRunDetail = (url: URL): boolean =>
  url.pathname.startsWith(`${API_V2_PATHS.runs}/`) &&
  !url.pathname.slice(API_V2_PATHS.runs.length + 1).includes("/");

/** True for a run's timeline path, whatever run it names. */
export const isTimeline = (url: URL): boolean =>
  url.pathname.endsWith("/timeline");

/**
 * True for the whole-run scope of that path. It is a different payload rather than a
 * subset of the node one — each node reduced to its root and one bounded summary per
 * category — so a view that reads it is answered with it.
 */
export const isRunScopeTimeline = (url: URL): boolean =>
  isTimeline(url) && url.searchParams.get(API_V2_QUERY.scope) === "run";

/** True for one transcript's path, whatever run and conversation it names. */
export const isConversation = (url: URL): boolean =>
  url.pathname.includes("/conversations/");

/**
 * The recorded run whose payloads stand in for the run a `/api/v2/runs/...` path
 * names. Two runs are recorded, and any other identifier — including one the app
 * asks for from a stale bookmark — is answered with the live run's shape, exactly
 * as a server that still holds that run would.
 */
export const fixtureRunFor = (url: URL): string =>
  url.pathname.split("/")[4] === HISTORY_RUN ? HISTORY_RUN : LIVE_RUN;

/**
 * The read API a browser would see: list, detail, timeline, one transcript, and the
 * SSE stream. Detail honours `include_conversations` exactly as the server does — it
 * serves the field empty rather than omitting it — so a client that opts out here is
 * opting out of the same payload it would opt out of in production.
 */
/** True for the grouped project listing. */
export const isProjectList = (url: URL): boolean =>
  url.pathname === API_V2_PATHS.projects;

/** The project a `/api/v2/projects/<id>` path names, decoded, or `undefined`. */
export const projectOf = (url: URL): string | undefined =>
  url.pathname.startsWith(`${API_V2_PATHS.projects}/`)
    ? decodeURIComponent(url.pathname.slice(API_V2_PATHS.projects.length + 1))
    : undefined;

/** The verb a `/api/v2/runs/<id>/<verb>` path names — `status`, `channel/next` — or `undefined`. */
export const verbOf = (url: URL): string | undefined => {
  const parts = url.pathname.split("/");
  return parts[3] === "runs" && parts.length > 5
    ? parts.slice(5).join("/")
    : undefined;
};

/**
 * The wrapped verbs, answered the way the server answers them over the two
 * recorded runs: the projects, the status and channel of a run, the acting
 * session's unwatched runs, and a receipt for anything written.
 */
function verbResponder(url: URL): Response | undefined {
  if (isProjectList(url)) return Response.json(projectList);
  const project = projectOf(url);
  if (project !== undefined) {
    // The project's agents, or the group itself: `<id>/agents` names the union
    // over the group's runs, and the id alone names the group.
    const [id, verb] = project.split("/");
    const group = projectList.projects.find((g) => g.project === id);
    if (group === undefined)
      return Response.json(
        { error: { code: "project_not_found", message: "no such project" } },
        { status: 404 },
      );
    return verb === "agents"
      ? Response.json(projectAgents(id ?? ""))
      : Response.json({ ...projectList, ...group });
  }
  if (url.pathname === API_V2_PATHS.unwatched)
    return Response.json(unwatched());
  if (url.pathname === API_V2_PATHS.host)
    return Response.json({
      ...unwatched(),
      reported: undefined,
      unresolved: undefined,
      rendered: "host a-host\n  no live dispatches\n",
    });
  const verb = verbOf(url);
  const runId = fixtureRunFor(url);
  if (verb?.startsWith("nodes/") && verb.endsWith("/agents"))
    return Response.json(nodeAgents(runId, verb.split("/")[1] ?? ""));
  if (verb?.startsWith("artifacts/"))
    return Response.json(harnessTranscript(verb.slice("artifacts/".length)));
  switch (verb) {
    case "agents":
      return Response.json(runAgents(runId));
    case "status":
      return Response.json(runStatus(runId));
    case "channel":
      return Response.json(channelQueue(runId));
    case "channel/reply":
    case "attest":
      return Response.json(receipt(runId));
    case "channel/surface":
      return Response.json({
        ...receipt(runId),
        receipt: undefined,
        advice: undefined,
        surface: 4,
        state: "queued",
      });
    case "channel/next":
      return Response.json({
        ...receipt(runId),
        receipt: undefined,
        advice: undefined,
        status: "surface",
        surface: channelQueue(runId).waiting[0],
        events: [],
      });
    case "results":
    case "goals":
      return Response.json({
        ...receipt(runId),
        receipt: undefined,
        advice: undefined,
        rendered: `${runId}  rendered ${verb}\n`,
      });
    case "transcript":
      return Response.json({
        ...receipt(runId),
        receipt: undefined,
        advice: undefined,
        node: url.searchParams.get("node"),
        rendered: `${runId}  transcript\n`,
      });
    case "telemetry":
      return Response.json({
        ...receipt(runId),
        receipt: undefined,
        advice: undefined,
        telemetry: { schema_version: 2, run_id: runId },
      });
    default:
      return undefined;
  }
}

export function defaultResponder(url: URL): Response {
  const verb = verbResponder(url);
  if (verb !== undefined) return verb;
  if (isRunList(url)) {
    const named = selectedRuns(url);
    return Response.json(
      named === undefined ? runList : selectionOf(runList, named),
    );
  }
  const runId = fixtureRunFor(url);
  if (isTimeline(url))
    return Response.json(
      isRunScopeTimeline(url) ? runScopeTimeline(runId) : runTimeline(runId),
    );
  if (isConversation(url)) {
    const wanted = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    if (wanted === LONG_SESSION) return Response.json(longConversation());
    const found = runDetail(runId).conversations.find(
      ({ conversation }) => conversation.id === wanted,
    );
    return found
      ? Response.json(found)
      : Response.json(
          {
            error: { code: "conversation_not_found", message: "no transcript" },
          },
          { status: 404 },
        );
  }
  const detail = runDetail(runId);
  return Response.json(
    url.searchParams.get(API_V2_QUERY.includeConversations) === "false"
      ? { ...detail, conversations: [] }
      : detail,
  );
}

/** A real `TelemetryClient` wired to a doubled network and event stream. */
export function telemetryHarness(
  responder: Responder = defaultResponder,
): TelemetryHarness {
  const sources: FakeEventSource[] = [];
  const fetchDouble = vi.fn(
    async (input: URL | RequestInfo, init?: RequestInit) =>
      responder(new URL(String(input), window.location.origin), init),
  );
  const client = new TelemetryClient(window.location.origin, {
    // `typeof fetch` carries overloads and a `preconnect` property that no
    // double can implement and the client never reaches for; the harness only
    // has to answer the one call signature above.
    fetch: fetchDouble as unknown as typeof fetch,
    eventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      // `EventSource` is a DOM class jsdom does not implement. What the client
      // uses of it is the listener/close surface `FakeEventSource` provides,
      // and the test drives that surface directly to deliver events.
      return source as unknown as EventSource;
    },
  });
  return { client, sources, fetch: fetchDouble };
}
