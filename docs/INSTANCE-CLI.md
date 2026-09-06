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
Backup, restoration, migration, memory, and inference are unavailable.

## Task preparation and checkpoints

Task storage is available through the command-line interface (CLI) and Model Context Protocol (MCP).
Tasks start in `todo`. Recorded approval, contract revisions, and workflow transitions are available.
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
A checkpoint save leaves the workflow state, current contract, and its approval unchanged.
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
This check covers contract controls only. Use the workflow transition controls below before starting work.

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
Record identifiers and revision numbers must be retained by the caller. Task listing remains separate work. Use checkpoint references to inspect retained history.
Reads do not return an unbounded contract history.

### Task interface mapping

| CLI operation | MCP tool |
| --- | --- |
| `task create` | `task_create` |
| `task save` | `task_save` |
| `task transition` | `task_transition` |
| `task read` | `task_read` |
| `task context` | `task_context` |
| `task checkpoint` | `task_checkpoint` |
| `task continue` | `task_continue` |
| `task approve` | `task_approve` |
| `task propose` | `task_propose` |
| `task check` | `task_check` |
| `task contract` | `task_contract` |
| `task proposal` | `task_proposal` |

All mutations commit their state change and retry result together.
Approval and proposal operations preserve the latest checkpoint; creation, saves, continuations, and state transitions add a checkpoint.
A retry returns its original result before stale-revision checks, even after later approvals or saves.
The current schema version is 4. Earlier stores remain unchanged and require their earlier executable.


## Task progress and completion

Issue #7 adds `task transition` and the `task_transition` MCP tool.
A transition changes workflow state and saves its checkpoint and retry result in one transaction.
Session termination does not change workflow state.
Use `task save` for a checkpoint update that keeps the same state.

| Current state | Permitted different state |
| --- | --- |
| `todo` | `in-progress`, `blocked`, `cancelled` |
| `in-progress` | `blocked`, `done`, `cancelled` |
| `blocked` | `todo`, `cancelled` |
| `done` | `todo` |
| `cancelled` | `todo` |

Every other transition returns `INVALID_TRANSITION`, including a transition to the current state.
Each transition requires `taskId`, `retryKey`, `expectedRevision`, `expectedContractRevision`, `state`, and a complete `checkpoint`.
Supply the additional evidence fields required below. Evidence fields for another transition are rejected.

```sh
statewell task transition --instance test --root /absolute/project --input /absolute/transition.json
```

MCP uses the same fields, with `root` and optional `projectId`.
All text must be nonempty. Omitted required fields and unknown fields are rejected.
The task revision and checkpoint count each increase by one after a successful transition.
Stale requests and retries follow the same rules as checkpoint saves.

### Start implementation

The transition from `todo` to `in-progress` requires recorded contract approval.
After a contract change, reconcile the latest checkpoint before starting implementation.
A transition cannot perform that reconciliation and start work in the same request.

For each contract dependency condition, supply one `dependencyEvidence` entry:

```json
{"conditionIndex":0,"evidence":"The maintainer accepted the dependency in its completion report."}
```

Indices start at zero and refer to the current contract array.
Duplicate, missing, or out-of-range indices return `DEPENDENCY_EVIDENCE_REQUIRED`.
Omit the field or use an empty array when the contract has no dependency conditions.
Statewell records the evidence without inspecting another ticket or running a scheduler.

### Record and resolve blockers

A blocked checkpoint requires at least one blocker with a `reason` and `continuationCondition`.
Its `nextAction` must describe the action needed to resolve the blocker.
Statewell requires nonempty text. The reporting agent must check that the text describes the actual resolution action.
A blocked checkpoint save preserves existing blockers in their current order. It can append blockers.
It cannot remove, replace, or reorder them to bypass resolution evidence.

To return from `blocked` to `todo`, supply `blockerResolutions` for every blocker in the latest checkpoint:

