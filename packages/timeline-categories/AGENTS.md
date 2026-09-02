# packages/timeline-categories/AGENTS.md

The vocabulary a journal record's kind is filed under, and the rules that file it.

Two projects hold this, which is why it is a package: `apps/dag-ui` draws a glyph
per category, and `apps/dag-ui-e2e` counts the scheme — "one record of every
category is drawn" is counted against `EVENT_CATEGORIES`. A copy on either side
passes while the other grows a category nobody drew.

**No React, no icon set, no DOM.** What a category *looks like* belongs to the
app; what a category *is* belongs here. The list is the source: `EventCategory`
is derived from it, so the app's glyph table fails to compile until a new
category has a drawing of its own.

The rules are read over a kind's hyphen-separated words rather than tabled per
kind, because four separately released producers write those kinds: a table would
need a line the first time any of them shipped one, and would be stale until
somebody noticed. Order is the rule — outcome before subject — and the exceptions
below it are the kinds whose words say the wrong thing.
