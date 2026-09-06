import { Database } from "bun:sqlite";
import { z } from "zod";
import { StatewellError } from "./errors.ts";
import { projectOperation } from "./projects.ts";

const text = z.string().refine(value => value.trim().length > 0, "Supply nonempty text.");
const texts = z.array(text);
const revision = z.number().int().positive();
export const contractSchema = z.object({
  goal: text, scopeLimits: texts, acceptanceChecks: texts.min(1), dependencyConditions: texts, completionApprovalRequired: z.boolean().optional(),
}).strict();
const sourceSchema = z.object({ reference: text, capturedAt: z.iso.datetime({ offset: true }) }).strict().nullable().default(null);
const approvalSchema = z.object({ source: text }).strict();
export const checkpointSchema = z.object({
  progress: text,
  remainingWork: texts,
  nextAction: text.nullable(),
  blockers: z.array(z.object({ reason: text, continuationCondition: text, affectsCompletion: z.boolean().optional() }).strict()),
  evidence: texts,
  repositoryState: z.object({ worktree: text, branch: text.nullable(), commit: text.nullable(), uncommittedChanges: texts }).strict(),
  uncertainExternalEffects: texts,
}).strict();
const selection = { root: z.string().optional(), projectId: z.string().optional(), taskId: z.string().uuid() };
const expected = { expectedRevision: revision, expectedContractRevision: revision };
const mutation = { ...selection, ...expected, retryKey: text };
export const taskSchemas = {
  "task.create": z.object({ ...selection, retryKey: text, expectedRevision: z.literal(0), contract: contractSchema, source: sourceSchema, checkpoint: checkpointSchema }).strict(),
  "task.transition": z.object({ ...mutation, state: z.enum(["todo", "in-progress", "blocked", "done", "cancelled"]), checkpoint: checkpointSchema, dependencyEvidence: z.array(z.object({ conditionIndex: z.number().int().nonnegative(), evidence: text }).strict()).optional(), reason: text.optional(), approval: approvalSchema.optional(), failureEvidence: texts.min(1).optional(), acceptanceEvidence: z.array(z.object({ checkIndex: z.number().int().nonnegative(), status: z.enum(["passed", "failed", "unverified"]), evidence: text }).strict()).optional(), blockerResolutions: z.array(z.object({ blockerIndex: z.number().int().nonnegative(), evidence: text }).strict()).optional() }).strict(),
  "task.save": z.object({ ...mutation, checkpoint: checkpointSchema }).strict(),
  "task.read": z.object(selection).strict(),
  "task.check": z.object({ ...selection, ...expected }).strict(),
  "task.approve": z.object({ ...mutation, contract: contractSchema, source: sourceSchema, approval: approvalSchema, proposalId: z.string().uuid().optional() }).strict(),
  "task.propose": z.object({ ...mutation, proposalId: z.string().uuid(), contract: contractSchema, source: sourceSchema }).strict(),
  "task.contract": z.object({ ...selection, contractRevision: revision }).strict(),
  "task.proposal": z.object({ ...selection, proposalId: z.string().uuid() }).strict(),
};
type TaskRequest = {
  [Operation in keyof typeof taskSchemas]: { operation: Operation; input: z.infer<(typeof taskSchemas)[Operation]> }
}[keyof typeof taskSchemas];

export const taskDescriptions: Record<keyof typeof taskSchemas, string> = {
  "task.create": "Prepare a task in todo with a contract and checkpoint.",
  "task.transition": "Change task state and save its checkpoint together. Evidence is reported, not independently verified.",
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
    contract_revision INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (project_id, id)
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
    contract_revision INTEGER NOT NULL, content TEXT NOT NULL, transition TEXT, PRIMARY KEY (project_id, task_id, revision)
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
  const row = db.query("SELECT revision, contract_revision, state FROM tasks WHERE project_id = ? AND id = ?").get(projectId, id) as { revision: number; contract_revision: number; state: string } | null;
  if (!row) throw new StatewellError("TASK_NOT_FOUND", "The selected project has no task with this identifier.");
  const contract = readContract(db, projectId, id, row.contract_revision);
  const latest = db.query("SELECT revision, contract_revision, content, transition FROM checkpoints WHERE project_id = ? AND task_id = ? ORDER BY revision DESC LIMIT 1").get(projectId, id) as { revision: number; contract_revision: number; content: string; transition: string | null };
  const lastTransition = db.query("SELECT revision, transition FROM checkpoints WHERE project_id = ? AND task_id = ? AND transition IS NOT NULL ORDER BY revision DESC LIMIT 1").get(projectId, id) as { revision: number; transition: string } | null;
  return {
    task: { lastTransition: lastTransition ? { checkpointRevision: lastTransition.revision, ...JSON.parse(lastTransition.transition) } : null, id, revision: row.revision, state: row.state, contractRevision: contract.revision, contract: contract.content, source: contract.source, approval: contract.approval },
    checkpoint: { revision: latest.revision, contractRevision: latest.contract_revision, content: JSON.parse(latest.content), transition: latest.transition ? JSON.parse(latest.transition) : null },
    contractMismatch: latest.contract_revision !== contract.revision,
    checkpointCount: (db.query("SELECT count(*) AS count FROM checkpoints WHERE project_id = ? AND task_id = ?").get(projectId, id) as { count: number }).count,
  };
}

