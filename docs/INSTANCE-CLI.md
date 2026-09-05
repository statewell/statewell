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
Task saves and logical retry keys belong to later tickets.

MCP input frames have a 16384-byte limit. MCP output frames have a 65536-byte limit.
MCP permits at most 16 pending output writes, each with a one-second deadline.
A transport-limit failure exits with code 2 and reports an error on stderr.
CLI operation failures exit with code 1 and return a JavaScript Object Notation (JSON) error on stderr.
Successful CLI operations return JSON on stdout.

These bounds apply to this initial interface. They do not promise database progress during a slow operation.
No backup, restoration, migration, memory, inference, or task workflow is implemented here.
