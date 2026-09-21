import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@oneharness/ui";
import type { ShutdownScope } from "@onepipeline-ui/dag-model";
import { useId, useState } from "react";
import {
  DEFAULT_GRACE,
  GRACE_UNITS,
  type GraceInput,
  graceSeconds,
  graceWords,
  isGraceUnit,
  type ScopedRun,
} from "./shutdown-model";

/** The words each scope's dialog is headed with, and its confirm says. */
const TITLES: Readonly<Record<ShutdownScope, string>> = {
  run: "Shut down this run?",
  mine: "Shut down all my runs?",
  host: "Shut down the entire host?",
};

const WHAT_IT_DOES =
  "Each live dispatch is asked to stop and commit, and given the grace to end itself; whatever is still standing then is torn down, and every branch the run's records name is pushed to its origin. Nothing is sent until you confirm.";

/**
 * The confirm every shutdown control opens before anything is sent.
 *
 * It names, by name, every run the engine is about to act on and whose each one
 * is — for the host, in words, the runs other sessions own that it acts on over
 * their owners — and holds the two things the request carries: the grace, in a
 * unit that reads plainly and sent as whole seconds, and the force, off by
 * default, whose label says what it gives up.
 *
 * `runs` is `undefined` while the view cannot yet say which runs those are, and
 * `blocked` says why; the confirm is withheld until both are settled, because a
 * dialog that cannot name what it acts on is not a confirm.
 */