```json
[{"blockerIndex":0,"evidence":"The test service started and returned the expected response."}]
```

Indices start at zero. Each index must occur exactly once.
The new checkpoint must have an empty `blockers` array and a nonempty next action.
Missing resolution evidence returns `RESOLUTION_REQUIRED`.
Resolution records do not certify that the condition is satisfied.

### Complete work

Only `in-progress` can transition to `done`.
Completion requires approval of the current contract and a checkpoint reconciled with that contract.
Supply one `acceptanceEvidence` entry for each current acceptance check:

```json
[{"checkIndex":0,"status":"passed","evidence":"The fresh process read the exact saved task."}]
```

Indices start at zero. Each check must occur exactly once, with nonempty evidence and `status: "passed"`.
Missing, duplicate, out-of-range, failed, or unverified entries return `COMPLETION_EVIDENCE_REQUIRED`.

Every blocker affects completion unless its checkpoint entry explicitly contains `affectsCompletion: false`.
A relevant unresolved blocker returns `UNRESOLVED_BLOCKER`.
The reporting agent must assess relevance honestly. Statewell does not independently verify that assessment.
Uncertain external effects still require actual inspection and a blocker when the outcome prevents completion.

Set `completionApprovalRequired: true` in the task contract when completion needs human approval.
Omission or `false` means that no separate completion approval is required.
This field is part of the exact approved contract. Progress updates cannot change it.
The reporting agent must encode any required completion approval in this field before contract approval.
Statewell cannot infer an omitted approval requirement from ordinary contract text.

When required, supply `approval: {"source":"The maintainer accepted the completion results."}` in the transition request.
Initial contract approval does not substitute for required completion approval.
The saved transition binds this reported approval to the current contract revision, checkpoint, and acceptance evidence.
Statewell validates the evidence fields. It does not run the checks, authenticate the maintainer, or certify success independently.

### Cancel or reopen work

Cancellation requires a nonempty `reason` and an `approval` object with nonempty `source` text.
For example, the source can identify an explicit maintainer request to cancel the task.
The resulting state is `cancelled`. It does not indicate successful completion.

To return from `done` to `todo`, supply a nonempty `reason` and a nonempty `failureEvidence` array of nonempty text.
To return from `cancelled` to `todo`, supply approval that identifies the maintainer's request to resume work.
Cancellation approval does not substitute for resumption approval.
Neither reopening operation changes the contract or its approval.
A resumed unapproved task still needs initial contract approval before implementation.

### Read retained transition evidence

`checkpoint.transition` contains the transition recorded with that checkpoint, or `null` for ordinary checkpoint saves.
`task.lastTransition` contains the latest transition and its `checkpointRevision`, or `null` before the first transition.
It preserves the reason, approval, and evidence after later checkpoint saves.
Transition records include the prior state, resulting state, and contract revision.
Earlier transitions remain available through exact checkpoint reads.

Done and cancelled checkpoints permit an explicit `nextAction: null`.
Other states require a nonempty next action, including after reopening.
A done checkpoint save cannot introduce a relevant unresolved blocker.
If an approved contract revision changes completed requirements, ordinary saves cannot replace the earlier completion evidence.
Reopen with failure evidence and a reason before addressing the changed requirements.
Contract approval alone does not change workflow state.

## Continuation context

Use `task context` with `taskId` and optional `maxBytes`.
The corresponding MCP tool is `task_context`.
The operation returns the complete current task, latest checkpoint, checkpoint count, mismatch flag, and continuation instructions.
It does not execute work or certify that continuation is safe.
The saved contract includes dependency conditions. Checkpoints retain progress, failed approaches, evidence, repository state, and uncertain external effects.
No inference provider or GitHub connection is used.

`maxBytes` limits the UTF-8 bytes of the JSON `value` object, before the interface adds its envelope.
The default and maximum are 16000 bytes. The minimum is 256 bytes.
The limit applies to a successful context bundle. An error can exceed the requested limit to supply recovery instructions and references.
The transport limits remain separate.

