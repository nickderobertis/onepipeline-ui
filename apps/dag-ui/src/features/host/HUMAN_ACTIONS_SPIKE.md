# Throwaway human actions visual spike

This branch is a planning artifact and must not land. It changes no SDK or wire
contract. All human-action records and receipts are local fixture state; no
tracker, journal, owning watch, approval service or engine mutation runs.

Recapture every report image with one command:

```sh
scripts/capture-human-actions-mock.sh
```

The existing `scripts/visual-capture.sh` builds the browser/fixture server and
uses `screenshots.config.ts` in the repository-pinned Playwright image. The
capture-only scene writes PNGs to `shots/local/human-actions/`. It runs no
assertions, lint, snapshot comparisons or other verification. No baseline cache
or store is created, and no baseline manifest is updated. The report stores its
PNGs as document assets rather than adding them to the production gallery.

The unchanged host URL is `/?page=host`. `/?page=host&mock=actions` exposes the
interactive fixture proposal. Terminal scenes use `/?mock=terminal&scene=list`,
`report`, or `receipts`. The latter are browser-rendered proposed output, not
implemented commands or evidence about the engine. All scenes use 1440×900 CSS
pixels at the screenshot config's existing pixel density. Each after image is
paired with the unchanged host image: the before state has no human-action list,
question/detail controls, or terminal human-items command.

Fixture: Release has Q1, T1 and T3 open; Access has T2 and Q2 open plus dismissed
T4. Q1 blocks five nodes, previewing three; T1 blocks three. T1 and T2 outlive
ended owners. The two blocking items sort before nonblocking P1 T2, with P1 Q1
before P2 T1. Counts cover each whole plan even when filters narrow the list.
Each resolution capture starts from a fresh fixture, except dismissal and
approval refusal/recovery pairs, which continue in place. A page reload resets
all mock state. Inputs, counts and receipts are illustrative; persistence,
idempotency, authorization and live engine delivery are outside this spike.
