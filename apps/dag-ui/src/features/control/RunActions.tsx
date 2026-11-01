import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@oneharness/ui";
import { TelemetryClientError } from "@onepipeline-ui/telemetry-client";
import { OctagonX } from "lucide-react";
import { useCallback, useState } from "react";
import { Outcome } from "../../lib/Outcome";
import type { RunControl } from "./useRunControl";
import { useVerb } from "./useVerb";

/**
 * The owner a refusal names, as the engine spells it — `[codex:160c290a]` —
 * read out of the refusal's own text so the confirm that overrides it can name
 * it. The whole text is shown beside it either way; this only picks the word
 * the button repeats.
 */
function ownerNamed(message: string): string | undefined {
  return /\[[^\]]+\]/.exec(message)?.[0];
}

/** Stop a run, confirming an owner override only after the engine refuses it. */
export function RunActions({
  runId,
  control,
  ended,
}: {
  readonly runId: string;
  readonly control: RunControl;
  readonly ended: boolean;
}) {
  const { stop, stopOpen, setStopOpen, forceOpen, setForceOpen, refusal } =
    useStop(control);
  const owner = refusal === undefined ? undefined : ownerNamed(refusal.message);
  const stopOutcome = stop.outcome;
  const stopping = stop.pending;

  const liveness = control.status.value?.liveness;

  return (
    <>
      <div className="run-actions">
        {liveness !== undefined && (
          <Badge
            aria-label={`Liveness ${liveness}`}
            className="run-actions-badge"
            variant="outline"
          >
            {liveness}
          </Badge>
        )}
        {!ended && (
          <Button
            aria-label="Stop"
            disabled={stopping}
            onClick={() => setStopOpen(true)}
            size="sm"
            title="Stop"
            type="button"
            variant="destructive"
          >
            <OctagonX size={14} />
            <span className="run-action-label">Stop</span>
          </Button>
        )}
      </div>
      <Dialog onOpenChange={setStopOpen} open={stopOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop {runId}?</DialogTitle>
            <DialogDescription>
              The run is stopped as the acting session. A run another session
              owns is refused, naming its owner.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={stopping}
              onClick={() => void stop.run(false)}
              type="button"
              variant="destructive"
            >
              Stop run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog onOpenChange={setForceOpen} open={forceOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Force-stop {runId}
              {owner !== undefined && `, overriding ${owner}`}?
            </DialogTitle>
            <DialogDescription>
              {refusal?.message}
              {" — "}a forced stop is journalled forced with the owner it
              overrode.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={stopping}
              onClick={() => void stop.run(true)}
              type="button"
              variant="destructive"
            >
              Force stop{owner !== undefined && `, overriding ${owner}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {stopOutcome !== undefined && (
        <div className="run-outcomes">
          <Outcome label="Stop" outcome={stopOutcome} />
          {refusal !== undefined && (
            <div className="composer-actions">
              <Button
                onClick={() => setForceOpen(true)}
                size="sm"
                type="button"
                variant="destructive"
              >
                Force stop…
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * The stop as a control offers it: two confirms, and the verb behind both.
 *
 * Both dialogs close on any answer, and the refusal that names another owner
 * is picked out of the outcome here because it is what decides whether the
 * second confirm — the forced one — is offered at all.
 */
function useStop(control: RunControl) {
  const [stopOpen, setStopOpen] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);
  const stop = useVerb(
    (force: boolean) => (force ? "Forced stop" : "Stop"),
    useCallback(
      async (force: boolean) => {
        try {
          return await control.stop(force);
        } finally {
          setStopOpen(false);
          setForceOpen(false);
        }
      },
      [control.stop],
    ),
  );
  const refusal =
    stop.outcome?.kind === "refused" &&
    stop.outcome.error instanceof TelemetryClientError &&
    stop.outcome.error.code === "not_owner"
      ? stop.outcome.error
      : undefined;
  return { stop, stopOpen, setStopOpen, forceOpen, setForceOpen, refusal };
}