If required content does not fit, the operation returns `CONTEXT_TOO_LARGE`.
The error includes `details.complete: false`, `requiredBytes`, `maxBytes`, current revision identifiers, task state, and `contractMismatch`.
It also includes instructions and `references.contract`, `references.checkpoint`, and, when present, `references.lastTransition`.
References select exact records in the same project and instance.
Each reference is an MCP argument object. Call `task_contract` for the contract and `task_checkpoint` for checkpoint references.
For CLI reads, pass `root` and `projectId` as command options. Put the other reference fields in the input file.
Use the same selected instance for every reference.
Read all references before continuation. Check the current task revision after those separate reads.
A size error is not an incomplete successful bundle or permission to omit constraints.

### Checkpoint history and corrections

Use `task checkpoint` with `taskId` and `checkpointRevision` to read an exact retained checkpoint.
Its response includes `value.checkpoint`, with the saved content, contract revision, transition, and any continuation evidence.
Each checkpoint includes `previousCheckpointRevision`. A null value identifies the first checkpoint.
Follow this reference to inspect earlier history. Task revisions without checkpoints do not interrupt this chain.
A missing checkpoint returns `CHECKPOINT_NOT_FOUND`.

To correct an earlier checkpoint, save a complete new checkpoint with `correctedCheckpointRevision` in its content.
The referenced checkpoint must exist in the selected task and project.
The correction becomes current. The earlier checkpoint and evidence remain available.
Corrections follow normal state, revision, retry, repository inspection, and external-outcome controls.
They cannot replace the approved contract or erase required inspection evidence.

### Record inspection before continuation

Use `task continue` with both expected revisions, a retry key, and a complete checkpoint.
This operation preserves `todo` or `in-progress` state. Other states require resolution or reopening first.
A task in `todo` still needs the normal transition to `in-progress` before implementation.

Supply these additional fields:

| Field | Required content |
| --- | --- |
| `inspection.repositoryState` | The inspected repository state, with the same fields as the checkpoint repository state. |
| `inspection.evidence` | Nonempty text that identifies the actual file and repository inspection. |
| `inspection.equivalenceEvidence` | Nonempty comparison evidence when the earlier checkpoint names a different branch or worktree. |
| `dependencyEvidence` | One entry per current dependency condition, with `conditionIndex` and nonempty `evidence`. |
| `externalEffectResolutions` | One entry per uncertain effect in the latest checkpoint, with `effectIndex` and nonempty `evidence`. |

Use empty arrays when no dependencies or uncertain effects exist.
Indices start at zero. Missing, duplicate, and out-of-range indices are rejected.
The inspected worktree must equal the selected canonical root.
The new checkpoint must record the same repository state as the inspection.
It must have no blockers or uncertain external effects.

Inspect actual files and results before reporting this evidence.
A different branch or worktree requires recorded equivalence, or maintainer direction.
Statewell does not switch branches, copy files, execute checks, or retry external actions.
If an external outcome remains unknown, record a blocker and request direction. Do not report a fabricated resolution.

Current contract approval is required.
After a contract mismatch, compare the current requirements and save a reconciled checkpoint first.
A continuation cannot perform that reconciliation and authorize continued implementation in the same request.
Successful continuation saves its checkpoint, inspection evidence, and retry result together.
`checkpoint.continuation` identifies the inspected earlier checkpoint and the reported inspection, dependency, and external-outcome evidence.
Later saves preserve this record in history.

The trusted local agent reports evidence honestly. Statewell validates fields and references, not the truth of inspection or approval.
`task check` remains limited to contract approval and checkpoint agreement.
A successful read, check, save, or continuation does not grant permission for an unrelated external action.

### Preserve inspection obligations during saves

