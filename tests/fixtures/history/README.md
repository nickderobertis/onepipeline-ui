# Recorded oneharness history

Two session files a real oneharness wrote on an operator's host, read by the
journeys that hold what the server serves of a turn's content to the engine's
`views::transcript` resolver (`tests/e2e/transcripts.rs`), and by the browser
corpus that draws them (`apps/dag-ui-e2e/fixtures/runs.mjs`).

- `home-operator-.onevcs-…-worktree/node-scope-…-worker-skill-….jsonl` — a worker
  turn's message, shell call, file edit and file read, each with its result,
  under one candidate that never wrote a closing line.
- `home-operator-projects-ai-orchestrator/design-doc-…-worker-judge-….jsonl` — a
  whole judge turn: a file read, a shell call, a search, the answer it closed on,
  and the closing line that carries its prompt.

Every line is the recorded line with these changes and no others: entries not
listed above were dropped; each long text (a prompt, a reply, an output, an
edit's strings, a long command) keeps its head and, for a prompt, reply or
output, its tail, joined by `[… trimmed from the recording …]`; and the
operator's home directory, workspace slug and employer name were replaced
(`/home/operator`, `github.com-example-onepipeline-0000`, `example`). Ids,
indices, tool-call identities, harnesses, models, timings and usage are as
recorded.