function checkRevisions(current: ReturnType<typeof readTask>, input: z.infer<typeof taskSchemas["task.check"]>) {
  if (current.task.revision !== input.expectedRevision) throw new StatewellError("STALE_REVISION", "Read the current task before submitting another change.");
  if (current.task.contractRevision !== input.expectedContractRevision) throw new StatewellError("STALE_CONTRACT_REVISION", "Read the current contract before continuing.");
}

function checkCompletion(contract: z.infer<typeof contractSchema>, input: Pick<z.infer<typeof taskSchemas["task.transition"]>, "checkpoint" | "approval" | "acceptanceEvidence">) {
  const evidence = input.acceptanceEvidence ?? [];
  if (evidence.length !== contract.acceptanceChecks.length || new Set(evidence.map(value => value.checkIndex)).size !== evidence.length ||
      evidence.some(value => value.checkIndex >= contract.acceptanceChecks.length || value.status !== "passed")) throw new StatewellError("COMPLETION_EVIDENCE_REQUIRED", "Record passing evidence for each acceptance check in the current contract.");
  if (input.checkpoint.blockers.some(blocker => blocker.affectsCompletion !== false)) throw new StatewellError("UNRESOLVED_BLOCKER", "Resolve completion blockers before marking the task done.");
  if (contract.completionApprovalRequired && !input.approval) throw new StatewellError("APPROVAL_REQUIRED", "Record the required maintainer approval of completion.");
}

