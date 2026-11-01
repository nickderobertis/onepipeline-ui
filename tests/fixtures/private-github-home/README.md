# Private GitHub Projects plan home with a public task projection

These records are captured without rewriting from onepipeline v0.96.0
(commit `7b6a7bbb6841f5cb0d673a6b3a9945973cfa78de`), from its offline journey
`tests/e2e/private_github_home.rs::a_private_github_home_files_a_live_added_public_task_in_its_private_repository`.
The engine talks to that suite's loopback GitHub (`tests/e2e/github_world.py`)
through its real `github-projects` plugin. The plan's home is an issue on a
board declared private, and the live-added `examples` task, which names only a
public repository, is filed on that private board with its one public presence
a neutral projection on the public board. The anchor then lands a commit and
settles `done`, merged on the private repository's base, while `examples` stays
parked. `github-home.md` is the home issue's body and `public-projection.json`
the projected public issue, both as the upstream journey's loopback held them.

To regenerate, check out the v0.96.0 tag in a temporary directory outside this
repository. Beside the journey's `world.script("anchor.wait", "hold")`, add
`world.script("anchor.work", "what the anchor built\n")`, so the engine's fake
agent commits and the anchor can land. Keep a clone of the journey's `projected`
issue. After its final `world.release("anchor.go")`, wait until
`world.events_of(name, "node-settled")` is non-empty and `writeback-landed.json`
records the anchor's status as `done`, then take a fresh `github.state()`. Copy
`launch.json`, `plan.json`, `events.jsonl`, `writeback-landed.json`, and
`writeback-projections.jsonl` from `world.run_file(name, file)` to an export
directory. Write that state's `["issues"]["plan"]["body"]` to `github-home.md`
and the kept `projected` issue, pretty-printed, to `public-projection.json`. Run:

```sh
cargo test --locked --test e2e a_private_github_home_files_a_live_added_public_task_in_its_private_repository
```

Replace this directory's seven captured files with those exports. Do not retain
the temporary instrumentation. The recorded paths, process ids and timestamps
are the upstream engine's output; no live GitHub service or recorded workspace
is needed to read the run through the API.
