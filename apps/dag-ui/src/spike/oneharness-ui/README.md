# @oneharness/ui

Presentational React components and hooks for rendering oneharness conversation history.

```tsx
import { ConversationView } from "@oneharness/ui";
import "@oneharness/ui/styles.css";
```

The stylesheet uses Tailwind CSS v4 and includes the theme tokens, transcript markdown,
formatted JSON, and syntax-highlight styles used by the components. Add the Inter and
JetBrains Mono variable fonts in the consumer when matching the desktop app typography.

React, Radix primitives, form/markdown dependencies, and Tailwind utilities remain peer
dependencies so consumers keep one runtime copy. The exported conversation types are
structural TypeScript interfaces and do not depend on the desktop app's Zod validators.

The components stay presentational, so a consumer that follows a session live owns the
transport itself: keep re-rendering `ConversationView` with the grown `conversation.turns`
and pass `live` to show its live indicator.

`ConversationView` and `ConversationTimeline` accept
`focus?: { turnId: string; toolCallId?: string; eventIndex?: number }`.
Setting or changing it scrolls to the turn, opens a collapsed turn and its tool details,
and marks the target with `aria-current="true"`. A tool call ID takes precedence over
an event index; an unknown tool falls back to its turn in the transcript. Focus waits
for a missing turn to arrive in the supplied data; the consumer owns loading it.
Every transcript turn has `data-turn-id`; tool entries have `data-event-index` and,
when reported, `data-tool-call-id`. Paired call/result entries use the call's index.
Selectors and scrolling are scoped to each rendered instance.

`Timeline` accepts `ticks?: { minSpacingPx?: number }` (default spacing: 80 px).
Axis markers use round second, minute or hour intervals and adapt to plot width and
zoom. `crosshair?: boolean` defaults to `true`: hovering the plot shows a vertical
line labeled with absolute ISO time and elapsed time since `axis.origin` (or the
first recorded time). Set `crosshair={false}` to hide it.
