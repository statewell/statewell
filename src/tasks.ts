import { Database } from "bun:sqlite";
import { z } from "zod";
import { StatewellError } from "./errors.ts";
import { projectOperation } from "./projects.ts";

const text = z.string().refine(value => value.trim().length > 0, "Supply nonempty text.");
const texts = z.array(text);
const revision = z.number().int().positive();
export const contractSchema = z.object({
  goal: text, scopeLimits: texts, acceptanceChecks: texts.min(1), dependencyConditions: texts,
}).strict();
const sourceSchema = z.object({ reference: text, capturedAt: z.iso.datetime({ offset: true }) }).strict().nullable().default(null);
const approvalSchema = z.object({ source: text }).strict();
export const checkpointSchema = z.object({
  progress: text,
  remainingWork: texts,
  nextAction: text,
  blockers: z.array(z.object({ reason: text, continuationCondition: text }).strict()),
  evidence: texts,
  repositoryState: z.object({ worktree: text, branch: text.nullable(), commit: text.nullable(), uncommittedChanges: texts }).strict(),
  uncertainExternalEffects: texts,
}).strict();
const selection = { root: z.string().optional(), projectId: z.string().optional(), taskId: z.string().uuid() };
const expected = { expectedRevision: revision, expectedContractRevision: revision };
const mutation = { ...selection, ...expected, retryKey: text };
export const taskSchemas = {
  "task.create": z.object({ ...selection, retryKey: text, expectedRevision: z.literal(0), contract: contractSchema, source: sourceSchema, checkpoint: checkpointSchema }).strict(),
  "task.save": z.object({ ...mutation, checkpoint: checkpointSchema }).strict(),
  "task.read": z.object(selection).strict(),
  "task.check": z.object({ ...selection, ...expected }).strict(),
  "task.approve": z.object({ ...mutation, contract: contractSchema, source: sourceSchema, approval: approvalSchema, proposalId: z.string().uuid().optional() }).strict(),
  "task.propose": z.object({ ...mutation, proposalId: z.string().uuid(), contract: contractSchema, source: sourceSchema }).strict(),
  "task.contract": z.object({ ...selection, contractRevision: revision }).strict(),
  "task.proposal": z.object({ ...selection, proposalId: z.string().uuid() }).strict(),
};
export const taskDescriptions: Record<keyof typeof taskSchemas, string> = {
  "task.create": "Prepare a task in todo with a contract and checkpoint.",
  "task.save": "Save a checkpoint against the current task and contract revisions.",
  "task.read": "Read the current contract and latest checkpoint, including any revision mismatch.",
  "task.check": "Check recorded contract approval and checkpoint agreement. This does not start work or verify evidence truth.",
  "task.approve": "Record reported approval of exact saved content. This does not authenticate the maintainer.",
  "task.propose": "Save a separate contract proposal without replacing approved requirements.",
  "task.contract": "Read one exact retained contract revision with its source and approval evidence.",
  "task.proposal": "Read one exact saved contract proposal.",
};

export function createTaskTables(db: Database) {
  db.exec(`CREATE TABLE tasks (
    project_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
    contract_revision INTEGER NOT NULL, PRIMARY KEY (project_id, id)
  );
  CREATE TABLE contracts (
    project_id TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
    content TEXT NOT NULL, source TEXT NOT NULL, approval TEXT,
    PRIMARY KEY (project_id, task_id, revision)
  );
  CREATE TABLE proposals (
    project_id TEXT NOT NULL, task_id TEXT NOT NULL, id TEXT NOT NULL,
    base_revision INTEGER NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL,
    PRIMARY KEY (project_id, task_id, id)
  );
  CREATE TABLE checkpoints (
    project_id TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
    contract_revision INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY (project_id, task_id, revision)
  );
  CREATE TABLE task_retries (
    project_id TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, response TEXT NOT NULL,
    PRIMARY KEY (project_id, key)
  );`);
}

