"""ci.yml's `budgets` job, driven at GitHub's boundary through the action it pins.

Each journey reads the job out of the workflow and runs what its `uses:` names with its `with:`
inputs: action.yml's own steps, the released driver and plugin archive, the published core wheel,
the real `gh` and the real `actions/upload-artifact` code. Only GitHub's API and artifact services,
the release host and the package index are doubled, by the harness the action ships at that same
tag. Scalars in seeded history and the job-count answers are synthetic or replayed, and say so.
What `test-linux` hands the job comes through the real thing too: each `budgets` target's own
command in a copy of this tree, then that job's own upload step.

`test_record_a_complete_job` saves `.telemetry/report-job.json`, which `report-job:budgets` reads.
"""
import ast
import hashlib
import importlib.util
import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import urllib.request
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TELEMETRY = HERE / '.telemetry'
ACTION = 'nickderobertis/onebudgetspec-github-action'
WORKFLOW = yaml.safe_load((ROOT / '.github/workflows/ci.yml').read_text())
JOB = WORKFLOW['jobs']['budgets']
OWN_BUDGET = 'onepipeline-ui-budget-report-command-seconds'
SECONDS = 'report-command-seconds'
REQUESTS = 'report-github-api-requests-per-run'
TARGETS = {('Linux', 'x86_64'): 'x86_64-unknown-linux-gnu', ('Linux', 'aarch64'): 'aarch64-unknown-linux-gnu',
           ('Darwin', 'arm64'): 'aarch64-apple-darwin'}

# The workload of the job's own budget: this repository's catalog, one rolling file, and one
# results artifact of a size real runs produced.
ROWS = 25
COMMITS = 20
SAVED_ARTIFACT_BYTES = (2619, 11350)
PROVISIONAL_REQUESTS = 20
TRANSFER_SERVICES = ('artifact-service', 'blob-storage', 'object-storage', 'release-host', 'package-index')

# The catalog fixture: what runs, and what cannot.
RUNNABLE = {'demo-bundle-bytes': 'bytes', 'demo-coverage-percent': 'percent', 'demo-host-reads': 'requests',
            'demo-walltime': 'seconds', 'demo-laptop-figure': 'count'}
UNAVAILABLE = ('demo-needs-cargo', 'demo-needs-telemetry')

# The production catalog as a pull request sees it.
NO_SAVED_RESULT = 'no saved result was found on this run'
CI_TIME = {'onepipeline-ui-ci-check-time': 981, 'onepipeline-ui-ci-job-count': 5}
RECORDED_JOBS = json.loads((HERE / 'fixtures/own-run/jobs.json').read_text())
SAVED = ('onepipeline-ui-macos-jobs-per-run', 'onepipeline-ui-macos-runs-per-change')
POOL = 'onepipeline-ui-pool-maintenance-seconds'
# Saved only when the affected tier selects their project, so here, as nothing selects it, none is.
READ_LATENCY = ('dag-ui-human-items-requests-per-minute', 'dag-ui-human-items-update-lag-seconds')
# Saved only by the release pull request's sweep, which reaches `test-large` through `check`.
LARGE_RUN = ('dag-ui-run-first-view-seconds', 'dag-ui-run-rest-arrived-seconds',
             'dag-ui-run-history-page-seconds', 'dag-ui-run-status-read-seconds')
# Its command runs in this job: nothing saves it, and a pull request's job measures the live listing.
HEADROOM = 'onepipeline-ui-cache-headroom'
# A push reads no saved results, so a row its merged run holds no figure for keeps its catalog reason.
PUSH_REASON = {
    **{budget: 'its command reads .github/.telemetry/macos-policy.json, which is not available in this job' for budget in SAVED},
    POOL: 'its command reads ../apps/dag-ui/dist/index.html, which is not available in this job',
    **{budget: 'its command reads apps/dag-ui-e2e/read-latency/telemetry/read-latency.json, which is not available in this job'
       for budget in READ_LATENCY},
    **{budget: 'its command reads apps/dag-ui-e2e/read-latency/telemetry/read-latency-large.json, which is not available in this job'
       for budget in LARGE_RUN},
}
OMITTED = {
    'onepipeline-ui-cd-job-time': 'actions-budget-figures.sh longest-job --stage cd',
    'onepipeline-ui-release-cycle-time': 'actions-budget-figures.sh release-cycle-time',
    'onepipeline-ui-cd-job-count': 'actions-budget-figures.sh job-count --stage cd',
    'onepipeline-ui-release-read-requests': 'actions-budget-figures.sh release-read-requests',
    'onepipeline-ui-pr-read-requests': 'actions-budget-figures.sh pr-read-requests',
    'onepipeline-ui-nx-cache-use': 'actions-budget-figures.sh cache-use',
    'onepipeline-ui-gate-time': 'gate-time-budget.mjs',
    'dag-ui-settled-requests-per-minute': 'request-load-budget.mjs',
    'dag-ui-live-requests-per-minute': 'request-load-budget.mjs',
    'dag-ui-live-update-lag-seconds': 'request-load-budget.mjs',
    'dag-ui-wire-megabytes-per-minute': 'request-load-budget.mjs',
    'dag-ui-server-cpu-cores-per-live-tab': 'request-load-budget.mjs',
}
OMITTED_LINE = (f'{len(OMITTED)} budgets are left out because a pull request cannot measure them '
                '(label not-measured-on-pr).')
SHOWN = {OWN_BUDGET, *CI_TIME, *SAVED, *READ_LATENCY, *LARGE_RUN, POOL, HEADROOM}
CI_TIME_ID = 'onepipeline-ui-ci-check-time'
# The targets the tier selects for these journeys' changes, and the one only a release pull request adds.
SAVING_TARGETS = {'.github/project.json': 'budgets', '.github/reporting/project.json': 'budgets'}
RELEASE_TIER_TARGETS = {'pool-maintenance/project.json': 'budgets-host'}
SAVED_FILES = {'github-workflows.json', 'report-job.json'}
RECORDED_POOL_SECONDS = 7.5
RESULTS_ARTIFACT = 'budget-check-results-test-linux'


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as answer:
        return answer.read()


class Released:
    """The action at the job's pin: its tree, its harness and its real payload."""

    def __init__(self, directory):
        self.tree = Path(directory)
        uses = [step['uses'] for step in JOB['steps'] if step.get('uses', '').startswith(f'{ACTION}@')]
        assert len(uses) == 1, uses
        self.tag = uses[0].split('@', 1)[1]
        version = self.tag.removeprefix('v')
        target = TARGETS[(platform.system(), platform.machine())]
        self.archive_name = f'onebudgetspec-github-action-{version}-{target}.tar.gz'
        releases = f'https://github.com/{ACTION}/releases/download/{self.tag}'
        self.assets = {name: fetch(f'{releases}/{name}') for name in (self.archive_name, 'SHA256SUMS', 'action.yml')}
        source = fetch(f'https://codeload.github.com/{ACTION}/tar.gz/refs/tags/{self.tag}')
        with tarfile.open(fileobj=io.BytesIO(source)) as archive:
            for member in archive.getmembers():
                member.name = member.name.split('/', 1)[-1]
                archive.extract(member, self.tree, filter='data')
        digest = hashlib.sha256(self.assets[self.archive_name]).hexdigest()
        assert f'{digest}  {self.archive_name}' in self.assets['SHA256SUMS'].decode().splitlines()
        saved = self.tree / 'dist' / self.archive_name
        saved.parent.mkdir()
        saved.write_bytes(self.assets[self.archive_name])
        spec = importlib.util.spec_from_file_location('released_harness', self.tree / 'tests/action-harness/harness.py')
        self.harness = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.harness)
        # The harness builds this archive from source for the action's own tests; a consumer
        # gets the released one.
        self.harness._cached['archive'] = saved


