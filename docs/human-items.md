# Action items: the design

The browser's **Action items** page, at `/human-items`, is the host-wide queue of
human work — tasks to do and questions to answer — that the engine's human-item
contract (`onepipeline::human_items`) describes. It reads as the `human-items` view of
the tab's one subscription and writes through the `/api/human-items` routes, both as
`docs/contract.md` defines them, and through nothing else. The
visual reference is `authoring:human-action-items-spike-visual-dense-report`, and for
grouping, the toast and the phone layout `action-items-ui-2026-11-06-spike-visual-report`
— except that its phone shots keep a navigation column the drawer has since replaced
and its filters are not folded. Their images illustrate this design; nothing here
builds on either spike's throwaway branch, mock or harness, and only the later
spike's six realistic items are taken, as the journeys' long-content fixture.

## What a reader sees

- **Its own navigation entry.** *Action items* sits beside *Host* in the sidebar and
  opens `/human-items`; the Host page is unchanged and carries none of it.
- **Dense rows, full width.** Unselected, every card spans the list. Selecting one —
  a click on the card, or its *Details* action — opens the detail pane beside the
  list, which narrows and wraps rather than moving out of view.
- **A compact card** shows the title; the priority as a word, the kind and whether it
  blocks, as badges; what the item blocks; where it came from; and the body in smaller
  secondary text, questions included. A card shows at most **four lines** of the body:
  a longer body ends in an ellipsis at the end of the fourth line, and a body of four
  lines or fewer shows in full with no ellipsis. Every task carries its tracker issue —
  GitHub or Linear — as a link on the card that opens the issue in a new tab without
  selecting the card. Long content — a long title, a long source, a long unbroken URL —
  wraps inside the card; the badges and actions keep their places.
- **Every task is rendered by `@onetaskgraph/ui`**, the one renderer for tasks across
  these tools: the card is its `TaskCard`, the body its `TaskMarkdown` — markdown with
  links, bare URLs, tables, lists and bold — and the tracker link its `TaskSourceLink`.
  The node timeline's task prose and acceptance criteria render the same way. Bodies
  are untrusted: raw HTML shows as text, only `http`, `https` and `mailto` links keep a
  target, every link opens in a new tab with `rel="noopener noreferrer"`, and an image
  is shown as a link to its source and never fetched.
- **The detail pane** leads with the item itself: its title, its body, for a question
  its choices (each with its description) and answer box, then its actions. Everything
  about the item, priority, kind, state, source, plan and run, what it blocks, tracker
  and times, the blocked steps listed under their plan, is a labelled block at the
  bottom, wrapping long values rather than cutting them. A detail taller than the pane scrolls as a whole. It
  enumerates every blocked step, grouped under its plan.
- **Who made each ruling is named quietly, in the detail alone.** No card names a
  party, under any filter. The detail's **History** lists the engine's own `history`
  as the detail route serves it, oldest first, one row per entry, in the pane's
  normal text: its action and its party in words — "Raised by the manager",
  "Answered by you", "Completed by the manager", "Note by you" — where "you" is
  `user` (a person at this page is the user) and "the manager" is `manager`, or a
  record with no `provenance`. The block's Answered, Completed or Dismissed row reads
  the same way. A party is never a badge, pill or colour: the user's rows and the
  manager's share one text style. Every time in the pane — each history row, the
  Raised row and the resolution's row — is a relative phrase ("2 hours ago") drawn by
  the page's one `Timestamp`, with the exact local time on hover and the served
  instant as its `datetime`; no RFC 3339 string or absolute date-time is shown.
- **Grouping.** The list is grouped by **Priority** by default, under a heading per
  value with its count — Critical, High, Medium, Low — and can be grouped by Kind,
  Source or Blocking instead, or by none. The choice is remembered per browser. The
  badge for the field the list is grouped by is left off each card, since its heading
  says it. Within a heading the engine's order stands.
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
- **Filters** — beside *Group by* — are kind, blocking (yes/no), priority, state and source
  (session/run/plan identifier, or host), each sent as the engine's `HumanItemFilter`
  and each narrowing the list on its own. Scope is never a filter or a column; it
  stays in the engine's record. No owner-ended label, filter or state exists.