function readContract(db: Database, projectId: string, id: string, revision: number) {
  const row = db.query("SELECT content, source, approval FROM contracts WHERE project_id = ? AND task_id = ? AND revision = ?").get(projectId, id, revision) as { content: string; source: string; approval: string | null } | null;
  if (!row) throw new StatewellError("CONTRACT_NOT_FOUND", "The selected task has no contract with this revision.");
  return { revision, content: JSON.parse(row.content), source: JSON.parse(row.source), approval: row.approval ? JSON.parse(row.approval) : null };
}

function readProposal(db: Database, projectId: string, taskId: string, id: string) {
  const row = db.query("SELECT base_revision, content, source FROM proposals WHERE project_id = ? AND task_id = ? AND id = ?").get(projectId, taskId, id) as { base_revision: number; content: string; source: string } | null;
  if (!row) throw new StatewellError("PROPOSAL_NOT_FOUND", "The selected task has no proposal with this identifier.");
  return { id, baseContractRevision: row.base_revision, contract: JSON.parse(row.content), source: JSON.parse(row.source) };
}

function readTask(db: Database, projectId: string, id: string) {
  const row = db.query("SELECT revision, contract_revision FROM tasks WHERE project_id = ? AND id = ?").get(projectId, id) as { revision: number; contract_revision: number } | null;
  if (!row) throw new StatewellError("TASK_NOT_FOUND", "The selected project has no task with this identifier.");
  const contract = readContract(db, projectId, id, row.contract_revision);
  const latest = db.query("SELECT revision, contract_revision, content FROM checkpoints WHERE project_id = ? AND task_id = ? ORDER BY revision DESC LIMIT 1").get(projectId, id) as { revision: number; contract_revision: number; content: string };
  return {
    task: { id, revision: row.revision, state: "todo", contractRevision: contract.revision, contract: contract.content, source: contract.source, approval: contract.approval },
    checkpoint: { revision: latest.revision, contractRevision: latest.contract_revision, content: JSON.parse(latest.content) },
    contractMismatch: latest.contract_revision !== contract.revision,
    checkpointCount: (db.query("SELECT count(*) AS count FROM checkpoints WHERE project_id = ? AND task_id = ?").get(projectId, id) as { count: number }).count,
  };
}

function checkRevisions(current: ReturnType<typeof readTask>, input: z.infer<typeof taskSchemas["task.check"]>) {
  if (current.task.revision !== input.expectedRevision) throw new StatewellError("STALE_REVISION", "Read the current task before submitting another change.");
  if (current.task.contractRevision !== input.expectedContractRevision) throw new StatewellError("STALE_CONTRACT_REVISION", "Read the current contract before continuing.");
}