RELEASED = None
SCRATCH = None
RUNNER_PATH = None
BUS_REQUESTS = None
RUNNER_COMMANDS = 'JOURNEY_RUNNER_COMMANDS'


def setUpModule():
    """One fetch of the release, and what a hosted runner has for a budget command."""
    global RELEASED, SCRATCH, RUNNER_PATH, BUS_REQUESTS
    SCRATCH = tempfile.TemporaryDirectory()
    scratch = Path(SCRATCH.name)
    (scratch / 'action').mkdir()
    RELEASED = Released(scratch / 'action')
    binaries = scratch / 'runner-bin'
    binaries.mkdir()
    # No uv, cargo, just, bun or onevcs: this job installs none of them. The two interpreters a
    # budget's command names note each run, which is how a journey says a command did not run.
    for program in ('node', 'bash'):
        recorder = binaries / program
        recorder.write_text(f'#!/bin/sh\n[ -z "${RUNNER_COMMANDS}" ] || echo "$*" >> "${RUNNER_COMMANDS}"\n'
                            f'exec \'{Path(shutil.which(program)).resolve()}\' "$@"\n')
        recorder.chmod(0o755)
    # Ahead of /usr/bin, so that no job can start a real bus, whatever it was given.
    BUS_REQUESTS = record_bus_requests(binaries)
    RUNNER_PATH = f'{binaries}{os.pathsep}/usr/bin{os.pathsep}/bin'
    TELEMETRY.mkdir(exist_ok=True)


def tearDownModule():
    asked = requests_for_a_bus(BUS_REQUESTS)
    SCRATCH.cleanup()
    assert asked == 0, f'jobs asked for a session bus {asked} times: every job takes runner_environment()'


def record_bus_requests(directory):
    """A `dbus-launch` that starts nothing: it notes the ask and fails. Returns where it notes."""
    record = Path(directory) / 'bus-requests'
    recorder = Path(directory) / 'dbus-launch'
    recorder.write_text(f"#!/bin/sh\necho asked >> '{record}'\nexit 1\n")
    recorder.chmod(0o755)
    return record


def requests_for_a_bus(record):
    return len(record.read_text().splitlines()) if record.exists() else 0


def runner_environment(**variables):
    """What a job's steps run in, ahead of what the harness gives them.

    gh takes GH_TOKEN for the harness's `github.localhost`, but for any other host, or with no
    token, it looks in the keyring, and on a host with no session bus that autolaunches a daemon
    nothing stops. The variable forbids it.
    """
    return {'DBUS_SESSION_BUS_ADDRESS': 'disabled:', 'PATH': RUNNER_PATH, **variables}


def job_inputs():
    """The `with:` the workflow's job really names, its token expression resolved."""
    step = next(step for step in JOB['steps'] if step.get('uses', '').startswith(f'{ACTION}@'))
    given = dict(step['with'])
    assert given.pop('token') == '${{ github.token }}'
    return {'token': 'job-token', **given}


