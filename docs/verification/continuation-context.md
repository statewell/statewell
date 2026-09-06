# Verification: Continuation context

## Problem and scope

[Issue #8](https://github.com/statewell/statewell/issues/8) requires complete continuation context, exact history, linked corrections, and reported inspection before continuation.
JavaScript Object Notation (JSON) is the request and response format.
The command-line interface (CLI) and Model Context Protocol (MCP) use the same task operations.
`task context` returns all required records or a size error with exact references.
`task checkpoint` reads retained history. `task continue` records inspection with a new checkpoint and retry result.
Ordinary saves and transitions also preserve repository and uncertain-outcome inspection obligations.

Backups, restoration, migrations, memory, inference, scheduling, and GitHub synchronization remain outside scope.
The parent specification and unrelated repository files are unchanged.

## Environment

Base commit: `8f138f94d7a67c83cba7fb57cfda1e620c3359b8`, with the ticket changes.
Native Linux x64, Ubuntu 24.04.4 LTS, Bun 1.4.2, Node.js 24.20.0, and npm 11.19.0.
Compiled target: `bun-linux-x64-baseline`.
Tests use separate temporary directories and actual SQLite databases through running CLI and MCP instances.
No normal development store is used.

## Verification steps and results

With Bun 1.4.2 on `PATH`, run:

```sh
bun run typecheck
bun test tests/tasks.test.ts --timeout 15000
bun run test
bun run build
bash scripts/package-smoke.sh
git diff --check
```

The task suite passed 53 tests before the additional interruption check.
The added interruption check passed separately.
Type checking, compilation, and whitespace checks passed.
The initial full run passed 79 tests and failed one lifecycle expectation.
Six concurrent reads can return the documented `OVERLOADED` result from the four-request queue.
The lifecycle expectation now includes that result and retains the post-removal setup check.
The full rerun passed 80 tests with 1232 assertions in 98.71 seconds.
The later duplicate-outcome regression passed separately. Final source and installed-package results remain pending.

| Acceptance check | Observable evidence |
| --- | --- |
| Retain history and linked corrections. | A correction becomes current. Exact CLI and MCP reads preserve earlier content. Predecessor references cross approval revision gaps. |
| Return the latest mismatched checkpoint. | A revised contract is returned with the latest earlier checkpoint, both revisions, and `contractMismatch: true`. |
| Require separate reconciliation. | Continuation returns `CHECKPOINT_CONTRACT_MISMATCH` until a separate save records reconciliation. |
| Reject incomplete context. | A 256-byte request returns `CONTEXT_TOO_LARGE` and exact references. Both interfaces read the complete referenced records. |
| Include required saved work. | Tests compare exact contracts and checkpoints, including dependency conditions, failed-approach evidence, and uncertain effects. |
| Inspect a different branch or worktree. | Missing equivalence evidence returns `REPOSITORY_EQUIVALENCE_REQUIRED`. The selected root and checkpoint must match the reported inspection. |
| Inspect uncertain outcomes before retry. | Continuation rejects missing resolution evidence. Saves cannot erase an uncertain effect without indexed resolution evidence. |
| Require dependencies and work offline. | Missing dependency evidence fails. Saved context is read after the controlled issue endpoint stops, without fetching its content. |
| Check isolation and external behavior. | Project and instance boundaries reject unrelated reads and correction links. Malformed, stale, and changed-retry requests preserve saved work. |

All saved-result assertions use public CLI or MCP operations.
No internal table query serves as the saved-result oracle.
The retained crash suite covers saves, approvals, revisions, and transitions at three failure boundaries.
The continuation test terminates the daemon at journal synchronization before database page writes.
The prior task remains exact. Retry records one checkpoint with its correction and inspection evidence.
Acknowledged continuation also survives process restart and returns its original retry result.

### Earlier schema preservation

A disposable store was created and approved with the #7 executable.
The #8 executable rejected startup with `INVALID_STORE`.
The database SHA-256 remained `5111e2eca4b262e8d744bd0701d66b9af9f47a2016eeb5c49d92ad8cf598059d`.
The #7 executable then read the exact original task, approval, checkpoint, and instance identity.
No migration or restoration was performed.

Prior executable SHA-256: `a5defad71e75fa86e43fce46b5deb08c5fb828ec553f1ee669ccd6a40d5e72c8`.
Candidate executable SHA-256: `f5de923baa79605f86d763667f7b4cf1934156e939dc43c87d6a07e689f4d429`.

To repeat this check, keep the prior executable before building.
Create a disposable named instance and approved task with that executable, then stop its daemon.
Compare database digests before and after rejected startup with the new executable.
Restart the prior executable and compare the full public task response with the original response.
Remove only the disposable test data after verification.

## Failures and review

The first correction test failed because the field was unavailable.
The first context test failed because the operation was unavailable.
A later test found that error details were lost between the worker and client. Both error boundaries now preserve them.
The first continuation test failed because the operation was unavailable.
The first predecessor test failed because no exact history reference was returned.

A preliminary Spec review found that an ordinary save could bypass continuation inspection by changing the worktree and clearing uncertain effects.
A failing regression reproduced that behavior.
Saves and transitions now require recorded equivalence and indexed effect-resolution evidence when those fields change.
A second regression found duplicate uncertain-effect descriptions could lose one unresolved occurrence.
Preservation now matches each occurrence separately.
Standards review requested the JSON expansion and a shared effect-resolution schema. Both changes are applied.
Formal committed reviews remain pending.

## Coverage and limitations

Schema version 4 rejects earlier stores without migration. Keep their compatible executable for access.
Evidence is reported by the trusted local agent. Statewell does not authenticate approval or independently inspect files or external services.
A successful context read does not authorize implementation or an external action.
The context limit measures the complete JSON value in UTF-8 bytes. Interface envelopes and error guidance are separate.
Exact reads must use the same selected instance. Recheck task revisions after reading several references.
No task listing, automatic branch switch, file copy, or external retry is performed.

Linux x64 is the accepted minimum viable product target.
ARM64 and macOS remain unverified and deferred. Cross-compilation is not platform execution evidence.
Power loss, corruption, database loss, and lost working files are not established recovery capabilities.
Formal ASD-STE100 dictionary review remains incomplete.

## Agent assistance and status

The lead agent implemented the change and owns integration, final verification, commits, and issue updates.
An independent agent performed the preliminary Spec check without repository edits or shared test data.
The maintainer explicitly requested tickets #8 and #9 in sequence.
Ticket #9 remains unstarted until #8 passes verification and dependency completion.
