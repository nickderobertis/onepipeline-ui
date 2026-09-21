import {
  type Adopted,
  API_V2_PATHS,
  API_V2_QUERY,
  API_V2_TIMELINE_SCOPES,
  type ArtifactContent,
  adoptedSchema,
  apiErrorSchema,
  artifactContentSchema,
  type ChannelNext,
  type ChannelQueue,
  channelNextSchema,
  channelQueueSchema,
  type DagConversation,
  dagConversationSchema,
  type ProjectAgents,
  type ProjectDetail,
  type ProjectList,
  projectAgentsSchema,
  projectDetailSchema,
  projectListSchema,
  type RenderedRoot,
  type RenderedRun,
  type ReplyReceipt,
  type RunAgents,
  type RunDetail,
  type RunList,
  type RunStatus,
  type RunTelemetryDocument,
  type RunTimeline,
  type RunTranscript,
  renderedRootSchema,
  renderedRunSchema,
  replyReceiptSchema,
  runAgentsSchema,
  runDetailSchema,
  runListSchema,
  runStatusSchema,
  runTelemetryDocumentSchema,
  runTimelineSchema,
  runTranscriptSchema,
  type SseEventName,
  type Stopped,
  type Surfaced,
  sseEventDataSchema,
  sseEventNameSchema,
  stoppedSchema,
  surfacedSchema,
  type Unwatched,
  unwatchedSchema,
  type WatchEventName,
  type WatchFrameData,
  watchEventNameSchema,
  watchFrameDataSchema,
} from "@onepipeline-ui/dag-model";

// llmlint: ignore-file[changed_behavior_has_e2e] client.e2e.test.ts crosses a real loopback HTTP
// boundary through the package export. Bun has no native browser EventSource implementation, so
// SSE is exercised at its public EventSource interface with real MessageEvents in index.test.ts;
// the injected factory is the browser boundary, not an internal client layer.

export class TelemetryClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TelemetryClientError";
  }
}

export interface TelemetryEvent {
  readonly id: string;
  readonly event: SseEventName;
  readonly data: RunList | Record<string, unknown>;
}

export interface TelemetrySubscription {
  close(): void;
}

export interface SubscribeOptions {
  readonly runId?: string;
  readonly after?: string;
  /**
   * Which events this connection is watching for, as a profile name or an inline
   * spec. A run whose only new records the filter excludes is not announced, so a
   * subscriber narrowed to decisions is not woken by every tool call.
   */
  readonly filter?: string;
  readonly onEvent: (event: TelemetryEvent) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * One frame of a held watch: the server's cursor within the connection, which of
 * the three frames it is, and the engine's own record for it.
 */
export interface WatchFrame {
  readonly id: string;
  readonly event: WatchEventName;
  readonly data: WatchFrameData;
}

export interface WatchOptions {
  readonly runId: string;
  /**
   * What ends the wait — the CLI's own conditions, repeatable — beside the run
   * finishing and nothing driving it. Omitted, the server defaults to `surface`.
   */
  readonly until?: readonly string[];
  /** Whole seconds, `0` to read once and return, or `"none"` to never give up. */
  readonly timeout?: number | "none";
  /** The heartbeat interval in whole seconds, `0` to turn it off. */
  readonly tick?: number;
  /** Which events the stream reports, as a profile name or an inline spec. */
  readonly filter?: string;
  /** Resume from the cursor an earlier watch returned. */
  readonly cursor?: string;
  readonly onFrame: (frame: WatchFrame) => void;
  readonly onError?: (error: unknown) => void;
}

type EventSourceFactory = (url: string) => EventSource;
type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface RunDetailOptions {
  /** Omit to accept the server default (`true`). */
  readonly includeConversations?: boolean;
  /**
   * Which events this reading carries: a built-in profile (`planner`, `monitor`),
   * one the run's own launch config defined, or an inline spec.
   *
   * A `string` rather than the built-in union, deliberately: a run may answer to
   * a name this client has never heard of, and refusing to send one would make
   * the browser the only reader that cannot use a profile its own run defined.
   */
  readonly filter?: string;
}

export interface TelemetryClientOptions {
  readonly fetch?: Fetch;
  readonly eventSource?: EventSourceFactory;
}

// Owned by `RUNS_PAGE_LIMIT` in the crate's src/contract.rs; sending it explicitly
// keeps continuation pages the same size as the first. TypeScript cannot read a Rust
// constant, so this line is a copy, and the copy is gated: `tests/contract.rs`'s
// `the_browser_clients_copy_of_the_page_bound_matches_this_one` reads this file and
// fails when the two numbers disagree, whichever side moved.
const RUNS_PAGE_LIMIT = 50;

export class TelemetryClient {
  readonly #baseUrl: URL;
  readonly #fetch: Fetch;
  readonly #eventSource?: EventSourceFactory;