export function taskOperation(db: Database, directory: string, operation: string, raw: unknown) {
  if (!Object.hasOwn(taskSchemas, operation)) throw new StatewellError("UNKNOWN_OPERATION", "The operation is not available.");
  const parsed = taskSchemas[operation as keyof typeof taskSchemas].safeParse(raw);
  if (!parsed.success) throw new StatewellError("INVALID_TASK_INPUT", "Supply all required task fields with valid values. Unknown fields are not permitted.");
  const input = parsed.data as z.infer<typeof taskSchemas["task.create"]> | z.infer<typeof taskSchemas["task.save"]> | z.infer<typeof taskSchemas["task.read"]> | z.infer<typeof taskSchemas["task.check"]> | z.infer<typeof taskSchemas["task.approve"]> | z.infer<typeof taskSchemas["task.propose"]> | z.infer<typeof taskSchemas["task.contract"]> | z.infer<typeof taskSchemas["task.proposal"]>;
  const { project } = projectOperation(db, directory, "project.inspect", input);
  const projectId = project.id!;
  if (!("expectedRevision" in input)) {
    if ("contractRevision" in input) return { project, contract: readContract(db, projectId, input.taskId, input.contractRevision) };
    if ("proposalId" in input) return { project, proposal: readProposal(db, projectId, input.taskId, input.proposalId) };
    return { project, ...readTask(db, projectId, input.taskId) };
  }
  if (!("retryKey" in input)) {
    const current = readTask(db, projectId, input.taskId);
    checkRevisions(current, input);
    if (!current.task.approval) throw new StatewellError("APPROVAL_REQUIRED", "Record approval of the initial contract before implementation.");
    if (current.contractMismatch) throw new StatewellError("CHECKPOINT_CONTRACT_MISMATCH", "Compare the latest checkpoint with the current contract. Save a new checkpoint before implementation.");
    return { project, ...current };
  }
  const payload = JSON.stringify({ operation, input: { ...input, root: project.root, projectId } });
  return db.transaction(() => {
    const retry = db.query("SELECT payload, response FROM task_retries WHERE project_id = ? AND key = ?").get(projectId, input.retryKey) as { payload: string; response: string } | null;
    if (retry) {
      if (retry.payload !== payload) throw new StatewellError("RETRY_CONFLICT", "This retry key belongs to a different request. Inspect the original result.");
      return JSON.parse(retry.response);
    }
    let contractRevision = 1;
    if (!("expectedContractRevision" in input)) {
      if (db.query("SELECT 1 FROM tasks WHERE project_id = ? AND id = ?").get(projectId, input.taskId)) throw new StatewellError("TASK_EXISTS", "The selected project already has this task identifier.");
      db.query("INSERT INTO tasks VALUES (?, ?, 1, 1)").run(projectId, input.taskId);
      db.query("INSERT INTO contracts VALUES (?, ?, 1, ?, ?, NULL)").run(projectId, input.taskId, JSON.stringify(input.contract), JSON.stringify(input.source));
    } else {
      const current = readTask(db, projectId, input.taskId);
      checkRevisions(current, input);
      contractRevision = current.task.contractRevision;
      if ("approval" in input) {
        const proposal = input.proposalId ? readProposal(db, projectId, input.taskId, input.proposalId) : null;
        if (proposal && proposal.baseContractRevision !== contractRevision) throw new StatewellError("STALE_CONTRACT_REVISION", "The proposal refers to an earlier contract. Prepare a new proposal.");
        if (!proposal && current.task.approval) throw new StatewellError("ALREADY_APPROVED", "The initial contract already has approval. Propose a change separately.");
        const content = proposal?.contract ?? current.task.contract;
        const source = proposal ? proposal.source : current.task.source;
        if (JSON.stringify(content) !== JSON.stringify(input.contract) || JSON.stringify(source) !== JSON.stringify(input.source)) throw new StatewellError("APPROVAL_CONTENT_MISMATCH", "Approval must identify the exact saved contract and source.");
        if (proposal) {
          contractRevision++;
          db.query("INSERT INTO contracts VALUES (?, ?, ?, ?, ?, ?)").run(projectId, input.taskId, contractRevision, JSON.stringify(content), JSON.stringify(source), JSON.stringify(input.approval));
        } else {
          db.query("UPDATE contracts SET approval = ? WHERE project_id = ? AND task_id = ? AND revision = 1").run(JSON.stringify(input.approval), projectId, input.taskId);
        }
      } else if ("proposalId" in input) {
        if (db.query("SELECT 1 FROM proposals WHERE project_id = ? AND task_id = ? AND id = ?").get(projectId, input.taskId, input.proposalId)) throw new StatewellError("PROPOSAL_EXISTS", "This proposal identifier already exists. Use a new identifier.");
        db.query("INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?)").run(projectId, input.taskId, input.proposalId, contractRevision, JSON.stringify(input.contract), JSON.stringify(input.source));
      }
      db.query("UPDATE tasks SET revision = revision + 1, contract_revision = ? WHERE project_id = ? AND id = ?").run(contractRevision, projectId, input.taskId);
    }
    if ("checkpoint" in input) db.query("INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?)").run(projectId, input.taskId, input.expectedRevision + 1, contractRevision, JSON.stringify(input.checkpoint));
    const response = { project, ...readTask(db, projectId, input.taskId) };
    db.query("INSERT INTO task_retries VALUES (?, ?, ?, ?)").run(projectId, input.retryKey, payload, JSON.stringify(response));
    return response;
  })();
}
