import type { ShutdownReport, ShutdownScope } from "@onepipeline-ui/dag-model";
import type { ShutdownOptions } from "@onepipeline-ui/telemetry-client";
import { useCallback, useRef, useState } from "react";
import {
  type ScopedRun,
  type SentShutdown,
  type ShutdownState,
  settleFailure,
} from "./shutdown-model";

export interface Shutdown {
  readonly state: ShutdownState;
  /**
   * Send the one request a confirmed dialog asks for. A second call while one is
   * out is ignored: a shutdown is minutes long, and two of them over the same
   * runs would be two engines signalling the same processes.
   */
  readonly confirm: (
    runs: readonly ScopedRun[],
    grace: number,
    force: boolean,
  ) => void;
  /** Put the last outcome away. Nothing is sent. */
  readonly dismiss: () => void;
}

/**
 * One shutdown control's request and what became of it.
 *
 * `send` is the route this control is wired to — one run's, or the session's
 * or the host's — so the hook knows nothing of scopes beyond the word it
 * records the request under.
 */
export function useShutdown(
  scope: ShutdownScope,
  send: (options: ShutdownOptions) => Promise<ShutdownReport>,
): Shutdown {
  const [state, setState] = useState<ShutdownState>({ phase: "idle" });
  const out = useRef(false);
  const confirm = useCallback(
    (runs: readonly ScopedRun[], grace: number, force: boolean) => {
      if (out.current) return;
      out.current = true;
      const sent: SentShutdown = {
        scope,
        runs,
        grace,
        force,
        sentAt: Date.now(),
      };
      setState({ phase: "sending", sent });
      send({ grace, force })
        .then(
          (report) => setState({ phase: "answered", sent, report }),
          (caught: unknown) => setState(settleFailure(sent, caught)),
        )
        .finally(() => {
          out.current = false;
        });
    },
    [scope, send],
  );
  const dismiss = useCallback(() => {
    if (!out.current) setState({ phase: "idle" });
  }, []);
  return { state, confirm, dismiss };
}