  constructor(baseUrl: string | URL, options: TelemetryClientOptions = {}) {
    this.#baseUrl = new URL(baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#eventSource = options.eventSource;
  }

  async listRuns(
    includeSettled = false,
    cursor?: string,
    limit = RUNS_PAGE_LIMIT,
  ): Promise<RunList> {
    const url = this.#url(API_V2_PATHS.runs);
    url.searchParams.set(API_V2_QUERY.includeSettled, String(includeSettled));
    url.searchParams.set(API_V2_QUERY.limit, String(limit));
    if (cursor !== undefined) url.searchParams.set(API_V2_QUERY.cursor, cursor);
    return this.#request(url, runListSchema.parse);
  }

  /**
   * The rows for exactly the runs named, in the order the list serves them.
   *
   * What it is for: an invalidation names the run that moved, and refreshing that
   * one row must cost one row — so a live view never has to refetch the first page
   * and throw away the pages a reader scrolled to.
   *
   * It is a selection rather than a page, so nothing paging is sent with it: the
   * server refuses `include_settled`, `limit` and `cursor` beside it, answers no
   * cursor, and names the runs it could not find in `missing` rather than failing.
   * A comma separates the ids and needs no escaping — a run id on this wire is a
   * bare name — which is exactly why one carrying a comma is refused here rather
   * than being sent as two.
   */
  async selectRuns(runIds: readonly string[]): Promise<RunList> {
    if (runIds.length === 0)
      throw new TelemetryClientError("Invalid selection");
    for (const runId of runIds) {
      requireOpaqueId(runId, "run ID");
      if (runId.includes(",")) throw new TelemetryClientError("Invalid run ID");
    }
    const url = this.#url(API_V2_PATHS.runs);
    url.searchParams.set(API_V2_QUERY.select, runIds.join(","));
    return this.#request(url, runListSchema.parse);
  }

  /**
   * One run's detail.
   *
   * `includeConversations: false` asks the server for no transcripts, which it
   * serves as an empty `conversations` array. Prefer it alongside {@link getTimeline}
   * for a live view: transcripts dominate the payload and are refetched on every
   * invalidation, while a single conversation stays reachable via
   * {@link getConversation}.
   */
  async getRun(
    runId: string,
    options: RunDetailOptions = {},
  ): Promise<RunDetail> {
    requireOpaqueId(runId, "run ID");
    const url = this.#url(API_V2_PATHS.run(runId));
    if (options.includeConversations !== undefined) {
      url.searchParams.set(
        API_V2_QUERY.includeConversations,
        String(options.includeConversations),
      );
    }
    if (options.filter !== undefined) {
      url.searchParams.set(API_V2_QUERY.filter, options.filter);
    }
    return this.#request(url, runDetailSchema.parse);
  }

  /**
   * One node's timeline, or the run-level timeline when nodeId is omitted.
   *
   * `filter` narrows the events the served spans carry; the spans themselves,
   * their bounds and their statuses are what the run recorded either way.
   */
  async getTimeline(
    runId: string,
    nodeId?: string,
    filter?: string,
  ): Promise<RunTimeline> {
    requireOpaqueId(runId, "run ID");
    const url = this.#url(API_V2_PATHS.timeline(runId));
    if (filter !== undefined) url.searchParams.set(API_V2_QUERY.filter, filter);
    // The scope is always stated, and a node scope always names its node: the two
    // are one query the contract refuses to read half of.
    if (nodeId === undefined) {
      url.searchParams.set(API_V2_QUERY.scope, API_V2_TIMELINE_SCOPES.run);
    } else {
      url.searchParams.set(API_V2_QUERY.scope, API_V2_TIMELINE_SCOPES.node);
      url.searchParams.set(API_V2_QUERY.node, nodeId);
    }
    return this.#request(url, runTimelineSchema.parse);
  }

