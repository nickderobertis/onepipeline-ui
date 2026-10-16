#!/usr/bin/env python3
"""Measure where a repository's GitHub Actions CI and CD time goes.

One command, two halves:

    python3 -I spike/onepipeline-ui-ci/measure.py \
        --repo nickderobertis/onepipeline-ui --since 2026-09-15 \
        --raw spike/onepipeline-ui-ci/raw --out spike/onepipeline-ui-ci/figures.json

fetches (read-only, through `gh`, every request logged with the quota remaining
before it — see ghread.py) whatever of the run, job and pull-request records it
does not already hold under --raw, then computes the per-job, per-run and per-PR
cycle-time figures from those files alone and writes them as one JSON document.
`--offline` skips the fetch and computes from --raw as it stands, which is how the
committed sample under raw/ reproduces the report's figures for its run and PR.

Raw files are the GitHub responses verbatim. The one input that is not a REST
response is raw/git-tags.json: which release tag first contains each merge commit,
read from the local clone's history (a git read, not an API request).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import statistics
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ghread import QuotaStop, Reader  # noqa: E402

WORKFLOWS = {"CI", "Release-plz", "Release", "Published smoke", "Visual docs", "notignored"}
PR_EVENTS = {"pull_request"}


# --------------------------------------------------------------------------- time


def ts(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def secs(a: str | None, b: str | None) -> float | None:
    start, end = ts(a), ts(b)
    if start is None or end is None:
        return None
    return (end - start).total_seconds()


def dist(values: list[float]) -> dict | None:
    """Median, p90 (nearest-rank) and max of a sample."""
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    rank = max(1, -(-len(vals) * 90 // 100))  # ceil(0.9 n)
    return {
        "n": len(vals),
        "median": round(statistics.median(vals), 1),
        "p90": round(vals[rank - 1], 1),
        "max": round(vals[-1], 1),
    }


def runner_os(job: dict) -> str:
    labels = " ".join(job.get("labels") or []).lower()
    name = (job.get("runner_name") or "").lower()
    if "windows" in labels or "windows" in name:
        return "windows"
    if "macos" in labels or "mac" in name:
        return "macos"
    if not labels and not name:
        return "unknown"
    return "linux-arm64" if "arm" in labels else "linux"


# -------------------------------------------------------------------------- fetch


def save(path: Path, body: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, indent=1, sort_keys=True) + "\n")


def windows(since: dt.date, until: dt.date, days: int):
    start = since
    while start <= until:
        end = min(until, start + dt.timedelta(days=days - 1))
        yield start, end
        start = end + dt.timedelta(days=1)


def fetch_runs(reader: Reader, repo: str, since: dt.date, until: dt.date, raw: Path) -> None:
    # The runs list returns at most 1,000 results for one filtered query, so the
    # window is walked in 3-day slices, each well under that.
    for start, end in windows(since, until, 3):
        page = 1
        while True:
            dest = raw / "runs" / f"{start}_{end}-p{page}.json"
            if dest.exists():
                body = json.loads(dest.read_text())
            else:
                body = reader.get(
                    f"repos/{repo}/actions/runs?created={start}..{end}&per_page=100&page={page}"
                )
                save(dest, body)
            if body["total_count"] > 1000:
                raise SystemExit(f"window {start}..{end} holds {body['total_count']} runs; narrow it")
            if page * 100 >= body["total_count"]:
                break
            page += 1


def fetch_pulls(reader: Reader, repo: str, since: dt.date, raw: Path) -> None:
    page = 1
    while True:
        dest = raw / "pulls" / f"closed-p{page}.json"
        if dest.exists():
            body = json.loads(dest.read_text())
        else:
            body = reader.get(
                f"repos/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page={page}"
            )
            save(dest, body)
        if len(body) < 100 or min(ts(p["updated_at"]).date() for p in body) < since:
            break
        page += 1


def fetch_jobs(reader: Reader, repo: str, run: dict, raw: Path) -> bool:
    page = 1
    while True:
        dest = raw / "jobs" / f"{run['id']}-a{run['run_attempt']}-p{page}.json"
        if dest.exists():
            body = json.loads(dest.read_text())
        else:
            body = reader.get(
                f"repos/{repo}/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100&page={page}"
            )
            save(dest, body)
        if page * 100 >= body["total_count"]:
            return True
        page += 1


def write_tag_containment(raw: Path, pulls: list[dict], git_dir: Path) -> None:
    """For each merge commit, the first version tag whose history contains it."""

    def git(*args: str) -> str:
        return subprocess.run(["git", "-C", str(git_dir), *args], check=True, capture_output=True, text=True).stdout

    tags = [t for t in git("for-each-ref", "refs/tags", "--format=%(refname:short) %(objectname) %(*objectname)").split("\n") if t]
    tag_sha = {}
    for line in tags:
        parts = line.split()
        name, sha = parts[0], parts[-1]
        if re.fullmatch(r"v\d+\.\d+\.\d+", name):
            tag_sha[name] = sha
    ordered = sorted(tag_sha, key=lambda t: tuple(int(x) for x in t[1:].split(".")))
    first_tag: dict[str, str | None] = {}
    for pr in pulls:
        sha = pr.get("merge_commit_sha")
        if not pr.get("merged_at") or not sha:
            continue
        found = None
        for tag in ordered:
            ok = subprocess.run(["git", "-C", str(git_dir), "merge-base", "--is-ancestor", sha, tag_sha[tag]], capture_output=True)
            if ok.returncode == 0:
                found = tag
                break
        first_tag[sha] = found
    save(raw / "git-tags.json", {"tag_commit": tag_sha, "first_tag_containing": first_tag})


# ----------------------------------------------------------------------- loading


def load_runs(raw: Path) -> dict[int, dict]:
    runs: dict[int, dict] = {}
    for f in sorted((raw / "runs").glob("*.json")):
        for run in json.loads(f.read_text())["workflow_runs"]:
            runs[run["id"]] = run
    return runs


def load_pulls(raw: Path) -> dict[int, dict]:
    pulls: dict[int, dict] = {}
    for f in sorted((raw / "pulls").glob("*.json")):
        for pr in json.loads(f.read_text()):
            pulls[pr["number"]] = pr
    return pulls


def load_jobs(raw: Path) -> dict[int, list[dict]]:
    jobs: dict[int, list[dict]] = defaultdict(list)
    for f in sorted((raw / "jobs").glob("*.json")):
        run_id = int(f.name.split("-")[0])
        jobs[run_id].extend(json.loads(f.read_text())["jobs"])
    return jobs


# ---------------------------------------------------------------------- grouping


def release_commit_runs(runs: dict[int, dict], tag: str, tag_sha: str) -> list[dict]:
    """Every run one release's CD consists of.

    The release-PR merge's push to main (CI, Release-plz, Visual docs on the tag's
    commit), the `release` event's run for the tag, and the `workflow_run`
    follow-ups (Published smoke) that release run started — the first one created
    after it completed.
    """
    chosen = [
        r for r in runs.values()
        if r["event"] == "push" and r["head_sha"] == tag_sha and r["name"] in WORKFLOWS
    ]
    rel = [r for r in runs.values() if r["name"] == "Release" and r["event"] == "release" and r["head_branch"] == tag]
    chosen += rel
    for release_run in rel:
        done = ts(release_run["updated_at"])
        follow = sorted(
            (r for r in runs.values()
             if r["name"] == "Published smoke" and r["event"] == "workflow_run"
             and ts(r["created_at"]) >= done - dt.timedelta(minutes=2)
             and ts(r["created_at"]) <= done + dt.timedelta(minutes=30)),
            key=lambda r: r["created_at"],
        )
        chosen += follow[:1]
    return chosen


def pr_head_runs(runs: dict[int, dict], pr: dict) -> list[dict]:
    """The pull_request-event runs on a PR's final head commit, before its merge.

    Visual docs also runs on `closed`, on the same head commit, at the merge; that
    run is not part of the checks phase, so runs created after `merged_at` drop.
    """
    merged = ts(pr["merged_at"]) if pr.get("merged_at") else None
    out = [
        r for r in runs.values()
        if r["event"] in PR_EVENTS and r["head_sha"] == pr["head"]["sha"] and r["name"] in WORKFLOWS
        and (merged is None or ts(r["created_at"]) < merged)
    ]
    return out


def latest_per_workflow(rs: list[dict]) -> list[dict]:
    best: dict[str, dict] = {}
    for r in rs:
        if r["name"] not in best or r["id"] > best[r["name"]]["id"]:
            best[r["name"]] = r
    return list(best.values())


def executed(jobs: list[dict]) -> list[dict]:
    """Jobs that occupied a runner: not skipped, and handed to a runner at all.

    A job cancelled before any runner picked it up (a superseded run's queued
    jobs) carries a conclusion and timestamps but no `runner_name`, and is no
    more an executed job than a skipped one.
    """
    return [
        j for j in jobs
        if j.get("conclusion") not in (None, "skipped") and j.get("started_at") and j.get("runner_name")
    ]


def job_dur(j: dict) -> float | None:
    return secs(j.get("started_at"), j.get("completed_at"))


# ---------------------------------------------------------------------- analysis


def analyse(raw: Path, since: dt.date, shape_since: dt.datetime | None = None) -> dict:
    """The figures over every run in the window, or — with `shape_since` — over the
    runs created at or after it (and the PRs merged after it), which is how the
    workflows' current shape is read apart from the shapes they had earlier."""
    runs = {k: v for k, v in load_runs(raw).items() if v["name"] in WORKFLOWS}
    if shape_since is not None:
        runs = {k: v for k, v in runs.items() if ts(v["created_at"]) >= shape_since}
    pulls = load_pulls(raw)
    if shape_since is not None:
        pulls = {k: v for k, v in pulls.items() if v.get("merged_at") and ts(v["merged_at"]) >= shape_since}
    jobs = load_jobs(raw)
    tags = json.loads((raw / "git-tags.json").read_text()) if (raw / "git-tags.json").exists() else {"tag_commit": {}, "first_tag_containing": {}}

    # --- per job ---------------------------------------------------------------
    per_job: dict[tuple, dict] = defaultdict(lambda: {"durations": [], "queue": [], "conclusions": defaultdict(int), "os": set()})
    per_step: dict[tuple, list[float]] = defaultdict(list)
    for run_id, js in jobs.items():
        run = runs.get(run_id)
        if run is None:
            continue
        # A re-run attempt's jobs queue from when that attempt started, not from
        # the first attempt's creation.
        origin = run["created_at"] if run.get("run_attempt", 1) == 1 else run.get("run_started_at")
        for j in js:
            key = (run["name"], run["event"], j["name"])
            rec = per_job[key]
            rec["conclusions"][j.get("conclusion") or "none"] += 1
            if j.get("conclusion") == "success":
                rec["durations"].append(job_dur(j))
                rec["queue"].append(secs(origin, j.get("started_at")))
                rec["os"].add(runner_os(j))
                for step in j.get("steps") or []:
                    if step.get("conclusion") == "success":
                        d = secs(step.get("started_at"), step.get("completed_at"))
                        if d is not None:
                            per_step[(run["name"], j["name"], step["name"])].append(d)
    job_table = []
    for (wf, event, name), rec in sorted(per_job.items()):
        job_table.append({
            "workflow": wf, "event": event, "job": name,
            "runner_os": sorted(rec["os"]),
            "duration_s": dist(rec["durations"]),
            "queue_wait_s": dist(rec["queue"]),
            "conclusions": dict(rec["conclusions"]),
            "failed": rec["conclusions"].get("failure", 0),
            "cancelled": rec["conclusions"].get("cancelled", 0),
        })
    step_table = [
        {"workflow": wf, "job": jn, "step": sn, "duration_s": dist(v)}
        for (wf, jn, sn), v in sorted(per_step.items())
        if (dist(v) or {}).get("median", 0) >= 30
    ]

    # --- per PR head commit ---------------------------------------------------
    pr_runs_all = [r for r in runs.values() if r["event"] in PR_EVENTS]
    by_head: dict[str, list[dict]] = defaultdict(list)
    for r in pr_runs_all:
        by_head[r["head_sha"]].append(r)
    head_counts, head_by_wf, head_by_os, ci_longest = [], defaultdict(list), defaultdict(list), []
    ci_longest_detail = []
    for sha, rs in by_head.items():
        latest = latest_per_workflow(rs)
        if not all(r["id"] in jobs for r in latest):
            continue
        if any(r["conclusion"] == "cancelled" for r in latest if r["name"] == "CI"):
            continue
        ex = [j for r in latest for j in executed(jobs[r["id"]])]
        head_counts.append(len(ex))
        wf_c, os_c = defaultdict(int), defaultdict(int)
        for r in latest:
            for j in executed(jobs[r["id"]]):
                wf_c[r["name"]] += 1
                os_c[runner_os(j)] += 1
        for k in ("CI", "Visual docs", "notignored"):
            head_by_wf[k].append(wf_c.get(k, 0))
        for k in ("linux", "linux-arm64", "windows", "macos"):
            head_by_os[k].append(os_c.get(k, 0))
        ci = [r for r in latest if r["name"] == "CI" and r["conclusion"] == "success"]
        for r in ci:
            ex_ci = executed(jobs[r["id"]])
            longest = max(ex_ci, key=lambda j: job_dur(j) or 0)
            ci_longest.append(job_dur(longest))
            ci_longest_detail.append({"run_id": r["id"], "head_sha": sha, "longest_job": longest["name"], "seconds": job_dur(longest), "jobs": len(ex_ci)})

    # --- per release CD -------------------------------------------------------
    releases = []
    for tag, sha in tags["tag_commit"].items():
        cd = release_commit_runs(runs, tag, sha)
        rel = [r for r in cd if r["name"] == "Release"]
        if not rel or ts(rel[0]["created_at"]).date() < since:
            continue
        complete = all(r["id"] in jobs for r in cd)
        ex = [(r, j) for r in cd if r["id"] in jobs for j in executed(jobs[r["id"]])]
        wf_c, os_c = defaultdict(int), defaultdict(int)
        for r, j in ex:
            wf_c[f"{r['name']} ({r['event']})"] += 1
            os_c[runner_os(j)] += 1
        longest = max(ex, key=lambda rj: job_dur(rj[1]) or 0) if ex else None
        last_done = max((ts(j["completed_at"]) for _, j in ex if j.get("completed_at")), default=None)
        first_created = min(ts(r["created_at"]) for r in cd)
        releases.append({
            "tag": tag, "commit": sha, "runs": sorted(r["id"] for r in cd),
            "run_workflows": sorted(f"{r['name']} ({r['event']}, {r['conclusion']})" for r in cd),
            "jobs_fetched_for_every_run": complete,
            "release_conclusion": rel[0]["conclusion"],
            "job_count": len(ex), "job_count_by_workflow": dict(wf_c), "job_count_by_os": dict(os_c),
            "longest_job": f"{longest[0]['name']} / {longest[1]['name']}" if longest else None,
            "longest_job_s": job_dur(longest[1]) if longest else None,
            "first_run_created": first_created.isoformat() if first_created else None,
            "last_job_completed": last_done.isoformat() if last_done else None,
            "cd_wall_s": (last_done - first_created).total_seconds() if last_done else None,
        })
    releases.sort(key=lambda r: tuple(int(x) for x in r["tag"][1:].split(".")))
    rel_by_tag = {r["tag"]: r for r in releases}

    # --- per PR cycle time -----------------------------------------------------
    cycles = []
    ineligible = defaultdict(int)
    for num, pr in sorted(pulls.items()):
        if not pr.get("merged_at") or ts(pr["merged_at"]).date() < since:
            continue
        if pr["head"]["ref"].startswith("release-plz-"):
            ineligible["release PR (its merge is the release itself)"] += 1
            continue
        hr = pr_head_runs(runs, pr)
        if not hr:
            ineligible["no head-commit runs in the run list"] += 1
            continue
        if not all(r["id"] in jobs for r in hr):
            ineligible["head-commit jobs not fetched (sampling)"] += 1
            continue
        first_created = min(ts(r["created_at"]) for r in hr)
        last_done = max((ts(j["completed_at"]) for r in hr for j in jobs[r["id"]] if j.get("completed_at")), default=None)
        tag = tags["first_tag_containing"].get(pr["merge_commit_sha"])
        rel = rel_by_tag.get(tag) if tag else None
        if rel is None or not rel["jobs_fetched_for_every_run"] or rel["last_job_completed"] is None:
            ineligible["no completed release containing the merge yet" if tag is None else "release CD not measured"] += 1
            continue
        checks = (last_done - first_created).total_seconds()
        m2r = (ts(rel["last_job_completed"]) - ts(pr["merged_at"])).total_seconds()
        cycles.append({
            "pr": num, "title": pr["title"], "head_sha": pr["head"]["sha"], "merged_at": pr["merged_at"],
            "merge_commit_sha": pr["merge_commit_sha"], "release": tag,
            "head_runs": sorted(r["id"] for r in hr),
            "checks_phase_s": checks, "merge_to_release_s": m2r, "total_s": checks + m2r,
        })
    release_cycle = defaultdict(list)
    for c in cycles:
        release_cycle[c["release"]].append(c["total_s"])
    release_cycle_max = {t: max(v) for t, v in release_cycle.items()}

    rel_measured = [r for r in releases if r["jobs_fetched_for_every_run"]]
    return {
        "schema": "onepipeline-ui-ci-spike/1",
        "since": str(since),
        "inputs": {
            "runs_in_window": len(runs),
            "runs_by_workflow_event": dict(sorted(_count(runs.values(), lambda r: f"{r['name']} / {r['event']}").items())),
            "runs_with_jobs_read": sum(1 for r in runs if r in jobs),
            "pulls_read": len(pulls),
        },
        "per_job": job_table,
        "per_step_over_30s_median": step_table,
        "per_pr_head_commit": {
            "heads_measured": len(head_counts),
            "jobs_executed": dist(head_counts),
            "by_workflow": {k: dist(v) for k, v in head_by_wf.items()},
            "by_runner_os": {k: dist(v) for k, v in head_by_os.items()},
            "ci_longest_job_s": dist(ci_longest),
            "ci_longest_job_detail": sorted(ci_longest_detail, key=lambda d: -d["seconds"])[:15],
        },
        "per_release_cd": {
            "releases": releases,
            "job_count": dist([r["job_count"] for r in rel_measured]),
            "longest_job_s": dist([r["longest_job_s"] for r in rel_measured if r["longest_job_s"]]),
            "cd_wall_s": dist([r["cd_wall_s"] for r in rel_measured if r["cd_wall_s"]]),
        },
        "cycle_time": {
            "eligible_prs": len(cycles),
            "ineligible": dict(ineligible),
            "checks_phase_s": dist([c["checks_phase_s"] for c in cycles]),
            "merge_to_release_s": dist([c["merge_to_release_s"] for c in cycles]),
            "total_s": dist([c["total_s"] for c in cycles]),
            "per_release_max_total_s": dist(list(release_cycle_max.values())),
            "per_release_max_detail": release_cycle_max,
            "prs": cycles,
        },
    }


