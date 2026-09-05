# Instance and project access

This implementation covers instance and project access from issue #3 and daemon lifecycle from issue #4 on Linux x64.
It provides a command-line interface (CLI) and the initial project access for the minimum viable product (MVP).
It requires Bun 1.4.2 for development. The compiled executable contains Bun and the database worker.
The executable does not require a separate Bun installation.
ARM64 and macOS remain unverified and are deferred until after the MVP.

## Build and check

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bash scripts/package-smoke.sh
```

Tests create disposable data in `/dev/shm`, outside repositories.
Tests require permission to create local Unix sockets and run Git.
The worker-failure test also requires `/usr/bin/python3` for its controlled external process.
The package check installs a local archive with an isolated npm cache and no network dependency.
The package is private. These commands do not publish it.

## Create and start an instance

Select a registration directory with `STATEWELL_HOME`.
Without that variable, Statewell uses `~/.local/share/statewell`.
Keep this directory and instance data outside repositories.
Use data directories owned by your user with mode `0700`.

```sh
export STATEWELL_HOME="$HOME/.local/share/statewell"
./dist/statewell instance create
./dist/statewell instance inspect
```

Explicit creation sets up `main`. Queries do not create a database or registration.
A CLI request can automatically start the existing `main` instance when its socket is absent or refuses the connection.
Model Context Protocol (MCP) tool requests use the same rule. Opening an MCP connection does not create an instance.
Automatic startup uses the registered identity and data directory.
Concurrent callers can connect to the daemon that completes startup first.
An unknown `main` returns `SETUP_REQUIRED`. Run explicit creation before another request.

Explicit startup runs in the foreground unless you supply `--detached`.
Use another terminal for client commands when the daemon runs in the foreground.
Terminate the foreground process with Ctrl+C or SIGTERM.

Use an explicit name for an isolated instance:

```sh
./dist/statewell instance create --instance test --data-dir "$HOME/.local/share/statewell-test"
./dist/statewell instance start --instance test --detached
```

Repeated creation preserves the registered identity and data.
If you omit `--data-dir`, repeated creation uses the registered directory.
A different explicit directory returns `DIRECTORY_CONFLICT`.
A stopped instance other than `main` requires explicit startup.
Clients return an error for that stopped instance. They do not select another instance or open SQLite directly.

## Stop an instance and remove its registration

Stop the selected daemon:

```sh
./dist/statewell instance stop --instance test
```

Stop preserves the registration, instance identity, database, and project records.
Repeating stop for a registered stopped instance returns a stopped result.
A later request can automatically start `main` again. Other instances still require explicit startup.

Remove the selected registration:

```sh
./dist/statewell instance remove --instance test
```

Removal first stops the selected daemon, then removes its local registration.
Removal preserves the data directory and its database. It does not remove project markers.
Requests for the removed registration fail until explicit setup registers an instance with that name.
An unknown name returns `SETUP_REQUIRED` for stop and removal.
An identity change returns an error instead of removing the registration.

## Select and register a project

Find the nearest Git root without creating a marker:

```sh
./dist/statewell project resolve --instance test --root "$PWD"
```

If you omit `--root` for CLI discovery, Statewell uses the CLI working directory.
Discovery removes inherited `GIT_*` overrides and preserves Git ownership checks.
A discovery failure requires explicit root selection. It does not select a parent directory.

Review the returned root. Register that exact absolute path:

```sh
./dist/statewell project register --instance test --root /absolute/project/root
./dist/statewell project inspect --instance test --root /absolute/project/root
./dist/statewell instance inspect --instance test
```

Registration can also use an explicitly selected directory outside Git.
Registration and inspection require `--root`. They do not infer a project from the daemon directory.
The marker is `.statewell.json`, with `schemaVersion: 1` and a stable `projectId`.
A valid marker is preserved. An invalid marker or conflicting `--project-id` causes an error.
Concurrent registration preserves the first complete marker.
Each instance registers the project separately. A shared marker does not import another instance's records.
If registration stops after marker creation, repeat the same explicit registration to complete the database entry.
An incompatible existing database is rejected. This version does not migrate it.

## MCP access

Start an MCP stdio process with:

```sh
./dist/statewell mcp --instance test
```

Configure the same `STATEWELL_HOME` for the MCP process and CLI.
The official MCP TypeScript software development kit (SDK) handles initialization, protocol negotiation, and tool calls.
Available tools are `instance_inspect`, `project_resolve`, `project_register`, and `project_inspect`.
Project tools accept `root`; registration and inspection also accept an optional expected `projectId`.
MCP does not use its process directory as a workspace default.
A persistent MCP client pins the first selected instance identity.
A daemon restart with the same identity preserves this connection's instance selection.
An identity or data-directory replacement returns `IDENTITY_CHANGED`.
Inspect the selected registration before reconnecting. Restart the MCP connection after explicit instance selection.
A reused name does not establish continuity with the earlier instance.

## Bounds and failure results

Each running instance has one SQLite worker and one daemon, either in the foreground or detached.
SQLite has exclusive ownership. A separate kernel-owned socket protects endpoint removal and binding.
The client socket is private to the instance owner.
A regular file or live foreign socket at the endpoint prevents startup.

The daemon accepts at most 16 connections and four pending database requests.
A request can contain at most 16384 bytes, including its newline.
Database requests have a two-second deadline. Idle client connections expire after three seconds.
The client response limit is 65536 bytes. Its absolute deadline is four seconds. Incoming bytes do not extend this deadline.
Detached and automatic startup have a five-second startup deadline.
A failed startup can take one additional second to terminate its child process.
The daemon permits three seconds for shutdown before it forces process exit.
This deadline does not establish termination of every external descendant process.

A database deadline stops the worker and fails pending requests.
Stop and restart the daemon before further database operations.
Automatic startup does not replace a live daemon whose database worker failed.
An interrupted response or worker failure can leave a write result uncertain. Inspect the project before repeating registration.
Task mutations support logical retry keys, as described below.

MCP input frames have a 16384-byte limit. MCP output frames have a 65536-byte limit.
MCP permits at most 16 pending output writes, each with a one-second deadline.
A transport-limit failure exits with code 2 and reports an error on stderr.
CLI operation failures exit with code 1 and return a JavaScript Object Notation (JSON) error on stderr.
Successful CLI operations return JSON on stdout.

These bounds apply to this initial interface. They do not promise database progress during a slow operation.
Backup, restoration, migration, memory, inference, and task state transitions are unavailable.

## Task preparation and checkpoints

Task storage is available through the command-line interface (CLI) and Model Context Protocol (MCP).
Tasks remain in `todo`. Recorded approval and contract revisions are available. Workflow transitions remain unavailable.
A saved checkpoint does not authorize implementation or certify evidence.

Use a new disposable instance for this version.
Earlier database schemas return `INVALID_STORE` without migration.
Keep earlier data and its compatible executable if you need to read that data.
Do not delete an earlier database to bypass this error.

### Prepare a task

Register the project in the selected instance first.
Create a JSON input file with this structure:

```json
{
  "taskId": "00000000-0000-4000-8000-000000000001",
  "retryKey": "prepare-task-1",
  "expectedRevision": 0,
  "contract": {
    "goal": "Check saved task persistence.",
    "scopeLimits": ["Do not change normal work data."],
    "acceptanceChecks": ["Read the exact task after restart."],
    "dependencyConditions": []
  },
  "checkpoint": {
    "progress": "Prepared the persistence check.",
    "remainingWork": ["Restart the test instance."],
    "nextAction": "Restart the test instance.",
    "blockers": [],
    "evidence": [],
    "repositoryState": {
      "worktree": "/absolute/project",
      "branch": "main",
      "commit": null,
      "uncommittedChanges": []
    },
    "uncertainExternalEffects": []
  }
}
```

Use a new task identifier and retry key for a new task.
Replace the example project and repository values with the actual selected values.

```sh
statewell task create --instance test --root /absolute/project --input /absolute/task.json
```

The CLI input must be a regular JSON file of at most 12000 bytes.
Select the project with `--root` and optional `--project-id`, not through the input file.
Unknown input fields are rejected.

The contract stores the goal, scope limits, acceptance checks, and dependency conditions separately from progress.
Each contract requires a goal and at least one acceptance check.
An empty array explicitly indicates no scope limits or dependency conditions.

Each checkpoint requires all seven content fields shown above.
Text values must contain non-whitespace characters. Statewell preserves the submitted text.
An empty array explicitly indicates no remaining work, blockers, evidence, uncommitted changes, or uncertain effects.
Each blocker requires `reason` and `continuationCondition` text fields.
The repository worktree is required. Use `null` for an absent branch or commit.
A `todo` task requires one next action. A missing field is not an absence value.

### Save a checkpoint

Use `task save` with a file that contains these fields:

- `taskId`: The saved task identifier.
- `retryKey`: A new key for this change.
- `expectedRevision`: The task revision that you read.
- `expectedContractRevision`: The current contract revision that you read.
- `checkpoint`: All required checkpoint fields.

```sh
statewell task save --instance test --root /absolute/project --input /absolute/checkpoint.json
```

Each successful save increases the task revision and adds one checkpoint.
A checkpoint save leaves the current contract and its approval unchanged.
The response includes the task, latest checkpoint, revision mismatch flag, checkpoint count, project, and instance.
Earlier checkpoints remain stored. History selection is not available through these commands.

Statewell commits the task revision, checkpoint, and retry response in one SQLite transaction.
A stale revision returns `STALE_REVISION` without a change.
A task identifier that already exists returns `TASK_EXISTS` for a new creation key.
A missing task returns `TASK_NOT_FOUND` within the selected project.

### Read and retry

For `task read`, the input file contains only `taskId`.

```sh
statewell task read --instance test --root /absolute/project --input /absolute/task-reference.json
```

A read returns the complete current contract and latest checkpoint.
It does not use GitHub, inference, or the earlier conversation.

If a save response is interrupted, preserve the original operation, input, and retry key.
Inspect the selected instance and restart it explicitly if necessary.
Retry the original request to recover its saved result.
A successful retry returns the original response, even if a later checkpoint exists.
A changed request under the same key returns `RETRY_CONFLICT` without changing state.
Read the task separately when you need its latest revision.

Retry keys belong to the selected project within one instance.
The operation, task, resolved project root, expected revision, and content identify the retry payload.
JSON object field order does not change the payload. Array order and text content do change it.
Retry results remain stored; automatic removal is not implemented.
Statewell retries do not make external actions execute exactly once.

### MCP operations

Use the task tools listed below through the selected MCP instance.
Their arguments contain the same fields as CLI input, plus `root` and optional `projectId`.
The shared task validation and transaction rules apply to both interfaces.
Protocol schema errors can use MCP error formatting.
Task results contain the same JSON response as CLI results.

### Task verification

Run the task checks with disposable data:

```sh
bun test tests/tasks.test.ts --timeout 15000
```

The crash checks require Linux, `strace`, and permission to trace child processes.
The before-commit check kills the daemon at journal synchronization before database page writes.
A second pre-commit check kills the daemon after database page writes and verifies automatic journal rollback.
The after-commit check withholds the socket response, kills the daemon, and then disconnects the caller.
All crash checks read and retry through CLI or MCP after restart.
No application fault flag or direct database query determines the saved result.

## Contract approval and revisions

Issue #6 adds recorded approval, separate proposals, and exact contract revision reads.
The initial contract is revision 1, with `approval: null`.
Preparation and checkpoint saves do not approve that contract.

Approval is reported audit evidence. Statewell trusts the local agent to report the maintainer's approval honestly.
It does not authenticate the maintainer or certify evidence truth.
An explicit user request can supply the approval source. Do not request equivalent confirmation again.

### Record initial approval

Use `task approve` with these input fields:

- `taskId`: The prepared task identifier.
- `retryKey`: A new key for this approval.
- `expectedRevision`: The current task revision.
- `expectedContractRevision`: The current contract revision.
- `contract`: The exact saved contract object.
- `source`: The exact saved source object, or `null` when absent.
- `approval`: An object with nonempty `source` text that identifies the actual approval.

For example, `approval` can contain this reported user request:

```json
{"source":"Session request: Implement the saved task under these requirements."}
```

Supply the complete request in a regular JSON file:

```sh
statewell task approve --instance test --root /absolute/project --input /absolute/approval.json
```

Initial approval preserves contract revision 1 and increases the task revision.
It adds no checkpoint. A different contract or source returns `APPROVAL_CONTENT_MISMATCH`.
A missing approval source is invalid. A second initial approval with a new key returns `ALREADY_APPROVED`.
Use the original key to retrieve an uncertain approval result.

### Capture issue requirements

For requirements from an issue, supply a self-contained `contract` and its `source` during creation or proposal.
The source requires a reference and an ISO 8601 capture time with a timezone:

```json
{
  "reference": "https://github.com/example/project/issues/42",
  "capturedAt": "2026-09-05T12:00:00Z"
}
```

ISO 8601 defines the date and time format used here.
Statewell stores the submitted capture time. It does not verify when the source was read.
For requirements without an external source, omit `source` or supply `null`.
For issue-derived requirements, the reporting agent must include the source and capture time.
Statewell cannot infer an omitted issue reference from ordinary contract text.

Statewell does not fetch the reference. It needs no GitHub access to approve, read, or check saved requirements.
Later issue edits cannot change a saved contract. Submit a separate proposal and record approval to adopt those edits.
Dependency conditions remain contract text. No task graph or scheduler is provided.

### Propose and approve a change

Use `task propose` with `taskId`, `retryKey`, both expected revisions, `proposalId`, `contract`, and optional `source`.
Use a new universally unique identifier (UUID) for `proposalId` and include the complete proposed contract.
A proposal increases the task revision. It leaves the current contract, approval, and latest checkpoint unchanged.
Proposals can correct an unapproved draft. Proposal creation does not require approval of rejected content.

```sh
statewell task propose --instance test --root /absolute/project --input /absolute/proposal.json
```

To adopt a proposal, use `task approve` with its `proposalId` in addition to the approval fields above.
The contract and source must match the saved proposal exactly.
Approval creates the next contract revision and increases the task revision.
Earlier contract content, source records, and approval evidence remain available.
The proposal also remains available with its original base contract revision.

A proposal based on an older contract returns `STALE_CONTRACT_REVISION` when approved against a newer contract.
Prepare a new proposal after comparing the current requirements.
A reused proposal identifier with a new retry key returns `PROPOSAL_EXISTS`.
Progress updates cannot contain contract or approval fields.

### Check the contract before implementation

Before implementation, call `task check` with `taskId`, `expectedRevision`, and `expectedContractRevision`.
This read-only operation checks recorded approval and checkpoint agreement. It does not start or execute work.

```sh
statewell task check --instance test --root /absolute/project --input /absolute/check.json
```

Without approval, the check returns `APPROVAL_REQUIRED`.
After a contract change, `task read` returns the latest checkpoint with `contractMismatch: true`.
The checkpoint retains its original `contractRevision`. It is not replaced by an earlier matching checkpoint.
The check returns `CHECKPOINT_CONTRACT_MISMATCH` until a new checkpoint records reconciliation with the current contract.
Compare the checkpoint with the new requirements before saving that checkpoint.
Statewell validates the submitted revision, not the truth of the reported comparison.

A stale task revision returns `STALE_REVISION` first.
With the current task revision, a stale contract revision returns `STALE_CONTRACT_REVISION`.
Saves, proposals, approvals, and checks require both expected revisions.
A successful check returns the current task and checkpoint. It is not a durable permission token.
Later changes can invalidate that result.

Check actual repository state, dependencies, blockers, and uncertain effects before work.
Recorded approval does not authorize unrelated external actions.
This check covers contract controls only. Workflow transitions and their additional controls belong to issue #7.

### Read exact records

Use `task contract` with `taskId` and `contractRevision` to read one retained contract.
Its `value.contract` contains `revision`, `content`, `source`, and `approval`.
Use `task proposal` with `taskId` and `proposalId` to read one proposal.
Its `value.proposal` contains `id`, `baseContractRevision`, `contract`, and `source`.
Both operations use the selected project and instance. Neither changes the current task.

```sh
statewell task contract --instance test --root /absolute/project --input /absolute/contract-reference.json
statewell task proposal --instance test --root /absolute/project --input /absolute/proposal-reference.json
```

Missing records return `CONTRACT_NOT_FOUND` or `PROPOSAL_NOT_FOUND`.
Record identifiers and revision numbers must be retained by the caller. Listing and checkpoint history selection remain separate work.
Reads do not return an unbounded contract history.

### Task interface mapping

| CLI operation | MCP tool |
| --- | --- |
| `task create` | `task_create` |
| `task save` | `task_save` |
| `task read` | `task_read` |
| `task approve` | `task_approve` |
| `task propose` | `task_propose` |
| `task check` | `task_check` |
| `task contract` | `task_contract` |
| `task proposal` | `task_proposal` |

All mutations commit their state change and retry result together.
Approval and proposal operations preserve the latest checkpoint; only creation and checkpoint saves add a checkpoint.
A retry returns its original result before stale-revision checks, even after later approvals or saves.
The current schema version is 2. Earlier stores remain unchanged and require their earlier executable.