class Journey:
    """One repository and one host double, driven through the workflow's job."""

    def __init__(self, case, files=None, tree=False):
        self.harness = RELEASED.harness
        self.host = self.harness.Host()
        case.addCleanup(self.host.close)
        self.repository = self.harness.Repository()
        case.addCleanup(self.repository.close)
        self.case = case
        self.tree = tree
        self.counts = Path(self.repository.path).parent / f'{Path(self.repository.path).name}.counts'
        case.addCleanup(self.counts.unlink, missing_ok=True)
        self.next_run = 1000
        self.commands = Path(f'{self.counts}.commands')
        case.addCleanup(self.commands.unlink, missing_ok=True)
        self._serve_run_jobs()
        if tree:
            self._copy_checkout()
        for relative, content in (files or {}).items():
            self.repository.write(relative, content)
        self.base_sha = self.repository.commit('catalog')

    def _serve_run_jobs(self):
        """GitHub's listing of a run's jobs, recorded, which the action's own harness has no need of."""
        answer_otherwise = self.host.read

        def read(handler, path):
            if re.fullmatch(r'/repos/owner/repo/actions/runs/\d+/jobs', path.split('?')[0]):
                return self.host.reply(handler, 200, json.dumps(RECORDED_JOBS).encode())
            return answer_otherwise(handler, path)

        self.host.read = read

    def _copy_checkout(self):
        """This tree as a fresh checkout holds it: nothing ignored, so no build or telemetry."""
        listed = subprocess.run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT,
                                capture_output=True, check=True).stdout.decode().split('\0')
        for relative in filter(None, listed):
            source = ROOT / relative
            if source.is_file():
                target = Path(self.repository.path) / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target, follow_symlinks=False)

    def run(self, event_name, sha, **options):
        self.next_run += 1
        self.counts.unlink(missing_ok=True)
        self.commands.unlink(missing_ok=True)
        job = self.harness.Job(self.host, self.repository, event_name, sha, inputs=job_inputs(),
                               run_id=self.next_run, environment=runner_environment(
                                   JOURNEY_COUNTS=str(self.counts),
                                   **{RUNNER_COMMANDS: str(self.commands)},
                                   # What a runner sets for every step, which the figures script reads.
                                   GITHUB_EVENT_NAME=event_name,
                                   GITHUB_REPOSITORY=self.harness.REPOSITORY,
                                   GITHUB_RUN_ID=str(self.next_run),
                                   RUNNER_NAME='hosted-runner',
                               ), **options)
        self.case.addCleanup(job.close)
        return job.run()

    def base_push(self, merged_head=None):
        self.repository.git('checkout', '--quiet', 'main')
        self.base_sha = self.repository.commit('merged')
        if merged_head:
            self.host.merge_pull_request(self.base_sha, merged_head)
        return self.run('push', self.base_sha)

    def pull_request(self, files=None, draft=False, head_repository=None, targets_saved_from=None, release_tier=False):
        self.repository.git('checkout', '--quiet', '-B', 'change', self.base_sha)
        for relative, content in (files or {}).items():
            self.repository.write(relative, content)
        head = self.repository.commit('change')
        self.host.head = head
        if targets_saved_from:
            self.test_linux(self.next_run + 1, head, targets_saved_from, release_tier)
        pull_request = {'head_repository': head_repository} if head_repository else {}
        event = self.harness.event_pull_request(1, head, self.base_sha, draft=draft, **pull_request)
        job = self.run('pull_request', head, event=event, base_ref='main', register=False)
        posted = [comment['body'] for comment in self.host.comments if f'head: {head} ·' in comment['body']]
        delivered = head_repository is None and self.host.write_status is None
        self.case.assertEqual(len(posted), int(delivered), job.stdout)
        for body in posted:
            assert_the_layout(self.case, job, body, omitted=self.tree)
        return job

    def executed(self):
        return sorted(self.counts.read_text().split()) if self.counts.exists() else []

    def commands_run(self):
        """What this run's job handed the interpreters a budget's command names."""
        return self.commands.read_text() if self.commands.exists() else ''

    def test_linux(self, run_id, head, earlier_job, release_tier=False):
        """The job before `budgets`, in its own checkout: its targets' commands, then its upload step."""
        tree = Path(self.repository.path)
        targets = {**SAVING_TARGETS, **(RELEASE_TIER_TARGETS if release_tier else {})}
        if release_tier:
            # One recorded pass in place of the real prune, which needs a superseded cargo build:
            # what this holds is the target's saving and the row after it, not the pass.
            (tree / 'pool-maintenance/measure.sh').write_text(
                f'#!/bin/sh\necho \'{{"value": {RECORDED_POOL_SECONDS}}}\' > "$ONEBUDGETSPEC_RESULT"\n')
        # Ignored, as a bootstrap leaves it, so the policy telemetry's digest of the tree holds.
        with (tree / '.git/info/exclude').open('a') as exclude:
            exclude.write('/node_modules\n')
        (tree / 'node_modules').symlink_to(ROOT / 'node_modules')
        # What each target's `dependsOn: test` left: `github-workflows:test` writes the policy
        # telemetry in this one test, and `report-job:test` the job's telemetry and its tools.
        recorded = subprocess.run(['node', '--test', '--test-name-pattern=record the complete lifecycle',
                                   '.github/tests/graph.test.mjs'], cwd=tree, capture_output=True, text=True, check=False)
        self.case.assertEqual(recorded.returncode, 0, recorded.stdout + recorded.stderr)
        reporting = tree / '.github/reporting/.telemetry'
        shutil.copytree(earlier_job.temp / 'onebudgetspec-action/tools', reporting / 'tools')
        (reporting / 'report-job.json').write_text(json.dumps(earlier_job.saved('report-job.json')))
        self.target_results = {}
        for project, target in targets.items():
            command = json.loads((tree / project).read_text())['targets'][target]['command']
            ran = subprocess.run(['bash', '-c', command], cwd=tree, capture_output=True, text=True, check=False)
            self.target_results[project] = ran.returncode
        self.upload_saved_results(run_id, head)
        # Another job's checkout: neither its results nor its telemetry reach `budgets`.
        for ephemeral in (tree / 'target', tree / 'node_modules', tree / '.github/.telemetry', reporting):
            if ephemeral.is_symlink():
                ephemeral.unlink()
            else:
                shutil.rmtree(ephemeral)
        self.repository.git('checkout', '--quiet', '--', 'pool-maintenance/measure.sh')

    def upload_saved_results(self, run_id, head):
        """`test-linux`'s own upload step, read off the workflow, through the real action's code."""
        [step] = [step for step in WORKFLOW['jobs']['test-linux']['steps']
                  if step.get('uses', '').startswith('actions/upload-artifact@')
                  and step['with']['name'] == RESULTS_ARTIFACT]
        self.case.assertEqual((step['if'], step['with']['path']), ('always()', 'target/budget-results/'))
        runner = self.harness.Job(self.host, self.repository, 'pull_request', head, run_id=run_id,
                                  environment=runner_environment())
        self.case.addCleanup(runner.close)
        outcome, _ = runner._artifact_action(step, self.harness.Expression({}), runner.temp / 'upload-output')
        self.case.assertEqual(outcome, 'success', runner.stdout)


def catalog_files():
    """The catalog fixture in a product's tree, beside the job's own real budget."""
    fixture = HERE / 'fixtures/catalog'
    files = {f'packages/demo/{path.name}': path.read_text() for path in fixture.iterdir()}
    files['.github/reporting/budgets.yaml'] = (HERE / 'budgets.yaml').read_text()
    files['.github/.gitignore'] = (ROOT / '.github/.gitignore').read_text()
    return files


def verdicts(job):
    return {result['id']: result for result in job.saved('budget-run.json')['results']['results']}


# Where each part of the core's comment layout opens; each closes at its next `</details>`.
SECTIONS = {'attention': '<details open><summary><b>Needs attention', 'within': '<details><summary><b>Within budget',
            'details': '<details><summary>Details</summary>'}
NOT_MEASURED = 'Not measured on this run'
MARKS = ('✅', '❌', '⚠️')


def section(body, name):
    """One collapsible part of a posted comment, from its opening to its first `</details>`."""
    start = body.index(SECTIONS[name])
    return body[start:body.index('</details>', start)]


def table_rows(text):
    """A section's table rows, each the budget's name and then its cells, in order."""
    return [[cell.strip() for cell in line.strip().strip('|').split('|')]
            for line in text.splitlines() if line.startswith('| **')]


def not_measured(details):
    """The names the Details section lists under its not-measured heading."""
    if f'**{NOT_MEASURED}' not in details:
        return []
    block = details.split(f'**{NOT_MEASURED}', 1)[1].split('\n\n', 2)[1]
    return [line[2:].split(': ', 1)[0] for line in block.splitlines() if line.startswith('- ')]


def signed(value):
    """A change to one decimal with its sign and no negative zero, as the core writes it."""
    rounded = f'{value:+.1f}'
    return '+0.0' if rounded == '-0.0' else rounded


def reason(row, report_only):
    """The core contract's one phrase for why a row needs attention, from its saved verdict and flag."""
    if row.get('verdict') == 'over':
        phrase = 'Over limit · flagged' if row['flag'] else 'Over limit'
    elif row.get('verdict') == 'error':
        phrase = 'Error'
    elif row.get('sd') == 0:
        phrase = 'Flagged (was constant)'
    else:
        phrase = f'Flagged {signed(row.get("sigma_change") or 0)} SD'
    return f'{phrase} (report-only)' if report_only else phrase


def placed(row, report_only):
    """The section the layout contract puts a saved row in."""
    if row.get('verdict') == 'over' or (row.get('verdict') == 'error' and not report_only) or row['flag']:
        return 'attention'
    return 'within' if row.get('verdict') == 'within' else 'not-measured'


