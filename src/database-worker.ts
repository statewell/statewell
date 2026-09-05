import { createTaskTables, taskOperation } from "./tasks.ts";
import { projectOperation, resolveProject } from "./projects.ts";
import { Database } from "bun:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";
import { existsSync, lstatSync, openSync, closeSync, readSync, fstatSync, constants } from "node:fs";
import { failure, StatewellError } from "./errors.ts";

const { directory, create } = workerData as { directory: string; create: boolean };
let db: Database;
try {
  const path = join(directory, "state.sqlite");
  const existed = existsSync(path);
  if (!create && !existed) throw new StatewellError("STORE_MISSING", "The instance database is missing. Create or select an instance explicitly.");
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.nlink !== 1) throw new StatewellError("INVALID_STORE", "The database must be a regular file without aliases.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existed) {
    let inspection: Database | undefined;
    try {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const file = fstatSync(fd);
        const header = Buffer.alloc(100);
        if (!file.isFile() || file.nlink !== 1 || readSync(fd, header, 0, 100, 0) !== 100 ||
            header.subarray(0, 16).toString() !== "SQLite format 3\0" ||
            header.readUInt32BE(60) !== 1 || header.readUInt32BE(68) !== 0x5354574c) throw new Error();
      } finally { closeSync(fd); }
      // SQLite must roll back a pending journal before schema inspection.
      inspection = new Database(path, { create: false, readwrite: true, strict: true });
      const identity = inspection.query("SELECT id FROM instance").all() as { id: string }[];
      if (identity.length !== 1 || !/^[0-9a-f-]{36}$/.test(identity[0]!.id)) throw new Error();
      inspection.query("SELECT root, id FROM projects LIMIT 0").all();
      const version = inspection.query("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version !== 1) throw new Error();
      inspection.query("SELECT project_id, id, revision, contract FROM tasks LIMIT 0").all();
      inspection.query("SELECT project_id, task_id, revision, content FROM checkpoints LIMIT 0").all();
      inspection.query("SELECT project_id, key, payload, response FROM task_retries LIMIT 0").all();
    } catch (error) {
      if ((error as { code?: string }).code === "SQLITE_BUSY") throw new StatewellError("INSTANCE_BUSY", "Another daemon owns this database.");
      throw new StatewellError("INVALID_STORE", "The existing database is not a compatible Statewell instance.");
    }
    finally { inspection?.close(); }
  } else {
    closeSync(openSync(path, "wx", 0o600));
  }
  db = new Database(path, { create: false, strict: true });
  db.exec("PRAGMA busy_timeout=200; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
  if (!existed) {
    db.transaction(() => {
      db.exec("CREATE TABLE instance (id TEXT PRIMARY KEY); CREATE TABLE projects (root TEXT PRIMARY KEY, id TEXT NOT NULL);");
      createTaskTables(db);
      db.exec("PRAGMA user_version=1; PRAGMA application_id=1398036300");
      db.query("INSERT INTO instance VALUES (?)").run(crypto.randomUUID());
    })();
  }
  const instance = db.query("SELECT id FROM instance").get() as { id: string } | null;
  if (!instance) throw new StatewellError("INVALID_INSTANCE", "The database has no instance identity.");
  parentPort!.postMessage({ ready: true, id: instance.id });
  parentPort!.on("message", (request) => {
    try {
      let value;
      if (request.operation === "instance.inspect") value = { id: instance.id };
      else if (request.operation === "project.resolve") value = resolveProject(db, request.input);
      else if (["project.register", "project.inspect"].includes(request.operation)) value = projectOperation(db, directory, request.operation, request.input);
      else if (["task.create", "task.save", "task.read"].includes(request.operation)) value = taskOperation(db, directory, request.operation, request.input);
      else throw new StatewellError("UNKNOWN_OPERATION", "The operation is not available.");
      parentPort!.postMessage({ requestId: request.requestId, value });
    } catch (error) { parentPort!.postMessage({ requestId: request.requestId, ...failure(error) }); }
  });
} catch (error) { if ((error as { code?: string }).code === "SQLITE_BUSY") error = new StatewellError("INSTANCE_BUSY", "Another daemon owns this database."); parentPort!.postMessage(failure(error)); parentPort!.close(); }
