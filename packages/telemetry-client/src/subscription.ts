import {
  API_V2_PATHS,
  API_V2_QUERY,
  applyPatch,
  type ResetFrame,
  type SidebarRow,
  SUBSCRIPTION_FRAME_TYPES,
  type Subscribed,
  type SubscriptionFrame,
  type SubscriptionSnapshot,
  type SubscriptionView,
  subscriptionFrameSchema,
  type VisibleState,
} from "@onepipeline-ui/dag-model";

/**
 * What a tab holds of the server: the sidebar's rows and the one visible view,
 * as of the frame `applied` names.
 */
export interface LiveState {
  readonly sidebar: readonly SidebarRow[];
  readonly visible: VisibleState;
  /** The id of the snapshot or frame this state is as of. */
  readonly applied: string;
}

/** Why a state was handed over. */
export type LiveCause =
  | { readonly kind: "snapshot" }
  | { readonly kind: "frame"; readonly frame: SubscriptionFrame }
  | { readonly kind: "reset"; readonly reason: ResetFrame["reason"] };

export interface LiveViewOptions {
  readonly view: SubscriptionView;
  /** Every state the tab moves to, in order. */
  readonly onState: (state: LiveState, cause: LiveCause) => void;
  /**
   * A protocol error — a frame or patch this client cannot apply — after which
   * nothing more is applied, or a failure to subscribe at all.
   */
  readonly onError?: (error: Error) => void;
  /** The stream dropped: the browser is retrying it, or it is offline. */
  readonly onDisconnected?: () => void;
  /** The stream is connected again after a drop. */
  readonly onConnected?: () => void;
}

/** The parts of the client a live view needs. */
export interface LiveTransport {
  subscribe(body: {
    view: SubscriptionView;
    replaces?: string;
    resume?: string;
  }): Promise<Subscribed>;
  /** `keepalive` lets the retirement outlive a page being unloaded. */
  retire(subscription: string, keepalive?: boolean): Promise<void>;
  open(url: URL): EventSource;
  url(path: string): URL;
}

/** How long a stream that dropped waits before it is opened again. */
const RECONNECT_MS = 1_000;

function seqOf(id: string): { epoch: string; seq: number } {
  const at = id.lastIndexOf(":");
  return { epoch: id.slice(0, at), seq: Number(id.slice(at + 1)) };
}

/**
 * One tab's subscription, kept current from what the server pushes.
 *
 * Created with the view the tab shows, it is answered with that view's state at
 * one publication boundary and then reads the stream for the changes after it.
 * Frames are applied in order and only onto the frame they name as their base;
 * one that is already applied is ignored, and one whose base is not the applied
 * cursor is not applied — the stream is opened again from the applied cursor,
 * which is what keeps a replayed append from landing twice. A stream the server
 * no longer serves (`410`, which an `EventSource` reports by closing) is
 * recreated with `resume`, and its explicit reset is applied once.
 *
 * `change` replaces the subscription for a new view and retires the old one, so
 * a view the tab stopped showing is no longer read; `close` retires it.
 */