def assert_the_layout(case, job, body, omitted):
    """Every saved row in the one section its verdict and flag give, once, with the summary counting them."""
    report = job.saved('comparison-report.json')
    excluded = set(job_inputs()['enforcement-exclude-labels'].split(','))
    labels = {(budget['file'], budget['id']): set(budget['labels']) for budget in job.saved('budget-run.json')['catalog']}
    prefix = f"{report['current']['repository'].rsplit('/', 1)[-1]}-"
    expected = {'attention': {}, 'within': {}, 'not-measured': {}}
    for row in report['rows']:
        report_only = bool(labels[(row['file'], row['id'])] & excluded)
        name = row['id'].removeprefix(prefix) or row['id']
        case.assertNotIn(name, {key for found in expected.values() for key in found}, 'one name per budget')
        expected[placed(row, report_only)][name] = reason(row, report_only)
    attention, within, details = (section(body, name) for name in ('attention', 'within', 'details'))
    shown = {'attention': table_rows(attention), 'within': table_rows(within)}
    case.assertEqual(sorted(cells[0].strip('*') for cells in shown['attention']), sorted(expected['attention']), body)
    case.assertEqual(sorted(cells[0].strip('*') for cells in shown['within']), sorted(expected['within']), body)
    case.assertEqual(sorted(not_measured(details)), sorted(expected['not-measured']), body)
    for cells in shown['attention']:
        case.assertEqual(len(cells), 3, cells)
        case.assertEqual(cells[2], expected['attention'][cells[0].strip('*')], cells)
    for cells in shown['within']:
        case.assertEqual(len(cells), 2, cells)
    if shown['attention']:
        case.assertIn('| Budget | Now · vs base | Reason |\n', attention)
    else:
        case.assertIn('Nothing failed or was flagged.', attention)
    if shown['within']:
        case.assertIn('| Budget | Now · vs base |\n', within)
    tables = [line for line in body.splitlines() if line.startswith('|')]
    for mark in MARKS:
        case.assertEqual([line for line in tables if mark in line], [], f'no table cell holds {mark}')
    counts = {name: len(found) for name, found in expected.items()}
    summary = (f"**⚠️ {counts['attention']} need attention**" if counts['attention'] else '**✅ Nothing needs attention**')
    summary += f" · {counts['within']} within budget"
    summary += f" · {counts['not-measured']} not measured" if counts['not-measured'] else ''
    [line] = [line for line in body.splitlines() if line.startswith('**') and 'within budget ·' in line]
    case.assertTrue(line.startswith(summary + ' · head '), (line, summary))
    case.assertTrue(attention.startswith(f"{SECTIONS['attention']} ({counts['attention']})</b></summary>"), attention)
    case.assertTrue(within.startswith(f"{SECTIONS['within']} ({counts['within']})</b></summary>"), within)
    left_out = [line for line in body.splitlines() if 'left out' in line]
    case.assertEqual(left_out, [line for line in details.splitlines() if 'left out' in line], 'inside Details')
    if omitted:
        case.assertEqual(left_out, [f'- {OMITTED_LINE}'], body)


def unavailable(job):
    return {entry['id']: entry['reason'] for entry in job.saved('budget-run.json')['unavailable']}


class SessionBus(unittest.TestCase):
    def test_every_job_is_given_the_runner_environment(self):
        """Read off the source, because `journey_tools` builds a job only when no tools are kept."""
        jobs = [node for node in ast.walk(ast.parse(Path(__file__).read_text()))
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'Job']
        self.assertTrue(jobs)
        for job in jobs:
            given = [keyword.value for keyword in job.keywords if keyword.arg == 'environment']
            self.assertTrue(given and isinstance(given[0], ast.Call) and given[0].func.id == 'runner_environment',
                            f'line {job.lineno}: a harness.Job takes environment=runner_environment(...)')

    def test_a_jobs_real_gh_asks_for_no_session_bus(self):
        if platform.system() != 'Linux':
            self.skipTest('gh autolaunches a session bus only on Linux')
        if shutil.which('gh') is None:
            self.skipTest('gh is not installed, so nothing here can ask for a bus')
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        record = record_bus_requests(scratch.name)
        # As the harness composes a step's environment, with the action's token, and a target that
        # token does not apply to: `github.localhost` is the one host this gh would not ask about.
        # gh looks in the keyring before it connects, so a closed loopback port is enough to ask with.
        url = 'http://127.0.0.1:9'
        job = {'HOME': scratch.name, **RELEASED.harness.real_gh_environment(url, scratch.name),
               'GH_TOKEN': 'test-token', **runner_environment()}

        def gh(environment):
            return subprocess.run(['gh', 'api', f'{url}/repos/owner/repo'],
                                  env={**environment, 'PATH': f'{scratch.name}{os.pathsep}{environment["PATH"]}'},
                                  capture_output=True, text=True, timeout=60, check=False)

        control = gh({name: value for name, value in job.items() if name != 'DBUS_SESSION_BUS_ADDRESS'})
        if requests_for_a_bus(record) == 0:
            self.skipTest('this gh asks for no bus without the variable, so none can leak')
        self.assertEqual(requests_for_a_bus(record), 1, 'the control asks for a bus exactly once')
        record.unlink()
        held = gh(job)
        self.assertEqual(requests_for_a_bus(record), 0, 'runner_environment() must set DBUS_SESSION_BUS_ADDRESS=disabled:')
        self.assertEqual((held.returncode, held.stdout), (control.returncode, control.stdout), held.stderr)


class ReleasedContract(unittest.TestCase):
    def test_the_vendored_contract_is_the_release_itself(self):
        vendored = HERE / 'fixtures/onebudgetspec-github-action' / RELEASED.tag
        self.assertEqual((vendored / 'action.yml').read_bytes(), RELEASED.assets['action.yml'])
        self.assertEqual((vendored / 'SHA256SUMS').read_bytes(), RELEASED.assets['SHA256SUMS'])
        self.assertEqual((RELEASED.tree / 'action.yml').read_bytes(), RELEASED.assets['action.yml'])
        with tempfile.TemporaryDirectory() as directory:
            with tarfile.open(fileobj=io.BytesIO(RELEASED.assets[RELEASED.archive_name])) as archive:
                archive.extractall(directory, filter='data')
            driver = Path(directory) / 'onebudgetspec-github-action'
            shown = subprocess.run([str(driver), 'telemetry', '--help'], capture_output=True, text=True, check=True)
        self.assertEqual(shown.stdout, (vendored / 'telemetry-help.txt').read_text())
        writer = (RELEASED.tree / 'crates/onebudgetspec-github-action/src/finish.rs').read_text()
        self.assertIn(f'name: "{SECONDS}"', writer, 'the metric the budget reads is the one the release writes')


