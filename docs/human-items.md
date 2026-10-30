# Action items: the design

The browser's **Action items** page, at `/human-items`, is the host-wide queue of
human work — tasks to do and questions to answer — that the engine's human-item
contract (`onepipeline::human_items`) describes. It reads and writes through the six
`/api/human-items` routes `docs/contract.md` defines, and through nothing else. The
visual reference is `authoring:human-action-items-spike-visual-dense-report`, whose
images illustrate this design; nothing here builds on that spike's throwaway branch,
mock or harness.

## What a reader sees

- **Its own navigation entry.** *Action items* sits beside *Host* in the sidebar and
  opens `/human-items`; the Host page is unchanged and carries none of it.
- **Dense rows, full width.** Unselected, every card spans the list. Selecting one —
  a click on the card, or its *Details* action — opens the detail pane beside the
  list, which narrows and wraps rather than moving out of view.
- **A compact card** shows the title; the kind; the priority as a word; what the item
  blocks; where it came from; and the body in smaller secondary text, questions
  included. A card shows at most **four lines** of the body: a longer body ends in an
  ellipsis at the end of the fourth line, and a body of four lines or fewer shows in
  full with no ellipsis. Every task carries its tracker issue — GitHub or Linear — as
  a link on the card that opens the issue without selecting the card.
- **The detail pane** shows the complete body, scrolling within the pane when it is
  taller than the room left, so the list and the rest of the detail stay in place. It
  enumerates every blocked step, grouped under its plan.
- **Priority** reads Critical, High, Medium or Low on the page and in every filter.
  Critical is the label of the wire's `urgent`; the wire keeps urgent/high/medium/low,
  and no P-label is shown anywhere.
- **What an item blocks** is derived from its open state and its declared scope,
  never a toggle: "blocks all work on this host" for a host item (every open host
  item blocks), "blocks all of *plan*" for a plan hold, and "blocks *N* steps in
  *plan*" for each plan a work hold reaches — on a card followed by the first three
  of those steps, the engine's preview, and how many more the detail lists.
- **Source** is the plan and run an item was raised in, the manager session for a
  question raised outside a run, or the host for a host item — in the words the CLI's
  `list` prints.
- **Filters** are kind, blocking (yes/no), priority, state and source
  (session/run/plan identifier, or host), each sent as the engine's `HumanItemFilter`
  and each narrowing the list on its own. Scope is never a filter or a column; it
  stays in the engine's record. No owner-ended label, filter or state exists.
- The list is in the engine's order — blocking first, then urgent, high, medium and
  low — and holds only the items the server's session owns.

## Acting on an item

- **Every open question has an answer box on its card**, resting one line tall and
  growing with what is written. Enter sends the focused answer without opening
  detail; Shift+Enter writes a new line.
- **Tasks complete with Complete**, design reviews included: the engine completes a
  design review with the approval reference the task stored when it was raised.
  There is no Approve action, approval checkbox, board-copy input or key input. A
  design review whose document has changed is refused with "Re-read the current
  document", and the engine dismisses the obsolete task and raises one replacement
  for the new version; the page shows the refusal and the replacement.
- **Dismiss** asks for an optional reason in a dialog; an empty reason sends none.
- **A write in flight keeps its item open**, marked as sending, and repeated Enter or
  clicks send nothing more. A refused or failed write leaves the item and the draft
  where they were, with the reason on the card. Every outcome is also announced at
  the top of the page, so a refusal that removed its card is still read.

## Keyboard

Tab moves from one open question's answer box **straight to the next**; nothing else
on a card is in that sequence. After the last answer box, Tab enters the
**card-action group** — every card's tracker link, Details, Complete and Dismiss — at
its first action. Arrow keys move through the group, holding at either end, and Home
and End reach its ends; Enter follows a focused tracker link, and Enter or Space
presses a focused button, as links and buttons natively do. The detail pane's body is a focusable
region, so a keyboard can scroll it.

## Density target

At **1440×900 CSS pixels**, the unselected full-width list shows **at least six
complete cards** — three tasks and three open questions, each with an 80–160
character body — with each question's answer box at single-line resting height, and
all six cards, their bodies and their controls visible without scrolling the list.
The selected detail pane may narrow and wrap the list. This is the manager-approved
target, recorded here for the user to tighten; `apps/dag-ui-e2e/dag-ui-human-items.spec.ts`
holds the page to it with bounding-box assertions.

## What this is proven against

The page and the routes are proven against the engine's **explicit sample adapter**:
`onepipeline-api serve --human-items-sample FILE`, a test-only configuration the
server refuses over a runs root that holds anything. A live host serves no sample —
every route answers the engine's `unavailable`, and the page says so. The journeys
prove the UI/API contract; the engine runtime's scheduling, persistence, bus delivery
and run-lifecycle resolution (auto-dismissal when a run ends, delivery to a manager's
next watch) are not claimed here, and are proven where that runtime is adopted.

The CLI's `list` and `report` are unchanged and print every body in full; only the
browser card truncates.