- The list is in the engine's order — blocking first, then urgent, high, medium and
  low — within each heading, and includes every owner’s open items by default.
  Explicit filters narrow this host-wide queue.

## Acting on an item

- **A question's choices are compact buttons on its card**, 28 to 32 CSS pixels tall on
  one line, side by side and at least 8 apart; a press makes that choice the card's
  draft answer, a second press clears it and a press on another replaces it. A title
  wraps inside its button, capped at 46ch at every width. A question offering no
  choices keeps its answer box on its card, resting one line tall and growing with
  what is written: Enter keeps the draft and never sends it, and Shift+Enter writes
  a new line. The detail offers the answer box on every question, so a draft may be a
  choice, words, or both.
- **The send bar is how an answer leaves.** A fixed region below the list reads "Send N
  answers" with a Discard control while any draft is sendable, and sends every draft as
  one `POST /api/human-items/answers`, so a queue is answered once and each manager
  woken once. It shows with a detail open too. A failed request keeps every draft
  and says why.
- **A draft is stored per browser** in `localStorage`, keyed by item id, until it is sent
  or discarded, so it survives a reload. A refused draft whose item is still open stays
  stored and counted, its card marked with the engine's reason. Once its item is no
  longer open, whether a send was refused or the list stopped holding it open, the
  draft leaves storage and a "Not sent" notice under the bar names the item, the reason
  and what was drafted, until cleared or reloaded. An item a filter merely hides is
  still open: the server is asked once per filter before its draft is touched. Other
  tabs are not followed live; each shows the drafts it has loaded, and a send re-reads
  storage so another tab's sent or discarded draft does not go out again.
- **Tasks complete with Complete**, design reviews included: the engine completes a
  design review with the approval reference the task stored when it was raised.
  There is no Approve action, approval checkbox, board-copy input or key input. A
  design review whose document has changed is refused with "Re-read the current
  document", and the engine dismisses the obsolete task and raises one replacement
  for the new version; the page shows the refusal and the replacement.
- **Complete and Dismiss are one click**, on a card and in detail, with no dialog or
  confirmation. The card leaves at once and, if the detail pane was showing that
  item, the pane closes with it.