export function ShutdownDialog({
  scope,
  open,
  onOpenChange,
  runs,
  blocked,
  runId,
  unreadable = 0,
  onConfirm,
}: {
  readonly scope: ShutdownScope;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly runs?: readonly ScopedRun[];
  /** Why the runs cannot be named yet, or why this confirm is not offered. */
  readonly blocked?: string;
  /** The run a run-scoped dialog is about, named even before its row is read. */
  readonly runId?: string;
  /** How many run roots the listing could not read, which no shutdown reaches. */
  readonly unreadable?: number;
  readonly onConfirm: (grace: number, force: boolean) => void;
}) {
  const id = useId();
  const [grace, setGrace] = useState<GraceInput>(DEFAULT_GRACE);
  const [force, setForce] = useState(false);
  const seconds = graceSeconds(grace);
  const ready = runs !== undefined && blocked === undefined;
  const others = runs?.filter((run) => !run.mine) ?? [];
  const own = runs?.filter((run) => run.mine) ?? [];
  const unowned = others.filter((run) => run.unowned).length;

  // Every closing — cancelled, escaped or confirmed — puts the defaults back, so
  // the next opening starts from them: a force left ticked from an earlier dialog
  // is exactly the choice the next one must not inherit.
  const close = () => {
    setGrace(DEFAULT_GRACE);
    setForce(false);
    onOpenChange(false);
  };

  return (
    <Dialog
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      open={open}
    >
      <DialogContent className="shutdown-dialog">
        <DialogHeader>
          <DialogTitle>
            {scope === "run" && runId !== undefined
              ? `Shut down ${runId}?`
              : TITLES[scope]}
          </DialogTitle>
          <DialogDescription>{WHAT_IT_DOES}</DialogDescription>
        </DialogHeader>
        <div className="shutdown-dialog-body">
          {blocked !== undefined ? (
            <p className="shutdown-blocked" role="status">
              {blocked}
            </p>
          ) : runs === undefined ? (
            <p className="shutdown-blocked" role="status">
              Reading which runs this acts on…
            </p>
          ) : scope === "run" ? (
            <RunScope run={runs[0]} />
          ) : scope === "mine" ? (
            runs.length === 0 ? (
              <p className="shutdown-scope-note">
                This session owns no run here, so this acts on none: nothing
                will be signalled and nothing pushed.
              </p>
            ) : (
              <RunList
                caption={`It acts on the ${countOf(runs.length)} this session owns, and on no other session's:`}
                label="Runs this shutdown acts on"
                runs={runs}
              />
            )
          ) : (
            <>
              {others.length > 0 ? (
                <RunList
                  caption={`It acts on ${countOf(others.length)} other sessions own${unowned > 0 ? " (or that no session is recorded as owning)" : ""}, over their owners — each is interrupted, torn down and pushed as if it were yours:`}
                  label="Runs other sessions own"
                  runs={others}
                  warning
                />
              ) : (
                <p className="shutdown-scope-note">
                  No run here is another session's.
                </p>
              )}
              {own.length > 0 && (
                <RunList
                  caption={`And on the ${countOf(own.length)} this session owns:`}
                  label="Runs this session owns"
                  runs={own}
                />
              )}
              {runs.length === 0 && (
                <p className="shutdown-scope-note">
                  This view lists no run on this host, so this acts on none.
                </p>
              )}
            </>
          )}
          {scope !== "run" && unreadable > 0 && (
            <p className="shutdown-scope-note">
              {unreadable === 1
                ? "1 run root on this host could not be read"
                : `${unreadable} run roots on this host could not be read`}
              : the engine cannot read them either, so this shutdown signals
              nothing in them and pushes none of their branches.
            </p>
          )}
          <fieldset className="shutdown-grace">
            <legend>Grace</legend>
            <div className="shutdown-grace-row">
              <Label className="sr-only" htmlFor={`${id}-grace`}>
                Grace
              </Label>
              <Input
                aria-describedby={`${id}-grace-help`}
                aria-invalid={seconds === undefined}
                id={`${id}-grace`}
                inputMode="numeric"
                min={0}
                onChange={(event) =>
                  setGrace({ ...grace, amount: event.target.value })
                }
                step={1}
                type="number"
                value={grace.amount}
              />
              <Label className="sr-only" htmlFor={`${id}-unit`}>
                Grace unit
              </Label>
              <select
                className="composer-select"
                id={`${id}-unit`}
                onChange={(event) => {
                  const unit = event.target.value;
                  if (isGraceUnit(unit)) setGrace({ ...grace, unit });
                }}
                value={grace.unit}
              >
                {Object.keys(GRACE_UNITS).map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
            </div>
            <p className="channel-age" id={`${id}-grace-help`}>
              {seconds === undefined
                ? "The grace is a whole number of minutes or seconds, 0 or more."
                : `How long each live dispatch has to end itself once asked: ${graceWords(seconds)}. The engine's default is ${graceWords(graceSeconds(DEFAULT_GRACE) ?? 0)}.`}
            </p>
          </fieldset>
          <div className="composer-check shutdown-force">
            <input
              checked={force}
              id={`${id}-force`}
              onChange={(event) => setForce(event.target.checked)}
              type="checkbox"
            />
            <Label htmlFor={`${id}-force`}>
              Force: skip the interrupt and the wait and go straight to the
              teardown — whatever a worker had not committed is lost.
            </Label>
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button
            disabled={!ready || seconds === undefined}
            onClick={() => {
              if (seconds === undefined) return;
              onConfirm(seconds, force);
              close();
            }}
            type="button"
            variant="destructive"
          >
            {scope === "run"
              ? "Shut down run"
              : scope === "mine"
                ? "Shut down my runs"
                : "Shut down the host"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const countOf = (count: number): string =>
  count === 1 ? "1 run" : `${count} runs`;

/** The one run a run-scoped shutdown acts on, and what the engine will say to it. */
function RunScope({ run }: { readonly run?: ScopedRun }) {
  if (run === undefined) return null;
  return (
    <>
      <RunList
        caption="It acts on this run alone:"
        label="Runs this shutdown acts on"
        runs={[run]}
      />
      {!run.mine && (
        <p className="shutdown-scope-note" role="note">
          {run.runId} is owned by {run.owner}, not by this session, so the
          engine will refuse this shutdown and signal nothing. Shutting the
          entire host down is what acts on another session's run.
        </p>
      )}
    </>
  );
}

function RunList({
  caption,
  label,
  runs,
  warning = false,
}: {
  readonly caption: string;
  readonly label: string;
  readonly runs: readonly ScopedRun[];
  readonly warning?: boolean;
}) {
  return (
    <div className="shutdown-runs" data-warning={warning}>
      <p className="shutdown-scope-note">{caption}</p>
      <ul aria-label={label}>
        {runs.map((run) => (
          <li key={run.runId}>
            <span className="shutdown-run-id">{run.runId}</span>
            {" — owned by "}
            {run.owner}
          </li>
        ))}
      </ul>
    </div>
  );
}
