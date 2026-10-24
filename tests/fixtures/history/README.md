# Recorded oneharness history

Two session files a real oneharness wrote on an operator's host, read by the
journeys that hold what the server serves of a turn's content to the engine's
`views::transcript` resolver (`tests/e2e/transcripts.rs`), and by the browser
corpus that draws them (`apps/dag-ui-e2e/fixtures/runs.mjs`).

- `home-operator-worktree/node-scope-…-worker-skill-….jsonl` — a worker
  turn's message, shell call, file edit and file read, each with its result,
  under one candidate that never wrote a closing line.
- `home-operator-projects-ai-orchestrator/design-doc-…-worker-judge-….jsonl` — a
  whole judge turn: a file read, a shell call, a search, the answer it closed on,
  and the closing line that carries its prompt.

Every line is the recorded line with these changes and no others: entries not
listed above were dropped; each long text (a prompt, a reply, an output, an
edit's strings, a long command) keeps its head and, for a prompt, reply or
output, its tail, joined by `[… trimmed from the recording …]`; and the
operator's home directory, worktree path and employer name were replaced
(`/home/operator`, `/home/operator/worktree`, `example`), and the worker's
project directory is named for that worktree as oneharness names it. The
worktree path is short because the path to this file is held, joined to the
deepest checkout of this repository a Windows test makes, under Windows'
260-character limit (`tests/checkout_paths.rs`). Ids,
indices, tool-call identities, harnesses, models, timings and usage are as
recorded.
