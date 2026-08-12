import { Badge, cn } from "@oneharness/ui";
import type { NodeControl } from "@onepipeline-ui/dag-model";
import { MessageSquareOff, MessageSquareReply } from "lucide-react";

/**
 * Whether a node still working can be corrected, or only cancelled.
 *
 * This is the reading a planner acts on before they act on anything else: a node
 * with a controllable turn in flight can be redirected, and one without it can only
 * be stopped and started again. Absent the answer, the safe assumption is "cancel",
 * which is the expensive one — so this renders whenever the server has an answer, and
 * renders *not interruptible* when the answer is no rather than rendering nothing.
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
  const word = control.interruptible ? "Interruptible" : "Not interruptible";
  const why = control.interruptible
    ? `a planner's note reaches the ${control.member ?? "member"} turn in flight`
    : control.reason;
  const Icon = control.interruptible ? MessageSquareReply : MessageSquareOff;
  return (
    <Badge
      aria-label={`${word}: ${why}`}
      className={cn(
        "node-view-control gap-1.5",
        control.interruptible
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
