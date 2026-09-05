# Verification: Task persistence

## Problem and scope

[Issue #5](https://github.com/statewell/statewell/issues/5) requires durable task and checkpoint saves through both interfaces.
Both the command-line interface (CLI) and Model Context Protocol (MCP) use the same task storage.
This change adds task preparation, checkpoint saves, exact reads, revision checks, and persisted retry responses.
Approval and workflow transitions remain unavailable. Tasks remain in `todo`.
Backups, restoration, migrations, memory, inference, and dependent tickets are outside scope.

The base is `dfaac61287d65f579cb9a57eb37df53133a560a4`, including merged pull request (PR) #10.
The change preserves its Apache-2.0 license, notices, package checks, and contribution rules.
Unrelated README and local design documents are outside this contribution.

## Environment

Ubuntu 24.04.4 LTS, Linux x64, Bun 1.4.2, Node 24.20.0, and npm 11.19.0.
The executable target is `bun-linux-x64-baseline`.
Linux x64 is the accepted minimum viable product (MVP) target. ARM64 and macOS remain unverified and deferred.
The source checks use Bun 1.4.2 and disposable `/dev/shm/statewell-task-*` directories.
Crash checks require `strace` and permission to trace child processes.
The existing lifecycle checks also require Python 3.

## Verification steps and results

Run these commands from the repository with Bun on `PATH`:

```sh
bun run typecheck
bun run test
bun run build
bash scripts/package-smoke.sh
git diff --check
```

The package script installs the archive offline into a fresh directory.
It checks the six permitted package files, including `LICENSE` and `NOTICE`.
It compares the installed executable with the build and runs all three test files.

| Acceptance check | Test in `tests/tasks.test.ts` | Expected result | Actual result | Status |
| --- | --- | --- | --- | --- |
| Separate task contract and progress. | CLI and MCP preserve exact task contracts and checkpoints across restart. | Exact contract and checkpoint survive restart. | Passed in source and installed-package runs. | Pass. |
| Require all checkpoint fields. | Invalid checkpoints and workflow shortcuts leave task state unchanged. | Missing fields, invalid absence, and unsupported workflow fields fail without changes. | Passed in source and installed-package runs. | Pass. |
| Commit task, checkpoint, and retry response together. | Retry and crash tests. | One revision and checkpoint per successful logical save. | Passed in source and installed-package runs. | Pass. |
| Terminate before and after commit. | All three death tests. | Complete prior state or complete new state, with safe retry. | Passed in source and installed-package runs. | Pass. |
| Reject changed retry payloads. | Retries preserve the original result and reject changed payloads without another checkpoint. | Conflict preserves state; valid retry returns the original response. | Passed in source and installed-package runs. | Pass. |
| Reject stale overlapping writes. | Overlapping CLI and MCP saves reject stale revisions with a specific error. | One success and one `STALE_REVISION`. | Passed in source and installed-package runs. | Pass. |
| Preserve project and instance separation. | Tasks and retry keys remain independent across projects and instances. | No task or retry result crosses the selected scope. | Passed in source and installed-package runs. | Pass. |
| Use actual SQLite through both interfaces. | All task tests. | Real selected instances; no approval or completion shortcut. | Passed in source and installed-package runs. | Pass. |

### Crash timing

The before-commit test starts the prepared instance under this trace configuration:

```sh
strace -f -yy -e trace=fsync,pwrite64 \
  -e inject=fsync:signal=SIGKILL:when=1 -o /disposable/trace \
  statewell instance start --instance test
```

The test verifies that the trace reaches the journal synchronization and contains no database page write.
The request is a checkpoint save through MCP. The caller receives `RESPONSE_INTERRUPTED`.
After restart, CLI reads the exact prior state and retries the update.
MCP retries the same request and receives the same result, with one additional checkpoint.

A second pre-commit test kills the daemon at database synchronization after page writes.
Its trace must contain database page writes and the database synchronization call.
This check initially failed: read-only startup inspection could not roll back the pending journal.
The fix checks the SQLite file header, schema version, and Statewell application identifier before opening for journal recovery.
SQLite then rolls back the journal before the normal schema and identity checks.
The regression now passes: MCP reads the exact prior checkpoint, then a retry commits one update.
This is normal [SQLite crash recovery](https://www.sqlite.org/lockingv3.html#dealing_with_hot_journals), not a backup or migration operation.
The header checks use the [documented SQLite file format](https://www.sqlite.org/fileformat.html#the_database_header).

The after-commit test places a bounded proxy at the disposable Unix socket endpoint.
The proxy forwards the CLI request, retains the successful response, and kills the daemon before forwarding any response bytes.
CLI receives `RESPONSE_INTERRUPTED`.
After restart, MCP reads and retries the exact committed result. The checkpoint count increases by one.
These tests use SQLite filesystem events only to control failure timing.
All saved-state assertions use CLI or MCP. No internal worker mock or direct database query serves as an oracle.

### Earlier schema

A separate check used the retained #4 executable to create a disposable earlier-schema instance.
Its executable SHA-256 was `0d826d0f2033923c1269ab7d9a9e49d74593c333096be2fec229d6d30c55cedd`.
The new executable returned `INVALID_STORE` at startup.
The database SHA-256 was unchanged. Repeated setup through the earlier executable returned its original identity.
To repeat this check, build #4 in a separate checkout, create a disposable named instance, and record its database hash.
Start that instance with this build. Compare the hash and repeat setup with the earlier executable.
Do not use normal work data.

## Coverage and limitations

The initial focused source run passed seven task tests with 94 assertions.
The added journal-recovery regression passed with 15 assertions after its failing run.
The final configured source suite passed 34 tests, with 259 assertions. Type checking and the build passed.
The final offline installed-package suite passed 34 tests, with 257 assertions. All six archive files passed inspection.
The executable SHA-256 is `d0805773f30376019715ebfd3ad74ba81a7856b4f999c5ebd5b96a3a08dd5a35`.
Local documentation links and diff whitespace checks passed.
Assertion counts differ because the concurrent removal test checks each failure response observed in that run.
Initial persistence and retry tests failed before their implementation and passed afterward.
One full-suite launch failed because Bun was absent from `PATH`; the corrected command supplies its directory.

Task history is retained, but history selection, approvals, contract changes, and workflow transitions remain for later tickets.
The new schema does not migrate earlier stores. It rejects them without changes.
The crash evidence covers process death, not power loss, database loss, corruption, or arbitrary external effects.
Native ARM64 and macOS execution remain unverified under the accepted MVP scope.
No full MCP protocol conformance or formal ASD-STE100 dictionary review is claimed.

## Agent assistance

Codex implemented and tested this change.
A separate agent investigated disposable external crash controls without changing repository source.
The lead agent integrated the controls and ran task-specific checks.
The standards review found abbreviation omissions in CLI help and this verification document. Both were corrected.
The specification review recorded the journal-recovery defect. The regression and fix address that finding.
Both reviewers rechecked the fixes and found no remaining findings.
The lead ran the final source and installed-package suites after these code changes.

## Review status

The maintainer requested implementation of #5 and required consideration of the recently merged PR.
The accepted test boundary is CLI and MCP against disposable real instances.
Maintainer acceptance of the completed ticket remains pending.
