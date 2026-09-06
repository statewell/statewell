# Packaged continuation prototype

This throwaway experiment checks whether a fresh agent can finish real documentation work from saved Statewell records.
The application must already provide the issue #8 operations.
The normal development store is never used.

## Prepare the experiment

Build the application with Bun 1.4.2 on Linux x64.
Use a source checkout at commit `badbd3a8cb432fec6ccb205124e2c0bbd9eee2b1`.
Run these commands from this prototype directory:

```sh
python3 prepare.py /absolute/statewell /tmp/statewell-continuation-prototype
python3 receipt_service.py /tmp/statewell-continuation-prototype
```

The first command installs the package offline and prepares an approved task in a disposable checkout.
Its output identifies the repository and task.
The second command starts a local receipt service and writes its address to `service.json` in the experiment directory.
Keep the service running during both sessions.
The service records each POST request and deliberately closes the connection without a response.
A GET request returns all recorded receipts.
This controlled service is not an exactly-once external-action implementation.

The Statewell data directory is a separate temporary directory under `/dev/shm`.
This Linux location avoids repository markers in the checkout or its parents.
`task.json` identifies the exact disposable instance, home directory, executable, and task.
No application data is committed to this prototype.

## Initial session

Give an agent the generated repository, task identifier, and receipt address.
Ask it to retrieve the approved task through the installed public command-line interface (CLI).
Limit its file ownership to `docs/INSTANCE-CLI.md` and temporary evidence in the experiment directory.

1. Inspect the installed commands and record dependency and continuation evidence.
2. Start the approved task through the public interface.
3. Write a useful but incomplete, uncommitted recovery walkthrough.
4. Run a document check that fails because the walkthrough is incomplete.
5. Preserve the actual command, failure output, and failed approach in the checkpoint evidence.
6. Send one POST request to the local receipt service.
7. Save the lost response as an uncertain effect, with the inspection address and a safe next action.
8. Save the complete checkpoint and wait without a final handoff.

End that agent session after the checkpoint succeeds.
Read the checkpoint through the public interface and preserve the observed response as experiment evidence.
Stop and restart the disposable daemon before the next session.
Do not change the working files between sessions.

## Fresh session

Create a new agent without conversation history or a fork of the initial session.
Give it only the generated repository location and task identifier.
The repository's generic configuration supplies the installed executable and selected instance context.
Do not give it progress, requirements, receipt information, or the earlier session's output separately.

Observe whether the agent retrieves the task, inspects actual files, and reads the receipt before further work.
It must not repeat the POST when inspection finds the receipt.
It must complete the documentation within the saved contract and record passing evidence and a final checkpoint through the public interface.

## Lead verification

Read the final task through the public CLI and Model Context Protocol (MCP) interfaces.
Verify the approved contract, done state, completion evidence, and final checkpoint.
Read earlier checkpoints and verify that failed work and the uncertain effect remain available.
Inspect the actual documentation diff and validate its operation names against the installed executable.
Check the service access log and receipt file: exactly one POST and one receipt must remain.
Verify a GET inspection occurred during the fresh session.

Record exact versions, commands, agent interruption, fresh-session input, results, failures, and limitations on issue #9.
Keep generated checkout files, configuration, receipts, stores, and package archives outside this prototype commit.
Stop only the disposable service and daemon after verification.

This experiment checks recovery of saved state and continuation against retained working files.
It does not recover lost working files, database loss, corruption, backups, or earlier schemas.
ARM64 and macOS execution remain unverified and deferred under the accepted Linux x64 scope.
