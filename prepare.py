"""Throwaway setup for a packaged, fresh-session recovery check."""
import datetime, json, os, pathlib, subprocess, sys, tempfile, uuid
source = pathlib.Path(sys.argv[1]).resolve()
root = pathlib.Path(sys.argv[2]).resolve()
root.mkdir(parents=True, exist_ok=True)
repo = root / 'repo'; install = root / 'install'; state = pathlib.Path(tempfile.mkdtemp(prefix='statewell-demo-', dir='/dev/shm'))
for name in ['archives', 'cache', 'npm-home']: (root / name).mkdir(exist_ok=True)
env = dict(os.environ, HOME=str(root / 'npm-home'), npm_config_cache=str(root / 'cache'))
if not repo.exists(): subprocess.run(['git', 'clone', '--no-hardlinks', str(source), str(repo)], check=True, capture_output=True)
packed = subprocess.run(['npm', 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', str(root / 'archives')], cwd=source, env=env, check=True, capture_output=True, text=True)
archive = root / 'archives' / json.loads(packed.stdout)[0]['filename']
subprocess.run(['npm', 'install', str(archive), '--prefix', str(install), '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], env=env, check=True)
binary = install / 'node_modules/.bin/statewell'
assert binary.read_bytes() == (source / 'dist/statewell').read_bytes()
context = {'binary': str(binary), 'home': str(state), 'instance': 'demo'}
(repo / '.statewell-session.json').write_text(json.dumps(context, indent=2) + '\n')
(repo / 'AGENTS.md').write_text('''# Disposable development task\n\nUse the installed Statewell application configured in `.statewell-session.json`.\nSet `STATEWELL_HOME` from `home` and select the configured instance for every command.\nRead `docs/INSTANCE-CLI.md` for its public task operations.\nRetrieve the caller-supplied task before implementation.\nInspect actual files, dependency evidence, repository state, and uncertain outcomes before continuing.\nUse `task continue` to record inspection before implementation.\nRecord completion evidence and the final checkpoint through the public interface.\nDo not open the database directly or use a different Statewell store.\nDo not change repository branches, commit, push, or update GitHub.\nKeep changes within the saved contract.\nWrite project documentation in ASD-STE100 Simplified Technical English.\nUse short active sentences and expand abbreviations before use.\n''')
state_env = dict(os.environ, STATEWELL_HOME=str(state))
def cli(*args):
    result = subprocess.run([str(binary), *args, '--instance', 'demo'], env=state_env, cwd=repo, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)
cli('instance', 'create'); cli('instance', 'start', '--detached'); project = cli('project', 'register', '--root', str(repo))
task_id = str(uuid.uuid4())
contract = {
 'goal': 'Add a usable fresh-session recovery walkthrough to docs/INSTANCE-CLI.md.',
 'scopeLimits': ['Edit only docs/INSTANCE-CLI.md.', 'Do not change application code or dependencies.', 'Use the installed application and the selected disposable instance.', 'Do not repeat the receipt request if inspection finds the receipt.', 'Do not commit, push, or update GitHub.'],
 'acceptanceChecks': ['The walkthrough gives ordered public CLI steps for retrieving context, inspecting actual files and uncertain effects, recording continuation, and recording completion.', 'The walkthrough explains exact reads for oversized context, contract reconciliation, and branch or worktree equivalence.', 'The existing documentation remains present and all documented operation names are supported by the installed application.', 'Inspect the uncertain receipt outcome and preserve exactly one receipt without repeating its POST.', 'Record passing evidence for every check and a final done checkpoint through the public interface.'],
 'dependencyConditions': ['The installed application provides task context, task checkpoint, and task continue.'],
 'completionApprovalRequired': False,
}
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
checkpoint = {'progress': 'Prepared the approved documentation task.', 'remainingWork': ['Write and verify the recovery walkthrough.'], 'nextAction': 'Inspect the installed commands and start the documentation work.', 'blockers': [], 'evidence': ['The package was installed offline and its executable matches the build.'], 'repositoryState': {'worktree': str(repo), 'branch': 'main', 'commit': head, 'uncommittedChanges': ['Disposable session configuration and project marker.']}, 'uncertainExternalEffects': []}
def task(operation, payload):
    path = root / 'request.json'; path.write_text(json.dumps(payload))
    return cli('task', operation, '--root', str(repo), '--input', str(path))
created = task('create', {'taskId': task_id, 'retryKey': str(uuid.uuid4()), 'expectedRevision': 0, 'contract': contract, 'source': {'reference': 'https://github.com/statewell/statewell/issues/9', 'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}, 'checkpoint': checkpoint})
approved = task('approve', {'taskId': task_id, 'retryKey': str(uuid.uuid4()), 'expectedRevision': 1, 'expectedContractRevision': 1, 'contract': contract, 'source': created['value']['task']['source'], 'approval': {'source': 'The maintainer requested work-ticket 8 and 9. Issue 9 explicitly requires a real fresh-session continuation task.'}})
(root / 'task.json').write_text(json.dumps({'taskId': task_id, 'root': str(repo), **context}, indent=2) + '\n')
(root / 'approved.json').write_text(json.dumps(approved, indent=2) + '\n')
print(json.dumps({'root': str(repo), 'taskId': task_id}))