class ProductionCatalog(unittest.TestCase):
    """This repository's own tree as the job finds it, with nothing saved for it to read."""

    def assert_the_rows_and_one_line(self, journey, job, reason=lambda budget: NO_SAVED_RESULT):
        rows = job.rows()
        self.assertEqual(job.exit_code, 0, job.stdout)
        self.assertEqual(sorted(rows), sorted(SHOWN))
        self.assertEqual([r['id'] for r in verdicts(job).values() if r['verdict'] == 'error'], [])
        for budget in (*SAVED, *READ_LATENCY, *LARGE_RUN, POOL):
            self.assertEqual(unavailable(job)[budget], reason(budget), budget)
            self.assertNotIn('verdict', rows[budget], budget)
        self.assertIn(rows[OWN_BUDGET].get('verdict'), (None, 'within', 'over'))
        report = job.markdown()
        self.assertEqual([line for line in report.splitlines() if 'left out' in line and OMITTED_LINE in line],
                         [line for line in report.splitlines() if 'left out' in line])
        self.assertIn(OMITTED_LINE, report)
        self.assertEqual(len(OMITTED) + len(SHOWN), ROWS)
        for budget, command in OMITTED.items():
            self.assertNotIn(budget, rows, budget)
            self.assertNotIn(budget, verdicts(job), budget)
            self.assertNotIn(budget, report, budget)
            self.assertNotIn(command, journey.commands_run(), budget)

    def test_a_pull_request_shows_its_rows_and_counts_what_it_left_out(self):
        journey = Journey(self, tree=True)
        base = journey.base_push()
        self.assert_the_rows_and_one_line(journey, base, PUSH_REASON.__getitem__)
        self.assertEqual(base.outcomes['final-upload'], 'success', base.stdout)
        # A push reads no run of its own, and with no merged pull request has no figure for these.
        for budget in CI_TIME:
            self.assertIn('onevcs is not on PATH', unavailable(base)[budget], budget)

        journey.host.clear_requests()
        pull_request = journey.pull_request(draft=True)
        self.assert_the_rows_and_one_line(journey, pull_request)
        rows = pull_request.rows()
        for budget, figure in CI_TIME.items():
            self.assertEqual(verdicts(pull_request)[budget]['actual'], figure, budget)
            self.assertEqual(rows[budget]['verdict'], 'within', budget)
        # This run's jobs, read once per figure, and nothing of a release.
        self.assertEqual(journey.host.count(rf'/actions/runs/{pull_request.run_id}/jobs'), len(CI_TIME))
        self.assertEqual(journey.host.count('/releases|/compare'), 0)
        self.assertEqual(len(journey.host.comments), 1)

        base_files = journey.host.artifact_files(base.run_id)
        pull_files = journey.host.artifact_files(pull_request.run_id)
        self.assertEqual(set(base_files) - set(pull_files), {'rolling-history.json'})
        self.assertEqual(set(pull_files) - set(base_files), set())
        own = {r['id']: r for r in json.loads(base_files['budget-run.json'])['results']['results']}[OWN_BUDGET]
        self.assertEqual(own['unit'], 'seconds')
        self.assertIn(own['verdict'], ('within', 'over'), 'a real verdict, saved')

        # This push had no pull request, so what it measured is the job's own, which alone saves history.
        self.assertNotIn('no rolling file saved', ' '.join(base.saved('comparison-report.json')['diagnostics']))
        [saved] = json.loads(base_files['rolling-history.json'])['runs']
        self.assertEqual(saved['head_sha'], base.sha)
        saved_own = {r['id']: r for r in saved['results']['results']}[OWN_BUDGET]
        self.assertEqual(saved_own['actual'], own['actual'])
        self.assertIsInstance(saved_own['actual'], (int, float))

        [read] = pull_request.saved('comparison-input.json')['baseline']
        self.assertEqual(read['head_sha'], base.sha)
        read_own = {r['id']: r for r in read['results']['results']}[OWN_BUDGET]
        self.assertEqual(read_own['actual'], own['actual'])
        self.assertEqual(pull_request.rows()[OWN_BUDGET]['baseline_n'], 1)

    def test_a_failed_read_of_this_run_reads_as_unavailable_and_fails_nothing(self):
        journey = Journey(self, tree=True)
        journey.host.refuse.append({'path': r'/actions/runs/\d+/jobs', 'status': 502, 'times': 2})
        job = journey.pull_request()
        self.assertEqual(job.exit_code, 0, job.stdout)
        for budget in CI_TIME:
            self.assertIn('failed', unavailable(job)[budget], budget)
            self.assertNotIn('verdict', job.rows()[budget], budget)


class SavedResults(unittest.TestCase):
    """What `test-linux`'s targets saved, read back through its upload and the job's own download."""

    def job_after_test_linux(self, files=None, release_tier=False):
        journey = Journey(self, tree=True)
        earlier = journey.base_push()
        keep_tools(earlier)
        return journey, journey.pull_request(files, targets_saved_from=earlier, release_tier=release_tier)

    def saved_in(self, journey, job):
        members = journey.host.artifact_files(job.run_id, RESULTS_ARTIFACT)
        results = {}
        for content in members.values():
            results.update({result['id']: result for result in json.loads(content)['results']})
        return members, results

    def test_a_row_shows_what_was_saved_and_one_with_nothing_saved_says_so(self):
        journey, job = self.job_after_test_linux()
        self.assertEqual(journey.target_results, {project: 0 for project in SAVING_TARGETS})
        self.assertEqual(job.exit_code, 0, job.stdout)
        members, saved = self.saved_in(journey, job)
        self.assertEqual(set(members), SAVED_FILES, 'what the targets saved, as they name it')
        rows = job.rows()
        self.assertEqual(sorted(rows), sorted(SHOWN))
        found = verdicts(job)
        for budget in SAVED:
            self.assertIsInstance(saved[budget]['actual'], (int, float), budget)
            self.assertEqual(found[budget]['actual'], saved[budget]['actual'], budget)
            self.assertEqual(found[budget]['verdict'], saved[budget]['verdict'], budget)
            self.assertEqual(rows[budget]['verdict'], saved[budget]['verdict'], budget)
            self.assertEqual(rows[budget]['current'], saved[budget]['actual'], budget)
            self.assertNotIn(budget, unavailable(job), budget)
            self.assertNotIn(budget, journey.commands_run(), budget)
        self.assertNotIn('macos-budget.mjs', journey.commands_run(), 'a saved figure runs no command')
        # The target did not run, or no result arrived: the job cannot tell, and says exactly this.
        self.assertEqual(unavailable(job)[POOL], NO_SAVED_RESULT)
        self.assertNotIn(POOL, saved)
        self.assertNotIn('verdict', rows[POOL])
        self.assertIn(NO_SAVED_RESULT, journey.host.comments[0]['body'])
        # The job's own figure is this job's telemetry, whatever a test job saved under its id.
        own = job.saved('report-job.json')['metrics'][SECONDS]['value']
        self.assertAlmostEqual(found[OWN_BUDGET]['actual'], own, places=6)
        self.assertNotEqual(found[OWN_BUDGET]['actual'], saved[OWN_BUDGET]['actual'])
        for budget, figure in CI_TIME.items():
            self.assertEqual(found[budget]['actual'], figure, budget)
        self.assertIn(OMITTED_LINE, journey.host.comments[0]['body'])
        for budget in OMITTED:
            self.assertNotIn(budget, journey.host.comments[0]['body'], budget)

    def test_the_release_tier_saves_the_pool_figure_and_its_row_shows_it(self):
        journey, job = self.job_after_test_linux(release_tier=True)
        self.assertEqual(journey.target_results['pool-maintenance/project.json'], 0)
        self.assertEqual(job.exit_code, 0, job.stdout)
        members, saved = self.saved_in(journey, job)
        self.assertEqual(set(members), {*SAVED_FILES, 'pool-maintenance.json'})
        self.assertEqual(saved[POOL]['actual'], RECORDED_POOL_SECONDS)
        self.assertEqual(job.rows()[POOL]['current'], RECORDED_POOL_SECONDS)
        self.assertEqual(job.rows()[POOL]['verdict'], saved[POOL]['verdict'])
        self.assertNotIn(POOL, unavailable(job))
        self.assertNotIn('measure.sh', journey.commands_run(), 'a saved figure runs no command')

    def test_a_target_that_ran_over_still_uploads_and_fails_this_job_with_its_figure(self):
        over = yaml.safe_load((ROOT / '.github/budgets.yaml').read_text())
        over['budgets'][0]['threshold'] = 0
        journey, job = self.job_after_test_linux({'.github/budgets.yaml': yaml.safe_dump(over)})
        self.assertEqual(journey.target_results['.github/project.json'], 1, 'the target itself failed')
        _, saved = self.saved_in(journey, job)
        budget = over['budgets'][0]['id']
        self.assertEqual(saved[budget]['verdict'], 'over')
        self.assertEqual(job.rows()[budget]['verdict'], 'over')
        self.assertEqual(job.rows()[budget]['current'], saved[budget]['actual'])
        self.assertEqual(job.exit_code, 1, job.stdout)

    def test_no_job_uploading_anything_reads_the_same_as_a_budget_it_did_not_reach(self):
        journey = Journey(self, tree=True)
        job = journey.pull_request()
        self.assertEqual(job.exit_code, 0, job.stdout)
        self.assertEqual({budget: unavailable(job)[budget] for budget in (*SAVED, POOL)},
                         {budget: NO_SAVED_RESULT for budget in (*SAVED, POOL)})