Ordinary saves and transitions cannot silently replace a branch or worktree, or remove an uncertain effect.
When those fields change, include `checkpoint.review`:

```json
{
  "previousCheckpointRevision": 5,
  "repositoryEvidence": "Inspected the required files in the selected worktree.",
  "equivalenceEvidence": "The required changes and evidence are present on this branch.",
  "externalEffectResolutions": [
    {"effectIndex": 0, "evidence": "Read the existing receipt. No repeat action is needed."}
  ]
}
```

The previous revision must identify the latest checkpoint.
A branch or worktree change requires both repository evidence fields and the selected canonical root.
Each removed uncertain effect requires resolution evidence for its index in that checkpoint.
Unresolved effects must remain recorded. Add a blocker and request direction when an outcome remains unknown.
A new task cannot review an earlier checkpoint.
`task continue` uses its own inspection fields instead of `checkpoint.review`.


## Fresh-session recovery walkthrough

Use this procedure after a session stops. A saved checkpoint is evidence to inspect.
It is not permission to repeat an external action.
Use the same installed executable, `STATEWELL_HOME`, instance, and project for all steps.
The examples use instance `test` and root `/absolute/project`.
Replace these values and each example identifier with the saved values.

1. Read the repository instructions and inspect `statewell --help`.
   Confirm that the installed application supports the required operations.
   Resolve the project and read the instance:

   ```sh
   statewell instance inspect --instance test
   statewell project resolve --instance test --root /absolute/project
   ```

2. Create `/tmp/task-reference.json` with the saved task identifier:

   ```json
   {"taskId":"00000000-0000-4000-8000-000000000001"}
   ```

   Retrieve the context:

   ```sh
   statewell task context --instance test --root /absolute/project --input /tmp/task-reference.json
   ```

   Read the full contract, approval, checkpoint, and continuation instructions.
   If the result is `CONTEXT_TOO_LARGE`, read all exact references from the error.
   For each reference, pass `root` and `projectId` as command options.
   Put its other fields in a separate JSON file.
   Use the operation that matches the reference:

   ```sh
   statewell task contract --instance test --root /absolute/project --project-id PROJECT_ID --input /tmp/contract-reference.json
   statewell task checkpoint --instance test --root /absolute/project --project-id PROJECT_ID --input /tmp/checkpoint-reference.json
   ```

   Read `references.lastTransition` with `task checkpoint` when present.
   Use its own input file. Do not substitute the latest checkpoint for an exact reference.
   Request `task context` again and compare the task revision with the first result.
   A second size error still supplies current revision identifiers.
   If the revision changed, read the new references before you continue.
   A size error does not permit you to omit requirements.

3. Inspect actual files, dependencies, and uncertain external effects before implementation.
   Compare the saved repository state with the selected worktree:

   ```sh
   git -C /absolute/project status --short
   git -C /absolute/project branch --show-current
   git -C /absolute/project rev-parse HEAD
   git -C /absolute/project diff -- docs/INSTANCE-CLI.md
   ```

   Read the changed files and retained check results.
   Check each dependency condition against actual evidence.
   Inspect the result of each uncertain external action.
   For example, read an existing receipt before you repeat a request.
   A lost response does not show that the external action failed.
   If the receipt exists, record it and do not repeat the request.
   If an outcome remains unknown, retain the uncertain effect, record a blocker,
   and request direction. Do not report a resolution without evidence.

   If the branch or worktree differs, inspect the required files and results there.
   Record `inspection.equivalenceEvidence` that explains why the work is equivalent,
   or request maintainer direction. Do not switch branches or copy work automatically.

