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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@oneharness/ui";
import { RUN_LIVENESS_NOTHING_DRIVING } from "@onepipeline-ui/dag-model";
import { TelemetryClientError } from "@onepipeline-ui/telemetry-client";
import { Eye, EyeOff, LifeBuoy, OctagonX } from "lucide-react";
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

/**
 * What a supervisor does to the run from its header: watch it, stop it, adopt
 * it — and read whether anybody is watching the runs they own.
 *
 * **Stop** stops a run the acting session owns on one confirm. A run another
 * session owns comes back `409 not_owner` naming the owner; that refusal is
 * shown as the engine worded it, and only then is a forced stop offered, behind
 * a second confirm that names the owner it would override. It is never the
 * default. **Adopt** is offered only when the run's own status says nothing is
 * driving it, and shows the driver pid the API answers.
 */
export function RunActions({
  runId,
  control,
}: {
  readonly runId: string;
  readonly control: RunControl;
}) {
  const { stop, stopOpen, setStopOpen, forceOpen, setForceOpen, refusal } =
    useStop(control);
  const owner = refusal === undefined ? undefined : ownerNamed(refusal.message);
  const { adopt, offered: nothingDriving, adoptedPid } = useAdopt(control);
  const stopOutcome = stop.outcome;
  const adoptOutcome = adopt.outcome;
  const stopping = stop.pending;

  const liveness = control.status.value?.liveness;
  const unwatched = control.unwatched.value;
  const thisUnwatched = unwatched?.reported.some((run) => run.run === runId);

  return (
    <>
      <div className="run-actions">
        {/* The two badges and the button labels leave the header at the phone,
            where five rows of header left the node view's collapsed plot no
            room: the words move to the Watch tab and the buttons keep their
            names on the icon. */}
        {liveness !== undefined && (
          <Badge
            aria-label={`Liveness ${liveness}`}
            className="run-actions-badge"
            variant="outline"
          >
            {liveness}
          </Badge>
        )}
        {unwatched !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                aria-label={`${unwatched.reported.length} unwatched`}
                className="run-actions-badge"
                variant={
                  unwatched.reported.length > 0 ? "secondary" : "outline"
                }
              >
                {unwatched.reported.length} unwatched
                {thisUnwatched === true && " · this run"}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {unwatched.reported.length === 0
                ? "Every run this session owns is watched or settled."
                : unwatched.reported
                    .map(
                      (run) =>
                        `${run.run} (${run.standing}): ${run.why_not_watched}`,
                    )
                    .join("\n")}
            </TooltipContent>
          </Tooltip>
        )}
        <Button
          aria-label={control.watch.held ? "Watching" : "Watch"}
          aria-pressed={control.watch.held}
          onClick={control.toggleWatch}
          size="sm"
          title={control.watch.held ? "Watching" : "Watch"}
          type="button"
          variant={control.watch.held ? "default" : "outline"}
        >
          {control.watch.held ? <Eye size={14} /> : <EyeOff size={14} />}
          <span className="run-action-label">
            {control.watch.held ? "Watching" : "Watch"}
          </span>
        </Button>
        {nothingDriving && (
          <Button
            aria-label="Adopt"
            disabled={adopt.pending}
            onClick={() => void adopt.run()}
            size="sm"
            title="Adopt"
            type="button"
            variant="outline"
          >
            <LifeBuoy size={14} />
            <span className="run-action-label">Adopt</span>
          </Button>
        )}
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
      {(stopOutcome !== undefined || adoptOutcome !== undefined) && (
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
          <Outcome label="Adopt" outcome={adoptOutcome} />
          {adoptedPid !== undefined && (
            <p className="channel-age">Driver pid {adoptedPid}</p>
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

/**
 * The adoption as a control offers it: the verb, whether it is offered at all
 * — only where the run's own status says nothing is driving it, the two words
 * the engine's `adopt` will take over — and the driver pid the last one
 * answered.
 */
function useAdopt(control: RunControl) {
  const adopt = useVerb("Adopt", control.adopt);
  const liveness = control.status.value?.liveness;
  const offered =
    liveness !== undefined && RUN_LIVENESS_NOTHING_DRIVING.includes(liveness);
  const answered = adopt.outcome;
  const adoptedPid =
    answered?.kind === "answered" &&
    typeof answered.payload === "object" &&
    answered.payload !== null &&
    "pid" in answered.payload
      ? String(answered.payload.pid)
      : undefined;
  return { adopt, offered, adoptedPid };
}
