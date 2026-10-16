#!/usr/bin/env python3
"""Render the spike-report answers for spike-onepipeline-ui-ci from the harness's outputs.

    python3 -B -I spike/onepipeline-ui-ci/report_answers.py > answers.json

Every measured figure below is read from figures.json (measure.py), ci-logs.json
(ci_logs.py) or local/*.json (local_profile.py). Every projected figure is computed
here from those, with its arithmetic printed beside it, and labelled a projection.
"""

import json
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import local_profile as lp  # noqa: E402

F = json.loads((HERE / "figures.json").read_text())
C = F["current_shape"]
LOGS = json.loads((HERE / "ci-logs.json").read_text())
L = {p.stem: json.loads(p.read_text()) for p in (HERE / "local").glob("*.json")}
REQ = [json.loads(x) for x in (HERE / "request-log.jsonl").read_text().splitlines()]
REST = [r for r in REQ if r["kind"] == "rest"]
BRANCH = "nick/ci-time-budgets-wave1/spike-onepipeline-ui-ci"
INVOCATION = ("python3 -I spike/onepipeline-ui-ci/measure.py --repo nickderobertis/onepipeline-ui "
              "--since 2026-09-15 --raw spike/onepipeline-ui-ci/raw --out spike/onepipeline-ui-ci/figures.json "
              "--offline --shape-since 2026-10-13T22:56:32Z")


def job(f, wf, ev, name):
    for j in f["per_job"]:
        if (j["workflow"], j["event"], j["job"]) == (wf, ev, name):
            return j
    raise KeyError((wf, ev, name))


def med(f, wf, ev, name, key="duration_s", stat="median"):
    return job(f, wf, ev, name)[key][stat]


def step(f, wf, jn, sn, stat="median"):
    for s in f["per_step_over_30s_median"]:
        if (s["workflow"], s["job"], s["step"]) == (wf, jn, sn):
            return s["duration_s"][stat]
    raise KeyError((wf, jn, sn))


def num(v):
    return f"{v:.1f}".rstrip("0").rstrip(".")


def d(x, unit="s"):
    return f"median {num(x['median'])} {unit}, p90 {num(x['p90'])} {unit}, max {num(x['max'])} {unit} (n={x['n']})"


def dj(x):
    return d(x, "jobs")


def logs(name):
    return [e for e in LOGS if e["job"] == name]


def cp(entries, task):
    out = []
    for e in entries:
        vals = [t["seconds"] for t in e["critical_path_tasks"] if t["task"] == task]
        if vals:
            out.append(vals[0])
    return out


def nx_inv(entries, target):
    out = []
    for e in entries:
        vals = [i.get("run_duration_s") for i in e["nx_invocations"] if i.get("targets") == target]
        if vals and vals[0] is not None:
            out.append(vals[0])
    return out


# ------------------------------------------------------------------ measured inputs
q_boot = step(C, "CI", "quality", "Bootstrap")
q_gate = step(C, "CI", "quality", "Quality gate (affected projects)")
sw_boot = step(C, "CI", "sweep", "Bootstrap")
sw_boot_max = step(C, "CI", "sweep", "Bootstrap", "max")
sw_check = step(C, "CI", "sweep", "Quality gate (every project)")
sw_check_max = step(C, "CI", "sweep", "Quality gate (every project)", "max")
rt_boot = step(C, "Release", "test", "Run just bootstrap")
rt_check = step(C, "Release", "test", "Run just check")
xw_boot = step(C, "CI", "cross (windows-latest)", "Bootstrap")
xw_gate = step(C, "CI", "cross (windows-latest)", "Quality gate (platform-sensitive tiers)")
mac_boot = step(C, "CI", "macos", "Bootstrap")

# What `just bootstrap` spends outside the sibling CLI's provisioning, per CI log:
# the bootstrap Nx invocation's run duration minus its critical-path
# `onepipeline-ui:bootstrap` task (the `cargo install onepipeline` of `_ensure-sibling`).
def boot_rest(name):
    es = logs(name)
    inv, crit = nx_inv(es, "bootstrap"), cp(es, "onepipeline-ui:bootstrap")
    return [round(a - b) for a, b in zip(inv, crit)], crit


q_rest, q_sib = boot_rest("quality")
xw_rest, xw_sib = boot_rest("cross (windows-latest)")
RESTORE = 30  # assumed: actions/cache restore of the ~100 MB sibling binary; NOT measured
q_boot_proj = round(statistics.median(q_rest)) + RESTORE
xw_boot_proj = round(statistics.median(xw_rest)) + RESTORE

proj = {}  # job -> (today median, projected, basis)


def P(key, today, projected, basis):
    proj[key] = (round(today), round(projected), basis)


quality = med(C, "CI", "pull_request", "quality")
P("CI quality", quality, quality - q_boot + q_boot_proj,
  f"{quality:.0f} − bootstrap step {q_boot:.0f} + cached bootstrap {q_boot_proj} (non-sibling bootstrap {statistics.median(q_rest):.0f} s measured in 3 logs, + {RESTORE} s assumed restore)")
sweep = med(C, "CI", "pull_request", "sweep")
sweep_max = med(C, "CI", "pull_request", "sweep", stat="max")
P("CI sweep", sweep, sweep - sw_boot + q_boot_proj,
  f"{sweep:.0f} − bootstrap step {sw_boot:.0f} + cached bootstrap {q_boot_proj}; its slowest run: {sweep_max:.0f} − {sw_boot_max:.0f} + {q_boot_proj} = {sweep_max - sw_boot_max + q_boot_proj:.0f}")
xw = med(C, "CI", "pull_request", "cross (windows-latest)")
xw_max = med(C, "CI", "pull_request", "cross (windows-latest)", stat="max")
P("CI cross (windows-latest)", xw, xw - xw_boot + xw_boot_proj,
  f"{xw:.0f} − bootstrap step {xw_boot:.0f} + cached bootstrap {xw_boot_proj} (non-sibling bootstrap {statistics.median(xw_rest):.0f} s in 3 logs + {RESTORE} s assumed)")
mac = med(C, "CI", "pull_request", "macos")
P("CI macos", mac, mac - mac_boot + xw_boot_proj, f"{mac:.0f} − bootstrap {mac_boot:.0f} + {xw_boot_proj} (n=1; Windows' non-sibling remainder used, unmeasured on macOS)")
rtest = med(C, "Release", "release", "test")
rtest_max = med(C, "Release", "release", "test", stat="max")
P("Release test", rtest, rtest - rt_boot + q_boot_proj,
  f"{rtest:.0f} − bootstrap {rt_boot:.0f} + {q_boot_proj}; replaced by ~0 if the re-sweep of an already-swept tree is dropped (release-model decision below)")
for name, key in [("install (ubuntu-latest)", "CI"), ("install (windows-latest)", "CI"), ("wheel (x86_64-unknown-linux-gnu)", "CI"),
                  ("wheel (aarch64-unknown-linux-gnu)", "CI"), ("browser-windows", "CI"), ("msrv", "CI"), ("deny", "CI"),
                  ("llmlint", "CI"), ("pr-title", "CI"), ("changes", "CI"), ("gate", "CI")]:
    t = med(C, "CI", "pull_request", name)
    P(f"CI {name}", t, t, "no cut named; queue waits move (see needs edges) but the job's own duration does not")
cap = med(C, "Visual docs", "pull_request", "visual-docs / capture (x86_64, shots/current, shots/verify, Visual docs)")
P("Visual docs capture (PR)", cap, cap, "unchanged by the coverage-preserving cuts; −287 s only with the reproducibility re-capture dropped (coverage-reducing, below)")
for name in ["upload (x86_64-pc-windows-msvc)", "build-wheels (x86_64-pc-windows-msvc)", "build-npm (x86_64-pc-windows-msvc)",
             "upload (x86_64-unknown-linux-gnu)", "build-wheels (x86_64-unknown-linux-gnu)", "build-npm (x86_64-unknown-linux-gnu)",
             "upload (aarch64-unknown-linux-gnu)", "build-wheels (aarch64-unknown-linux-gnu)", "build-npm (aarch64-unknown-linux-gnu)",
             "darwin", "publish-crate", "publish-npm", "publish-pypi", "upload-darwin", "guard",
             "verify-assets (x86_64-unknown-linux-gnu)", "verify-assets (aarch64-unknown-linux-gnu)",
             "verify-pypi (ubuntu-latest)", "verify-pypi (windows-latest)"]:
    t = med(C, "Release", "release", name)
    P(f"Release {name}", t, t, "own duration unchanged; with the `needs: test` hold removed it starts ~{:.0f} s earlier".format(
        [h for h in C["needs_holds"] if h["needs"] == "test" and h["dependent"].startswith("^upload")][0]["held_s"]["median"])
      if name.startswith(("upload (", "build-", "darwin")) else ("unchanged; its `needs: test` is a publication gate and stays" if name == "publish-crate" else "unchanged"))
for name in ["probe", "npm (ubuntu-latest)", "npm (windows-latest)", "pypi (ubuntu-latest)", "pypi (windows-latest)"]:
    t = med(C, "Published smoke", "workflow_run", name)
    P(f"Published smoke {name}", t, t, "unchanged")
for name in ["guard", "release-plz"]:
    t = med(C, "Release-plz", "push", name)
    P(f"Release-plz {name}", t, t, "unchanged")