4. Compare the current contract with the checkpoint contract revision.
   If `contractMismatch` is true, read both contracts with `task contract`.
   Use `taskId` and the required `contractRevision` in each reference file.
   Save a complete checkpoint that reconciles progress with the current requirements:

   ```sh
   statewell task save --instance test --root /absolute/project --input /tmp/reconciled-checkpoint.json
   ```

   The input needs `taskId`, a new `retryKey`, both current expected revisions,
   and all checkpoint fields from the checkpoint example above.
   Record which requirements are complete and which remain.
   Preserve unresolved effects and supply `checkpoint.review` when required by
   the inspection rules above. Approval of the current contract is also required.
   A reconciliation save does not approve a contract or start implementation.
   Use the returned task revision for the next request.

5. Record the inspection with `task continue` before further implementation.
   Create `/tmp/continue.json` with this structure:

   ```json
   {
     "taskId": "00000000-0000-4000-8000-000000000001",
     "retryKey": "recovery-inspection-1",
     "expectedRevision": 5,
     "expectedContractRevision": 1,
     "checkpoint": {
       "progress": "Inspected the saved work and current requirements.",
       "remainingWork": ["Complete the remaining approved work."],
       "nextAction": "Complete the remaining approved work.",
       "blockers": [],
       "evidence": ["The actual files match the saved progress."],
       "repositoryState": {
         "worktree": "/absolute/project",
         "branch": "main",
         "commit": null,
         "uncommittedChanges": []
       },
       "uncertainExternalEffects": []
     },
     "inspection": {
       "repositoryState": {
         "worktree": "/absolute/project",
         "branch": "main",
         "commit": null,
         "uncommittedChanges": []
       },
       "evidence": "Read the changed files, Git state, and retained check results."
     },
     "dependencyEvidence": [],
     "externalEffectResolutions": []
   }
   ```

   Replace the example revisions, repository state, progress, and evidence with actual values.
   Both repository state objects must match the inspected state.
   Use `null` only for an absent branch or commit. Record all uncommitted changes.
   Add `inspection.equivalenceEvidence` when the saved branch or worktree differs.
   Supply one `dependencyEvidence` entry per contract dependency condition.
   Supply one `externalEffectResolutions` entry per earlier uncertain effect.
   Use the entry formats from the continuation rules above. Empty arrays apply only
   when there are no corresponding conditions or effects.
   Resolve all blockers and uncertain outcomes before this operation:

   ```sh
   statewell task continue --instance test --root /absolute/project --input /tmp/continue.json
   ```

   Continue only after a successful result. Preserve the input and retry key if
   the response is lost. Use the retry procedure above before another mutation.
   This operation preserves the task state.
   A `todo` task still needs an approved transition to `in-progress` with dependency evidence.
   A blocked or terminal task needs the applicable resolution or reopening procedure first.

6. Complete the remaining approved work and run the acceptance checks.
   Inspect the final repository state and external results.
   Keep failed checks and unresolved effects in the checkpoint until resolved.
   Do not report an unchecked requirement as passed.

7. Record completion through `task transition`.
   Create `/tmp/completion.json` with `taskId`, a new `retryKey`, both current expected
   revisions, `state: "done"`, and a complete `checkpoint`.
   Record the final progress, actual evidence, and repository state.
   Use an empty `remainingWork` array, no unresolved completion blockers, and
   `nextAction: null` when no next action remains.
   Supply an `acceptanceEvidence` entry for every current acceptance check:

   ```json
   {"checkIndex":0,"status":"passed","evidence":"The required check passed; record its command and actual result here."}
   ```

   Use each zero-based check index exactly once. Replace the example evidence.
   If `completionApprovalRequired` is true, obtain the required approval and include
   `approval` with its actual `source`. Initial contract approval is not completion approval.

   ```sh
   statewell task transition --instance test --root /absolute/project --input /tmp/completion.json
   statewell task read --instance test --root /absolute/project --input /tmp/task-reference.json
   ```

   Confirm that the read returns `done`, the expected contract revision, the final
   checkpoint, and passing evidence for every check in `task.lastTransition`.
   Preserve the exact request for retry if the transition response is lost.
   Statewell records reported evidence. It does not independently certify the checks.
