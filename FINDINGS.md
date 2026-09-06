# Fresh-session results

## Question

Can a fresh agent finish real work with the packaged Statewell application, without the initial conversation or a final handoff?

## Result

Yes, in this bounded Linux x64 experiment.
The fresh agent completed a recovery walkthrough from the approved task and saved checkpoint.
This result does not establish database-loss recovery or recovery of lost working files.

The installed application was built from `badbd3a8cb432fec6ccb205124e2c0bbd9eee2b1`.
Executable SHA-256: `3cba395929c20aeba605a6208ff04382367c6901234b1ab471c71ad80908d09b`.
Environment: Ubuntu 24.04.4 LTS, native Linux x64, Bun 1.4.2, Node.js 24.20.0, npm 11.19.0.
The package was installed offline with a fresh cache and matched the build.

## Evidence

The initial session left the uncommitted draft in `initial-draft.patch`.
The actual check output is retained in `initial-check.txt`; `check_walkthrough.py` reproduces the check.
The text-presence check does not establish procedure usability by itself.

One receipt POST returned curl exit 52 after the service stored the receipt.
The initial session saved the unknown outcome and inspection address in checkpoint 5.
It sent only `Checkpoint saved.` and was interrupted while still running, before any final handoff.
The saved task response was identical after a disposable daemon stop and restart.

The fresh agent had no conversation fork.
Its task message contained only the generated repository path and task identifier.
Generic repository configuration supplied the installed executable and selected instance context.
No requirements, progress, receipt information, or initial-session output were supplied in a follow-up message.

The fresh agent independently resolved the tool sandbox's shared-memory visibility limit through elevated public execution.
It retrieved checkpoint 5, inspected actual files and dependencies, and read the receipt before editing.
Checkpoint 6 recorded that inspection and the indexed external-effect resolution.
It completed the walkthrough, reran the failed check successfully, and recorded done at task revision 7.
All five task acceptance checks have reported passing evidence.

The lead verified identical final command-line interface and Model Context Protocol responses.
Six exact history records retained the failed draft checkpoint, inspection, and completion.
The approved contract and approval evidence remained unchanged.
The service log has exactly one POST and two GET requests. The receipt file has exactly one receipt.
`completed-walkthrough.patch` contains the resulting documentation change.
The original documentation remained an exact prefix of the completed file.

## Limits

Setup correctly rejected data under the environment-owned `/tmp/.git` marker.
The isolated Statewell data used `/dev/shm`, outside repository ancestry.
Only process and session recovery are claimed; no reboot or power-loss check was performed.
The service is a controlled loopback service. The result does not guarantee exactly-once behavior for arbitrary external services.
ARM64 and macOS remain unverified and deferred under the accepted Linux x64 scope.
Backups, restoration, migrations, memory, inference, and normal development-store adoption were not performed.
Generated stores, receipts, package archives, and session configuration remain outside Git.
