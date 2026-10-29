# Private Linear plan home with a public task projection

These records are captured without rewriting from onepipeline v0.95.5
(commit `10dde3918791a7e66095ad179c4e8ca7d70f881e`), from its offline journey
`tests/e2e/linear_writeback.rs::a_private_linear_home_keeps_public_projections_after_a_live_add`.
The engine talks to that suite's loopback Linear GraphQL endpoint through its
real Linear plugin. The home is private, and the live-added `examples` task has
a public projection in the `views` local-md destination. `linear-home.md` and
`public-view.md` are the upstream journey's observed store documents.

To regenerate, check out the v0.95.5 tag in a temporary directory outside this
repository. Immediately before that journey's final `world.release("anchor.go")`,
copy `launch.json`, `plan.json`, `events.jsonl`, `writeback-landed.json`, and
`writeback-projections.jsonl` from `world.run_file(name, file)` to an export
directory. Write its `home` and `view` strings to `linear-home.md` and
`public-view.md`. Run:

```sh
cargo test --locked --test e2e a_private_linear_home_keeps_public_projections_after_a_live_add
```

Replace this directory's seven captured files with those exports. Do not retain
the temporary instrumentation. The recorded paths, process ids and timestamps
are the upstream engine's output; no live Linear service or recorded workspace
is needed to read the run through the API.