export function taskOperation(db: Database, directory: string, operation: string, raw: unknown) {
  if (!Object.hasOwn(taskSchemas, operation)) throw new StatewellError("UNKNOWN_OPERATION", "The operation is not available.");
  const parsed = taskSchemas[operation as keyof typeof taskSchemas].safeParse(raw);
  if (!parsed.success) throw new StatewellError("INVALID_TASK_INPUT", "Supply all required task fields with valid values. Unknown fields are not permitted.");
  const { operation: action, input } = { operation, input: parsed.data } as TaskRequest;
  const { project } = projectOperation(db, directory, "project.inspect", input);
  const projectId = project.id!;
  if (action === "task.read" || action === "task.contract" || action === "task.proposal") {
    if (action === "task.contract") return { project, contract: readContract(db, projectId, input.taskId, input.contractRevision) };
    if (action === "task.proposal") return { project, proposal: readProposal(db, projectId, input.taskId, input.proposalId) };
    return { project, ...readTask(db, projectId, input.taskId) };
  }
  if (action === "task.check") {
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
    let transition = null;
    if (action === "task.create") {
      if (input.checkpoint.nextAction === null) throw new StatewellError("INVALID_TASK_INPUT", "Record one next action for task preparation.");
      if (db.query("SELECT 1 FROM tasks WHERE project_id = ? AND id = ?").get(projectId, input.taskId)) throw new StatewellError("TASK_EXISTS", "The selected project already has this task identifier.");
      db.query("INSERT INTO tasks VALUES (?, ?, 1, 1, 'todo')").run(projectId, input.taskId);
      db.query("INSERT INTO contracts VALUES (?, ?, 1, ?, ?, NULL)").run(projectId, input.taskId, JSON.stringify(input.contract), JSON.stringify(input.source));
    } else {
      const current = readTask(db, projectId, input.taskId);
      checkRevisions(current, input);
      contractRevision = current.task.contractRevision;
      if (action === "task.transition") {
        const permitted: Record<string, string[]> = { todo: ["in-progress", "blocked", "cancelled"], "in-progress": ["blocked", "done", "cancelled"], blocked: ["todo", "cancelled"], done: ["todo"], cancelled: ["todo"] };
        if (!permitted[current.task.state]?.includes(input.state)) throw new StatewellError("INVALID_TRANSITION", "This state transition is not permitted.");
        if ((input.dependencyEvidence !== undefined && input.state !== "in-progress") ||
            (input.acceptanceEvidence !== undefined && input.state !== "done") ||
            (input.blockerResolutions !== undefined && !(current.task.state === "blocked" && input.state === "todo")) ||
            (input.failureEvidence !== undefined && !(current.task.state === "done" && input.state === "todo")) ||
            (input.reason !== undefined && input.state !== "cancelled" && current.task.state !== "done") ||
            (input.approval !== undefined && input.state !== "done" && input.state !== "cancelled" && current.task.state !== "cancelled")) throw new StatewellError("INVALID_TASK_INPUT", "Supply only evidence that applies to this transition.");
        if (input.state === "in-progress") {
          const dependencies = input.dependencyEvidence ?? [];
          if (dependencies.length !== current.task.contract.dependencyConditions.length || new Set(dependencies.map(value => value.conditionIndex)).size !== dependencies.length ||
              dependencies.some(value => value.conditionIndex >= current.task.contract.dependencyConditions.length)) throw new StatewellError("DEPENDENCY_EVIDENCE_REQUIRED", "Record evidence for each dependency condition before implementation.");
          if (!current.task.approval) throw new StatewellError("APPROVAL_REQUIRED", "Record contract approval before implementation.");
          if (current.contractMismatch) throw new StatewellError("CHECKPOINT_CONTRACT_MISMATCH", "Compare the current contract and save a new checkpoint before implementation.");
        }
        if (current.task.state === "blocked" && input.state === "todo") {
          const resolutions = input.blockerResolutions ?? [];
          if (input.checkpoint.blockers.length || resolutions.length !== current.checkpoint.content.blockers.length ||
              new Set(resolutions.map(value => value.blockerIndex)).size !== resolutions.length ||
              resolutions.some(value => value.blockerIndex >= current.checkpoint.content.blockers.length)) throw new StatewellError("RESOLUTION_REQUIRED", "Record evidence for each current blocker and clear the blockers before returning to todo.");
        }
        if (input.state === "cancelled" && !input.reason) throw new StatewellError("CANCELLATION_REASON_REQUIRED", "Record the reason for cancellation.");
        if ((input.state === "cancelled" || current.task.state === "cancelled") && !input.approval) throw new StatewellError("APPROVAL_REQUIRED", "Record maintainer approval for cancellation or resumption of cancelled work.");
        if (input.state === "done") {
          if (!current.task.approval) throw new StatewellError("APPROVAL_REQUIRED", "Record contract approval before completion.");
          if (current.contractMismatch) throw new StatewellError("CHECKPOINT_CONTRACT_MISMATCH", "Compare the current contract and save a new checkpoint before completion.");
          checkCompletion(current.task.contract, input);
        }
        if (current.task.state === "done" && (!input.reason || !input.failureEvidence?.length)) throw new StatewellError("REOPENING_EVIDENCE_REQUIRED", "Record a reopening reason and failure evidence.");
        transition = { ...(input.dependencyEvidence ? { dependencyEvidence: input.dependencyEvidence } : {}), from: current.task.state, to: input.state, contractRevision, ...(input.blockerResolutions ? { blockerResolutions: input.blockerResolutions } : {}), ...(input.reason ? { reason: input.reason } : {}), ...(input.approval ? { approval: input.approval } : {}), ...(input.failureEvidence ? { failureEvidence: input.failureEvidence } : {}), ...(input.acceptanceEvidence ? { acceptanceEvidence: input.acceptanceEvidence } : {}) };
        db.query("UPDATE tasks SET state = ? WHERE project_id = ? AND id = ?").run(input.state, projectId, input.taskId);
      } else if (action === "task.approve") {
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
      } else if (action === "task.propose") {
        if (db.query("SELECT 1 FROM proposals WHERE project_id = ? AND task_id = ? AND id = ?").get(projectId, input.taskId, input.proposalId)) throw new StatewellError("PROPOSAL_EXISTS", "This proposal identifier already exists. Use a new identifier.");
        db.query("INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?)").run(projectId, input.taskId, input.proposalId, contractRevision, JSON.stringify(input.contract), JSON.stringify(input.source));
      }
      if (action === "task.save" || action === "task.transition") {
        const state = action === "task.transition" ? input.state : current.task.state;
        if (state !== "done" && state !== "cancelled" && input.checkpoint.nextAction === null) throw new StatewellError("INVALID_TASK_INPUT", "Record one next action for unfinished work.");
        if (action === "task.save" && state === "done") {
          const completion = current.task.lastTransition;
          if (completion.contractRevision !== contractRevision) throw new StatewellError("CHECKPOINT_CONTRACT_MISMATCH", "Reopen the task to address the revised completion requirements.");
          checkCompletion(current.task.contract, { ...completion, checkpoint: input.checkpoint });
        }
        if (action === "task.save" && state === "blocked" && input.checkpoint.blockers.length &&
            JSON.stringify(input.checkpoint.blockers.slice(0, current.checkpoint.content.blockers.length)) !== JSON.stringify(current.checkpoint.content.blockers)) throw new StatewellError("RESOLUTION_REQUIRED", "Preserve current blockers during checkpoint saves. Resolve them when returning to todo.");
        if (state === "blocked" && !input.checkpoint.blockers.length) throw new StatewellError("BLOCKER_REQUIRED", "Record a blocker reason, continuation condition, and resolution action.");
      }
      db.query("UPDATE tasks SET revision = revision + 1, contract_revision = ? WHERE project_id = ? AND id = ?").run(contractRevision, projectId, input.taskId);
    }
    if (action === "task.create" || action === "task.save" || action === "task.transition") db.query("INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?)").run(projectId, input.taskId, input.expectedRevision + 1, contractRevision, JSON.stringify(input.checkpoint), transition ? JSON.stringify(transition) : null);
    const response = { project, ...readTask(db, projectId, input.taskId) };
    db.query("INSERT INTO task_retries VALUES (?, ?, ?, ?)").run(projectId, input.retryKey, payload, JSON.stringify(response));
    return response;
  })();
}
