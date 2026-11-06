"""ci.yml's `budgets` job, driven at GitHub's boundary through the action it pins.

Each journey reads the job out of the workflow and runs what its `uses:` names with its `with:`
inputs: action.yml's own steps, the released driver and plugin archive, the published core wheel,
the real `gh` and the real `actions/upload-artifact` code. Only GitHub's API and artifact services,
the release host and the package index are doubled, by the harness the action ships at that same
tag. Scalars in seeded history and the job-count answers are synthetic or replayed, and say so.

`test_record_a_complete_job` saves `.telemetry/report-job.json`, which `report-job:budgets` reads.
"""
import ast
import hashlib
import importlib.util
import io
import json
import os
import platform
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

# The workload of the job's own budget.
ROWS = 100
COMMITS = 20
COMMANDS_READING_REST = 12
PROVISIONAL_REQUESTS = 20
TRANSFER_SERVICES = ('artifact-service', 'blob-storage', 'object-storage', 'release-host', 'package-index')

# The catalog fixture: what runs, and what cannot.
RUNNABLE = {'demo-bundle-bytes': 'bytes', 'demo-coverage-percent': 'percent', 'demo-host-reads': 'requests',
            'demo-walltime': 'seconds', 'demo-laptop-figure': 'count'}
UNAVAILABLE = {'demo-needs-cargo': 'needs cargo', 'demo-needs-telemetry': 'dist/telemetry/journey.json'}

# Every production budget, each with the words of why it cannot measure in this job.
ROOT_FIGURE = 'onevcs is not on PATH'
PRODUCTION = {
    'onepipeline-ui-ci-check-time': ROOT_FIGURE,
    'onepipeline-ui-cd-job-time': ROOT_FIGURE,
    'onepipeline-ui-release-cycle-time': ROOT_FIGURE,
    'onepipeline-ui-ci-job-count': ROOT_FIGURE,
    'onepipeline-ui-cd-job-count': ROOT_FIGURE,
    'onepipeline-ui-release-read-requests': ROOT_FIGURE,
    'onepipeline-ui-pr-read-requests': ROOT_FIGURE,
    'onepipeline-ui-nx-cache-use': 'no release',
    'onepipeline-ui-gate-time': '@onebudgetspec/sdk',
    'onepipeline-ui-macos-jobs-per-run': '.github/.telemetry/macos-policy.json',
    'onepipeline-ui-macos-runs-per-change': '.github/.telemetry/macos-policy.json',
    'onepipeline-ui-pool-maintenance-seconds': '../apps/dag-ui/dist/index.html',
    'dag-ui-settled-requests-per-minute': 'telemetry/request-load.json',
    'dag-ui-live-requests-per-minute': 'telemetry/request-load.json',
    'dag-ui-live-update-lag-seconds': 'telemetry/request-load.json',
    'dag-ui-wire-megabytes-per-minute': 'telemetry/request-load.json',
    'dag-ui-server-cpu-cores-per-live-tab': 'telemetry/request-load.json',
}


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


def setUpModule():
    """One fetch of the release, and what a hosted runner has for a budget command."""
    global RELEASED, SCRATCH, RUNNER_PATH, BUS_REQUESTS
    SCRATCH = tempfile.TemporaryDirectory()
    scratch = Path(SCRATCH.name)
    (scratch / 'action').mkdir()
    RELEASED = Released(scratch / 'action')
    binaries = scratch / 'runner-bin'
    binaries.mkdir()
    # No uv, cargo, just, bun or onevcs: this job installs none of them.
    (binaries / 'node').symlink_to(Path(shutil.which('node')).resolve())
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
        self.counts = Path(self.repository.path).parent / f'{Path(self.repository.path).name}.counts'
        case.addCleanup(self.counts.unlink, missing_ok=True)
        self.next_run = 1000
        if tree:
            self._copy_checkout()
        for relative, content in (files or {}).items():
            self.repository.write(relative, content)
        self.base_sha = self.repository.commit('catalog')

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
        job = self.harness.Job(self.host, self.repository, event_name, sha, inputs=job_inputs(),
                               run_id=self.next_run, environment=runner_environment(
                                   JOURNEY_COUNTS=str(self.counts),
                                   # What a runner sets for every step, which the figures script reads.
                                   GITHUB_REPOSITORY=self.harness.REPOSITORY,
                                   GITHUB_RUN_ID=str(self.next_run),
                                   RUNNER_NAME='hosted-runner',
                               ), **options)
        self.case.addCleanup(job.close)
        return job.run()

    def base_push(self):
        self.repository.git('checkout', '--quiet', 'main')
        self.base_sha = self.repository.commit('merged')
        return self.run('push', self.base_sha)

    def pull_request(self, files=None, draft=False, head_repository=None):
        self.repository.git('checkout', '--quiet', '-B', 'change', self.base_sha)
        for relative, content in (files or {}).items():
            self.repository.write(relative, content)
        head = self.repository.commit('change')
        self.host.head = head
        pull_request = {'head_repository': head_repository} if head_repository else {}
        event = self.harness.event_pull_request(1, head, self.base_sha, draft=draft, **pull_request)
        return self.run('pull_request', head, event=event, base_ref='main', register=False)

    def executed(self):
        return sorted(self.counts.read_text().split()) if self.counts.exists() else []