# Every other current-shape job: a push-event twin of a projected PR job takes the
# same cut; anything else is unchanged by the recommended cuts.
_named = {"CI quality": ("CI", "quality"), "CI cross (windows-latest)": ("CI", "cross (windows-latest)"), "CI macos": ("CI", "macos")}
_delta = {v: proj[k][0] - proj[k][1] for k, v in _named.items()}
for j in C["per_job"]:
    if not j["duration_s"]:
        continue
    label = f"{j['workflow']} {j['event']} {j['job']}"
    short = f"{j['workflow'] if j['workflow'] != 'CI' else 'CI'} {j['job']}"
    if short in proj or label in proj or (j["workflow"] == "Release" and f"Release {j['job']}" in proj) \
            or (j["workflow"] == "Published smoke" and f"Published smoke {j['job']}" in proj) \
            or (j["workflow"] == "Release-plz" and f"Release-plz {j['job']}" in proj):
        if j["event"] == "pull_request" or j["workflow"] != "CI":
            continue
    t = j["duration_s"]["median"]
    dl = _delta.get((j["workflow"], j["job"])) if j["event"] == "push" else None
    if dl:
        P(label, t, t - dl, f"push-to-main twin of the PR job: same cached-bootstrap cut (−{dl:.0f} s)")
    elif j["workflow"] == "Visual docs" and "capture" in j["job"]:
        P(label, t, t, "unchanged (see the PR capture row)")
    else:
        P(label, t, t, "unchanged by the recommended cuts")
pushq = med(C, "CI", "push", "quality")
P("CI push (every job on the merge commit)", C["repeats"]["per_merged_pr"]["push_runner_s"]["median"], 0,
  "runner-seconds per merged PR; 0 if push-to-main stops re-running a tree its PR head already passed (decision below)")

# ------------------------------------------------------------------- local profile
cold = L["check-cold"]
warm = L["check-warm-2"]
tiers_cold = {k: L[k] for k in ("test-baseline-cold", "test-cost-cold", "doc-cold")}
cold_total = cold["wall_seconds"] + sum(t["wall_seconds"] for t in tiers_cold.values())
aff_cold = L.get("check-affected-pr339-nxcold")
aff_warm = L.get("check-affected-pr339-warm-2")
llm = job(C, "CI", "pull_request", "llmlint")["duration_s"]
llm_w = job(F, "CI", "pull_request", "llmlint")["duration_s"]


def task_table():
    """Cold and warm local seconds per Nx task of `just check`, CI's figure beside it."""
    cold_t = {}
    for doc in [cold, *tiers_cold.values()]:
        for t in doc["tasks"]:
            if t["status"] in ("success", "failure"):
                cold_t.setdefault(t["task"], (t["seconds"], t["status"]))
    # A task the cold invocation never reached first executed in check-warm-1.
    for t in L["check-warm-1"]["tasks"]:
        if t["status"] in ("success", "failure") and t["task"] not in cold_t:
            cold_t[t["task"]] = (t["seconds"], t["status"] + ", first run in check-warm-1")
    aff = {}
    for t in (aff_cold or {"tasks": []})["tasks"]:
        if t["status"] in ("success", "failure"):
            aff.setdefault(t["task"], (t["seconds"], t["status"]))
    warm_t = {}
    for t in warm["tasks"]:
        prev = warm_t.get(t["task"])
        warm_t[t["task"]] = (round((prev[0] if prev else 0) + t["seconds"], 1), t["status"])
    ci = {
        "onepipeline-ui-repo-tooling:test": cp(logs("sweep") + logs("test"), "onepipeline-ui-repo-tooling:test"),
        "onepipeline-ui:ensure-baseline": cp(logs("sweep") + logs("test"), "onepipeline-ui:ensure-baseline"),
        "onepipeline-ui:lint": cp(logs("sweep") + logs("test"), "onepipeline-ui:lint"),
        "onepipeline-ui:bootstrap": cp(logs("quality") + logs("cross (windows-latest)"), "onepipeline-ui:bootstrap"),
    }
    nextest_ci = {}
    for e in logs("sweep") + logs("test"):
        seen = set()
        for n in e["nextest_summaries"]:
            k = n["summary"].split(":")[0]
            if k in seen:
                continue
            seen.add(k)
            nextest_ci.setdefault(k, []).append(n["seconds"])
    rows = ["| Nx task | cold local s (status) | Nx-cold, cargo-warm s (PR #339 affected run) | warm local s (status) | CI figure |", "| --- | --- | --- | --- | --- |"]
    keyed = sorted(cold_t, key=lambda k: -cold_t[k][0])
    ci_note = {
        "onepipeline-ui-repo-tooling:test": "nextest run " + ", ".join(f"{v:.0f}" for v in nextest_ci.get("223 tests run", [])) + " s",
        "onepipeline-ui-e2e:test": "nextest run " + ", ".join(f"{v:.0f}" for v in nextest_ci.get("251 tests run", nextest_ci.get("250 tests run", []))) + " s",
        "onepipeline-ui:test": "nextest run " + ", ".join(f"{v:.1f}" for v in nextest_ci.get("64 tests run", [])) + " s",
        "onepipeline-ui-baseline:test-baseline": "nextest run " + ", ".join(f"{v:.0f}" for v in nextest_ci.get("1 test run", [])) + " s",
        "onepipeline-ui-cost:test-cost": "nextest run " + ", ".join(f"{v:.1f}" for v in nextest_ci.get("13 tests run", [])) + " s",
        "dag-ui-e2e:test": "Playwright " + ", ".join(f"{p['seconds']:.0f}" for e in logs("sweep") + logs("test") for p in e["playwright"][:1]) + " s",
        "dag-ui:test": "Vitest " + ", ".join(f"{max(v['seconds'] for v in e['vitest']):.0f}" for e in logs("sweep") + logs("test") if e["vitest"]) + " s",
    }
    for k in keyed:
        c, cs = cold_t[k]
        w = warm_t.get(k)
        civ = ci.get(k)
        cinote = ci_note.get(k) or (("critical path " + ", ".join(f"{v:.0f}" for v in civ) + " s") if civ else "–")
        a = aff.get(k)
        av = f"{a[0]:.1f} ({a[1]})" if a else "– (not affected)"
        wv = f"{w[0]:.1f} ({w[1]})" if w else "–"
        rows.append(f"| {k} | {c:.1f} ({cs}) | {av} | {wv} | {cinote} |")
    return "\n".join(rows)


def slowest_tier_tests():
    text = (HERE / "local/check-cold.log").read_text(errors="replace")
    tests = [t for t in lp.tests_from_log(text) if t["task"] == "onepipeline-ui-repo-tooling:test"]
    tests.sort(key=lambda t: -t["seconds"])
    rows = ["| # | test (binary::name) | local cold s |", "| --- | --- | --- |"]
    for i, t in enumerate(tests[:20], 1):
        rows.append(f"| {i} | `{t['binary']}` `{t['test']}` | {t['seconds']:.1f} |")
    return "\n".join(rows), len(tests)


