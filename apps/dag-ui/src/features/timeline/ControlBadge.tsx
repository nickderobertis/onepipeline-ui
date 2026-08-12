import { Badge, cn } from "@oneharness/ui";
import type { NodeControl } from "@onepipeline-ui/dag-model";
import { MessageSquareOff, MessageSquareReply } from "lucide-react";

/**
 * Whether the run has a turn it can reach for a node still working.
 *
 * This is the first thing a planner needs before deciding between correcting a node
 * and cancelling it, and it is deliberately the narrower claim: a reachable turn is
 * one a note can be *delivered into*, not a promise the harness will act on it.
 * Whether it will is onejudge's `control`, which nothing in the published stack
 * reports for a turn in flight — so the badge says the part that is known and the
 * reason says the rest. Absent any answer the safe assumption is "cancel", the
 * expensive one, so this renders whenever the server has one.
 *
 * A word rather than the whole sentence, because of where it sits. The node view's
 * header is the one thing above a plot that is sized to a share of what is left below
 * it, and the collapsed plot is the view a node opens on and has to be whole at every
 * width — so a header that grows by a line of prose is a plot that no longer fits.
 * The reason therefore rides the badge's own accessible description, where a pointer
 * and a screen reader both reach it and neither costs the plot a pixel; the record
 * that carries the same reason at length is the redirection on the node's timeline.
 */
export function ControlBadge({ control }: { readonly control?: NodeControl }) {
  // A node with no turn is not a node whose turn cannot be reached. The server serves
  // an entry for every node it has in flight and for no other, so an absent one means
  // "not working", which the state badge beside this one already says.
  if (control === undefined) return null;
  const word = control.addressable ? "Turn reachable" : "No turn to reach";
  const why = control.addressable
    ? `a planner's note can be delivered into the ${control.member ?? "member"} turn in flight`
    : control.reason;
  const Icon = control.addressable ? MessageSquareReply : MessageSquareOff;
  return (
    <Badge
      aria-label={`${word}: ${why}`}
      className={cn(
        "node-view-control gap-1.5",
        control.addressable
          ? "border-info bg-info-surface text-info"
          : "border-warning bg-warning-surface text-warning",
      )}
      title={why}
      variant="outline"
    >
      <Icon aria-hidden="true" size={12} />
      {word}
    </Badge>
  );
}