export class LiveView {
  readonly #transport: LiveTransport;
  readonly #options: LiveViewOptions;
  #view: SubscriptionView;
  #subscription?: string;
  #state?: LiveState;
  #source?: EventSource;
  #retry?: ReturnType<typeof setTimeout>;
  #closed = false;
  #failed = false;
  /** Bumped by every `change`, so a creation it overtook is dropped. */
  #generation = 0;
  readonly #offline = () => {
    this.#disconnect();
    this.#options.onDisconnected?.();
  };
  readonly #online = () => this.#connect();
  /** A page going away retires its subscription rather than leaving it to expire. */
  readonly #pagehide = () => this.close(true);

  constructor(transport: LiveTransport, options: LiveViewOptions) {
    this.#transport = transport;
    this.#options = options;
    this.#view = options.view;
    globalThis.addEventListener?.("offline", this.#offline);
    globalThis.addEventListener?.("online", this.#online);
    globalThis.addEventListener?.("pagehide", this.#pagehide);
    void this.#create({});
  }

  /** The view this subscription shows. */
  get view(): SubscriptionView {
    return this.#view;
  }

  /** Show `view` instead, retiring the subscription for the old one. */
  change(view: SubscriptionView): void {
    if (this.#closed || sameView(view, this.#view)) return;
    this.#view = view;
    this.#failed = false;
    this.#disconnect();
    void this.#create(
      this.#subscription === undefined ? {} : { replaces: this.#subscription },
    );
  }

  /** End the subscription: its stream closes and the server stops reading for it. */
  close(unloading = false): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    globalThis.removeEventListener?.("offline", this.#offline);
    globalThis.removeEventListener?.("online", this.#online);
    globalThis.removeEventListener?.("pagehide", this.#pagehide);
    this.#disconnect();
    if (this.#subscription !== undefined)
      void this.#transport
        .retire(this.#subscription, unloading)
        .catch(() => undefined);
  }

  async #create(options: { replaces?: string; resume?: string }) {
    const generation = ++this.#generation;
    let subscribed: Subscribed;
    try {
      subscribed = await this.#transport.subscribe({
        view: this.#view,
        ...options,
      });
    } catch (caught) {
      if (generation !== this.#generation) return;
      this.#options.onError?.(asError(caught));
      return;
    }
    if (generation !== this.#generation || this.#closed) {
      // Overtaken by another view or closed while being made: nobody shows it.
      void this.#transport
        .retire(subscribed.subscription)
        .catch(() => undefined);
      return;
    }
    this.#subscription = subscribed.subscription;
    const initial = subscribed.initial;
    if (initial.type === "snapshot") {
      this.#take(initial.snapshot, { kind: "snapshot" });
    } else {
      this.#take(initial.snapshot, { kind: "reset", reason: initial.reason });
    }
    this.#connect();
  }

  #take(snapshot: SubscriptionSnapshot, cause: LiveCause) {
    this.#state = {
      sidebar: snapshot.sidebar,
      visible: snapshot.visible,
      applied: snapshot.id,
    };
    this.#options.onState(this.#state, cause);
  }

  #connect() {
    if (
      this.#closed ||
      this.#failed ||
      this.#source !== undefined ||
      this.#subscription === undefined ||
      this.#state === undefined
    )
      return;
    if (this.#retry !== undefined) clearTimeout(this.#retry);
    this.#retry = undefined;
    const url = this.#transport.url(API_V2_PATHS.events);
    url.searchParams.set(API_V2_QUERY.subscription, this.#subscription);
    url.searchParams.set(API_V2_QUERY.after, this.#state.applied);
    const source = this.#transport.open(url);
    this.#source = source;
    let reconnected = false;
    source.onopen = () => {
      if (reconnected) this.#options.onConnected?.();
      reconnected = true;
    };
    for (const type of SUBSCRIPTION_FRAME_TYPES) {
      source.addEventListener(type, (raw) => {
        if (this.#source !== source) return;
        // A named server-sent event is always delivered as a `MessageEvent`
        // whose data is the frame's text; anything else is not a frame.
        if (raw instanceof MessageEvent && typeof raw.data === "string")
          this.#receive(raw.data);
      });
    }
    source.onerror = () => {
      if (this.#source !== source) return;
      // A connection the browser is retrying is left to retry, from the last
      // frame it received; one it gave up on was refused — the subscription is
      // gone — and is recreated from the last frame this tab applied.
      this.#options.onDisconnected?.();
      if (source.readyState !== 2) return;
      this.#source = undefined;
      this.#retry = setTimeout(() => {
        this.#retry = undefined;
        if (this.#closed || this.#failed || this.#state === undefined) return;
        void this.#create({ resume: this.#state.applied });
      }, RECONNECT_MS);
    };
  }

  #disconnect() {
    this.#source?.close();
    this.#source = undefined;
    if (this.#retry !== undefined) clearTimeout(this.#retry);
    this.#retry = undefined;
  }

  /** Open the stream again from the applied cursor. */
  #resume() {
    this.#disconnect();
    this.#connect();
  }

  #receive(data: string) {
    const state = this.#state;
    if (state === undefined || this.#failed) return;
    let frame: SubscriptionFrame;
    try {
      frame = subscriptionFrameSchema.parse(JSON.parse(data));
    } catch (caught) {
      this.#fail(
        new Error(`A frame failed contract validation: ${message(caught)}`),
      );
      return;
    }
    if (frame.subscription !== this.#subscription) return;
    const applied = seqOf(state.applied);
    const incoming = seqOf(frame.id);
    if (incoming.epoch === applied.epoch && incoming.seq <= applied.seq) return;
    if (frame.type === "reset") {
      this.#take(frame.snapshot, { kind: "reset", reason: frame.reason });
      return;
    }
    if (frame.base !== state.applied) {
      this.#resume();
      return;
    }
    let next: LiveState;
    try {
      next = { ...applyFrame(state, frame), applied: frame.id };
    } catch (caught) {
      this.#fail(new Error(`A patch could not be applied: ${message(caught)}`));
      return;
    }
    this.#state = next;
    this.#options.onState(next, { kind: "frame", frame });
  }

  #fail(error: Error) {
    this.#failed = true;
    this.#disconnect();
    this.#options.onError?.(error);
  }
}

/** The state after one non-reset frame. */
function applyFrame(
  state: LiveState,
  frame: Exclude<SubscriptionFrame, ResetFrame>,
): Omit<LiveState, "applied"> {
  switch (frame.type) {
    case "run.changed": {
      const at = state.sidebar.findIndex((row) => row.id === frame.row.id);
      const sidebar =
        at === -1
          ? [...state.sidebar, frame.row]
          : state.sidebar.map((row, index) => (index === at ? frame.row : row));
      return { sidebar, visible: state.visible };
    }
    case "run.removed":
      return {
        sidebar: state.sidebar.filter((row) => row.id !== frame.run_id),
        visible: state.visible,
      };
    default:
      return { sidebar: state.sidebar, visible: patched(state.visible, frame) };
  }
}

/**
 * The visible state with one patch applied — to the payload of exactly the
 * view the frame names, its run, its scope and its node, or not at all.
 */
function patched(
  visible: VisibleState,
  frame: Extract<
    SubscriptionFrame,
    { type: "detail.patch" | "timeline.patch" | "channel.patch" }
  >,
): VisibleState {
  const refused = (what: string) =>
    new Error(`a ${frame.type} for ${what} this tab does not show`);
  if (visible.type === "sidebar" || visible.run_id !== frame.run_id)
    throw refused("a run");
  switch (frame.type) {
    case "detail.patch":
      return { ...visible, detail: applyPatch(visible.detail, frame.ops) };
    case "timeline.patch": {
      if (visible.type !== "timeline" || visible.scope !== frame.scope)
        throw refused("a timeline");
      if (
        frame.scope === "node" &&
        (visible.scope !== "node" || visible.node !== frame.node)
      )
        throw refused("a node's timeline");
      return { ...visible, timeline: applyPatch(visible.timeline, frame.ops) };
    }
    case "channel.patch":
      if (visible.type !== "channel") throw refused("a channel");
      return { ...visible, channel: applyPatch(visible.channel, frame.ops) };
  }
}

function sameView(left: SubscriptionView, right: SubscriptionView): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