class BasePush(unittest.TestCase):
    """A push to the base runs no test job and keeps the merged pull request's figures."""

    def test_the_test_jobs_are_skipped_and_the_budgets_job_runs(self):
        def runs(job, event_name):
            condition = WORKFLOW['jobs'][job].get('if')
            expression = RELEASED.harness.Expression({'github': {'event_name': event_name}})
            return expression.value(condition) if condition else True

        self.assertTrue(runs('budgets', 'push'))
        for job in ('lint', 'test-linux', 'test-windows', 'test-macos'):
            self.assertFalse(runs(job, 'push'), job)
            self.assertTrue(runs(job, 'pull_request'), job)

    def test_history_holds_the_merged_runs_figures_with_no_command_run(self):
        journey = Journey(self, tree=True)
        earlier = journey.base_push()
        merged = journey.pull_request(targets_saved_from=earlier)
        self.assertEqual(merged.exit_code, 0, merged.stdout)
        self.assertIn('actions-budget-figures.sh longest-job --stage pr', journey.commands_run(),
                      'the record of commands sees a figure the job did run')
        journey.host.add_run(merged.run_id, merged.sha, minute=merged.run_id, event='pull_request', branch='change')
        members = journey.host.artifact_files(merged.run_id, RESULTS_ARTIFACT)
        artifact = {result['id']: result for content in members.values() for result in json.loads(content)['results']}

        journey.host.clear_requests()
        push = journey.base_push(merged_head=merged.sha)
        self.assertEqual(push.exit_code, 0, push.stdout)
        # The merged run held no figure for the headroom row (this host has no cache listing), so
        # only its command runs here; every budget it held a figure for runs none.
        ran = journey.commands_run()
        self.assertEqual([line for line in ran.splitlines()
                          if 'actions-budget-figures.sh' in line and 'cache-headroom' not in line], [], ran)
        self.assertEqual(journey.commands_run().count('macos-budget.mjs'), 0, journey.commands_run())
        self.assertEqual(journey.host.count(r'/actions/runs/\d+/jobs'), 0)
        self.assertEqual(journey.host.count(rf'/commits/{push.sha}/pulls'), 1)

        history = json.loads(journey.host.artifact_files(push.run_id)['rolling-history.json'])
        entry = history['runs'][-1]
        self.assertEqual(entry['head_sha'], push.sha)
        results = {result['id']: result for result in entry['results']['results']}
        for budget in SAVED:
            self.assertEqual(results[budget]['actual'], artifact[budget]['actual'], budget)
            self.assertEqual(results[budget]['verdict'], artifact[budget]['verdict'], budget)
        for budget, figure in CI_TIME.items():
            self.assertEqual(results[budget]['actual'], figure, budget)
        self.assertEqual(unavailable(push)[POOL], PUSH_REASON[POOL], 'the merged run held none for it')
        self.assertAlmostEqual(results[OWN_BUDGET]['actual'], push.saved('report-job.json')['metrics'][SECONDS]['value'],
                               places=6)
        for budget in OMITTED:
            self.assertNotIn(budget, results, budget)

        # The next pull request reads those figures as its baseline.
        later = journey.pull_request()
        baseline = later.saved('comparison-input.json')['baseline']
        self.assertEqual(baseline[-1]['head_sha'], push.sha)
        self.assertEqual(later.rows()[CI_TIME_ID]['baseline_n'], 1)

    def test_a_push_with_no_merged_run_keeps_its_rows_with_their_reasons(self):
        journey = Journey(self, tree=True)
        push = journey.base_push(merged_head='0' * 40)
        self.assertEqual(push.exit_code, 0, push.stdout)
        for budget in (*SAVED, POOL):
            self.assertEqual(unavailable(push)[budget], PUSH_REASON[budget], budget)


    def test_a_budget_whose_input_is_present_keeps_its_enforcement(self):
        # With the view it names in place the command runs, and on this runner it cannot finish:
        # an enforced budget whose command really breaks stays an error.
        journey = Journey(self, tree=True)
        # Ignored, as a build leaves it: the job's own checkout never holds one.
        journey.repository.write('apps/dag-ui/dist/index.html', '<!doctype html>\n')
        job = journey.run('push', journey.base_sha)
        self.assertEqual(job.exit_code, 3, job.stdout)
        self.assertEqual(verdicts(job)['onepipeline-ui-pool-maintenance-seconds']['verdict'], 'error')
        self.assertNotIn('onepipeline-ui-pool-maintenance-seconds', unavailable(job))