  async getConversation(
    runId: string,
    conversationId: string,
  ): Promise<DagConversation> {
    requireOpaqueId(runId, "run ID");
    requireOpaqueId(conversationId, "conversation ID");
    return this.#request(
      this.#url(API_V2_PATHS.conversation(runId, conversationId)),
      dagConversationSchema.parse,
    );
  }

  async getArtifact(
    runId: string,
    artifactId: string,
  ): Promise<ArtifactContent> {
    requireOpaqueId(runId, "run ID");
    requireOpaqueId(artifactId, "artifact ID");
    return this.#request(
      this.#url(API_V2_PATHS.artifact(runId, artifactId)),
      artifactContentSchema.parse,
    );
  }

  subscribe(options: SubscribeOptions): TelemetrySubscription {
    if (options.runId !== undefined) requireOpaqueId(options.runId, "run ID");
    if (options.after !== undefined) requireOpaqueId(options.after, "cursor");
    const url = this.#url(API_V2_PATHS.events);
    if (options.runId !== undefined)
      url.searchParams.set(API_V2_QUERY.runId, options.runId);
    if (options.after !== undefined)
      url.searchParams.set(API_V2_QUERY.after, options.after);
    if (options.filter !== undefined)
      url.searchParams.set(API_V2_QUERY.filter, options.filter);
    const source = this.#open(url);
    for (const eventName of sseEventNameSchema.options) {
      source.addEventListener(eventName, (rawEvent) => {
        try {
          // DOM's EventListener callback erases the MessageEvent subtype even though
          // EventSource listeners for named server events always receive one.
          const event = rawEvent as MessageEvent<string>;
          const decoded: unknown = JSON.parse(event.data);
          const data =
            eventName === "snapshot"
              ? runListSchema.parse(decoded)
              : sseEventDataSchema.parse(decoded);
          options.onEvent({
            id: event.lastEventId,
            event: eventName,
            data,
          });
        } catch (error) {
          options.onError?.(error);
        }
      });
    }
    source.onerror = (error) => options.onError?.(error);
    return { close: () => source.close() };
  }

  /**
   * The grouped listing: every project the root holds, newest activity first,
   * each with its runs newest first — the SDK's own order, never recomputed.
   */
  async listProjects(): Promise<ProjectList> {
    return this.#request(
      this.#url(API_V2_PATHS.projects),
      projectListSchema.parse,
    );
  }

  /**
   * One project's group. The `(no project)` group has no id and so no route of
   * its own; a reader of it takes it off {@link listProjects}.
   */
  async getProject(projectId: string): Promise<ProjectDetail> {
    requireOpaqueId(projectId, "project ID");
    return this.#request(
      this.#url(API_V2_PATHS.project(projectId)),
      projectDetailSchema.parse,
    );
  }

  /** The run's channel, read and never consumed. */
  async getChannel(runId: string): Promise<ChannelQueue> {
    requireOpaqueId(runId, "run ID");
    return this.#request(
      this.#url(API_V2_PATHS.channel(runId)),
      channelQueueSchema.parse,
    );
  }

  /**
   * Claim the next surface, as `onepipeline next` does: the channel's only
   * consumer. `filter` shapes the `events` answered and nothing else.
   */
  async claimNext(runId: string, filter?: string): Promise<ChannelNext> {
    requireOpaqueId(runId, "run ID");
    const url = this.#url(API_V2_PATHS.channelNext(runId));
    if (filter !== undefined) url.searchParams.set(API_V2_QUERY.filter, filter);
    return this.#request(url, channelNextSchema.parse, { method: "POST" });
  }

  /**
   * Send a reply envelope **as the bytes given**. Nothing here reads or reshapes
   * them: a malformed envelope is the engine's refusal in the engine's words, and
   * the author the body names is granted or refused by the run's own launch
   * configuration. `correlation` names the question a verdict answers.
   */
  async reply(
    runId: string,
    envelope: string,
    correlation?: string,
  ): Promise<ReplyReceipt> {
    requireOpaqueId(runId, "run ID");
    const url = this.#url(API_V2_PATHS.channelReply(runId));
    if (correlation !== undefined)
      url.searchParams.set(API_V2_QUERY.correlation, correlation);
    return this.#request(url, replyReceiptSchema.parse, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: envelope,
    });
  }

  /** Raise a surface on the run's channel under `kind`, with `message`. */
  async surface(
    runId: string,
    surface: { readonly kind: string; readonly message: string },
  ): Promise<Surfaced> {
    requireOpaqueId(runId, "run ID");
    return this.#request(
      this.#url(API_V2_PATHS.channelSurface(runId)),
      surfacedSchema.parse,
      json("POST", surface),
    );
  }

  /** Attest a ready human action by its reference, as the planner's own `attest`. */
  async attest(runId: string, reference: string): Promise<ReplyReceipt> {
    requireOpaqueId(runId, "run ID");
    return this.#request(
      this.#url(API_V2_PATHS.attest(runId)),
      replyReceiptSchema.parse,
      json("POST", { reference }),
    );
  }

  /**
   * Stop the run as the acting session. A run another session owns is refused
   * `409 not_owner` naming the owner unless `force` is set, in which case the
   * stop is journalled forced with the owner it overrode.
   */
  async stop(runId: string, force = false): Promise<Stopped> {
    requireOpaqueId(runId, "run ID");
    return this.#request(
      this.#url(API_V2_PATHS.stop(runId)),
      stoppedSchema.parse,
      json("POST", { force }),
    );
  }

  /** Adopt a run nothing is driving; the answer names the retained driver's pid. */
  async adopt(runId: string): Promise<Adopted> {
    requireOpaqueId(runId, "run ID");
    return this.#request(
      this.#url(API_V2_PATHS.adopt(runId)),
      adoptedSchema.parse,
      {
        method: "POST",
      },
    );
  }

  /**
   * Hold `GET .../watch` as a server-sent stream. While it is held the server is
   * the run's registered watcher; the `returned` frame ends the wait and this
   * closes the source on it, so the browser does not reopen a wait that is over.
   */
  watch(options: WatchOptions): TelemetrySubscription {
    requireOpaqueId(options.runId, "run ID");
    const url = this.#url(API_V2_PATHS.watch(options.runId));
    for (const condition of options.until ?? [])
      url.searchParams.append(API_V2_QUERY.until, condition);
    if (options.timeout !== undefined)
      url.searchParams.set(API_V2_QUERY.timeout, String(options.timeout));
    if (options.tick !== undefined)
      url.searchParams.set(API_V2_QUERY.tick, String(options.tick));
    if (options.filter !== undefined)
      url.searchParams.set(API_V2_QUERY.filter, options.filter);
    if (options.cursor !== undefined)
      url.searchParams.set(API_V2_QUERY.cursor, options.cursor);
    const source = this.#open(url);
    for (const eventName of watchEventNameSchema.options) {
      source.addEventListener(eventName, (rawEvent) => {
        try {
          // DOM's EventListener callback erases the MessageEvent subtype even though
          // EventSource listeners for named server events always receive one.
          const event = rawEvent as MessageEvent<string>;
          const data = watchFrameDataSchema.parse(JSON.parse(event.data));
          if (eventName === "returned") source.close();
          options.onFrame({ id: event.lastEventId, event: eventName, data });
        } catch (error) {
          options.onError?.(error);
        }
      });
    }
    source.onerror = (error) => options.onError?.(error);
    return { close: () => source.close() };
  }

  /** The runs the acting session owns that nothing is watching. */
  async unwatched(): Promise<Unwatched> {
    return this.#request(
      this.#url(API_V2_PATHS.unwatched),
      unwatchedSchema.parse,
    );
  }

  /** Every live dispatch on the host, as `onepipeline host` prints it. */
  async host(): Promise<RenderedRoot> {
    return this.#request(
      this.#url(API_V2_PATHS.host),
      renderedRootSchema.parse,
    );
  }

  async getStatus(runId: string): Promise<RunStatus> {
    requireOpaqueId(runId, "run ID");
    return this.#request(
      this.#url(API_V2_PATHS.status(runId)),
      runStatusSchema.parse,
    );
  }

  async getResults(runId: string): Promise<RenderedRun> {
    requireOpaqueId(runId, "run ID");
    return this.#request(
      this.#url(API_V2_PATHS.results(runId)),
      renderedRunSchema.parse,
    );
  }

  async getGoals(): Promise<RenderedRoot> {
    return this.#request(
      this.#url(API_V2_PATHS.goals),
      renderedRootSchema.parse,
    );
  }

  async getRunGoals(runId: string): Promise<RenderedRun> {
    requireOpaqueId(runId, "run ID");
    return this.#request(
      this.#url(API_V2_PATHS.runGoals(runId)),
      renderedRunSchema.parse,
    );
  }

  /** The CLI's rendering of a node's transcript, or the whole run's when `node` is omitted. */
  async getTranscript(runId: string, node?: string): Promise<RunTranscript> {
    requireOpaqueId(runId, "run ID");
    const url = this.#url(API_V2_PATHS.transcript(runId));
    if (node !== undefined) url.searchParams.set(API_V2_QUERY.node, node);
    return this.#request(url, runTranscriptSchema.parse);
  }

  /** The SDK's own telemetry document for the run. */
  async getTelemetryDocument(runId: string): Promise<RunTelemetryDocument> {
    requireOpaqueId(runId, "run ID");
    return this.#request(
      this.#url(API_V2_PATHS.telemetry(runId)),
      runTelemetryDocumentSchema.parse,
    );
  }

  /**
   * Every oneharness session the run's launches wrote, off the run's own
   * pointer file. A run with no pointer file is an empty list.
   */
  async getAgents(runId: string): Promise<RunAgents> {
    requireOpaqueId(runId, "run ID");
    return this.#request(
      this.#url(API_V2_PATHS.agents(runId)),
      runAgentsSchema.parse,
    );
  }

  /** The sessions one node's dispatches wrote; a node that dispatched nothing is an empty list. */
  async getNodeAgents(runId: string, nodeId: string): Promise<RunAgents> {
    requireOpaqueId(runId, "run ID");
    requireOpaqueId(nodeId, "node ID");
    return this.#request(
      this.#url(API_V2_PATHS.nodeAgents(runId, nodeId)),
      runAgentsSchema.parse,
    );
  }

  /** The union over a project's runs, under the same id {@link getProject} takes. */
  async getProjectAgents(projectId: string): Promise<ProjectAgents> {
    requireOpaqueId(projectId, "project ID");
    return this.#request(
      this.#url(API_V2_PATHS.projectAgents(projectId)),
      projectAgentsSchema.parse,
    );
  }

  #url(path: string): URL {
    return new URL(path, this.#baseUrl);
  }

  #open(url: URL): EventSource {
    const create =
      this.#eventSource ??
      ((sourceUrl: string) => {
        if (typeof EventSource === "undefined") {
          throw new TelemetryClientError(
            "EventSource is unavailable; provide an eventSource factory",
          );
        }
        return new EventSource(sourceUrl);
      });
    return create(url.toString());
  }

  async #request<T>(
    url: URL,
    parse: (value: unknown) => T,
    init?: RequestInit,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (error) {
      throw new TelemetryClientError(
        "Telemetry request failed",
        undefined,
        undefined,
        {
          cause: error,
        },
      );
    }
    const value: unknown = await response.json().catch((error: unknown) => {
      throw new TelemetryClientError(
        "Telemetry server returned invalid JSON",
        response.status,
        undefined,
        { cause: error },
      );
    });
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(value);
      throw new TelemetryClientError(
        parsed.success
          ? parsed.data.error.message
          : `Telemetry request failed with status ${response.status}`,
        response.status,
        parsed.success ? parsed.data.error.code : undefined,
      );
    }
    try {
      return parse(value);
    } catch (error) {
      throw new TelemetryClientError(
        "Telemetry response failed contract validation",
        response.status,
        undefined,
        { cause: error },
      );
    }
  }
}

/** A JSON request body with the header that says so. */
function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function requireOpaqueId(value: string, label: string): void {
  const hasControlCharacter = [...value].some(
    (character) => character.charCodeAt(0) < 32,
  );
  if (value.length === 0 || hasControlCharacter || /[/?#]/u.test(value)) {
    throw new TelemetryClientError(`Invalid ${label}`);
  }
}
