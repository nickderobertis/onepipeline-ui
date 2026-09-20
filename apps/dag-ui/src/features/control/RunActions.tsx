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
import { useState } from "react";
import { Outcome, outcomeOf, type VerbOutcome } from "./Outcome";
import type { RunControl } from "./useRunControl";

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
  const [stopOpen, setStopOpen] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopOutcome, setStopOutcome] = useState<VerbOutcome>();
  const [adoptOutcome, setAdoptOutcome] = useState<VerbOutcome>();
  const [adopting, setAdopting] = useState(false);

  const refusal =
    stopOutcome?.kind === "refused" &&
    stopOutcome.error instanceof TelemetryClientError &&
    stopOutcome.error.code === "not_owner"
      ? stopOutcome.error
      : undefined;
  const owner = refusal === undefined ? undefined : ownerNamed(refusal.message);

  const stop = async (force: boolean) => {
    setStopping(true);
    const answered = await outcomeOf(force ? "Forced stop" : "Stop", () =>
      control.stop(force),
    );
    setStopOutcome(answered);
    setStopping(false);
    setStopOpen(false);
    setForceOpen(false);
  };
  const adopt = async () => {
    setAdopting(true);
    setAdoptOutcome(await outcomeOf("Adopt", () => control.adopt()));
    setAdopting(false);
  };

  const liveness = control.status.value?.liveness;
  const nothingDriving =
    liveness !== undefined && RUN_LIVENESS_NOTHING_DRIVING.includes(liveness);
  const unwatched = control.unwatched.value;
  const thisUnwatched = unwatched?.reported.some((run) => run.run === runId);
  const adoptedPid =
    adoptOutcome?.kind === "answered" &&
    typeof adoptOutcome.payload === "object" &&
    adoptOutcome.payload !== null &&
    "pid" in adoptOutcome.payload
      ? String(adoptOutcome.payload.pid)
      : undefined;

  return (
    <>
      <div className="run-actions">
        {liveness !== undefined && (
          <Badge aria-label={`Liveness ${liveness}`} variant="outline">
            {liveness}
          </Badge>
        )}
        {unwatched !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                aria-label={`${unwatched.reported.length} unwatched`}
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
          aria-pressed={control.watch.held}
          onClick={control.toggleWatch}
          size="sm"
          type="button"
          variant={control.watch.held ? "default" : "outline"}
        >
          {control.watch.held ? <Eye size={14} /> : <EyeOff size={14} />}
          {control.watch.held ? "Watching" : "Watch"}
        </Button>
        {nothingDriving && (
          <Button
            disabled={adopting}
            onClick={() => void adopt()}
            size="sm"
            type="button"
            variant="outline"
          >
            <LifeBuoy size={14} /> Adopt
          </Button>
        )}
        <Button
          disabled={stopping}
          onClick={() => setStopOpen(true)}
          size="sm"
          type="button"
          variant="destructive"
        >
          <OctagonX size={14} /> Stop
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
              onClick={() => void stop(false)}
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
              onClick={() => void stop(true)}
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