class CatalogFixture(unittest.TestCase):
    def test_every_runnable_budget_runs_once_and_only_the_unrunnable_says_why(self):
        journey = Journey(self, catalog_files())
        # Discovery must skip these: either would make `list` refuse the whole catalog.
        journey.repository.write('tests/fixtures/budgets.yaml', 'not: a budgets file\n')
        journey.repository.write('conformance/case/budgets.yaml', 'not: a budgets file\n')
        journey.base_sha = journey.repository.commit('fixture trees')
        job = journey.pull_request()
        self.assertEqual(job.exit_code, 0, job.stdout)
        self.assertEqual(journey.executed(), sorted(RUNNABLE))
        found = verdicts(job)
        for budget, unit in RUNNABLE.items():
            self.assertEqual(found[budget]['unit'], unit)
            self.assertEqual(found[budget]['verdict'], 'over' if budget == 'demo-laptop-figure' else 'within', budget)
        self.assertEqual(found['demo-coverage-percent']['actual'], 91)
        self.assertEqual(unavailable(job), {budget: NO_SAVED_RESULT for budget in UNAVAILABLE})
        self.assertEqual(found[OWN_BUDGET]['unit'], 'seconds')
        self.assertEqual(job.outcomes['main-upload'], 'success', job.stdout)
        self.assertEqual(job.outcomes['final-upload'], 'success', job.stdout)
        self.assertIsNotNone(journey.host.artifact_files(job.run_id, 'budget-results-main'))
        self.assertEqual(len(journey.host.comments), 1)

    def test_saved_telemetry_being_there_runs_the_command_with_its_own_verdict(self):
        journey = Journey(self, {**catalog_files(), 'packages/demo/dist/telemetry/journey.json': '{}\n'})
        job = journey.pull_request()
        self.assertEqual(verdicts(job)['demo-needs-telemetry']['verdict'], 'within')
        self.assertNotIn('demo-needs-telemetry', unavailable(job))

    def test_a_real_failure_fails_and_a_report_only_one_does_not(self):
        journey = Journey(self, catalog_files())
        passing = journey.pull_request()
        self.assertEqual(passing.exit_code, 0, passing.stdout)
        self.assertEqual(passing.rows()['demo-laptop-figure']['verdict'], 'over')
        failing = journey.pull_request({'packages/demo/bundle-size': '5000\n'})
        self.assertEqual(failing.exit_code, 1, failing.stdout)
        self.assertEqual(failing.rows()['demo-bundle-bytes']['verdict'], 'over')
        self.assertEqual(journey.executed(), sorted(RUNNABLE), 'selected commands still run once')
        self.assertEqual(len(journey.host.comments), 1, 'a second head updates the one standing comment')
        self.assertIsNotNone(journey.host.artifact_files(failing.run_id), 'a failing job keeps its results')

    def test_base_pushes_are_what_a_pull_request_compares_with(self):
        journey = Journey(self, catalog_files())
        for _ in range(4):
            self.assertEqual(journey.base_push().exit_code, 0)
        few = journey.pull_request()
        self.assertEqual(few.rows()['demo-bundle-bytes']['baseline_n'], 4)
        # Below five samples nothing is compared: no mean, and the comment counts the samples instead.
        self.assertNotIn('mean', few.rows()['demo-bundle-bytes'])
        self.assertIn('| **demo-bundle-bytes** | 500 bytes<br>baseline 4/5 |', journey.host.comments[0]['body'])
        self.assertEqual(few.exit_code, 0, 'a missing baseline is a diagnostic')

        base = journey.base_push()
        history = json.loads(journey.host.artifact_files(base.run_id)['rolling-history.json'])
        self.assertEqual(len(history['runs']), 5)
        worse = journey.pull_request({'packages/demo/bundle-size': '900\n'})
        self.assertEqual(worse.exit_code, 0, worse.stdout)
        row = worse.rows()['demo-bundle-bytes']
        self.assertEqual((row['baseline_n'], row['verdict'], row['flag']), (5, 'within', True))
        better = journey.pull_request({'packages/demo/bundle-size': '100\n'})
        row = better.rows()['demo-bundle-bytes']
        self.assertEqual((row['current'], row['flag']), (100, False), 'an improvement keeps its number, unflagged')
        self.assertEqual(len(journey.host.comments), 1)
        self.assertIn('100', journey.host.comments[0]['body'], 'the standing comment holds the second head')

    def test_a_fork_gets_the_summary_and_artifact_with_no_comment_or_credential(self):
        journey = Journey(self, catalog_files())
        journey.host.clear_requests()
        job = journey.pull_request(head_repository='someone/fork')
        self.assertEqual(job.exit_code, 0, job.stdout)
        self.assertEqual(journey.host.comments, [])
        self.assertEqual(journey.host.count('commits/main'), 0, 'a budget command reached the host')
        self.assertIn('someone/fork', job.summary)
        self.assertIsNotNone(journey.host.artifact_files(job.run_id))

    def test_comment_and_history_failures_are_diagnostics_and_a_real_failure_survives(self):
        journey = Journey(self, catalog_files())
        journey.host.write_status = 403
        posted = journey.pull_request()
        self.assertEqual(posted.exit_code, 0, posted.stdout)
        self.assertIn('not delivered', posted.summary)
        journey.host.write_status = None

        journey.host.refuse.append({'path': r'actions/runs/\d+$', 'status': 429, 'times': 1})
        unread = journey.pull_request()
        self.assertEqual(unread.exit_code, 0, unread.stdout)
        self.assertIn('baseline unavailable', unread.markdown())

        journey.host.write_status = 403
        failed = journey.pull_request({'packages/demo/bundle-size': '5000\n'})
        self.assertEqual(failed.exit_code, 1, failed.stdout)
        self.assertIn('not delivered', failed.summary)


def saved_artifact(harness):
    """One results artifact at the top of the workload's size, each budget's result as its target saves it."""
    catalog = yaml.safe_load((ROOT / '.github/budgets.yaml').read_text())['budgets']
    results = [harness.check_result(budget['id'], 1, file='.github/budgets.yaml', labels=budget['labels'],
                                    unit=budget['unit'], threshold=budget['threshold'], detail=os.urandom(2600).hex())
               for budget in catalog]
    archive = harness.zipped({'github-workflows.json': harness.check_report(*results)})
    low, high = SAVED_ARTIFACT_BYTES
    assert low <= len(archive) <= high, len(archive)
    return archive


class ReportJob(unittest.TestCase):
    def test_record_a_complete_job(self):
        """One complete PR job and one base job, recorded rather than held to a figure here."""
        harness = RELEASED.harness
        journey = Journey(self, tree=True)
        host, repository = journey.host, journey.repository
        first = journey.base_push()
        self.assertEqual(first.exit_code, 0, first.stdout)
        keep_tools(first)

        # A rolling file of synthetic copies of one real result, one per real commit.
        heads = [repository.commit(f'base {index}') for index in range(COMMITS)]
        run = first.saved('budget-run.json')
        history = {'schema_version': 1, 'repository': harness.REPOSITORY, 'base_ref': 'main',
                   'runs': [{**run, 'head_sha': head, 'run_id': str(500 + index), 'attempt': 1}
                            for index, head in enumerate(heads)]}
        host.artifacts.clear()
        host.runs.clear()
        host.add_run(519, heads[-1], minute=519)
        host.attach(519, 'budget-results', zip_of('rolling-history.json', json.dumps(history)))

        journey.base_sha = heads[-1]
        repository.git('checkout', '--quiet', '-b', 'feature')
        head = repository.commit('change')
        host.head = head
        # The base push reads the run of the pull request this head merged as.
        pull_request_run = journey.next_run + 1
        host.merge_pull_request(heads[-1], head)
        host.attach(pull_request_run, RESULTS_ARTIFACT, saved_artifact(harness))
        jobs = (
            ('pull_request', head, {'event': harness.event_pull_request(1, head, heads[-1]), 'base_ref': 'main'}),
            ('push', heads[-1], {'attempt': 2}),
        )
        recorded = []
        for event_name, sha, options in jobs:
            host.clear_requests()
            # One retried rate-limit response, which the figure includes.
            host.refuse.append({'path': r'artifacts\?', 'status': 429, 'times': 1, 'retry_after': 1})
            job = journey.run(event_name, sha, register=False, **options)
            self.assertEqual(job.exit_code, 0, job.stdout)
            self.assertEqual(job.outcomes['main-upload'], 'success', job.stdout)
            self.assertEqual(job.outcomes['final-upload'], 'success', job.stdout)
            self.assertEqual(sorted(job.rows()), sorted(SHOWN))
            self.assertEqual(len(job.saved('budget-run.json')['catalog']), ROWS)
            self.assertEqual(len(job.saved('comparison-input.json')['baseline']),
                             COMMITS - (event_name == 'push'))
            if event_name == 'pull_request':
                self.assertEqual(job.outcomes['saved-results'], 'success', job.stdout)
                self.assertEqual(verdicts(job)[SAVED[0]]['actual'], 1)
                host.add_run(job.run_id, head, minute=job.run_id, event='pull_request', branch='feature')
            else:
                self.assertEqual(host.count(rf'/commits/{sha}/pulls'), 1, 'it read the merged run')
            telemetry = job.saved('report-job.json')
            figure = telemetry['metrics'][REQUESTS]['value']
            self.assertEqual(figure + host.requests_not_through_gh, host.count(''), 'the job and the host disagree')
            self.assertIsInstance(telemetry['metrics'][SECONDS]['value'], (int, float))
            self.assertIn('ci-report', telemetry['labels'])
            recorded.append((event_name, telemetry, host.count(''),
                             {service: host.transferred(service) for service in TRANSFER_SERVICES}))
        save_record(recorded)

    def test_the_recorded_budget_reads_back_through_the_released_reader(self):
        with tempfile.TemporaryDirectory() as directory:
            reporting = Path(directory)
            shutil.copy(HERE / 'budgets.yaml', reporting)
            journey = Journey(self, catalog_files())
            job = journey.pull_request()
            keep_tools(job)
            (reporting / '.telemetry').mkdir()
            telemetry = job.saved('report-job.json')
            for value, expected in ((telemetry['metrics'][SECONDS]['value'], 0), (10_000, 1)):
                telemetry['metrics'][SECONDS]['value'] = value
                (reporting / '.telemetry/report-job.json').write_text(json.dumps(telemetry))
                checked = check(['budgets.yaml'], cwd=reporting)
                self.assertEqual(checked.returncode, expected, checked.stdout + checked.stderr)
            (reporting / '.telemetry/report-job.json').unlink()
            self.assertNotEqual(check(['budgets.yaml'], cwd=reporting).returncode, 0, 'absent telemetry is no pass')