- **A toast** says what was done the moment it is sent ("Completing: …", then
  "Completed: …" once the engine's receipt is in). After Dismiss it offers **Restore**
  and **Add reason**; after Complete, **Reopen** and **Add comment**. Restore and
  Reopen are the engine's `reopen`, which also runs a completed design review's
  approval-adapter undo; Add reason and Add comment take text in the toast and send
  the engine's `note`. A Restore pressed before the receipt arrives is sent after it,
  in order. The toast shows for **15 seconds** from the receipt or refusal, and
  stays while the write is still on its way and while it is hovered, focused or
  being written in, leaving once that ends. It is a muted green when the
  write went through and a muted red when something failed, each bordered in its own
  hue; on a wide screen it sits bottom right, and on a phone it runs across the
  bottom. While it shows, the list keeps room below its last card equal to the
  toast's height, so any card can be scrolled clear of it.
- **When Reopen cannot be offered** — the engine's `reopen.available` is false: no
  undo declared by the item's approval adapter, an item standing for a run's human
  step, an item the engine resolved — Reopen is greyed, and a small question mark set
  on its text as a superscript gives `reopen.reason`, on hover and on a press, which
  works on a phone. Restore follows the same rule.
- **Every write is the reader's own.** Every owner’s items are visible and
  actionable, including design reviews, even through an unattributed server.
  The engine records `browser:session:<id>` for the server’s acting session or
  `browser` without one, and `on_behalf_of: null`; the page sends neither. The
  `browser` prefix is what tells a person's press here from a manager's own CLI
  action over the same journal, which records `session:<id>`. **What is sent here is
  recorded with provenance `user`**: every answer, completion, dismissal, reopen and
  note through the routes is the user's ruling, binding the dispatches that read it,
  while a manager's CLI action with no `--as` is the manager's. A body naming its own
  `provenance`, and a body claiming `manager` above all, is refused with nothing
  recorded. The toast names no party: what the page sends is the user's by
  construction. Owners and
  delivery to their watches stay unchanged. Raising still requires the server
  to act as the owner. A manager
  completing a task on a user's behalf, after that user approved in the manager's
  chat, does so through the CLI and engine runtime, which record `on_behalf_of` —
  never through this page or its routes.
- **A batch in flight shows on the send bar**, which reads Sending… and is disabled, so
  a repeated press sends nothing more; each question stays until its receipt.
- **A failed write leaves the item as it was.** A failed Complete or Dismiss — the
  server unreachable or the engine refusing — leaves the item open: its card returns
  where it was with the reason in the engine's words, brought into view above the
  red toast, which says the same. A design review refused because its document
  changed is replaced on the page by the engine's replacement. A failed Restore,
  Reopen or note leaves the item resolved as it was: no card returns, and the toast
  stays past its 15 seconds with the reason and whatever was typed, until it is sent
  again or closed. A refused answer keeps its draft.

## At phone width

At `max-width: 640px` the navigation is a drawer, so a card has the main area's whole
width. *Group by* and the filters fold behind one **Filters** button, closed by
default, which counts how many of them differ from their defaults, so the list keeps
the screen. A card's actions take a row of their own. A card's actions and choice buttons are the
compact 28 to 32 CSS pixels tall and at least 8 apart, toast actions at least 44, and
none overlaps, and the question mark on a greyed
Reopen has a hit area at least 24 pixels square inside that control, clear of the
action beside it. The detail pane takes the main area while it is open.

## Keyboard

Tab moves from one open question's answer controls **straight to the next**: its choice
buttons, or its answer box where it offers none, and nothing else on a card is in
that sequence. After the last of them, Tab enters the
**card-action group** — every card's tracker link, Details, Complete and Dismiss — at
its first action. The toast's actions follow in the ordinary Tab order. Arrow keys
move through the group, holding at either end, and Home
and End reach its ends; Enter follows a focused tracker link, and Enter or Space
presses a focused button, as links and buttons natively do. The detail pane is a focusable
region, so a keyboard can scroll it.

## Density target

At **1440×900 CSS pixels**, the unselected full-width list, grouped by Priority with
its headings showing, shows **at least six complete cards** — three tasks and three
open questions, each with an 80–160 character body — with each question's answer box
at single-line resting height, and all six cards, their bodies, their controls and
their headings visible without scrolling the list.
The selected detail pane may narrow and wrap the list. This is the manager-approved
target, recorded here for the user to tighten; `apps/dag-ui-e2e/dag-ui-human-items.spec.ts`
holds the page to it with bounding-box assertions.

The gallery photographs the page at every viewport (`26-action-items` to
`32-action-items-reopen-unavailable` in `docs/dag-ui.md`): the cards, the filters,
detail, and the success, refusal and Reopen-unavailable toasts.

## What this is proven against

The page and the routes are proven against the engine's **live runtime**, the release
this crate links. `apps/dag-ui-e2e/fixtures/human-items-world.mjs` builds each journey's
host: plans of `kind: human` steps on a loopback GitHub board, runs launched by the
provisioned `onepipeline` CLI's own `start`, items raised by that CLI as the sessions that
own them — design reviews through configured phases and approval authorities, one
declaring an undo and one not — and every task projected onto the board. Further
worlds carry hostile and formatted markdown in a run's task prose, and the visual
spike's six realistic items with long titles, sources and URLs. `onepipeline-api serve` then reads and writes the one
journal the engine keeps, and the journeys check what the page did against that journal
through `onepipeline human-items show`/`list`, and against what the owning session's
`human-items watch` was told. Only the tracker (the board) and the approval authority — the
two things a host reaches beyond the engine — are stood in for. `tests/e2e/human_items.rs`
holds the routes and the CLI to the same runtime: ten sessions' queue, every action
through each surface, blocked-step derivation, a run's end retiring its holds, an open host
item holding dispatch, and the refusals. A host whose configuration does not enable human
items is answered the engine's `unavailable`, and the page says so.

The CLI's `list` and `report` are unchanged and print every body in full; only the
browser card truncates.