def _count(items, key) -> dict:
    out: dict[str, int] = defaultdict(int)
    for i in items:
        out[key(i)] += 1
    return out


# ---------------------------------------------------------------------- selection


def select_job_reads(raw: Path, since: dt.date, budget: int) -> list[dict]:
    """Which runs' jobs to read, most valuable first, within `budget` runs.

    1. Every run of every release's CD in the window.
    2. The head-commit runs of merged PRs, newest merge first.
    3. The remaining CI pull_request and push runs, newest first, for the per-job
       distributions.
    4. Everything else, newest first.
    """
    runs = {k: v for k, v in load_runs(raw).items() if v["name"] in WORKFLOWS}
    pulls = load_pulls(raw)
    tags = json.loads((raw / "git-tags.json").read_text())
    order: list[dict] = []
    seen: set[int] = set()

    def add(rs):
        for r in rs:
            if r["id"] not in seen and r.get("status") == "completed":
                seen.add(r["id"])
                order.append(r)

    for tag, sha in sorted(tags["tag_commit"].items(), key=lambda kv: tuple(int(x) for x in kv[0][1:].split(".")), reverse=True):
        add(release_commit_runs(runs, tag, sha))
    merged = sorted((p for p in pulls.values() if p.get("merged_at") and ts(p["merged_at"]).date() >= since), key=lambda p: p["merged_at"], reverse=True)
    for pr in merged:
        add(pr_head_runs(runs, pr))
    rest = sorted(runs.values(), key=lambda r: r["created_at"], reverse=True)
    add([r for r in rest if r["name"] == "CI"])
    add(rest)
    return order[:budget]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--since", required=True, type=dt.date.fromisoformat)
    ap.add_argument("--until", type=dt.date.fromisoformat, default=None, help="last day of the window (default: the first fetch's day, recorded in raw/window.json)")
    ap.add_argument("--raw", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--git-dir", type=Path, default=Path(__file__).resolve().parents[2])
    ap.add_argument("--shape-since", type=lambda v: dt.datetime.fromisoformat(v.replace("Z", "+00:00")), default=None,
                    help="also compute every figure over runs created at or after this instant (the workflows' current shape)")
    ap.add_argument("--offline", action="store_true", help="compute from --raw alone; make no request")
    ap.add_argument("--job-run-budget", type=int, default=900, help="at most this many runs' jobs are read")
    ap.add_argument("--max-requests", type=int, default=3000)
    ap.add_argument("--floor", type=int, default=2500)
    args = ap.parse_args()

    raw: Path = args.raw
    raw.mkdir(parents=True, exist_ok=True)
    stop = None
    if not args.offline:
        window_file = raw / "window.json"
        if window_file.exists():
            until = dt.date.fromisoformat(json.loads(window_file.read_text())["until"])
        else:
            until = args.until or dt.datetime.now(dt.timezone.utc).date()
            save(window_file, {"since": str(args.since), "until": str(until)})
        reader = Reader(raw.parent / "request-log.jsonl", max_requests=args.max_requests, floor=args.floor)
        try:
            fetch_runs(reader, args.repo, args.since, until, raw)
            fetch_pulls(reader, args.repo, args.since, raw)
            write_tag_containment(raw, list(load_pulls(raw).values()), args.git_dir)
            for run in select_job_reads(raw, args.since, args.job_run_budget):
                fetch_jobs(reader, args.repo, run, raw)
        except QuotaStop as err:
            stop = str(err)
            print(f"stopped: {stop}", file=sys.stderr)
    figures = analyse(raw, args.since)
    if args.shape_since is not None:
        figures["current_shape"] = {"shape_since": args.shape_since.isoformat(), **analyse(raw, args.since, args.shape_since)}
    figures["fetch_stopped"] = stop
    figures["invocation"] = " ".join(["python3 -I spike/onepipeline-ui-ci/measure.py", *sys.argv[1:]])
    save(args.out, figures)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