class ReplayedHostFigures(unittest.TestCase):
    """The root CI and CD figures over replayed host telemetry at the existing ONEVCS seam."""

    def replay(self, budget, answers=HERE / 'fixtures/job-count'):
        environment = {'ONEVCS': str(HERE / 'fixtures/job-count/replay-onevcs.sh'), 'ANSWERS': str(answers),
                       'GITHUB_REPOSITORY': 'nickderobertis/onepipeline-ui', 'GITHUB_REF_TYPE': 'tag',
                       'GITHUB_REF_NAME': 'v0.69.0'}
        for name in ('GITHUB_RUN_ID', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'RUNNER_TEMP'):
            environment[name] = ''
        checked = check(['--json', str(ROOT / 'budgets.yaml'), '--id', budget], cwd=ROOT, environment=environment)
        results = json.loads(checked.stdout)['results']
        self.assertEqual(len(results), 1, checked.stderr)
        return results[0], checked

    def test_the_saved_pull_request_is_the_finished_workflows_jobs(self):
        saved = json.loads((HERE / 'fixtures/job-count/change-checks.json').read_text())
        names = sorted(job['name'] for run in saved['runs'] for job in run['jobs'])
        self.assertEqual(names, sorted(WORKFLOW['jobs']))

    def test_ci_job_count_counts_the_report_job(self):
        result, checked = self.replay('onepipeline-ui-ci-job-count')
        print(f'replayed telemetry: onepipeline-ui-ci-job-count {result["actual"]} of {result["threshold"]}, '
              f'verdict {result["verdict"]}', file=sys.stderr)
        self.assertEqual((result['actual'], result['verdict'], checked.returncode), (5, 'within', 0), checked.stderr)

    def test_a_job_beyond_the_report_job_is_over(self):
        with tempfile.TemporaryDirectory() as directory:
            shutil.copytree(HERE / 'fixtures/job-count', directory, dirs_exist_ok=True)
            path = Path(directory) / 'change-checks.json'
            saved = json.loads(path.read_text())
            run = saved['runs'][0]
            run['jobs'].append({**run['jobs'][0], 'name': 'another'})
            path.write_text(json.dumps(saved))
            result, checked = self.replay('onepipeline-ui-ci-job-count', directory)
        self.assertEqual((result['actual'], result['verdict'], checked.returncode), (6, 'over', 1), checked.stderr)

    def test_cd_figures_leave_out_the_report_jobs_push_run(self):
        result, checked = self.replay('onepipeline-ui-cd-job-count')
        self.assertEqual((result['actual'], result['verdict']), (6, 'within'), checked.stderr)
        self.assertIn('left out by --exclude-workflow: CI (run 203, push)', result['detail'])
        result, checked = self.replay('onepipeline-ui-release-read-requests')
        self.assertEqual(result['verdict'], 'within', checked.stderr)
        self.assertNotIn('run-jobs --run 203', result.get('detail', ''))


def keep_tools(job):
    """The released tools as that job installed them, which `report-job:budgets` runs."""
    shutil.copytree(job.temp / 'onebudgetspec-action/tools', TELEMETRY / 'tools', dirs_exist_ok=True)


def check(arguments, cwd, environment=None):
    tools = TELEMETRY / 'tools'
    if not (tools / 'onebudgetspec').exists():
        journey_tools()
    env = {**os.environ, 'PATH': f'{tools}{os.pathsep}{os.environ["PATH"]}', **(environment or {})}
    for name, value in list(env.items()):
        if value == '':
            del env[name]
    return subprocess.run([str(tools / 'onebudgetspec'), 'check', *arguments], cwd=cwd, env=env,
                          capture_output=True, text=True, check=False)


def journey_tools():
    """The real install the first time something needs the tools ahead of a job."""
    harness = RELEASED.harness
    host = harness.Host()
    repository = harness.Repository()
    try:
        repository.write('budgets.yaml', harness.budgets_yaml([]))
        job = harness.Job(host, repository, 'push', repository.commit('tools'), inputs=job_inputs(), run_id=1,
                          environment=runner_environment())
        job.run()
        keep_tools(job)
        job.close()
    finally:
        repository.close()
        host.close()


def save_record(recorded):
    """The slower job's telemetry for the budget, with both jobs' traffic beside it."""
    _, slowest, _, _ = max(recorded, key=lambda entry: entry[1]['metrics'][SECONDS]['value'])
    record = json.loads(json.dumps(slowest))
    record['metrics'][REQUESTS]['value'] = max(entry[2] for entry in recorded)
    record['scope'] = 'every client: measured at the external boundary'
    record['boundary'] = {
        event_name: {'github_api_requests': requests, 'provisional_design_total': PROVISIONAL_REQUESTS,
                     'file_transfers': transfers, SECONDS: telemetry['metrics'][SECONDS]['value']}
        for event_name, telemetry, requests, transfers in recorded}
    (TELEMETRY / 'report-job.json').write_text(json.dumps(record, indent=2))
    print('recorded: ' + json.dumps(record['boundary']), file=sys.stderr)


def zip_of(name, content):
    import zipfile
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr(name, content)
    return buffer.getvalue()


if __name__ == '__main__':
    unittest.main(verbosity=2)
