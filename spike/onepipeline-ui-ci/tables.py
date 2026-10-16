#!/usr/bin/env python3
"""Render figures.json's per-job distributions as Markdown tables.

    python3 -I spike/onepipeline-ui-ci/tables.py spike/onepipeline-ui-ci/figures.json [--current]

Prints nothing it did not read from figures.json: one row per workflow, event and
job (matrix legs are separate jobs), durations and queue waits over successful
runs, with the failed and cancelled counts beside them.
"""

import json
import sys


def fmt(d, key):
    return "–" if not d else f"{d[key]:.0f}"


def main() -> int:
    figures = json.load(open(sys.argv[1]))
    if "--current" in sys.argv:
        figures = figures["current_shape"]
    print("| Workflow | Event | Job | OS | n ok | median s | p90 s | max s | queue median s | queue p90 s | queue max s | failed | cancelled |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for j in figures["per_job"]:
        d, q = j["duration_s"], j["queue_wait_s"]
        if not d and not j["failed"]:
            continue
        print(
            f"| {j['workflow']} | {j['event']} | {j['job'].replace('|', '/')} | {','.join(j['runner_os'])} | "
            f"{d['n'] if d else 0} | {fmt(d, 'median')} | {fmt(d, 'p90')} | {fmt(d, 'max')} | "
            f"{fmt(q, 'median')} | {fmt(q, 'p90')} | {fmt(q, 'max')} | {j['failed']} | {j['cancelled']} |"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
