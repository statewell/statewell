import { Database } from "bun:sqlite";
import { z } from "zod";
import { StatewellError } from "./errors.ts";
import { projectOperation } from "./projects.ts";

const text = z.string().refine(value => value.trim().length > 0, "Supply nonempty text.");
const texts = z.array(text);
export const contractSchema = z.object({
  goal: text, scopeLimits: texts, acceptanceChecks: texts.min(1), dependencyConditions: texts,
}).strict();
export const checkpointSchema = z.object({
  progress: text,
  remainingWork: texts,
  nextAction: text,
  blockers: z.array(z.object({ reason: text, continuationCondition: text }).strict()),
  evidence: texts,
  repositoryState: z.object({ worktree: text, branch: text.nullable(), commit: text.nullable(), uncommittedChanges: texts }).strict(),
  uncertainExternalEffects: texts,
}).strict();
const selection = { root: z.string().optional(), projectId: z.string().optional() };
const taskId = z.string().uuid();
export const taskSchemas = {
  "task.create": z.object({ ...selection, taskId, retryKey: text, expectedRevision: z.literal(0), contract: contractSchema, checkpoint: checkpointSchema }).strict(),
  "task.save": z.object({ ...selection, taskId, retryKey: text, expectedRevision: z.number().int().positive(), checkpoint: checkpointSchema }).strict(),
  "task.read": z.object({ ...selection, taskId }).strict(),
};

export function createTaskTables(db: Database) {
  db.exec(`CREATE TABLE tasks (
    project_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
    contract TEXT NOT NULL, PRIMARY KEY (project_id, id)
  );
  CREATE TABLE checkpoints (
    project_id TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
    content TEXT NOT NULL, PRIMARY KEY (project_id, task_id, revision)
  );
  CREATE TABLE task_retries (
    project_id TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, response TEXT NOT NULL,
    PRIMARY KEY (project_id, key)
  );`);
}

function readTask(db: Database, projectId: string, id: string) {
  const row = db.query("SELECT revision, contract FROM tasks WHERE project_id = ? AND id = ?").get(projectId, id) as { revision: number; contract: string } | null;
  if (!row) throw new StatewellError("TASK_NOT_FOUND", "The selected project has no task with this identifier.");
  const latest = db.query("SELECT content FROM checkpoints WHERE project_id = ? AND task_id = ? AND revision = ?").get(projectId, id, row.revision) as { content: string };
  return {
    task: { id, revision: row.revision, state: "todo", contractRevision: 1, contract: JSON.parse(row.contract) },
    checkpoint: { revision: row.revision, contractRevision: 1, content: JSON.parse(latest.content) },
    checkpointCount: (db.query("SELECT count(*) AS count FROM checkpoints WHERE project_id = ? AND task_id = ?").get(projectId, id) as { count: number }).count,
  };
}

export function taskOperation(db: Database, directory: string, operation: string, raw: unknown) {
  const schema = taskSchemas[operation as keyof typeof taskSchemas];
  if (!schema) throw new StatewellError("UNKNOWN_OPERATION", "The operation is not available.");
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new StatewellError("INVALID_TASK_INPUT", "Supply all required task fields with valid values. Unknown fields are not permitted.");
  const input = parsed.data as z.infer<typeof taskSchemas["task.create"]> | z.infer<typeof taskSchemas["task.save"]> | z.infer<typeof taskSchemas["task.read"]>;
  const { project } = projectOperation(db, directory, "project.inspect", input);
  const projectId = project.id!;
  if (!("expectedRevision" in input)) return { project, ...readTask(db, projectId, input.taskId) };
  const payload = JSON.stringify({ operation, input: { ...input, root: project.root, projectId } });
  return db.transaction(() => {
    const retry = db.query("SELECT payload, response FROM task_retries WHERE project_id = ? AND key = ?").get(projectId, input.retryKey) as { payload: string; response: string } | null;
    if (retry) {
      if (retry.payload !== payload) throw new StatewellError("RETRY_CONFLICT", "This retry key belongs to a different request. Inspect the original result.");
      return JSON.parse(retry.response);
    }
    if ("contract" in input) {
      if (db.query("SELECT 1 FROM tasks WHERE project_id = ? AND id = ?").get(projectId, input.taskId)) throw new StatewellError("TASK_EXISTS", "The selected project already has this task identifier.");
      db.query("INSERT INTO tasks (project_id, id, revision, contract) VALUES (?, ?, 1, ?)").run(projectId, input.taskId, JSON.stringify(input.contract));
    } else {
      const current = readTask(db, projectId, input.taskId);
      if (current.task.revision !== input.expectedRevision) throw new StatewellError("STALE_REVISION", "Read the current task before submitting another change.");
      db.query("UPDATE tasks SET revision = revision + 1 WHERE project_id = ? AND id = ?").run(projectId, input.taskId);
    }
    db.query("INSERT INTO checkpoints VALUES (?, ?, ?, ?)").run(projectId, input.taskId, input.expectedRevision + 1, JSON.stringify(input.checkpoint));
    const response = { project, ...readTask(db, projectId, input.taskId) };
    db.query("INSERT INTO task_retries VALUES (?, ?, ?, ?)").run(projectId, input.retryKey, payload, JSON.stringify(response));
    return response;
  })();
}