def job_table(f):
    rows = ["| Workflow | Event | Job / matrix leg | OS | n ok | median s | p90 s | max s | queue median s | queue p90 s | queue max s | failed | cancelled |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for j in f["per_job"]:
        dd, q = j["duration_s"], j["queue_wait_s"]
        if not dd and not j["failed"] and not j["cancelled"]:
            continue
        g = lambda x, k: "–" if not x else f"{x[k]:.0f}"
        rows.append(f"| {j['workflow']} | {j['event']} | {j['job']} | {','.join(j['runner_os']) or '–'} | {dd['n'] if dd else 0} | "
                    f"{g(dd,'median')} | {g(dd,'p90')} | {g(dd,'max')} | {g(q,'median')} | {g(q,'p90')} | {g(q,'max')} | {j['failed']} | {j['cancelled']} |")
    return "\n".join(rows)


def counts_table():
    rows = ["| Unit | Split | Window (since 2026-09-15) | Current shape (since #315) |", "| --- | --- | --- | --- |"]
    ph, pc = F["per_pr_head_commit"], C["per_pr_head_commit"]
    rows.append(f"| PR head commit, all workflows | total | {dj(ph['jobs_executed'])} | {dj(pc['jobs_executed'])} |")
    for k in ph["by_workflow"]:
        rows.append(f"| PR head commit | workflow {k} | {dj(ph['by_workflow'][k])} | {dj(pc['by_workflow'][k])} |")
    for k in ph["by_runner_os"]:
        rows.append(f"| PR head commit | runner {k} | {dj(ph['by_runner_os'][k])} | {dj(pc['by_runner_os'][k])} |")
    rf, rc = F["per_release_cd"], C["per_release_cd"]
    rows.append(f"| Release CD (all its runs) | total | {dj(rf['job_count'])} | {dj(rc['job_count'])} |")
    for k in rf["job_count_by_workflow"]:
        rows.append(f"| Release CD | workflow {k} | {dj(rf['job_count_by_workflow'][k])} | {dj(rc['job_count_by_workflow'][k]) if k in rc['job_count_by_workflow'] else '–'} |")
    for k in rf["job_count_by_runner_os"]:
        rows.append(f"| Release CD | runner {k} | {dj(rf['job_count_by_runner_os'][k])} | {dj(rc['job_count_by_runner_os'][k])} |")
    return "\n".join(rows)


def cycle_table():
    rows = ["| Phase | Window | Current shape |", "| --- | --- | --- |"]
    for k, label in [("checks_phase_s", "checks phase (first head-commit run created → last head job completed)"),
                     ("merge_to_release_s", "merge → release (merged_at → last CD job completed, first release containing the merge)"),
                     ("merge_to_release_commit_s", "  of which merge → release commit's first CD run"),
                     ("total_s", "total (sum of the two phases)"),
                     ("per_release_max_total_s", "per release: max total over the PRs it carries")]:
        rows.append(f"| {label} | {d(F['cycle_time'][k])} | {d(C['cycle_time'][k])} |")
    return "\n".join(rows)


def proj_table():
    rows = ["| Job | today median s (current shape) | projected s | projection basis |", "| --- | --- | --- | --- |"]
    for k, (t, p, b) in proj.items():
        rows.append(f"| {k} | {t} | {p} | {b} |")
    return "\n".join(rows)


slow_rows, slow_n = slowest_tier_tests()


def closed_pr_runs():
    """Visual docs pull_request runs created at a PR's close, and which jobs they executed."""
    import measure as m
    from collections import Counter
    raw = HERE / "raw"
    runs, jobs, pulls = m.load_runs(raw), m.load_jobs(raw), m.load_pulls(raw)
    closed = {p["head"]["sha"]: m.ts(p["closed_at"]) for p in pulls.values() if p.get("closed_at")}
    n, with_capture = 0, 0
    for r in runs.values():
        ca = closed.get(r["head_sha"])
        if r["name"] == "Visual docs" and r["event"] == "pull_request" and ca and (m.ts(r["created_at"]) - ca).total_seconds() >= -5:
            n += 1
            names = {j["name"].split(" (")[0] for j in m.executed(jobs[r["id"]])}
            with_capture += "visual-docs / capture" in names
    return n, with_capture


closed_n, closed_cap = closed_pr_runs()
mac_conc = job(C, "CI", "pull_request", "macos")["conclusions"]
rel_conc = {}
for _r in F["per_release_cd"]["releases"]:
    rel_conc[_r["release_conclusion"]] = rel_conc.get(_r["release_conclusion"], 0) + 1
by_name = F["per_pr_head_commit"]["ci_longest_job_by_name"]
xw_longest = by_name.get("ordinary PR: cross (windows-latest)", 0)
ordinary_n = F["per_pr_head_commit"]["ci_longest_job_s_by_kind"]["ordinary PR"]["n"]
local_wall_h = sum(v["wall_seconds"] for v in L.values()) / 3600
pull_pages = len(list((HERE / "raw/pulls").glob("*.json")))
holds = {(h["workflow"], h["dependent"]): h for h in C["needs_holds"]}
holds_w = {(h["workflow"], h["dependent"]): h for h in F["needs_holds"]}
rep_pr, rep_rel = F["repeats"]["per_merged_pr"], F["repeats"]["per_release"]
crep_pr, crep_rel = C["repeats"]["per_merged_pr"], C["repeats"]["per_release"]

def release_commit_ci_runner_s():
    """Runner-seconds of push CI on each current-shape release commit."""
    import measure as m
    raw = HERE / "raw"
    runs, jobs = m.load_runs(raw), m.load_jobs(raw)
    out = []
    for r in C["per_release_cd"]["releases"]:
        ci = [rid for rid in r["runs"] if runs[rid]["name"] == "CI" and runs[rid]["event"] == "push"]
        out.append(sum(m.job_dur(j) or 0 for rid in ci for j in m.executed(jobs[rid])))
    return out


rel_push_ci = release_commit_ci_runner_s()
rest_n = len(REST)
min_q = min(r["core_remaining_before"] for r in REST)
refused = sum(1 for r in REQ if r["kind"] == "refused")

harness = f"""On branch `{BRANCH}`, directory `spike/onepipeline-ui-ci/` (throwaway; nothing there lands).

- **The one command** — `measure.py`. Given a repository and a start date it reads the repository's Actions runs (in 3-day `created` slices, under the 1,000-result cap a filtered list has), the jobs of every run's latest attempt, and its closed pull requests, all through `gh api --method GET`, and writes the per-job, per-run and per-PR cycle-time figures as one JSON document. The fetch was: `python3 -I spike/onepipeline-ui-ci/measure.py --repo nickderobertis/onepipeline-ui --since 2026-09-15 --raw spike/onepipeline-ui-ci/raw --out spike/onepipeline-ui-ci/figures.json --job-run-budget 1200`. It ran three times, resuming from its cache: the first run stopped at the quota floor, the second on a transient `rate_limit` read failure. **The report's figures are the output of** `{INVOCATION}`, which is the same command reading the cache offline. Its output is `spike/onepipeline-ui-ci/figures.json`, and `current_shape` inside it holds the same figures for runs created on or after 2026-10-13T22:56:32Z.
- **Request log and quota guard** — `ghread.py`. Before every REST request it asks `gh api rate_limit` (which does not count against the core quota) for the core requests remaining, writes that figure into `request-log.jsonl`, and refuses the request if the figure is below 2,500 or 3,000 requests have already been made.
- **Raw responses** — `raw.tar.xz` holds every response the harness read, verbatim: 1,149 runs, the jobs of all 1,149, {pull_pages} pages of pull requests, {len(LOGS)} job logs, plus `git-tags.json`. That last file is the only input that is not a REST response; it records, from the local clone, which tag first contains each merge commit. To reproduce: `tar xJf spike/onepipeline-ui-ci/raw.tar.xz -C spike/onepipeline-ui-ci`, then run the command above. That reproduces `figures.json` exactly; this was checked by diffing a re-run in a scratch directory. `sample/raw/` is a smaller verbatim subset for PR #339 and release v0.36.1: running `python3 -I spike/onepipeline-ui-ci/measure.py --repo nickderobertis/onepipeline-ui --since 2026-09-15 --raw spike/onepipeline-ui-ci/sample/raw --out /tmp/sample.json --offline` reproduces PR #339's two phases (checks {[c for c in F['cycle_time']['prs'] if c['pr']==339][0]['checks_phase_s']:.0f} s, merge→release {[c for c in F['cycle_time']['prs'] if c['pr']==339][0]['merge_to_release_s']:.0f} s), and v0.36.1's CD job count (43) and longest job (Release / test, 2,320 s), identical to the full figures. It also gives every job duration of Release run 38706388926.
- **Helpers** (not the budget command): `ci_logs.py`, which reads per-Nx-invocation and per-test-runner timings out of 12 CI job logs into `ci-logs.json`; `local_profile.py`, which times one of the repository's own recipes and reads Nx's own task history into `local/*.json`; `tables.py`; `report_answers.py`, which renders this report's answers from those outputs.
- **Required-checks snapshot** — `required-status-checks.json`: GitHub's response to `GET repos/nickderobertis/onepipeline-ui/branches/main/protection/required_status_checks`, with `taken_at` added.

How the budget node can grow it: `measure.py`'s `analyse()` already computes the measures for `ci-check-time` (`per_pr_head_commit.ci_longest_job_s`), `cd-job-time` (`per_release_cd.longest_job_s`), `release-cycle-time` (`cycle_time.per_release_max_total_s`), `ci-job-count` (`per_pr_head_commit.jobs_executed`) and `cd-job-count` (`per_release_cd.job_count`), each for one unit. A onebudgetspec command can call it on the runs for one head commit or one release. `gate-time` is `local_profile.py --label gate -- just check`, plus the judge tier."""

method = f"""**Systems and window.** GitHub's REST API, read through this host's `gh` authentication, with `gh api --method GET` only. Repository `nickderobertis/onepipeline-ui`, every run of `CI`, `Release-plz`, `Release`, `Published smoke`, `Visual docs` and `notignored` created from 2026-09-15 to 2026-10-16 00:04 UTC. That is {F['inputs']['runs_in_window']} runs, by workflow and event: {', '.join(f'{k} {v}' for k, v in F['inputs']['runs_by_workflow_event'].items())}. `pages-build-deployment` is excluded. **No sampling:** jobs were read for all {F['inputs']['runs_with_jobs_read']} runs, along with {F['inputs']['pulls_read']} closed pull requests. REST requests made: {rest_n}, including 1 made by hand before the logger existed, which is recorded in the log with the quota read immediately before it. The lowest core quota reported before any request was {min_q}; 1 further request was refused at the floor (2,499 < 2,500) and made after the hourly reset. The quota is shared with the other spikes on this host: between the first request and the floor, core quota fell {REST[0]['core_remaining_before'] - min_q} while this spike made {sum(1 for x in REST if x['at'] <= '2026-10-16T00:28')} requests.

**Definitions.** All of these are in `measure.py`.
- A job's duration is `started_at` → `completed_at`.
- Queue wait is the run's `created_at` → the job's `started_at`, or `run_started_at` for a re-run attempt. It therefore includes time held behind a `needs` edge.
- Duration distributions are taken over successful jobs. Failed and cancelled jobs are counted separately.
- An executed job is one that is not skipped and was given a runner. Jobs cancelled while still queued are excluded.
- p90 is the nearest-rank p90.
- A PR head commit's runs are the pull_request-event runs on the PR's final head SHA created before `merged_at`. This drops the visual-docs `closed` run. The latest run per workflow is used.
- A release's CD is: the push runs on the tag's commit (CI, Release-plz, Visual docs on the release-PR merge), the `release`-event Release run for that tag, and the first Published smoke `workflow_run` run created within 30 minutes after that Release run completed.
- Cycle time covers every non-release PR merged in the window. The first tag containing the merge commit comes from the local clone's history.

**Two shapes.** The workflows changed shape during the window: #244 split the test tiers and added `sweep` (10-07), and #315 consolidated macOS (10-13). So every figure is given twice. *Window* covers every run since 2026-09-15. *Current shape* covers runs created since 2026-10-13T22:56:32Z (#315), which is only 4 releases (v0.34.1–v0.36.1) and 6 PR head commits. Current-shape distributions are therefore thin: they describe today's workflows, and the window describes their history.

**CI's own per-target timings** come from 12 job logs read on 2026-10-16: the newest 3 successful `quality`, `sweep`, `cross (windows-latest)` and Release `test` jobs since #315. From each log the harness took what Nx and the runners print themselves: each Nx invocation's `Run duration`, the critical-path tasks Nx names, nextest `Summary [ Ns ]` lines, the Playwright `passed (…)` total and the Vitest `Duration`. CI's nextest profiles print failures only, so **CI per-test durations are not observable; this report has none.**

**Local profile — the limits matter.** This host is Linux aarch64 with 14 cores and 29 GB. Load average was 9 when the profile started and **27–55 for most of it**, because other repositories' gates were running on the same host. Local figures are therefore inflated well past CI's: repo-tooling `test` took 15,778 s locally against CI's 944–1,287 s critical path. They are useful for ordering and for cold/warm ratios, not as absolute CI predictions.
- The spike's own files under `spike/` were kept out of Nx's file hashing during the profile by an untracked `.nxignore` (`spike/`), so the profiled tree hashed as ecb96f6. That file was removed afterwards and never committed.
- *Cold* means no Nx cache (the session clone's cache held only what bootstrap built) and a cargo `target/` holding only bootstrap's debug build. The cold `just check` stopped at its `test` recipe. `dag-ui:test` and `dag-ui-e2e:test` failed on timeouts under load and passed on re-run, which Nx reports as flaky. `github-workflows:test` failed, and that failure was caused by this profile: the profiler's log was growing inside the checkout, and `.github/workflow-graph.mjs`'s `digest()` hashes every untracked file. Its later runs, with the log kept outside the tree, passed. `test-baseline`, `test-cost` and `doc` were therefore timed cold as separate invocations of their own recipes.
- *Warm* means the same tree again, with the Nx cache those runs left. The first warm `just check` (`check-warm-1`) also failed on `github-workflows:budgets`, for the same digest reason; `check-warm-2` passed with exit 0.
- `check-affected` was profiled on PR #339's diff (5a2daca..cd4be04, a deps bump that affects 8 of the 15 projects, which is the commonest PR shape here). It used the command `just check-affected` execs, with the base and head named explicitly so the spike's own commits did not enter the diff: once with Nx's `--skip-nx-cache` (Nx cold, cargo warm, which is the state CI's rust-cache leaves) and once warm.
- The judged tier `lint-llm-diff` was **not run locally**, by manager ruling. `gate-time` is `just check`'s local wall clock plus the judge's wall clock **as CI measured it** (the `llmlint` job).

**Per job and matrix leg — window (every run since 2026-09-15).** Durations are over successful jobs.

{job_table(F)}

**Per job and matrix leg — current shape (since #315).**

{job_table(C)}

**Jobs per PR head commit and per release's CD** (executed jobs; matrix legs counted; skipped excluded):

{counts_table()}

**Cycle time** ({F['cycle_time']['eligible_prs']} merged PRs eligible in the window, out of {F['cycle_time']['eligible_prs'] + sum(F['cycle_time']['ineligible'].values())} merged. Ineligible: {', '.join(f'{v} {k}' for k, v in F['cycle_time']['ineligible'].items())}. Current shape: {C['cycle_time']['eligible_prs']} eligible):

{cycle_table()}

**Local profile, per Nx task of `just check`.** Cold seconds come from `check-cold` and the three cold tier runs; a task those never reached is taken from its first run, in `check-warm-1`. The Nx-cold, cargo-warm column is the `--skip-nx-cache` run over PR #339's 8 affected projects, which is closest to a CI `quality` job. Warm seconds come from `check-warm-2`, where `local-cache*` means replayed. The CI figure comes from the 12 logs (sweep and Release `test` jobs).

{task_table()}

Wall clock: cold `just check` {cold['wall_seconds']:.0f} s (stopped at `test`), plus the cold `test-baseline` {tiers_cold['test-baseline-cold']['wall_seconds']:.0f} s, `test-cost` {tiers_cold['test-cost-cold']['wall_seconds']:.0f} s and `doc` {tiers_cold['doc-cold']['wall_seconds']:.0f} s runs, which totals **{cold_total:.0f} s**. Warm `just check`: **{warm['wall_seconds']:.1f} s**, exit {warm['exit_code']}: {warm['tasks_replayed']} tasks replayed, and {warm['tasks_executed']} executed because they are uncacheable (bootstrap, ensure-*, coverage, `github-workflows:test`/`budgets`, `dag-ui:build-api-server`). {('`check-affected` (PR #339 diff): Nx-cold ' + f"{aff_cold['wall_seconds']:.0f} s (exit {aff_cold['exit_code']}), warm {aff_warm['wall_seconds']:.1f} s (exit {aff_warm['exit_code']}). The Nx-cold run's one failure was `onepipeline-ui:doc`: rustdoc read `apps/dag-ui/dist` while `dag-ui:build` was rewriting it, because `doc` declares no `dependsOn` on that build (a follow-up is drafted). Every other task passed. Its {aff_cold['wall_seconds']:.0f} s is close to CI `quality`'s {q_gate:.0f} s `check-affected` step, so at this load the host's Nx-cold, cargo-warm figures are roughly CI-scale, while its fully cold ones are not.") if aff_cold and aff_warm else '`check-affected` Nx-cold profile: MISSING (did not complete).'}

**Slowest tier and its 20 slowest tests.** `onepipeline-ui-repo-tooling:test` is the slowest tier both locally ({[t for t in cold['tasks'] if t['task']=='onepipeline-ui-repo-tooling:test'][0]['seconds']:.0f} s cold) and in CI (critical path {', '.join(f'{v:.0f}' for v in cp(logs('sweep') + logs('test'), 'onepipeline-ui-repo-tooling:test'))} s in the sweep and Release `test` logs). These are its 20 slowest of {slow_n} tests, from nextest's own `PASS [ Ns ]` lines in the cold local run. This is host-contended, local timing only, since CI does not print per-test times.

{slow_rows}
"""

r = rep_pr
findings = []

findings.append(
    f"**Checks run more than once per change (measured, window medians; current shape in brackets).** "
    f"(1) *A PR's whole CI runs again on its merge commit.* A push to `main` re-runs every CI job the PR head ran, on a tree that matches the head whenever the PR was up to date. Branch protection has `strict: false`, so that is not guaranteed. Cost: {rep_pr['push_rerun_of_head_jobs_runner_s']['median']:.0f} runner-s per merged PR ({crep_pr['push_rerun_of_head_jobs_runner_s']['median']:.0f}), p90 {rep_pr['push_rerun_of_head_jobs_runner_s']['p90']:.0f}. Of that, `just bootstrap` is {rep_pr['push_steps_s']['just bootstrap']['median']:.0f} s, `check-affected` {rep_pr['push_steps_s']['just check / check-affected']['median']:.0f} s, `check-cross` {rep_pr['push_steps_s']['just check-cross']['median']:.0f} s and release-profile compiles {rep_pr['push_steps_s']['release-profile compile of the binary']['median']:.0f} s. "
    f"(2) *The full `just check` runs three times per release, on the same tree.* It runs in `sweep` on the release PR (median {rep_rel['sweep_s']['median']:.0f} s, {crep_rel['sweep_s']['median']:.0f} current); in push CI's `quality` on the release commit ({med(C,'CI','push','quality'):.0f} s current); and in Release `test` ({rep_rel['release_test_s']['median']:.0f} s, {crep_rel['release_test_s']['median']:.0f} current). All three use the same tree when the release PR was up to date. "
    f"(3) *`just bootstrap`* costs {rep_pr['head_steps_s']['just bootstrap']['median']:.0f} s per PR head commit ({crep_pr['head_steps_s']['just bootstrap']['median']:.0f}), {rep_pr['push_steps_s']['just bootstrap']['median']:.0f} s again on its merge commit, and {rep_rel['cd_steps_s']['just bootstrap']['median']:.0f} s per release's CD ({crep_rel['cd_steps_s']['just bootstrap']['median']:.0f}). Per job: `quality` {q_boot:.0f}, `sweep` {sw_boot:.0f}, `cross (windows)` {xw_boot:.0f}, `macos` {mac_boot:.0f}, Release `test` {rt_boot:.0f} s. Most of it is the sibling CLI's `cargo install onepipeline`: Nx's critical path names `onepipeline-ui:bootstrap` at {', '.join(f'{v:.0f}' for v in q_sib)} s in `quality` and {', '.join(f'{v:.0f}' for v in xw_sib)} s on Windows. Everything else in bootstrap measured {', '.join(str(v) for v in q_rest)} s and {', '.join(str(v) for v in xw_rest)} s. Locally, `onepipeline-ui:bootstrap` took {[t for t in L['bootstrap-cold']['tasks'] if t['task']=='onepipeline-ui:bootstrap'][0]['seconds']:.1f} s with no `.tools/` and {[t for t in L['bootstrap-warm']['tasks'] if t['task']=='onepipeline-ui:bootstrap'][0]['seconds']:.1f} s with the sibling already provisioned, and the whole `just bootstrap` took {L['bootstrap-cold']['wall_seconds']:.0f} s against {L['bootstrap-warm']['wall_seconds']:.1f} s. "
    f"(4) *`just build` (the browser view)* runs {rep_rel['cd_steps_s']['just build (browser view)']['median']:.0f} s per release's CD, across 11 jobs, and {rep_pr['head_steps_s']['just build (browser view)']['median']:.0f} s per PR head commit (`wheel` ×2, `browser-windows` {step(C,'CI','browser-windows','Build the browser view (shared with release.yml)'):.0f} s). It is cheap per job; the cost is that it repeats. "
    f"(5) *Release-profile compiles of the same binary* total {rep_rel['cd_steps_s']['release-profile compile of the binary']['median']:.0f} s per release ({crep_rel['cd_steps_s']['release-profile compile of the binary']['median']:.0f} current), because `upload`, `build-wheels` and `build-npm` each compile every Linux and Windows target. For Windows that is {step(C,'Release','upload (x86_64-pc-windows-msvc)','Build, archive, checksum, and upload'):.0f}+{step(C,'Release','build-wheels (x86_64-pc-windows-msvc)','Build wheel'):.0f}+{step(C,'Release','build-npm (x86_64-pc-windows-msvc)','Build the platform binary'):.0f} s; for x86_64 Linux {step(C,'Release','upload (x86_64-unknown-linux-gnu)','Build, archive, checksum, and upload'):.0f}+{step(C,'Release','build-wheels (x86_64-unknown-linux-gnu)','Build wheel (Linux, shared with ci.yml\'s wheel)'):.0f}+{step(C,'Release','build-npm (x86_64-unknown-linux-gnu)','Build the platform binary'):.0f} s. `darwin` already builds once. On top of that comes `{rep_pr['head_steps_s']['release-profile compile of the binary']['median']:.0f}` s per PR head (`install` ×2, `wheel` ×2, `macos`). `ci.yml`'s `wheel` and Release's Linux `build-wheels` run the same `just wheel-linux` (≈{step(C,'CI','wheel (x86_64-unknown-linux-gnu)','Build wheel (shared with the Linux build-wheels legs in release.yml)'):.0f}/{step(C,'CI','wheel (aarch64-unknown-linux-gnu)','Build wheel (shared with the Linux build-wheels legs in release.yml)'):.0f} s); this repeat is deliberate (v0.16.0). "
    f"(6) *Screenshot capture* runs on the PR head ({rep_pr['head_steps_s']['screenshot capture']['median']:.0f} s) and again on the push to `main` whenever that run is not superseded. Each capture includes its own reproducibility re-capture ({step(C,'Visual docs','visual-docs / capture (x86_64, shots/current, shots/verify, Visual docs)','Capture again for the reproducibility gate'):.0f} s).")

hq = holds[("CI", r"^install \((ubuntu|windows)-latest\)$")]["held_s"]
hm = holds[("CI", r"^macos$")]["held_s"]
ht = holds[("Release", r"^upload \(")]["held_s"]
hd = holds[("Release", r"^darwin$")]["held_s"]
hp = holds[("Release", r"^publish-crate$")]["held_s"]
findings.append(
    f"**`needs` edges that wait without using the needed job's output (measured hold = the needed job's completion minus when the dependent could otherwise start; current shape, window in brackets).** "
    f"`ci.yml` `install` ← `quality` (ci.yml:376; install reads no output or artifact of quality): held {d(hq)} [{d(holds_w[('CI', r'^install \((ubuntu|windows)-latest\)$')]['held_s'])}]. "
    f"`ci.yml` `macos` ← `quality` (ci.yml:213): held {d(hm)}. "
    f"`release.yml` `upload`/`build-wheels`/`build-npm` ← `test` (release.yml:243, 403, 561): held {d(ht)} [{d(holds_w[('Release', r'^upload \(')]['held_s'])}]. "
    f"`darwin` ← `test` (release.yml:165): held {d(hd)}, after which the Mac runner still queued (darwin's queue wait is {d(job(C,'Release','release','darwin')['queue_wait_s'])}). "
    f"`publish-crate` ← `test` (release.yml:369): held {d(hp)}. That edge is a publication gate, so it stays. Only the *build* half of the release edges is free to move: `upload` publishes assets, so it would split into build (no wait) and attach (`needs: test`). "
    f"Edges that consume output and stay: `gate`, `cross-macos` and `install-macos` read their needs' results; `sweep`, `cross`, `msrv`, `deny`, `wheel` and `install` read `changes` outputs; Visual docs `report` downloads `capture`'s artifact; the `publish-*` and `verify-*` jobs need what they publish. "
    f"Removing `install`←`quality` cuts a PR's checks-phase wall time by up to the hold ({hq['median']:.0f} s median), at the price of ~{med(C,'CI','pull_request','install (ubuntu-latest)')+med(C,'CI','pull_request','install (windows-latest)'):.0f} runner-s spent on PRs whose `quality` fails. Removing the build half of `needs: test` cuts CD wall time by up to {ht['median']:.0f} s, at the price of ~{sum(med(C,'Release','release',n) for n in ['upload (x86_64-unknown-linux-gnu)','upload (aarch64-unknown-linux-gnu)','upload (x86_64-pc-windows-msvc)','build-wheels (x86_64-unknown-linux-gnu)','build-wheels (aarch64-unknown-linux-gnu)','build-wheels (x86_64-pc-windows-msvc)','build-npm (x86_64-unknown-linux-gnu)','build-npm (aarch64-unknown-linux-gnu)','build-npm (x86_64-pc-windows-msvc)','darwin']):.0f} runner-s wasted when `test` fails.")

findings.append("**Projected duration of every CI and CD job after the recommended coverage-preserving cuts. PROJECTION**, not measurement: each row names the measurements it rests on. The cuts are: cache the sibling CLI `.tools/bin/onepipeline` across runs, keyed on the `onepipeline` version in Cargo.lock and the OS; remove the wait-only `needs` edges above; and use Nx affected-only selection as `quality` already does. The `+30 s` cache restore is assumed, not measured.\n\n" + proj_table())

findings.append(
    f"**Local gate wall clock (the `onepipeline-ui-gate-time` figure).** `just gate` = `just check` + `just lint-llm-diff`. Cold (no Nx cache): `just check` {cold['wall_seconds']:.0f} s in one invocation, which stopped at `test` after two load-induced timeouts and one profile-induced failure, plus {sum(t['wall_seconds'] for t in tiers_cold.values()):.0f} s for the three tiers it never reached: **{cold_total:.0f} s cold** on a host at load 27–55. Warm (Nx cache restored, same tree): **{warm['wall_seconds']:.1f} s**. Adding the judge tier **as CI measured it, not run locally** (`llmlint` job, current shape {d(llm)}; window {d(llm_w)}) gives a gate time of **≈{cold_total + llm['median']:.0f} s cold, ≈{warm['wall_seconds'] + llm['median']:.0f} s warm** (sums, judge at its CI median). For an uncontended host, CI's own full-`check` step is the better reference: `sweep` {sw_check:.0f} s, Release `test` {rt_check:.0f} s.")

ci_save = []
findings.append(
    f"**What restoring the Nx cache in CI would save — little on the paths that matter, because of cache scoping.** A full replay costs {warm['wall_seconds']:.0f} s locally for all of `check` (uncacheable tasks included), and {(aff_warm or {}).get('wall_seconds', float('nan')):.1f} s for PR #339's affected set. That is the floor a hit replaces CI's {q_gate:.0f} s `check-affected`, {sw_check:.0f} s sweep `check` or {rt_check:.0f} s Release `check` with. But GitHub's cache rules decide which runs can hit. A run restores caches from its own ref and the default branch; a PR additionally restores from its base, PR caches are scoped to the merge ref, and a tag's run sees only default-branch caches (docs: *Dependency caching reference → Restrictions for accessing a cache*). "
    f"So: (a) a PR's first run hits nothing it does not already skip, because `check-affected` runs only projects whose inputs differ from `main`. (b) Re-runs and later pushes of the same PR replay the projects that push did not touch. (c) `cross`'s `check-cross` is `run-many` over all 15 projects, so it would replay the 7 unaffected small projects' `format-check`/`lint`. Those are ≤{max(nx_inv(logs('cross (windows-latest)'),'format-check')):.0f}+{max(nx_inv(logs('cross (windows-latest)'),'lint')):.0f} s on Windows across *all* projects, so ≤ ~100 s per run (projection). (d) Release `test` cannot replay the release PR's `sweep`: that cache is merge-ref scoped. It could replay only a `main`-scoped cache written by push CI on the release commit, and that run starts in the same second as the Release run (v0.36.1: both at +0–36 s), so it finishes too late. The Release version bump also changes `Cargo.toml`, an input of every Rust target. "
    f"Restoring the cache is therefore worth ≲100 s per PR run and nothing on the release path, unless the release model changes (finding below). **Caveat measured here:** `github-workflows:budgets` checks a telemetry digest over every tracked *and untracked* file (`.github/workflow-graph.mjs:117`), while Nx hashes `github-workflows:test` from `workflowPolicy` alone. Any file appearing between the two fails the budget, as it did twice in this profile. A restored cache needs that test to stay uncached, which it is today (`cache: false`).")

findings.append(
    f"**Checks that cannot reach 1,800 s without sharding: none is projected to need sharding, but two sit at the edge.** Measured today: `sweep` {d(job(C,'CI','pull_request','sweep')['duration_s'])} and Release `test` {d(job(C,'Release','release','test')['duration_s'])}. Both are over 1,800 s on every current-shape run. `cross (windows-latest)` measures {d(job(C,'CI','pull_request','cross (windows-latest)')['duration_s'])}, and `macos` 1,928 s (n=1). After caching the sibling CLI (projection, table above): `sweep` ≈{proj['CI sweep'][1]} s median, but its slowest measured run projects to {sweep_max - sw_boot_max + q_boot_proj:.0f} s. Release `test` ≈{proj['Release test'][1]} s, and Windows `cross` ≈{proj['CI cross (windows-latest)'][1]} s. What keeps the full sweep near 30 minutes is `onepipeline-ui-repo-tooling:test`: critical path {', '.join(f'{v:.0f}' for v in cp(logs('sweep')+logs('test'),'onepipeline-ui-repo-tooling:test'))} s inside a {sw_check:.0f}–{sw_check_max:.0f} s `check`. Its slowest test, `packaging::the_release_staging_path_builds_installs_and_serves_the_native_artifact`, compiles a release, LTO, instrumented binary; it took 5,649 s locally under contention, and its CI duration is MISSING because nextest prints failures only. **Decision for the user:** accept a sweep/Release `test` that may run ~1,830 s at its slowest, or fund the test-speed work on that test below.")

findings.append(
    "**Expensive test strategies and their alternatives (time saved vs coverage lost; savings are projections from the measured figures named).** "
    f"(1) *The release-staging journey in the repo-tooling tier* (above). Keeps coverage: build that release artifact once per run as a cached Nx target the test consumes, rather than inside the test. Saving unmeasured (CI per-test time missing); its share of the tier's {', '.join(f'{v:.0f}' for v in cp(logs('sweep')+logs('test'),'onepipeline-ui-repo-tooling:test'))} s critical path is the upper bound. Reduces coverage: run it only in release.yml, where native artifacts are built anyway. That saves its PR/sweep time and loses PR-time detection of a broken staging path, plus whatever lines only it covers toward the 95% floor (unmeasured). "
    f"(2) *Windows `cross` leg* ({xw:.0f} s median, of which bootstrap {xw_boot:.0f} s and `check-cross` {xw_gate:.0f} s). Keeps coverage: cache the sibling CLI (−{xw - proj['CI cross (windows-latest)'][1]:.0f} s, projection). Reduces coverage: run it only when the diff touches platform-sensitive code, or only on the release PR. That saves {xw:.0f} s of runner time per other PR and loses Windows proof of every other change before merge. `cross (windows-latest)` is a required context, so this is also a protection change. "
    f"(3) *`macos` leg* ({mac:.0f} s, n=1; queued {d(job(C,'CI','pull_request','macos')['queue_wait_s'])}, cancelled 7 times in the current shape). Already policy-limited by the two macOS budgets, which this plan leaves unchanged; no further cut is proposed. "
    f"(4) *Playwright tiers* (`dag-ui-e2e:test` 139 tests: {', '.join(f'{p['seconds']:.0f}' for e in logs('sweep')+logs('test') for p in e['playwright'][:1])} s in CI; `test-isolation` 2 tests ~15–22 s). Keeps coverage: none needed for 30 minutes, since neither is on the critical path (repo-tooling is). Reduces coverage: run the 139-test suite only in the sweep, saving ~{statistics.median([p['seconds'] for e in logs('quality') for p in e['playwright'] if p['passed']>100]):.0f} s of `quality` per affecting PR, but this suite is the only proof the served UI works (ci.yml:118–124). "
    f"(5) *Baseline tier* (builds the base commit's server: `ensure-baseline` critical path {', '.join(f'{v:.0f}' for v in cp(logs('sweep')+logs('test'),'onepipeline-ui:ensure-baseline'))} s in sweep/Release logs; 747 s locally cold). Keeps coverage: cache `.tools/bin/onepipeline-api-baseline` keyed on the base commit, which it is already stamped with. That saves ≈ the figure above on a hit, since sweep and Release `test` share a base only when no merge landed in between (hit rate unmeasured). "
    f"(6) *Reproducibility re-capture in visual docs* ({step(C,'Visual docs','visual-docs / capture (x86_64, shots/current, shots/verify, Visual docs)','Capture again for the reproducibility gate'):.0f} s per capture). Reduces coverage: `verify: false` saves that much per PR and per push, and loses the byte-identical reproducibility gate. "
    f"(7) *Coverage instrumentation* (`test` vs `test-quick`): every Linux tier compiles instrumented. No measured split is available, so no figure is given (MISSING).")

findings.append(
    "**Cuts that change a published artifact, a release target or the release model (decision for the user; savings are projections from measured medians, current shape).** "
    f"(1) *Drop release.yml's re-sweep (`test`) when the tagged tree is one `sweep` already passed.* Compare the release PR head's tree SHA to the tag commit's and check `sweep`'s conclusion; keep the full sweep for a hand-cut Release (AGENTS.md's reason). Saves {rtest:.0f} s of CD wall clock per release and {rt_boot + rt_check:.0f} s of runner time (bootstrap + `check`). Coverage is unchanged when the trees match, but the release's gate becomes \"a sweep of this tree passed\" rather than \"this run swept it\". "
    f"(2) *Skip push-to-main CI on the release commit.* It re-runs the release PR's tree, which is identical when up to date: saves {statistics.median(rel_push_ci):.0f} runner-s per release (measured on the 4 current-shape release commits: {', '.join(f'{v:.0f}' for v in rel_push_ci)}; `quality` {med(C,'CI','push','quality'):.0f} s and `cross` {med(C,'CI','push','cross (windows-latest)'):.0f} s of it, medians) and 13 CD jobs. It is off the critical path, so no wall clock is saved. "
    f"(3) *Build each Linux/Windows target once, as `darwin` already does,* and derive the archive, wheel and npm package from one binary. That saves ≈{sum(step(C,'Release',j,s) for j,s in [('upload (x86_64-pc-windows-msvc)','Build, archive, checksum, and upload'),('build-npm (x86_64-pc-windows-msvc)','Build the platform binary'),('upload (x86_64-unknown-linux-gnu)','Build, archive, checksum, and upload'),('build-npm (x86_64-unknown-linux-gnu)','Build the platform binary'),('upload (aarch64-unknown-linux-gnu)','Build, archive, checksum, and upload'),('build-npm (aarch64-unknown-linux-gnu)','Build the platform binary')]):.0f} runner-s per release (the two compiles per target beyond the wheel's) and 6 jobs. The archives' and npm packages' Linux binaries would then be the manylinux-built ones: different bytes and a different glibc floor, which **changes published artifacts**. Wall clock barely moves, since the longest build (Windows ≈{med(C,'Release','release','build-npm (x86_64-pc-windows-msvc)'):.0f} s) remains. "
    f"(4) *Split `upload` into build and attach, and let builds start without `needs: test`.* No artifact changes, but assets are attached only after `test`, as today. Saves up to {ht['median']:.0f} s of CD wall clock. "
    f"(5) *Batch fewer releases* (release-model): each release's CD costs {crep_rel['cd_runner_s']['median']:.0f} runner-s ({rep_rel['cd_runner_s']['median']:.0f} window) and {C['per_release_cd']['job_count']['median']:.0f} jobs, and there were 54 releases in 31 days. That is a product decision, not a CI one.")

findings.append(
    "**Required-check plan.** Snapshot: `spike/onepipeline-ui-ci/required-status-checks.json` (taken " + json.loads((HERE / 'required-status-checks.json').read_text())['taken_at'] + ", `strict: false`, 9 contexts). Every context maps to a job of `ci.yml`, and a `verdict` job must `needs:` each of these with `if: always()`, then rule on the results:\n"
    "- `gate` → job `gate` (ci.yml:463). It aggregates `changes`, `quality`, `wheel` and `browser-windows` through `scripts/gate-verdict.sh`, so `verdict` can need `gate` or absorb those four.\n"
    "- `deny` → `deny` (ci.yml:352).\n"
    "- `pr-title` → `pr-title` (ci.yml:481).\n"
    "- `llmlint` → `llmlint` (ci.yml:495).\n"
    "- `msrv` → `msrv` (ci.yml:321).\n"
    "- `cross (windows-latest)` → `cross`'s windows-latest leg (ci.yml:175–208).\n"
    "- `install (ubuntu-latest)` and `install (windows-latest)` → `install`'s two legs (ci.yml:375–404).\n"
    "- `visual-docs / report (x86_64, shots/current, shots/verify, Visual docs)` → today `visual-docs.yml`'s job `visual-docs` (visual-docs.yml:44); after the move, a `ci.yml` job `visual-docs`.\n"
    "`verdict` must accept `skipped` exactly where protection does today:\n"
    "- `deny`, `msrv`, `cross` and `install` skip when `changes.outputs.crate == 'false'` (ci.yml:177, 323, 354, 377);\n"
    "- `pr-title` and `llmlint` skip on push (ci.yml:482, 496);\n"
    "- `gate`'s own `--may-skip wheel` rule holds.\n"
    "`cross (macos-latest)` and `install (macos-latest)` are not required and need not be in it.")

findings.append(
    "**Moving the visual-docs PR run into `ci.yml` reproduces the required context byte for byte, if the caller job is id `visual-docs` with no `name:` and passes none of `gallery-title`, `projects` or `arches`.** The evidence:\n"
    "- **Observed names.** Today's job records name the check `visual-docs / report (x86_64, shots/current, shots/verify, Visual docs)`, the exact required context (this spike's raw jobs, e.g. run 38696669809). It is the caller's job id `visual-docs` (visual-docs.yml:44, no `name:`), then ` / `, then the called job's name.\n"
    "- **The called job's name comes only from its matrix.** `report` (screencomp `visual-docs-reusable.yml@v0.4.8` :387) has no `name:`, so GitHub names it `report (<matrix values>)`. Those values come from the `arches` job (:246–317): `arch` from `screencomp.toml`, `current`/`verify` defaulting to `shots/current`/`shots/verify`, the empty `project`/`manifest` omitted, and `gallery_title` from the input `gallery-title`, whose default is `Visual docs` (:112–114). That default is fixed and independent of the calling workflow's `name:`, so calling it from the workflow named `CI` does not change it. The reusable workflow never reads `github.workflow`, which becomes the caller's name in a called workflow (docs: *Reusing workflow configurations*).\n"
    "- **Permissions.** A job-level `uses:` may set `permissions:` (docs: *Supported keywords for jobs that call a reusable workflow*), and \"The `GITHUB_TOKEN` permissions passed from the caller workflow can be only downgraded (not elevated) by the called workflow\" (same section). `ci.yml`'s top level is `contents: read` (ci.yml:13–14), so the job must declare `contents: write`, `pull-requests: write` and `pages: read` (visual-docs.yml:38–41).\n"
    "- **Concurrency.** The called workflow's own group is `visual-docs-${{ github.ref }}` (:213–215), distinct from ci.yml's `ci-${{ github.ref }}`. The docs warn against sharing a group value between caller and called workflow.\n"
    "**What `visual-docs.yml` keeps once the PR run moves:**\n"
    "- `push: main`, which deploys the canonical gallery;\n"
    "- `workflow_dispatch`;\n"
    "- `schedule`, because `prune-history` runs only on schedule (:546–548);\n"
    "- `pull_request: types: [closed]` alone, because `cleanup-preview` runs only on `closed` (:521–523).\n"
    f"On `closed`, `arches` and `capture` skip (:248, :324). This spike's data shows it: {closed_n} closed-PR runs executed `pages-preflight` and `cleanup-preview` only, apart from {closed_cap} that coincided with a push. The PR types it drops (opened, synchronize, reopened) are exactly ci.yml's (ci.yml:10), so the context reports on the same events as today.")

findings.append(
    "**Token permissions for a CD-tail measurement job** (documentation-based; not exercised, since no workflow could be changed). Reading runs, jobs and pull requests needs **`actions: read`** (`GET /repos/{o}/{r}/actions/runs`, `…/runs/{id}`, `…/runs/{id}/jobs`) and **`pull-requests: read`** (`GET /repos/{o}/{r}/pulls`) (docs: *Permissions required for GitHub Apps*, the Actions and Pull requests tables). Add `contents: read` for tags and commits. Both workflows that would host the job set `permissions: {}` at the top: release.yml:97 and published-smoke.yml:83. \"If you specify the access for any of these permissions, all of those that are not specified are set to `none`\" (docs: *Workflow syntax → permissions*), so the job must declare all three at job level.\n"
    "- *`release`-triggered* (release.yml): `GITHUB_SHA` is the tagged commit and `GITHUB_REF` the tag (docs: *Events that trigger workflows → release*). The job can read its own run's sibling jobs and the push runs on that commit. It cannot see Published smoke, which starts only after the Release run completes, so the CD job time and count it reports would be incomplete.\n"
    "- *`workflow_run`-triggered* (published-smoke.yml): it \"is able to access secrets and write tokens, even if the previous workflow was not\" (docs: *Events that trigger workflows → workflow_run*). `GITHUB_SHA`/`GITHUB_REF` are the default branch's, so the release must be found through `github.event.workflow_run` (its id and `head_sha`), not through `GITHUB_SHA`. This is the only host that sees the whole CD tail; it should `needs:` the smoke jobs so its own run is complete when it reads.\n"
    "Per release, the reads are ≈1 runs-list call for the commit, 5–6 jobs calls, and 1–2 PR-list calls: ~10 requests, against GITHUB_TOKEN's primary limit of 1,000 requests per hour per repository (docs: *Rate limits for the REST API → Primary rate limit for GITHUB_TOKEN*).")

findings.append(
    "**Other design facts the finalize needs.** "
    f"(a) Releases do not complete green. {rel_conc.get('failure', 0)} of {sum(rel_conc.values())} Release runs concluded `failure`. Since #315, `verify-npm (ubuntu-latest)` failed {job(C,'Release','release','verify-npm (ubuntu-latest)')['failed']} of {sum(v for k, v in job(C,'Release','release','verify-npm (ubuntu-latest)')['conclusions'].items() if k != 'skipped')} runs and `release-status` {job(C,'Release','release','release-status')['failed']} of {sum(job(C,'Release','release','release-status')['conclusions'].values())}, which demotes every Release; a follow-up is drafted. Cycle time therefore measures *to the last CD job's completion*, not to a successful publish. "
    f"(b) Mac capacity dominates the CD tail. `darwin` queued {d(job(C,'Release','release','darwin')['queue_wait_s'])}, against `test`'s {hd['median']:.0f} s hold, and the window's CD wall clock reached {F['per_release_cd']['cd_wall_s']['max']:.0f} s (v0.30.1, 13.3 h). In v0.30.0, v0.30.1 and v0.31.1 the last CD jobs were the Mac legs of Published smoke, which started 9–13 h after the release commit and ran for seconds. "
    f"(c) CI `macos` was cancelled {mac_conc.get('cancelled', 0)} of the {sum(v for k, v in mac_conc.items() if k != 'skipped')} current-shape PR runs where it was not skipped, and its reporters `cross (macos-latest)` and `install (macos-latest)` then fail ({job(C,'CI','pull_request','cross (macos-latest)')['failed']} and {job(C,'CI','pull_request','install (macos-latest)')['failed']}). That reddens ordinary PR CI runs without any required context failing. "
    f"(d) The current-shape sample is thin: 4 releases and 6 head commits. Thresholds set from it alone would be fitted to two days.")

cand = []
ci_c, ci_w = C["per_pr_head_commit"]["ci_longest_job_s"], F["per_pr_head_commit"]["ci_longest_job_s"]
kinds_w = F["per_pr_head_commit"]["ci_longest_job_s_by_kind"]
consumed = f"{rest_n} REST GETs in total for the whole spike (lowest quota before a request: {min_q}; 1 refused at the floor and retried after the reset), {len(LOGS)} of them job logs; {local_wall_h:.1f} h of local wall clock for the profile runs"
cand.append({
    "budget": "onepipeline-ui-ci-check-time",
    "measure": "Seconds of the longest executed job (any conclusion) of one PR head commit's latest `ci.yml` run. `figures.json` `per_pr_head_commit.ci_longest_job_s`.",
    "workload": f"Every PR head commit in the window: n={ci_w['n']} runs ({kinds_w['ordinary PR']['n']} ordinary, {kinds_w['release PR']['n']} release PRs); current shape n={ci_c['n']}.",
    "achievable": f"Today: window {d(ci_w)}; ordinary PRs {d(kinds_w['ordinary PR'])}, longest job `cross (windows-latest)` in {xw_longest} of {ordinary_n}; release PRs {d(kinds_w['release PR'])}; current shape {d(ci_c)} ({'; '.join(f'{v}× {k}' for k, v in C['per_pr_head_commit']['ci_longest_job_by_name'].items())}). Achievable (PROJECTION from the job table: cached sibling CLI): ordinary PR ≈{max(proj['CI quality'][1], proj['CI cross (windows-latest)'][1], proj['CI install (windows-latest)'][1])} s (`quality`), release PR ≈{proj['CI sweep'][1]} s median / {sweep_max - sw_boot_max + q_boot_proj:.0f} s at the slowest measured sweep.",
    "limits": f"Target 1,800 s/job. Ordinary PRs clear it with ~{1800 - max(proj['CI quality'][1], proj['CI cross (windows-latest)'][1]):.0f} s headroom (projection). The release PR's `sweep` sits at the limit, with `onepipeline-ui-repo-tooling:test`'s critical path ({', '.join(f'{v:.0f}' for v in cp(logs('sweep'),'onepipeline-ui-repo-tooling:test'))} s) inside it.",
    "consumed": consumed,
})
cd_c, cd_w = C["per_release_cd"]["longest_job_s"], F["per_release_cd"]["longest_job_s"]
cand.append({
    "budget": "onepipeline-ui-cd-job-time",
    "measure": "Seconds of the longest executed job across one release's CD runs (push runs on the tag commit, the Release run, the Published smoke follow-up). `per_release_cd.longest_job_s`.",
    "workload": f"All 54 releases in the window (v0.8.0–v0.36.1); current shape 4 (v0.34.1–v0.36.1).",
    "achievable": f"Today: window {d(cd_w)}; current {d(cd_c)}, always Release `test`. Achievable (PROJECTION): Release `test` ≈{proj['Release test'][1]} s with the sibling CLI cached; if the re-sweep is dropped for already-swept trees (release-model decision), the longest becomes the Windows builds at ≈{max(med(C,'Release','release','build-npm (x86_64-pc-windows-msvc)'), med(C,'Release','release','upload (x86_64-pc-windows-msvc)'), proj['CI push cross (windows-latest)'][1]):.0f} s (measured medians of the Windows builds; push `cross` at its projected figure).",
    "limits": "Target 1,800 s/job: reachable without sharding either way (projection). The CD *wall clock* is a different quantity: measured current median 6,041 s, set by `test`'s hold plus Mac queueing, not by any one job.",
    "consumed": consumed,
})
rc_c, rc_w = C["cycle_time"]["per_release_max_total_s"], F["cycle_time"]["per_release_max_total_s"]
checks_c = C["cycle_time"]["checks_phase_s"]["median"]
m2c_c = C["cycle_time"]["merge_to_release_commit_s"]["median"]
cdw_c = C["per_release_cd"]["cd_wall_s"]["median"]
checks_p = max(proj['CI quality'][1], proj['CI cross (windows-latest)'][1], proj['CI install (windows-latest)'][1]) + med(C, 'CI', 'pull_request', 'changes')

def v0361_timeline():
    """The v0.36.1 CD timeline, rebuilt as if builds and darwin did not wait for `test`.

    Measured from run 38706388926 (Release) and 38714430690 (Published smoke):
    each build's queue after `test` ended plus its own duration; darwin likewise
    (its queue there is Mac capacity); then the measured span from the last
    build's end to release-status's end, and the smoke run's span.
    """
    import measure as m
    raw = HERE / "raw"
    jobs = m.load_jobs(raw)
    rel = {j["name"]: j for j in jobs[38706388926]}
    test_end = m.ts(rel["test"]["completed_at"])
    start = m.ts(rel["test"]["started_at"])
    builds = [n for n in rel if n.startswith(("upload (", "build-wheels (", "build-npm (")) or n == "darwin"]
    ready = {n: (m.ts(rel[n]["started_at"]) - test_end).total_seconds() + m.job_dur(rel[n]) for n in builds}
    last_build_end = max(m.ts(rel[n]["completed_at"]) for n in builds)
    tail = (m.ts(rel["release-status"]["completed_at"]) - last_build_end).total_seconds()
    smoke = jobs[38714430690]
    smoke_span = (max(m.ts(j["completed_at"]) for j in smoke) - m.ts(rel["release-status"]["completed_at"])).total_seconds()
    runs = m.load_runs(raw)
    first = min(m.ts(runs[rid]["created_at"]) for rid in (38706314578, 38706314579, 38706314891, 38706388926))
    offset = (start - first).total_seconds()
    return ready, tail, smoke_span, offset


ready, cd_tail, smoke_span, cd_offset = v0361_timeline()
cd_p = round(cd_offset + max(proj['Release test'][1], max(ready.values())) + cd_tail + smoke_span)
cd_p_basis = (f"{cd_offset:.0f} s from the release commit's first CD run to `test` starting + max(projected `test` {proj['Release test'][1]} s, slowest build-or-darwin queue+duration {max(ready.values()):.0f} s "
              f"[{max(ready, key=ready.get)}]) + last build→release-status {cd_tail:.0f} s + smoke {smoke_span:.0f} s, all measured on v0.36.1")
cand.append({
    "budget": "onepipeline-ui-release-cycle-time",
    "measure": "Per release: the maximum, over the non-release PRs it carries, of (PR checks phase + merge→last CD job completed for the first release containing the merge). `cycle_time.per_release_max_total_s`.",
    "workload": f"{F['cycle_time']['eligible_prs']} merged PRs carried by 54 releases (window); current shape {C['cycle_time']['eligible_prs']} PRs in 3 releases. 1 PR merged after v0.36.1 had no release yet (ineligible).",
    "achievable": f"Today: window {d(rc_w)}; current {d(rc_c)}. Components (current medians): checks {checks_c:.0f} s, merge→release commit {m2c_c:.0f} s (release PR cut, swept, auto-merged), CD wall {cdw_c:.0f} s. Achievable (PROJECTION): checks ≈{checks_p:.0f} s (longest projected PR job + `changes`, edges removed); merge→release commit ≈{m2c_c - (sweep - proj['CI sweep'][1]):.0f} s (sweep −{sweep - proj['CI sweep'][1]:.0f} s); CD ≈{cd_p:.0f} s ({cd_p_basis}). So a release whose PRs merged just before its release PR would be ≈{checks_p + m2c_c - (sweep - proj['CI sweep'][1]) + cd_p:.0f} s. PRs merged while an earlier release was in flight add that release's whole path, which no CI cut removes.",
    "limits": "Bounded below by two full `check`s in series (sweep, then Release `test`) unless the re-sweep is dropped, and by Mac queueing on the account-wide limit (measured up to 7,524 s for `darwin`).",
    "consumed": consumed,
})
jc_c, jc_w = C["per_pr_head_commit"]["jobs_executed"], F["per_pr_head_commit"]["jobs_executed"]
cand.append({
    "budget": "onepipeline-ui-ci-job-count",
    "measure": "Executed jobs (matrix legs counted, skipped and never-started excluded) across one PR head commit's latest CI, Visual docs and notignored runs. `per_pr_head_commit.jobs_executed`.",
    "workload": f"{jc_w['n']} PR head commits in the window; current shape {jc_c['n']}.",
    "achievable": f"Today: window {dj(jc_w)}; current {dj(jc_c)}; by OS in the window: linux {F['per_pr_head_commit']['by_runner_os']['linux']['median']:.0f}, arm64 1, windows {F['per_pr_head_commit']['by_runner_os']['windows']['median']:.0f}, macos {F['per_pr_head_commit']['by_runner_os']['macos']['median']:.0f} (medians). Achievable (PROJECTION, arithmetic): +1 for `verdict`. Moving visual docs into ci.yml moves its 5 jobs without changing the count. −2 if the unrequired `cross (macos-latest)`/`install (macos-latest)` reporters fold into `verdict`. So ≈ current {jc_c['median']:.0f} −1 = {jc_c['median']-1:.0f}.",
    "limits": "Every executed job takes a slot of the account-wide concurrent-job limit the other repositories share, which is why job count is budgeted separately from time.",
    "consumed": consumed,
})
cc_c, cc_w = C["per_release_cd"]["job_count"], F["per_release_cd"]["job_count"]
cand.append({
    "budget": "onepipeline-ui-cd-job-count",
    "measure": "Executed jobs across one release's CD runs (definition above). `per_release_cd.job_count`.",
    "workload": "54 releases (window); 4 (current shape).",
    "achievable": f"Today: window {dj(cc_w)}; current {dj(cc_c)}: CI push {C['per_release_cd']['job_count_by_workflow']['CI (push)']['median']:.0f}, Release {C['per_release_cd']['job_count_by_workflow']['Release (release)']['median']:.0f}, Published smoke {C['per_release_cd']['job_count_by_workflow']['Published smoke (workflow_run)']['median']:.1f}, Release-plz 2, Visual docs push {C['per_release_cd']['job_count_by_workflow']['Visual docs (push)']['median']:.1f} (medians). Achievable (PROJECTION, arithmetic; both are release-model or artifact decisions): −13 skipping push CI on the release commit, −6 building each Linux/Windows target once, so ≈{num(cc_c['median']-19)} jobs (from the current median {num(cc_c['median'])}).",
    "limits": "Same shared concurrent-job limit; Mac jobs are additionally bounded by the existing macOS budgets (1 per run), which hold today (1 Mac job per release in the current shape).",
    "consumed": consumed,
})
cand.append({
    "budget": "onepipeline-ui-gate-time",
    "measure": "`just gate`'s wall clock on this host = local `just check` wall clock + the judge tier's wall clock **as measured in CI** (`llmlint` job; the judge was not run locally, by manager ruling).",
    "workload": f"The tree of ecb96f6 (this branch adds only `spike/`, which an untracked `.nxignore` kept out of Nx's hashing for the profile); this host, Linux aarch64 14 cores, at load average 27–55 from other repositories' gates.",
    "achievable": f"Today (cold, no Nx cache): {cold_total:.0f} s `check` (one invocation of {cold['wall_seconds']:.0f} s that stopped at `test`, plus the three tiers it did not reach) + judge {llm['median']:.0f} s (CI median; p90 {llm['p90']:.0f}) ≈ {cold_total + llm['median']:.0f} s. Warm (Nx cache restored): {warm['wall_seconds']:.1f} s + {llm['median']:.0f} s ≈ {warm['wall_seconds'] + llm['median']:.0f} s. Uncontended reference: CI's full `check` step {sw_check:.0f}–{rt_check:.0f} s + judge ≈ {sw_check + llm['median']:.0f}–{rt_check + llm['median']:.0f} s.",
    "limits": "Dominated by host contention, which no change in this repository controls. A threshold set on this host's cold figure would measure the host rather than the gate.",
    "consumed": f"{local_wall_h:.1f} h of local wall clock across the {len(L)} profile runs in local/ (cold check {cold['wall_seconds']:.0f} s, three cold tiers {sum(t['wall_seconds'] for t in tiers_cold.values()):.0f} s, warm runs, check-affected runs); no REST requests; no judge calls",
})

# A finding is one Markdown list item: continuation lines are indented under it.
findings = [f.replace("\n", "\n  ") for f in findings]

answers = {
    "spike": "spike-onepipeline-ui-ci",
    "branch": BRANCH,
    "harness": harness,
    "method": method,
    "candidates": cand,
    "findings": findings,
    "visual_changes": [],
}
json.dump(answers, sys.stdout, indent=1)
