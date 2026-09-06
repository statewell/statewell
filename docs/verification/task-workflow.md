# Verification: Task progress and completion

## Problem and scope

[Issue #7](https://github.com/statewell/statewell/issues/7) requires controlled task transitions with durable checkpoints and reported evidence.
The command-line interface (CLI) provides `task transition`. The Model Context Protocol (MCP) interface provides `task_transition`.
Both operations use the existing selected-instance boundary.
Task state, transition evidence, checkpoint, and retry response commit together.
Ordinary checkpoint saves preserve workflow state.

The change covers all five states, the approved transition matrix, blockers, completion, cancellation, and reopening.
It preserves contract approval and revision controls from issue #6.
Backups, restoration, migrations, memory, inference, scheduling, and GitHub synchronization remain excluded.
The parent specification and unrelated local files remain unchanged.

## Environment

- Base commit: `c88dd1730b69137227b64a645765889af0b88fc9`, with the issue #7 changes.
- Operating system: Ubuntu 24.04.4 LTS, native Linux x64.
- Runtime: Bun 1.4.2. Compiled target: `bun-linux-x64-baseline`.
- Package tools: Node.js 24.20.0 and npm 11.19.0.
- Test data: separate disposable directories in `/dev/shm`.
- Failure inputs: Linux process termination, `strace`, and a controlled Unix socket proxy.
- Normal development data: not used.

Linux x64 is the accepted minimum viable product (MVP) target. ARM64 and macOS remain unverified and deferred.
A cross-build does not establish platform support.

## Verification steps and results

With Bun 1.4.2 on `PATH`, run:

```sh
bun run typecheck
bun run test
bun run build
bash scripts/package-smoke.sh
git diff --check
```

The package script creates a local npm archive and installs it offline with a fresh cache and home directory.
It checks the six permitted regular files, compares the installed executable with the build, and runs the full behavioral suite.

| Acceptance check | Observable verification | Result |
| --- | --- | --- |
| Persist all five workflow states. | CLI and MCP read the saved state. Restart does not change it. | Pass in source and installed-package suites. |
| Permit each approved transition. | Both interfaces test all ten permitted different-state edges. | Pass in source and installed-package suites. |
| Reject all other transitions. | Both interfaces reject ten other different-state edges and five same-state transition requests. | Pass in source and installed-package suites. |
| Require contract approval before implementation. | An unapproved start fails without writes. Reconciled approval permits start. | Pass in source and installed-package suites. |
| Require blockers and resolution evidence. | Blocked saves require a resolution action and preserve blockers. Returning to todo requires indexed evidence for every blocker. | Pass in source and installed-package suites. |
| Require passing completion evidence and required approval. | Missing, duplicate, failed, unverified, and out-of-range entries fail. Relevant blockers and missing required approval prevent done. | Pass in source and installed-package suites. |
| Permit terminal next-action absence. | Done and cancelled accept null. Todo, in-progress, and blocked reject null. | Pass in source and installed-package suites. |
| Control cancellation and reopening. | Cancellation needs a reason and approval. Done reopening needs failure evidence and a reason. Cancelled resumption needs approval. | Pass in source and installed-package suites. |
| Keep task updates and checkpoints consistent. | Crash and response-loss checks verify the complete prior or committed state through public reads and retries. | Pass in source and installed-package suites. |
| Preserve isolation, revisions, and retries. | Overlapping transitions have one winner. Changed retries and stale contracts fail. Other projects and instances cannot access the task. | Pass in source and installed-package suites. |

### Final check results

| Check | Actual result |
| --- | --- |
| Type check | Passed. |
| Source suite | 71 passed, 0 failed, 1117 assertions, 89.00 seconds. |
| Offline-installed suite | 71 passed, 0 failed, 1123 assertions, 102.24 seconds. |
| Compiled build and help | Passed. Help lists transitions and no longer claims that they are unavailable. |
| Package contents | Exactly six permitted regular files. The installed executable matched the build. |
| Whitespace and local documentation links | Passed. |
| Earlier schema preservation | Passed with unchanged database bytes and exact earlier public reads. |

The suite contains 45 task tests, 14 instance tests, and 12 lifecycle tests.
Assertion counts can vary because a concurrent-removal test checks each observed permitted error.
The executable SHA-256 is `a5defad71e75fa86e43fce46b5deb08c5fb828ec553f1ee669ccd6a40d5e72c8`.

### Failure boundaries

The task tests cover four mutation classes: checkpoint save, initial approval, contract revision approval, and state transition.
Each class runs at three failure boundaries:

1. Kill at journal synchronization before database page writes. Restart reads the exact prior state.
2. Kill after database page writes and database synchronization, before commit. Restart rolls back the journal and reads the prior state.
3. Withhold a committed response, kill the daemon, and disconnect the caller. Restart reads the exact committed state.

Retries return the original logical response without another checkpoint, contract revision, or state change.
The transition cases include cancellation reason, approval source, and a null next action.
System-call traces establish fault timing. CLI and MCP responses establish saved state.
The tests do not query private database tables to determine results.

### Earlier schema preservation

The previous executable has SHA-256 `95d817608cb0a2dd1e72eaf03557a089287bcd159720a76dee306c5955bb2151`.
The preservation check uses a disposable instance created by that executable.

1. Register a disposable project. Create a task and record approval through the previous CLI.
2. Terminate the previous daemon. Record the database SHA-256 digest.
3. Start the new executable against that instance. Require `INVALID_STORE`.
4. Compare the database digest. Require unchanged bytes.
5. Restart the previous executable. Require the exact earlier task, checkpoint, approval, and instance identity.
6. Remove only the disposable test directory.

The new executable returned `INVALID_STORE`. The database digest remained `0ca420882339ef715da702abc26a442876fc4eb48597c35890c02b813b11c8fe`.
The earlier executable then returned the exact saved task, checkpoint, approval, and instance identity.
The new schema is version 3. No migration or data deletion is implemented.

## Coverage and limitations

`completionApprovalRequired` belongs to the approved contract. Omission means no separate completion approval is required.
The trusted reporting agent must encode any required approval before contract approval.
Statewell cannot infer an omitted approval requirement from ordinary text.

Blockers affect completion unless explicitly marked `affectsCompletion: false`.
The reporting agent must assess relevance and describe the actual blocker-resolution action honestly.
Statewell validates fields and indices. It does not certify evidence truth, run acceptance checks, or authenticate the maintainer.
Reported approval binds to the stored transition, checkpoint, and current contract revision.

The latest transition remains visible after checkpoint saves. Earlier transitions remain stored with earlier checkpoints.
History selection and context bundles remain later ticket work.
`task check` continues to check contract approval and checkpoint agreement only. A successful check does not grant external-action authority.

A state transition cannot reconcile an earlier checkpoint and start implementation in one request.
An ordinary done checkpoint save cannot introduce relevant blockers or replace completion evidence after a contract revision.
Reopening uses the required controls and preserves the contract.

Power loss, corruption, database loss, and exactly-once external actions are not established by these tests.
Earlier schema stores require their compatible executable.
Formal ASD-STE100 dictionary review remains incomplete.

## Agent assistance

The lead agent implemented the change and owns integration, final verification, commits, and issue updates.
A separate agent performed a read-only specification precheck without shared test data.
The precheck found a blocker-removal bypass in ordinary checkpoint saves.
A failing regression reproduced the issue. The fix preserves existing blockers and permits appended blockers.
The reviewer rechecked the fix and found no further concrete specification gaps.

## Review status

The maintainer requested implementation with `$work-ticket 7`.
The parent specification supplies the accepted CLI/MCP testing boundary with disposable real SQLite data.
The formal Standards review found stale CLI help and missing abbreviation expansions. Both findings were corrected and rechecked.
The suggested shared index-coverage helper was implemented. Final source and package suites passed after that change.
The Spec review found the same stale help. The reviewer confirmed its correction and the unchanged index-validation behavior.
No unresolved findings remain on either review axis.
Verification passed. Push verification, issue reporting, and maintainer acceptance for closure are pending.
