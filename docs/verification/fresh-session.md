# Verification: Fresh-session continuation

## Problem and scope

[Issue #9](https://github.com/statewell/statewell/issues/9) requires a fresh agent to complete real work from saved state.
The agent must use the packaged application without the initial conversation or a final handoff.

The bounded real task adds a fresh-session recovery walkthrough to the packaged command-line interface (CLI) documentation.
Its approved contract limits changes to `docs/INSTANCE-CLI.md`.
The task requires actual file inspection, dependency evidence, receipt inspection, complete documentation, and a final checkpoint through the public interface.
The final walkthrough is the validated repository change. The experiment code stays on a separate prototype branch.

Backups, restoration, migrations, memory, inference, and database-loss recovery remain outside scope.
The normal development store and temporary active-work procedure are unchanged.

## Environment and isolation

Application base: `badbd3a8cb432fec6ccb205124e2c0bbd9eee2b1`.
Native Linux x64, Ubuntu 24.04.4 LTS, Bun 1.4.2, Node.js 24.20.0, npm 11.19.0.
Compiled target: `bun-linux-x64-baseline`.
Installed executable SHA-256: `3cba395929c20aeba605a6208ff04382367c6901234b1ab471c71ad80908d09b`.

The package was installed offline in a separate directory with a fresh npm cache.
The installed executable matched the build byte for byte.
The experiment used a separate Git clone and a named `demo` instance with disposable SQLite data under `/dev/shm`.
The receipt service listened only on loopback and stored only the experiment receipt.
No application data, generated session configuration, package archive, or receipt store is included in Git.

The setup first rejected data under `/tmp` because this environment contains `/tmp/.git`.
The application correctly returned `DATA_IN_REPOSITORY` before creating the store.
The prototype then selected a separate disposable directory under `/dev/shm`.
The tool sandbox hides that host directory from ordinary execution.
Both agents independently used elevated public CLI execution after observing the unavailable configured home.
They did not create another instance or select another store.

## Reproduction

The throwaway source and findings are retained at [prototype commit 19e1740](https://github.com/statewell/statewell/tree/19e1740f6adaf8dc2fa521c43193cf76fc6b90e1).
Its README describes setup, initial-session interruption, fresh-session input, and lead verification.
Run its setup and service commands with a built application checkout:

```sh
python3 prepare.py /absolute/statewell /tmp/statewell-continuation-prototype
python3 receipt_service.py /tmp/statewell-continuation-prototype
```

`task.json` identifies the generated repository, task, installed executable, and selected instance context.
Give the initial agent the bounded preparation instructions from the prototype README.
After its checkpoint succeeds, interrupt it before a final handoff.
Restart the disposable daemon and verify that the public task response is unchanged.

Create a new agent without a conversation fork.
Its task message contains only:

```text
Repository: <generated repository>
Task: <generated task identifier>
```

The repository configuration identifies the installed executable, instance name, and Statewell home.
It contains general continuation instructions, not task progress or receipt information.
Do not supply the approved contract, checkpoint, receipt address, or earlier agent output through a second channel.

## Observed initial session

The initial session retrieved the approved contract through the installed application.
It inspected available commands and recorded continuation and dependency evidence.
It then transitioned the task to `in-progress` and appended an incomplete, uncommitted walkthrough.

The retained document check failed with exit code 1:

```text
FAIL: missing recovery steps: CONTEXT_TOO_LARGE, task contract, task checkpoint, task save, equivalenceEvidence, task continue, acceptanceEvidence, task transition
```

The check tests text presence only. It does not establish that the procedure is usable.
The checkpoint states this limitation and identifies the failed approach and its command.

The initial session sent one POST to the controlled receipt service.
The service stored the receipt and closed the connection without a response.
The client returned exit code 52, `Empty reply from server`.
The initial session saved that uncertain outcome, the inspection address, and a next action to inspect before retry.
It did not send a GET request or repeat the POST.

Checkpoint 5 retained the approved contract revision 1, failed check, uncommitted changes, remaining work, and uncertain effect.
The agent sent only `Checkpoint saved.` and was interrupted while still running.
It sent no final handoff.
The complete task response was identical after the disposable daemon stopped and restarted.

## Fresh session and final verification

The fresh agent retrieved checkpoint 5 and inspected the actual draft, failed check, Git state, and installed commands.
It read the receipt with GET before implementation and found exactly one stored receipt.
No POST was repeated.

Public `task continue` saved checkpoint 6 with the file inspection, current dependency evidence, and indexed receipt-resolution evidence.
The agent then completed the walkthrough and reran the retained check successfully.
It verified that the original document remained present and all documented operations appeared in installed help.
Public `task transition` recorded `done` at revision 7, with all five task acceptance checks marked passed.
The final checkpoint has no next action, blocker, or uncertain external effect.

The lead independently repeated the document check and inspected the complete diff.
Only `docs/INSTANCE-CLI.md` changed among tracked files. The original document remains an exact prefix.
The lead compared final CLI and Model Context Protocol (MCP) task responses; they were identical.
Exact MCP history reads returned six checkpoints, including the unchanged interrupted checkpoint 5.
Checkpoint 6 retained inspection and resolution evidence. Checkpoint 7 retained completion evidence.
The approved contract and approval source remained unchanged at contract revision 1.

The service log contains one POST and two GET requests.
Its receipt file contains exactly one receipt, with sequence 1 and the expected review body.
The initial session issued the POST. Both GET inspections occurred in the fresh session.

Final documentation SHA-256 before integration: `9462ef4898799e4ac4c19d54d05a81eea542844ef125733bc066b5386d595d1a`.
The lead integrated that exact walkthrough into the main checkout.
The final offline-installed package suite passed 81 tests, with 1237 assertions, in 112.23 seconds.
The archive contained exactly six permitted regular files. The installed executable matched the unchanged build.
All 21 documented operations matched compiled help. All 10 JavaScript Object Notation (JSON) examples parsed, including the indented walkthrough examples.
Whitespace and local documentation links passed.
The final done task remained exact after another disposable daemon stop and restart.
The lead then stopped the disposable daemon and receipt service while retaining their evidence.

No application code changed in this ticket.
The source suite for the same executable passed 81 tests in issue #8; it was not repeated for this documentation-only change.

## Coverage and limitations

The accepted minimum viable product target is Linux x64.
ARM64 and macOS remain unverified and deferred, despite the earlier platform text in issue #9 and its parent.
The confirmed PRODUCT decision and explicit maintainer acceptance define the current target.
No cross-build is reported as platform execution evidence.

This experiment recovers submitted state and uses working files that still exist.
It does not restore lost files, a lost database, or unrecorded thoughts.
The controlled receipt service demonstrates inspection after one lost response.
It does not establish exactly-once behavior for arbitrary external services.
The SQLite files are disposable process-recovery data. No reboot or power-loss durability result is claimed.
Formal ASD-STE100 dictionary review remains incomplete.

## Agent assistance and review

The lead prepared the approved task, isolated the environment, and controlled interruption and daemon restart.
Separate initial and fresh agents own only the disposable documentation task in sequence.
The fresh agent has no fork of the earlier conversation.
The lead owns integration, final checks, commits, and GitHub updates.
The Standards review found one missing abbreviation expansion. It was corrected and rechecked.
The Spec reviewer independently compared the retained public responses, checkpoint history, receipt counts, and integrated document digest.
Both review axes have no unresolved findings.
The reviews did not run commands against the task store; final verification remained with the lead.