def catalog_files():
    """The catalog fixture in a product's tree, beside the job's own real budget."""
    fixture = HERE / 'fixtures/catalog'
    files = {f'packages/demo/{path.name}': path.read_text() for path in fixture.iterdir()}
    files['.github/reporting/budgets.yaml'] = (HERE / 'budgets.yaml').read_text()
    files['.github/.gitignore'] = (ROOT / '.github/.gitignore').read_text()
    return files


def verdicts(job):
    return {result['id']: result for result in job.saved('budget-run.json')['results']['results']}


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
    """This repository's own tree as the job finds it, its predecessors' files absent."""

    def assert_every_row_unavailable_with_its_reason(self, job):
        self.assertEqual(job.exit_code, 0, job.stdout)
        self.assertEqual([r['id'] for r in verdicts(job).values() if r['verdict'] == 'error'], [])
        reasons = unavailable(job)
        rows = job.rows()
        self.assertEqual(sorted(rows), sorted({*PRODUCTION, OWN_BUDGET}))
        for budget, reason in PRODUCTION.items():
            self.assertIn(reason, reasons[budget], budget)
            self.assertNotIn('verdict', rows[budget], budget)
            self.assertIn(reason, rows[budget]['unavailable'], budget)
        self.assertIn(rows[OWN_BUDGET].get('verdict'), (None, 'within', 'over'))

    def test_every_production_budget_has_one_row_on_a_pull_request_and_a_base_push(self):
        journey = Journey(self, tree=True)
        base = journey.base_push()
        self.assert_every_row_unavailable_with_its_reason(base)
        self.assertEqual(base.outcomes['final-upload'], 'success', base.stdout)

        journey.host.clear_requests()
        pull_request = journey.pull_request(draft=True)
        self.assert_every_row_unavailable_with_its_reason(pull_request)
        # The figures scripts refuse before they ask: nothing here reads a release.
        self.assertEqual(journey.host.count('/releases|/runs/\\d+/jobs|/compare'), 0)
        self.assertEqual(len(journey.host.comments), 1)

        base_files = journey.host.artifact_files(base.run_id)
        pull_files = journey.host.artifact_files(pull_request.run_id)
        # The same results. This tree's only measuring budget is the job's own, which the release
        # does not count towards a rolling file, and it says so.
        self.assertEqual(set(base_files), set(pull_files))
        self.assertIn('no rolling file saved', ' '.join(base.saved('comparison-report.json')['diagnostics']))
        own = {r['id']: r for r in json.loads(base_files['budget-run.json'])['results']['results']}[OWN_BUDGET]
        self.assertEqual(own['unit'], 'seconds')
        self.assertIn(own['verdict'], ('within', 'over'), 'a real verdict, saved')

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
        self.assertEqual(set(unavailable(job)), set(UNAVAILABLE))
        for budget, reason in UNAVAILABLE.items():
            self.assertIn(reason, unavailable(job)[budget])
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
        self.assertIn('minimum 5', few.rows()['demo-bundle-bytes']['unavailable'])
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


def workload_files():
    """This repository's budget's stated workload, in a catalog of exactly ROWS rows."""
    production = len(PRODUCTION) + 1
    write = 'echo "{\\"value\\": 1}" > "$ONEBUDGETSPEC_RESULT"'
    entries = []
    for index in range(COMMANDS_READING_REST):
        read = f'gh api repos/owner/repo/commits/{index} > /dev/null || exit 1; {write}'
        entries.append((f'workload-reads-rest-{index}', ['bash', '-c', read], {'unit': 'requests'}))
    while production + len(entries) < ROWS:
        entries.append((f'workload-local-{len(entries)}', ['bash', '-c', write], {'unit': 'bytes'}))
    return {'packages/workload/budgets.yaml': RELEASED.harness.budgets_yaml(entries)}


class ReportJob(unittest.TestCase):
    def test_record_a_complete_job(self):
        """One complete PR job and one base job, recorded rather than held to a figure here."""
        harness = RELEASED.harness
        journey = Journey(self, workload_files(), tree=True)
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
            self.assertEqual(len(job.rows()), ROWS)
            self.assertEqual(host.count('commits/'), COMMANDS_READING_REST, 'each reader ran once')
            self.assertEqual(len(job.saved('comparison-input.json')['baseline']),
                             COMMITS - (event_name == 'push'))
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
        for name in ('GITHUB_RUN_ID', 'GITHUB_EVENT_PATH', 'RUNNER_TEMP'):
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
