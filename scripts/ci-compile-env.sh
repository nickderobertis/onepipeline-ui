# shellcheck shell=bash
# The compile environment every CI job's recipe (scripts/ci-job.sh) and the
# cache producer that warms them (scripts/ci-warm.sh) share, sourced by both, so
# a job restores units built under the environment it compiles under: cargo
# rebuilds a build script and every crate above it when a variable the script
# reads differs. `.github/tests/ci-warm.test.mjs` holds both scripts to it.
#
# OPENSSL_NO_VENDOR: link the host's OpenSSL rather than compiling OpenSSL from
# source. reqwest's `native-tls-vendored`, which the engine's task-graph crates
# turn on, enables `openssl-sys`'s `vendored` feature, and `openssl-sys` lets
# this variable override it on Linux, the one platform it is built for here.
# That build script was half of a cold debug graph (235 of 1003 CPU-seconds, and
# the head of the chain to `onepipeline-api`), and test-linux compiles that graph
# on its critical path before the browser tier can start. Hosted Ubuntu runners
# carry libssl-dev. The shipped binaries are not built here: release.yml's jobs
# and the manylinux wheel (scripts/build-linux-wheel.sh, which hands its
# container only the variables it names) still vendor OpenSSL, and
# test-linux's release rehearsal builds that same wheel.
export OPENSSL_NO_VENDOR=1
