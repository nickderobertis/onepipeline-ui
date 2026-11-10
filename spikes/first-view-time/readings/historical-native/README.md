# Historical: native-build readings (2026-11-10, 03:50–07:10 host time)

`m01`–`m25` and `journeys.md` here were taken before the prototype was rebuilt through
`dag-ui-read-latency:compile-release-server`: `m02`–`m14`, `m16`, `m18`, `m19`, `m21b`, `m22b` and `m23`–`m25`
read a native `cargo build --release` of the prototype (the retired
`spikes/first-view-time/Cargo.toml`), whose switches-off path read slower than the
release build (Overall 1.006 s `m09` against the landed release's 0.885 s `m15`). `m01`,
`m15`, `m17`, `m21a` and `m22a` read the landed release build of `59eaa15`. All are
superseded by `../r*.json`, taken on release builds; none is relied on by the report.
