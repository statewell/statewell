# Verification: Contract approval and revisions

## Problem and scope

[Issue #6](https://github.com/statewell/statewell/issues/6) requires recorded approval without allowing progress updates or issue edits to replace requirements.
The command-line interface (CLI) and Model Context Protocol (MCP) now share approval, proposal, revision, and exact-read operations.
Tasks remain in `todo`. The contract check rejects missing approval and a checkpoint that refers to an older contract.
Workflow transitions remain in issue #7. This change does not modify the parent specification.

The implementation changes task storage, database compatibility checks, CLI dispatch and help, MCP tool descriptions, external tests, and usage instructions.
The [usage document](../INSTANCE-CLI.md#contract-approval-and-revisions) defines the fields and errors.
No backup, restoration, migration, memory, inference, task graph, scheduler, or GitHub synchronization is included.

## Environment

- Operating system: Ubuntu 24.04.4 LTS, native Linux x64.
- Bun: 1.4.2. Compile target: `bun-linux-x64-baseline`.
- Node.js: 24.20.0. npm: 11.19.0.
- Base commit: `65ff3e1278545ff430877c403a780135005dcf81`, with the issue #6 changes.
- Test storage: disposable directories in `/dev/shm`, with separate instance registration and data.
- Test inputs: public CLI and MCP requests, actual SQLite storage, controlled process termination, and interrupted socket responses.

Bun was available through the retained prototype's tooling directory, which was added to `PATH`.
No prototype source or evidence was changed.
The build includes the runtime and database worker. The installed executable needs no separate Bun installation.

## Verification steps and results

Run these commands from the repository with Bun 1.4.2 on `PATH`:

```sh
bun run typecheck
bun test tests/tasks.test.ts --timeout 15000
bun run test
bun run build
bash scripts/package-smoke.sh
git diff --check
```

The task suite requires Linux, `strace`, and permission to trace child processes.
The full suite also requires Git, Python 3, and permission to create local Unix sockets.
The package check installs a local archive with an empty npm cache and the `--offline` option.
It checks the archive file list and compares the installed executable with the build.

| Acceptance check | Observable evidence | Result |
| --- | --- | --- |
| Prepare before approval. | Creation and checkpoints retain `todo`; `task check` returns `APPROVAL_REQUIRED` before recorded approval. | Pass. |
| Record source and exact content. | CLI and MCP approval bind exact contract content and source metadata. Missing evidence and changed content fail without changes. | Pass. |
| Separate proposals from approved requirements. | A proposal preserves the current contract and checkpoint. Approval creates the next contract revision. Draft corrections need no false approval. | Pass. |
| Reject stale contracts. | Stale saves and proposal approvals return `STALE_CONTRACT_REVISION`. Overlapping approvals return one success and one `STALE_REVISION`. | Pass. |
| Treat approval as audit evidence. | Inputs require reported approval source text. CLI help, MCP descriptions, and documentation state the trust boundary. | Pass. |
| Capture issue-derived content for offline use. | Source metadata survives restart. A controlled source endpoint receives zero requests; exact reads also pass after that endpoint stops. | Pass. |
| Preserve later issue edits as unapproved. | The source endpoint offers different wording, but saved content remains exact. Dependency conditions remain text in the contract. | Pass. |
| Match interfaces and retain revisions. | Approvals, proposals, retries, current reads, and exact earlier contract reads cross CLI and MCP. | Pass. |

Additional checks cover changed retry payloads, duplicate proposals, project and instance isolation, invalid source metadata, and checkpoint reconciliation.
A source capture time requires a timezone. The submitted time remains exact.
Both interfaces reject missing approval fields. MCP schema errors can use the software development kit's native error format.

Each crash boundary runs for checkpoint saves, initial approvals, and contract revision approvals:

1. Kill at journal synchronization before database page writes.
2. Kill at database synchronization after page writes, before commit.
3. Capture the committed response, withhold it from the caller, kill the daemon, and disconnect the caller.

The first two cases return the complete prior task after restart.
The third case returns the complete committed task and original retry response.
Retries create one logical result. Approval operations add no checkpoint and preserve earlier progress.
The tests inspect system-call traces for termination timing. They read saved results only through CLI or MCP.

The source suite passed 47 tests with 493 assertions and no failures.
Type checking, compilation, and whitespace checks passed.
The offline-installed package suite passed 47 tests with 494 assertions and no failures.
The archive contained exactly six permitted regular files. The installed executable matched the build.
Assertion counts differ because the existing concurrent removal test checks each observed failure response.
The executable SHA-256 value was `95d817608cb0a2dd1e72eaf03557a089287bcd159720a76dee306c5955bb2151`.

### Earlier schema check

The previous executable was retained before the build.
Its SHA-256 value was `d0805773f30376019715ebfd3ad74ba81a7856b4f999c5ebd5b96a3a08dd5a35`.
SHA-256 is the file digest used to compare the executables and database bytes.

To repeat the check:

1. Use the #5 executable to create a disposable instance and save a task.
2. Stop that daemon and record the database digest.
3. Start the instance with the #6 executable.
4. Confirm `INVALID_STORE` and compare the database digest with the original digest.
5. Start the instance with the #5 executable and read the original task.

The #6 executable returned `INVALID_STORE` without changing the database bytes.
The #5 executable then returned the exact saved task, checkpoint, and instance identity.
Schema version 2 applies only to newly created stores. No migration runs.

## Coverage and limitations

The contract check covers recorded approval and checkpoint agreement only.
It does not independently verify evidence, dependencies, blockers, repository state, or authorization for external actions.
It returns no durable permission token. Later changes can invalidate its result.
State transitions and their additional enforcement remain issue #7 work.

Exact contract and proposal reads need identifiers supplied by the caller.
Listing, checkpoint history selection, and bounded recovery context belong to later tickets.
All prior checkpoint-save crash checks remain in the suite.

Process-crash evidence does not establish recovery after power loss, database corruption, or database loss.
ARM64 and macOS execution remain unverified and deferred after the minimum viable product (MVP).
Other Linux system-library variants and minimum operating-system versions are not established by this run.

Documentation was checked against confirmed product decisions, current fields, error behavior, and domain terms.
Local file and heading links passed. The Standards review found no documented language-rule violations.
Formal ASD-STE100 dictionary review remains incomplete.

The Bun transaction behavior was checked through Context7 against [the Bun SQLite documentation](https://github.com/oven-sh/bun/blob/main/docs/runtime/sqlite.mdx).
The timestamp validator was checked against [the Zod documentation](https://github.com/colinhacks/zod/blob/main/packages/docs/content/api.mdx).

## Agent assistance

The lead agent implemented the change and ran the external tests, type check, build, and earlier-schema check.
An independent spec precheck identified the restriction on proposals for unapproved drafts.
A failing regression test reproduced that restriction. The corrected implementation passed the test.
The lead retained integration, final verification, commits, and issue updates.

## Review status

The maintainer requested issue #6 through the work-ticket skill.
Confirmed decisions authorize Bun with `bun:sqlite` and Linux x64 for the MVP.
The selected CLI/MCP test boundary was accepted in parent issue #1.

The Standards review found no documented violations and suggested explicit typed operation dispatch.
That suggestion was implemented and rechecked. Both final test runs include the change.
The Spec review found no remaining omissions, incorrect behavior, or scope creep.
Both review axes have zero unresolved findings.
Push verification, the issue report, and maintainer acceptance remain pending.
