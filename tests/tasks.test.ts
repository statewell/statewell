import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer, createConnection } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cleanups: (() => Promise<void>)[] = [];
const entry = resolve("src/cli.ts");
async function fixture() {
  const root = mkdtempSync("/dev/shm/statewell-task-");
  const home = join(root, "home");
  const project = join(root, "project"); mkdirSync(project);
  const daemons: Bun.Subprocess[] = [];
  const clients: Client[] = [];
  const command = [Bun.env.STATEWELL_TEST_BINARY ?? Bun.argv[0]!, ...(Bun.env.STATEWELL_TEST_BINARY ? [] : [entry])];
  const env = { ...process.env, STATEWELL_HOME: home };
  async function cli(...args: string[]) {
    const child = Bun.spawn([...command, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, result: JSON.parse(out || err) };
  }
  async function start(name = "test", trace?: string, synchronization = 1) {
    const prefix = trace ? ["strace", "-f", "-yy", "-e", "trace=fsync,pwrite64", "-e", `inject=fsync:signal=SIGKILL:when=${synchronization}`, "-o", trace] : [];
    const child = Bun.spawn([...prefix, ...command, "instance", "start", "--instance", name], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    daemons.push(child);
    const reader = child.stdout.getReader();
    const first = await reader.read(); reader.releaseLock();
    if (!first.value) throw new Error(await new Response(child.stderr).text());
    expect(JSON.parse(new TextDecoder().decode(first.value)).ready).toBe(true);
    return child;
  }
  async function mcp(name = "test") {
    const client = new Client({ name: "task-tests", version: "0.0.0" }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: command[0]!, args: [...command.slice(1), "mcp", "--instance", name], env: env as Record<string, string>, stderr: "pipe" }));
    return async (operation: string, input: any) => {
      const result = await client.callTool({ name: operation, arguments: input });
      try { return JSON.parse((result.content as any[])[0].text); }
      catch { return result; }
    };
  }
  async function task(operation: string, input: any, name = "test", selectedRoot = project) {
    const path = join(root, `${crypto.randomUUID()}.json`); writeFileSync(path, JSON.stringify(input));
    return (await cli("task", operation, "--instance", name, "--root", selectedRoot, "--input", path)).result;
  }
  cleanups.push(async () => {
    for (const client of clients) await client.close();
    for (const daemon of daemons) if (daemon.exitCode === null) { daemon.kill("SIGKILL"); await daemon.exited; }
    rmSync(root, { recursive: true, force: true });
  });
  expect((await cli("instance", "create", "--instance", "test")).code).toBe(0);
  const daemon = await start();
  expect((await cli("project", "register", "--instance", "test", "--root", project)).code).toBe(0);
  return { root, home, project, cli, task, mcp, start, daemon };
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const contract = { goal: "Preserve a task across sessions.", scopeLimits: ["No memory operations."], acceptanceChecks: ["Read the exact saved task."], dependencyConditions: [] };
const checkpoint = { progress: "Prepared the task.", remainingWork: ["Verify persistence."], nextAction: "Read the task in a fresh process.", blockers: [], evidence: [], repositoryState: { worktree: "/work/project", branch: "main", commit: null, uncommittedChanges: [] }, uncertainExternalEffects: [] };
function createInput() { return { taskId: crypto.randomUUID(), retryKey: crypto.randomUUID(), expectedRevision: 0, contract, checkpoint }; }

test("CLI and MCP preserve exact task contracts and checkpoints across restart", async () => {
  const f = await fixture();
  const input = createInput();
  const saved = await f.task("create", input);
  expect(saved.error).toBeUndefined();
  expect(saved.value.task).toEqual({ id: input.taskId, revision: 1, state: "todo", contractRevision: 1, contract, source: null, approval: null, lastTransition: null });
  expect(saved.value.checkpoint.content).toEqual(checkpoint);
  f.daemon.kill("SIGKILL"); await f.daemon.exited; await f.start();
  const mcp = await f.mcp();
  expect(await mcp("task_read", { root: f.project, taskId: input.taskId })).toEqual(saved);
  const next = { ...checkpoint, progress: "Verified persistence.", evidence: ["A fresh process read the exact content."] };
  const updated = await mcp("task_save", { root: f.project, taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, checkpoint: next });
  expect(updated.error).toBeUndefined();
  expect(updated.value.task.revision).toBe(2);
  expect(updated.value.task.contract).toEqual(contract);
  expect(updated.value.checkpoint.content).toEqual(next);
  expect(await f.task("read", { taskId: input.taskId })).toEqual(updated);
});

test("retries preserve the original result and reject changed payloads without another checkpoint", async () => {
  const f = await fixture(); const input = createInput();
  const created = await f.task("create", input);
  expect(await f.task("create", input)).toEqual(created);
  const mcp = await f.mcp();
  const update = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, checkpoint: { ...checkpoint, progress: "Saved a second checkpoint." } };
  const saved = await mcp("task_save", { root: f.project, ...update });
  expect(saved.value.checkpointCount).toBe(2);
  expect(await f.task("save", { ...update, checkpoint: { ...checkpoint, progress: "Changed under the same key." } })).toMatchObject({ error: { code: "RETRY_CONFLICT" } });
  expect(await f.task("read", { taskId: input.taskId })).toEqual(saved);
  f.daemon.kill("SIGKILL"); await f.daemon.exited; await f.start();
  expect(await f.task("save", update)).toEqual(saved);
  expect(await f.task("create", input)).toEqual(created);
  expect(await f.task("read", { taskId: input.taskId })).toEqual(saved);
  expect(await f.task("create", { ...createInput(), retryKey: input.retryKey })).toMatchObject({ error: { code: "RETRY_CONFLICT" } });
});

test("invalid checkpoints and workflow shortcuts leave task state unchanged", async () => {
  const f = await fixture(); const input = createInput();
  const saved = await f.task("create", input);
  for (const field of Object.keys(checkpoint)) {
    const incomplete: any = { ...checkpoint }; delete incomplete[field];
    expect(await f.task("save", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, checkpoint: incomplete })).toMatchObject({ error: { code: "INVALID_TASK_INPUT" } });
  }
  for (const change of [{ nextAction: null }, { progress: " " }, { blockers: [{ reason: "Waiting." }] }, { repositoryState: null }, { evidence: null }]) {
    expect(await f.task("save", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, checkpoint: { ...checkpoint, ...change } })).toMatchObject({ error: { code: "INVALID_TASK_INPUT" } });
  }
  for (const extra of [{ state: "done" }, { state: "in-progress" }, { approval: "Approved." }, { contract: { ...contract, goal: "Replace requirements." } }]) {
    expect(await f.task("save", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, checkpoint, ...extra })).toMatchObject({ error: { code: "INVALID_TASK_INPUT" } });
  }
  expect(await f.task("read", { taskId: input.taskId })).toEqual(saved);
});

test("overlapping CLI and MCP saves reject stale revisions with a specific error", async () => {
  const f = await fixture(); const input = createInput(); await f.task("create", input);
  const mcp = await f.mcp();
  const first = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, checkpoint: { ...checkpoint, progress: "CLI update." } };
  const second = { ...first, retryKey: crypto.randomUUID(), checkpoint: { ...checkpoint, progress: "MCP update." } };
  const results = await Promise.all([f.task("save", first), mcp("task_save", { root: f.project, ...second })]);
  expect(results.filter(result => result.error).map(result => result.error.code)).toEqual(["STALE_REVISION"]);
  const winner = results.find(result => !result.error);
  expect(winner.value.task.revision).toBe(2);
  expect(winner.value.checkpointCount).toBe(2);
  expect(await f.task("read", { taskId: input.taskId })).toEqual(winner);
  const loser = results[0].error ? first : second;
  expect(await f.task("save", loser)).toMatchObject({ error: { code: "STALE_REVISION" } });
});

test("tasks and retry keys remain independent across projects and instances", async () => {
  const f = await fixture(); const input = createInput();
  const first = await f.task("create", input);
  const otherRoot = join(f.root, "other-project"); mkdirSync(otherRoot);
  await f.cli("project", "register", "--instance", "test", "--root", otherRoot);
  expect(await f.task("read", { taskId: input.taskId }, "test", otherRoot)).toMatchObject({ error: { code: "TASK_NOT_FOUND" } });
  const other = await f.task("create", { ...input, contract: { ...contract, goal: "Other project." } }, "test", otherRoot);
  expect(other.value.task.contract.goal).toBe("Other project.");
  expect((await f.cli("instance", "create", "--instance", "second")).code).toBe(0); await f.start("second");
  const secondMcp = await f.mcp("second");
  expect(await secondMcp("task_read", { root: f.project, taskId: input.taskId })).toMatchObject({ error: { code: "PROJECT_NOT_REGISTERED" } });
  await f.cli("project", "register", "--instance", "second", "--root", f.project);
  expect(await secondMcp("task_read", { root: f.project, taskId: input.taskId })).toMatchObject({ error: { code: "TASK_NOT_FOUND" } });
  const second = await secondMcp("task_create", { root: f.project, ...input, contract: { ...contract, goal: "Other instance." } });
  expect(second.value.task.contract.goal).toBe("Other instance.");
  expect(await f.task("read", { taskId: input.taskId })).toEqual(first);
  expect(await f.task("create", input)).toEqual(first);
  expect(await f.task("save", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, checkpoint }, "test", join(f.root, "missing"))).toHaveProperty("error");
  expect(await f.task("read", { taskId: input.taskId })).toEqual(first);
});

for (const operation of ["save", "approve", "revise", "transition"] as const) test(`death before commit preserves the prior task and retry commits one complete update (${operation})`, async () => {
  const f = await fixture(); const input = createInput();
  let prior = await f.task("create", input);
  const proposalId = crypto.randomUUID();
  const revisedContract = { ...contract, goal: "Approved replacement after a crash." };
  if (operation === "revise") {
    await f.task("approve", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, contract, approval: { source: "Initial request." } });
    prior = await f.task("propose", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 2, expectedContractRevision: 1, proposalId, contract: revisedContract });
    expect(prior.error).toBeUndefined();
  }
  const command = operation === "transition" ? "transition" : operation === "save" ? "save" : "approve";
  f.daemon.kill("SIGKILL"); await f.daemon.exited;
  const trace = join(f.root, "before-commit.trace");
  const traced = await f.start("test", trace);
  const update = operation === "transition" ? { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, state: "cancelled", reason: "Maintainer withdrew this task.", approval: { source: "Cancel this task." }, checkpoint: { ...checkpoint, progress: "Stopped without a completion claim.", nextAction: null } } : operation === "save" ? { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, checkpoint: { ...checkpoint, progress: "Atomic update." } } : { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, contract: operation === "revise" ? revisedContract : contract, ...(operation === "revise" ? { proposalId, expectedRevision: 3 } : {}), approval: { source: "User approved before the interrupted request." } };
  const mcp = await f.mcp();
  expect(await mcp(`task_${command}`, { root: f.project, ...update })).toMatchObject({ error: { code: "RESPONSE_INTERRUPTED" } });
  await traced.exited;
  const syscalls = readFileSync(trace, "utf8");
  expect(syscalls).toMatch(/fsync\([^\n]*state\.sqlite-journal/);
  expect(syscalls).toContain("SIGKILL");
  expect(syscalls).not.toMatch(/pwrite64\([^\n]*state\.sqlite>/);
  await f.start();
  expect(await f.task("read", { taskId: input.taskId })).toEqual(prior);
  const retried = await f.task(command, update);
  expect(retried.error).toBeUndefined();
  expect(retried.value.task.state).toBe(operation === "transition" ? "cancelled" : "todo");
  if (operation === "transition") expect(retried.value.checkpoint.transition).toMatchObject({ from: "todo", to: "cancelled", reason: "Maintainer withdrew this task.", approval: { source: "Cancel this task." } });
  expect(retried.value.task.revision).toBe(operation === "revise" ? 4 : 2);
  expect(retried.value.checkpoint.content).toEqual("checkpoint" in update ? update.checkpoint : checkpoint);
  expect(retried.value.task.approval).toEqual(operation !== "transition" && "approval" in update ? update.approval : null);
  expect(retried.value.task.contract).toEqual(operation === "revise" ? revisedContract : contract);
  expect(retried.value.task.contractRevision).toBe(operation === "revise" ? 2 : 1);
  expect(retried.value.checkpointCount).toBe((operation === "save" || operation === "transition") ? 2 : 1);
  expect(await mcp(`task_${command}`, { root: f.project, ...update })).toEqual(retried);
});

for (const operation of ["save", "approve", "revise", "transition"] as const) test(`death after commit with a withheld response preserves the exact retry result (${operation})`, async () => {
  const f = await fixture(); const input = createInput();
  let prior = await f.task("create", input);
  const proposalId = crypto.randomUUID();
  const revisedContract = { ...contract, goal: "Approved replacement after a crash." };
  if (operation === "revise") {
    await f.task("approve", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, contract, approval: { source: "Initial request." } });
    prior = await f.task("propose", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 2, expectedContractRevision: 1, proposalId, contract: revisedContract });
    expect(prior.error).toBeUndefined();
  }
  const command = operation === "transition" ? "transition" : operation === "save" ? "save" : "approve";
  const path = join(prior.instance.directory, "daemon.sock");
  const upstreamPath = join(prior.instance.directory, "upstream.sock");
  renameSync(path, upstreamPath);
  let withheld: any;
  const connections = new Set<ReturnType<typeof createConnection>>();
  const proxy = createServer(caller => {
    connections.add(caller); caller.setTimeout(3000, () => caller.destroy());
    caller.on("error", () => caller.destroy());
    const upstream = createConnection(upstreamPath); connections.add(upstream);
    upstream.setTimeout(3000, () => upstream.destroy());
    upstream.on("error", () => caller.destroy());
    caller.pipe(upstream);
    let response = "";
    upstream.on("data", async chunk => {
      response += chunk.toString();
      if (response.length > 65536) { caller.destroy(); upstream.destroy(); return; }
      if (!response.includes("\n")) return;
      withheld = JSON.parse(response);
      f.daemon.kill("SIGKILL"); await f.daemon.exited;
      caller.destroy(); upstream.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(path, resolve); });
  const update = operation === "transition" ? { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, state: "cancelled", reason: "Maintainer withdrew this task.", approval: { source: "Cancel this task." }, checkpoint: { ...checkpoint, progress: "Stopped without a completion claim.", nextAction: null } } : operation === "save" ? { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, checkpoint: { ...checkpoint, progress: "Committed before response loss." } } : { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, contract: operation === "revise" ? revisedContract : contract, ...(operation === "revise" ? { proposalId, expectedRevision: 3 } : {}), approval: { source: "User approved before the interrupted request." } };
  try {
    expect(await f.task(command, update)).toMatchObject({ error: { code: "RESPONSE_INTERRUPTED" } });
    expect(withheld.error).toBeUndefined();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    rmSync(path, { force: true }); rmSync(upstreamPath, { force: true });
  }
  await f.start(); const mcp = await f.mcp();
  expect(await mcp("task_read", { root: f.project, taskId: input.taskId })).toEqual(withheld);
  expect(await mcp(`task_${command}`, { root: f.project, ...update })).toEqual(withheld);
  expect(withheld.value.task.state).toBe(operation === "transition" ? "cancelled" : "todo");
  if (operation === "transition") expect(withheld.value.checkpoint.transition).toMatchObject({ from: "todo", to: "cancelled", reason: "Maintainer withdrew this task.", approval: { source: "Cancel this task." } });
  expect(withheld.value.task.revision).toBe(operation === "revise" ? 4 : 2);
  expect(withheld.value.checkpointCount).toBe((operation === "save" || operation === "transition") ? 2 : 1);
  expect(withheld.value.checkpoint.content).toEqual("checkpoint" in update ? update.checkpoint : checkpoint);
  expect(withheld.value.task.approval).toEqual(operation !== "transition" && "approval" in update ? update.approval : null);
  expect(withheld.value.task.contract).toEqual(operation === "revise" ? revisedContract : contract);
  expect(withheld.value.task.contractRevision).toBe(operation === "revise" ? 2 : 1);
  expect(await f.task("read", { taskId: input.taskId })).toEqual(withheld);
});


for (const operation of ["save", "approve", "revise", "transition"] as const) test(`death after database page writes rolls back the pending journal before reads (${operation})`, async () => {
  const f = await fixture(); const input = createInput();
  let prior = await f.task("create", input);
  const proposalId = crypto.randomUUID();
  const revisedContract = { ...contract, goal: "Approved replacement after a crash." };
  if (operation === "revise") {
    await f.task("approve", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, contract, approval: { source: "Initial request." } });
    prior = await f.task("propose", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 2, expectedContractRevision: 1, proposalId, contract: revisedContract });
    expect(prior.error).toBeUndefined();
  }
  const command = operation === "transition" ? "transition" : operation === "save" ? "save" : "approve";
  f.daemon.kill("SIGKILL"); await f.daemon.exited;
  const trace = join(f.root, "late-before-commit.trace");
  const traced = await f.start("test", trace, 4);
  const update = operation === "transition" ? { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, state: "cancelled", reason: "Maintainer withdrew this task.", approval: { source: "Cancel this task." }, checkpoint: { ...checkpoint, progress: "Stopped without a completion claim.", nextAction: null } } : operation === "save" ? { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, checkpoint: { ...checkpoint, progress: "Interrupted after page writes." } } : { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, contract: operation === "revise" ? revisedContract : contract, ...(operation === "revise" ? { proposalId, expectedRevision: 3 } : {}), approval: { source: "User approved before the interrupted request." } };
  expect(await f.task(command, update)).toMatchObject({ error: { code: "RESPONSE_INTERRUPTED" } });
  await traced.exited;
  const syscalls = readFileSync(trace, "utf8");
  expect(syscalls).toMatch(/pwrite64\([^\n]*state\.sqlite>/);
  expect(syscalls).toMatch(/fsync\([^\n]*state\.sqlite>/);
  expect(syscalls).toContain("SIGKILL");
  await f.start();
  const mcp = await f.mcp();
  expect(await mcp("task_read", { root: f.project, taskId: input.taskId })).toEqual(prior);
  const retried = await mcp(`task_${command}`, { root: f.project, ...update });
  expect(retried.error).toBeUndefined();
  expect(retried.value.task.state).toBe(operation === "transition" ? "cancelled" : "todo");
  if (operation === "transition") expect(retried.value.checkpoint.transition).toMatchObject({ from: "todo", to: "cancelled", reason: "Maintainer withdrew this task.", approval: { source: "Cancel this task." } });
  expect(retried.value.task.revision).toBe(operation === "revise" ? 4 : 2);
  expect(retried.value.checkpointCount).toBe((operation === "save" || operation === "transition") ? 2 : 1);
  expect(retried.value.checkpoint.content).toEqual("checkpoint" in update ? update.checkpoint : checkpoint);
  expect(retried.value.task.approval).toEqual(operation !== "transition" && "approval" in update ? update.approval : null);
  expect(retried.value.task.contract).toEqual(operation === "revise" ? revisedContract : contract);
  expect(retried.value.task.contractRevision).toBe(operation === "revise" ? 2 : 1);
  expect(await f.task(command, update)).toEqual(retried);
});

test("initial approval binds exact content and source through CLI and MCP after restart", async () => {
  const f = await fixture(); const input = createInput();
  await f.task("create", input);
  expect(await f.task("check", { taskId: input.taskId, expectedRevision: 1, expectedContractRevision: 1 })).toMatchObject({ error: { code: "APPROVAL_REQUIRED" } });
  const approval = { source: 'Session request: "Implement the saved task."' };
  const request = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, contract, approval };
  const mcp = await f.mcp();
  const approved = await mcp("task_approve", { root: f.project, ...request });
  expect(approved.error).toBeUndefined();
  expect(approved.value.task.approval).toEqual(approval);
  expect(approved.value.task.contract).toEqual(contract);
  expect(approved.value.task.contractRevision).toBe(1);
  expect(approved.value.task.revision).toBe(2);
  expect(approved.value.checkpointCount).toBe(1);
  expect((await f.task("check", { taskId: input.taskId, expectedRevision: 2, expectedContractRevision: 1 })).error).toBeUndefined();
  f.daemon.kill("SIGKILL"); await f.daemon.exited; await f.start();
  expect(await f.task("read", { taskId: input.taskId })).toEqual(approved);
  expect(await f.task("approve", request)).toEqual(approved);
});

test("proposals preserve requirements until approval and retain offline contract revisions", async () => {
  const f = await fixture(); const input = createInput();
  const source = { reference: "https://github.com/example/project/issues/42", capturedAt: "2026-09-05T12:00:00Z" };
  const initial = await f.task("create", { ...input, source });
  expect(initial.error).toBeUndefined();
  const approved = await f.task("approve", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, contract, source, approval: { source: "User request in session A." } });
  expect(approved.error).toBeUndefined();
  const mcp = await f.mcp();
  const proposalId = crypto.randomUUID();
  const changed = { ...contract, goal: "Read the saved task without GitHub access.", dependencyConditions: ["The storage verification has passed."] };
  const laterSource = { ...source, capturedAt: "2026-09-05T13:00:00Z" };
  const proposed = await mcp("task_propose", { root: f.project, taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 2, expectedContractRevision: 1, proposalId, contract: changed, source: laterSource });
  expect(proposed.error).toBeUndefined();
  expect(proposed.value.task.contract).toEqual(contract);
  expect(proposed.value.task.contractRevision).toBe(1);
  expect(proposed.value.checkpointCount).toBe(1);
  expect((await f.task("proposal", { taskId: input.taskId, proposalId })).value.proposal).toEqual({ id: proposalId, baseContractRevision: 1, contract: changed, source: laterSource });
  const approval = { source: 'User response in session B: "Approve this change."' };
  const revised = await f.task("approve", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 3, expectedContractRevision: 1, proposalId, contract: changed, source: laterSource, approval });
  expect(revised.error).toBeUndefined();
  expect(revised.value.task).toMatchObject({ revision: 4, contractRevision: 2, contract: changed, source: laterSource, approval });
  expect(revised.value.checkpoint).toEqual(approved.value.checkpoint);
  expect(revised.value.contractMismatch).toBe(true);
  expect(await mcp("task_check", { root: f.project, taskId: input.taskId, expectedRevision: 4, expectedContractRevision: 2 })).toMatchObject({ error: { code: "CHECKPOINT_CONTRACT_MISMATCH" } });
  const saved = await mcp("task_save", { root: f.project, taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 4, expectedContractRevision: 2, checkpoint: { ...checkpoint, progress: "Compared the checkpoint with the approved revision." } });
  expect(saved.error).toBeUndefined();
  expect(saved.value.contractMismatch).toBe(false);
  expect(saved.value.checkpoint.contractRevision).toBe(2);
  f.daemon.kill("SIGKILL"); await f.daemon.exited; await f.start();
  expect(await f.task("read", { taskId: input.taskId })).toEqual(saved);
  expect((await mcp("task_contract", { root: f.project, taskId: input.taskId, contractRevision: 1 })).value.contract).toEqual({ revision: 1, content: contract, source, approval: { source: "User request in session A." } });
  expect((await f.task("contract", { taskId: input.taskId, contractRevision: 2 })).value.contract).toEqual({ revision: 2, content: changed, source: laterSource, approval });
});

test("invalid approval evidence and changed content cannot alter prepared requirements", async () => {
  const f = await fixture(); const input = createInput(); const prepared = await f.task("create", input);
  const mcp = await f.mcp();
  const request = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, contract, approval: { source: "Explicit user request." } };
  for (const approval of [undefined, null, {}, { source: " " }, { source: "Request.", authenticated: true }]) {
    expect(await f.task("approve", { ...request, approval })).toMatchObject({ error: { code: "INVALID_TASK_INPUT" } });
    expect(await mcp("task_approve", { root: f.project, ...request, approval })).toMatchObject({ isError: true });
  }
  for (const change of [{ contract: { ...contract, goal: "Unapproved replacement." } }, { source: { reference: "Another source.", capturedAt: "2026-09-05T00:00:00Z" } }]) {
    expect(await f.task("approve", { ...request, ...change })).toMatchObject({ error: { code: "APPROVAL_CONTENT_MISMATCH" } });
    expect(await mcp("task_approve", { root: f.project, ...request, ...change })).toMatchObject({ error: { code: "APPROVAL_CONTENT_MISMATCH" } });
  }
  expect(await f.task("read", { taskId: input.taskId })).toEqual(prepared);
  const approved = await f.task("approve", request);
  expect(approved.error).toBeUndefined();
  expect(await mcp("task_approve", { root: f.project, ...request, approval: { source: "Changed evidence under the original key." } })).toMatchObject({ error: { code: "RETRY_CONFLICT" } });
  expect(await f.task("approve", { ...request, retryKey: crypto.randomUUID(), expectedRevision: 2 })).toMatchObject({ error: { code: "ALREADY_APPROVED" } });
  expect(await f.task("read", { taskId: input.taskId })).toEqual(approved);
});

test("overlapping approvals and stale proposals cannot replace a newer contract", async () => {
  const f = await fixture(); const input = createInput(); await f.task("create", input);
  const mcp = await f.mcp();
  const initial = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, contract, approval: { source: "Initial request." } };
  const approvals = await Promise.all([f.task("approve", initial), mcp("task_approve", { root: f.project, ...initial, retryKey: crypto.randomUUID() })]);
  expect(approvals.filter(result => result.error).map(result => result.error.code)).toEqual(["STALE_REVISION"]);
  const proposal = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 2, expectedContractRevision: 1, proposalId: crypto.randomUUID(), contract: { ...contract, goal: "First proposed goal." } };
  const proposed = await f.task("propose", proposal);
  expect(proposed.error).toBeUndefined();
  expect(await mcp("task_propose", { root: f.project, ...proposal })).toEqual(proposed);
  expect(await f.task("propose", { ...proposal, contract: { ...contract, goal: "Changed proposal under the same retry key." } })).toMatchObject({ error: { code: "RETRY_CONFLICT" } });
  const second = { ...proposal, retryKey: crypto.randomUUID(), expectedRevision: 3, proposalId: crypto.randomUUID(), contract: { ...contract, goal: "Second proposed goal." } };
  expect((await mcp("task_propose", { root: f.project, ...second })).error).toBeUndefined();
  const approve = { ...proposal, retryKey: crypto.randomUUID(), expectedRevision: 4, approval: { source: "Approved the first proposal." } };
  const revised = await mcp("task_approve", { root: f.project, ...approve });
  expect(revised.error).toBeUndefined();
  expect(revised.value.task.contractRevision).toBe(2);
  expect(await f.task("approve", { ...second, retryKey: crypto.randomUUID(), expectedRevision: 5, expectedContractRevision: 2, approval: { source: "Stale proposal approval." } })).toMatchObject({ error: { code: "STALE_CONTRACT_REVISION" } });
  expect(await f.task("save", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 5, expectedContractRevision: 1, checkpoint })).toMatchObject({ error: { code: "STALE_CONTRACT_REVISION" } });
  expect(await mcp("task_save", { root: f.project, taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 5, expectedContractRevision: 1, checkpoint })).toMatchObject({ error: { code: "STALE_CONTRACT_REVISION" } });
  expect(await f.task("propose", { ...proposal, retryKey: crypto.randomUUID(), expectedRevision: 5, expectedContractRevision: 2 })).toMatchObject({ error: { code: "PROPOSAL_EXISTS" } });
  expect(await f.task("read", { taskId: input.taskId })).toEqual(revised);
  expect(await f.task("approve", approve)).toEqual(revised);
  expect(await f.task("propose", proposal)).toEqual(proposed);
});

test("contract and proposal reads and approvals remain isolated by task project and instance", async () => {
  const f = await fixture(); const input = createInput(); await f.task("create", input);
  const approval = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, contract, approval: { source: "Request for the first project." } };
  const approved = await f.task("approve", approval);
  const proposalId = crypto.randomUUID();
  const proposed = await f.task("propose", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 2, expectedContractRevision: 1, proposalId, contract: { ...contract, goal: "First project only." } });
  const otherRoot = join(f.root, "another-project"); mkdirSync(otherRoot);
  await f.cli("project", "register", "--instance", "test", "--root", otherRoot);
  expect((await f.task("create", input, "test", otherRoot)).error).toBeUndefined();
  expect((await f.task("contract", { taskId: input.taskId, contractRevision: 1 }, "test", otherRoot)).value.contract.approval).toBeNull();
  expect(await f.task("proposal", { taskId: input.taskId, proposalId }, "test", otherRoot)).toMatchObject({ error: { code: "PROPOSAL_NOT_FOUND" } });
  expect(await f.task("approve", { ...approval, proposalId }, "test", otherRoot)).toMatchObject({ error: { code: "PROPOSAL_NOT_FOUND" } });
  const otherApproved = await f.task("approve", { ...approval, approval: { source: "Request for the second project." } }, "test", otherRoot);
  expect(otherApproved.value.task.approval.source).toBe("Request for the second project.");
  await f.cli("instance", "create", "--instance", "second"); await f.start("second");
  await f.cli("project", "register", "--instance", "second", "--root", f.project);
  const mcp = await f.mcp("second");
  expect(await mcp("task_contract", { root: f.project, taskId: input.taskId, contractRevision: 1 })).toMatchObject({ error: { code: "CONTRACT_NOT_FOUND" } });
  expect(await mcp("task_proposal", { root: f.project, taskId: input.taskId, proposalId })).toMatchObject({ error: { code: "PROPOSAL_NOT_FOUND" } });
  expect(await mcp("task_approve", { root: f.project, ...approval })).toMatchObject({ error: { code: "TASK_NOT_FOUND" } });
  const otherTask = createInput(); await f.task("create", otherTask);
  expect(await f.task("proposal", { taskId: otherTask.taskId, proposalId })).toMatchObject({ error: { code: "PROPOSAL_NOT_FOUND" } });
  expect(await f.task("read", { taskId: input.taskId })).toEqual(proposed);
  expect(await f.task("approve", approval)).toEqual(approved);
});

test("a rejected draft can be corrected by proposal without approving its original content", async () => {
  const f = await fixture(); const input = createInput(); await f.task("create", input);
  const proposal = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, proposalId: crypto.randomUUID(), contract: { ...contract, goal: "Corrected goal approved by the user." } };
  const proposed = await f.task("propose", proposal);
  expect(proposed.error).toBeUndefined();
  expect(proposed.value.task.approval).toBeNull();
  const mcp = await f.mcp();
  expect(await mcp("task_check", { root: f.project, taskId: input.taskId, expectedRevision: 2, expectedContractRevision: 1 })).toMatchObject({ error: { code: "APPROVAL_REQUIRED" } });
  const approved = await mcp("task_approve", { root: f.project, ...proposal, expectedRevision: 2, retryKey: crypto.randomUUID(), approval: { source: "User approved only the corrected goal." } });
  expect(approved.error).toBeUndefined();
  expect(approved.value.task.contractRevision).toBe(2);
  expect(approved.value.task.contract).toEqual(proposal.contract);
  expect(approved.value.contractMismatch).toBe(true);
  expect((await f.task("contract", { taskId: input.taskId, contractRevision: 1 })).value.contract).toEqual({ revision: 1, content: contract, source: null, approval: null });
});

test("issue capture is self-contained and rejects incomplete source metadata without fetching", async () => {
  const f = await fixture(); const input = createInput(); const mcp = await f.mcp();
  for (const source of [{ reference: "Issue 42." }, { capturedAt: "2026-09-05T12:00:00Z" }, { reference: " ", capturedAt: "2026-09-05T12:00:00Z" }, { reference: "Issue 42.", capturedAt: "yesterday" }, { reference: "Issue 42.", capturedAt: "2026-09-05T12:00:00" }]) {
    expect(await f.task("create", { ...input, source })).toMatchObject({ error: { code: "INVALID_TASK_INPUT" } });
    expect(await mcp("task_create", { root: f.project, ...input, source })).toMatchObject({ isError: true });
  }
  let requests = 0;
  const server = createServer(socket => {
    requests++;
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 24\r\nConnection: close\r\n\r\nLater unapproved wording");
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  const source = { reference: `http://127.0.0.1:${port}/issues/42`, capturedAt: "2026-09-05T09:00:00-03:00" };
  let approved: any;
  try {
    expect((await f.task("create", { ...input, source })).error).toBeUndefined();
    approved = await mcp("task_approve", { root: f.project, taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, contract, source, approval: { source: "User request captured with the issue." } });
    expect(approved.error).toBeUndefined();
    expect(await f.task("read", { taskId: input.taskId })).toEqual(approved);
    expect(requests).toBe(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  f.daemon.kill("SIGKILL"); await f.daemon.exited; await f.start();
  expect(await mcp("task_read", { root: f.project, taskId: input.taskId })).toEqual(approved);
  expect((await f.task("contract", { taskId: input.taskId, contractRevision: 1 })).value.contract).toEqual({ revision: 1, content: contract, source, approval: { source: "User request captured with the issue." } });
});

test("starting implementation requires approval and saves state with its checkpoint across restart", async () => {
  const f = await fixture(); const input = createInput();
  const created = await f.task("create", input);
  const change = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, state: "in-progress", checkpoint: { ...checkpoint, progress: "Started approved work." } };
  expect(await f.task("transition", change)).toMatchObject({ error: { code: "APPROVAL_REQUIRED" } });
  expect(await f.task("read", { taskId: input.taskId })).toEqual(created);
  await f.task("approve", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, contract, approval: { source: "Implement this task." } });
  const mcp = await f.mcp();
  const started = await mcp("task_transition", { root: f.project, ...change, expectedRevision: 2 });
  expect(started.error).toBeUndefined();
  expect(started.value.task.state).toBe("in-progress");
  expect(started.value.checkpoint.content).toEqual(change.checkpoint);
  expect(started.value.checkpointCount).toBe(2);
  f.daemon.kill("SIGKILL"); await f.daemon.exited; await f.start();
  expect(await f.task("read", { taskId: input.taskId })).toEqual(started);
  expect(await f.task("transition", { ...change, expectedRevision: 2 })).toEqual(started);
});

test("blocked work requires a resolution action and evidence before returning to todo", async () => {
  const f = await fixture(); const input = createInput(); const created = await f.task("create", input); const mcp = await f.mcp();
  const blockedCheckpoint = { ...checkpoint, blockers: [{ reason: "The test service is unavailable.", continuationCondition: "The test service accepts requests." }], nextAction: "Start the test service." };
  const change = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, state: "blocked", checkpoint: blockedCheckpoint };
  expect(await f.task("transition", { ...change, checkpoint })).toMatchObject({ error: { code: "BLOCKER_REQUIRED" } });
  expect(await f.task("read", { taskId: input.taskId })).toEqual(created);
  const blocked = await mcp("task_transition", { root: f.project, ...change });
  expect(blocked.value.task.state).toBe("blocked");
  expect(blocked.value.checkpoint.content).toEqual(blockedCheckpoint);
  const resume = { ...change, retryKey: crypto.randomUUID(), expectedRevision: 2, state: "todo", checkpoint };
  expect(await f.task("transition", resume)).toMatchObject({ error: { code: "RESOLUTION_REQUIRED" } });
  expect(await f.task("save", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 2, expectedContractRevision: 1, checkpoint })).toMatchObject({ error: { code: "BLOCKER_REQUIRED" } });
  const resolved = await f.task("transition", { ...resume, blockerResolutions: [{ blockerIndex: 0, evidence: "The test service returned 200." }] });
  expect(resolved.value.task.state).toBe("todo");
  expect(resolved.value.task.contract).toEqual(contract);
  expect(resolved.value.checkpoint.transition).toMatchObject({ from: "blocked", to: "todo", blockerResolutions: [{ blockerIndex: 0, evidence: "The test service returned 200." }] });
  expect(await mcp("task_read", { root: f.project, taskId: input.taskId })).toEqual(resolved);
});

test("completion requires every passing check and required approval before evidence-based reopening", async () => {
  const f = await fixture(); const input = { ...createInput(), contract: { ...contract, acceptanceChecks: ["Read the saved task.", "Read the saved checkpoint."], completionApprovalRequired: true } };
  await f.task("create", input);
  await f.task("approve", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, contract: input.contract, approval: { source: "Implement these requirements." } });
  await f.task("transition", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 2, expectedContractRevision: 1, state: "in-progress", checkpoint });
  const mcp = await f.mcp();
  const complete = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 3, expectedContractRevision: 1, state: "done", checkpoint: { ...checkpoint, progress: "Both reads passed.", remainingWork: [], nextAction: null }, acceptanceEvidence: [{ checkIndex: 0, status: "passed", evidence: "Task read matched." }, { checkIndex: 1, status: "passed", evidence: "Checkpoint read matched." }] };
  expect(await f.task("transition", complete)).toMatchObject({ error: { code: "APPROVAL_REQUIRED" } });
  const approved = { ...complete, approval: { source: "Maintainer accepted both results." } };
  for (const acceptanceEvidence of [[], [complete.acceptanceEvidence[0]], [complete.acceptanceEvidence[0], complete.acceptanceEvidence[0]], [{ ...complete.acceptanceEvidence[0], status: "failed" }, complete.acceptanceEvidence[1]], [{ ...complete.acceptanceEvidence[0], checkIndex: 2 }, complete.acceptanceEvidence[1]]]) {
    expect(await f.task("transition", { ...approved, acceptanceEvidence })).toMatchObject({ error: { code: "COMPLETION_EVIDENCE_REQUIRED" } });
  }
  expect(await mcp("task_transition", { root: f.project, ...approved, checkpoint: { ...complete.checkpoint, blockers: [{ reason: "Read failed.", continuationCondition: "Read passes." }] } })).toMatchObject({ error: { code: "UNRESOLVED_BLOCKER" } });
  const done = await mcp("task_transition", { root: f.project, ...approved });
  expect(done.value.task.state).toBe("done");
  expect(done.value.checkpoint.transition).toMatchObject({ from: "in-progress", to: "done", approval: approved.approval, acceptanceEvidence: complete.acceptanceEvidence });
  const reopen = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 4, expectedContractRevision: 1, state: "todo", checkpoint };
  expect(await f.task("transition", reopen)).toMatchObject({ error: { code: "REOPENING_EVIDENCE_REQUIRED" } });
  expect(await f.task("transition", { ...reopen, reason: "The checkpoint read regressed." })).toMatchObject({ error: { code: "REOPENING_EVIDENCE_REQUIRED" } });
  const reopened = await f.task("transition", { ...reopen, reason: "The checkpoint read regressed.", failureEvidence: ["The fresh process returned different content."] });
  expect(reopened.value.task.state).toBe("todo");
  expect(reopened.value.task.contract).toEqual(input.contract);
  expect(reopened.value.task.contractRevision).toBe(1);
  expect(await mcp("task_read", { root: f.project, taskId: input.taskId })).toEqual(reopened);
});

test("cancellation records its reason and approval and resumption requires new approval", async () => {
  const f = await fixture(); const input = createInput(); const created = await f.task("create", input); const mcp = await f.mcp();
  const cancel = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, state: "cancelled", checkpoint: { ...checkpoint, progress: "Work stopped without completion.", nextAction: null } };
  expect(await f.task("transition", cancel)).toMatchObject({ error: { code: "CANCELLATION_REASON_REQUIRED" } });
  expect(await f.task("transition", { ...cancel, reason: "The maintainer withdrew this work." })).toMatchObject({ error: { code: "APPROVAL_REQUIRED" } });
  expect(await f.task("read", { taskId: input.taskId })).toEqual(created);
  const cancelled = await mcp("task_transition", { root: f.project, ...cancel, reason: "The maintainer withdrew this work.", approval: { source: "Cancel this task." } });
  expect(cancelled.value.task.state).toBe("cancelled");
  expect(cancelled.value.checkpoint.transition).toMatchObject({ from: "todo", to: "cancelled", reason: "The maintainer withdrew this work.", approval: { source: "Cancel this task." } });
  const resume = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 2, expectedContractRevision: 1, state: "todo", checkpoint };
  expect(await f.task("transition", resume)).toMatchObject({ error: { code: "APPROVAL_REQUIRED" } });
  const resumed = await f.task("transition", { ...resume, approval: { source: "Resume the cancelled task." } });
  expect(resumed.value.task.state).toBe("todo");
  expect(resumed.value.task.contract).toEqual(contract);
  expect(resumed.value.task.approval).toBeNull();
  expect(await mcp("task_read", { root: f.project, taskId: input.taskId })).toEqual(resumed);
});

const states = ["todo", "in-progress", "blocked", "done", "cancelled"] as const;
type WorkflowState = typeof states[number];
const edges = new Set(["todo/in-progress", "todo/blocked", "todo/cancelled", "in-progress/blocked", "in-progress/done", "in-progress/cancelled", "blocked/todo", "blocked/cancelled", "done/todo", "cancelled/todo"]);
function transitionFields(state: WorkflowState) {
  return { state, checkpoint: { ...checkpoint, nextAction: state === "done" || state === "cancelled" ? null : "Resolve the recorded condition and continue.", blockers: state === "blocked" ? [{ reason: "Test service stopped.", continuationCondition: "Test service started." }] : [] },
    ...(state === "done" ? { acceptanceEvidence: [{ checkIndex: 0, status: "passed", evidence: "Exact read passed." }] } : {}),
    ...(state === "cancelled" ? { reason: "Work withdrawn.", approval: { source: "Maintainer requested cancellation." } } : {}) };
}
async function prepareState(f: Awaited<ReturnType<typeof fixture>>, state: WorkflowState) {
  const input = createInput(); let current = await f.task("create", input);
  expect(current.error).toBeUndefined();
  current = await f.task("approve", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, contract, approval: { source: "Implement this task." } });
  expect(current.error).toBeUndefined();
  const path: WorkflowState[] = state === "done" ? ["in-progress", "done"] : state === "todo" ? [] : [state];
  for (const next of path) {
    current = await f.task("transition", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: current.value.task.revision, expectedContractRevision: 1, ...transitionFields(next) });
    expect(current.error).toBeUndefined();
  }
  return { input, current };
}
for (const interfaceName of ["CLI", "MCP"]) for (const from of states) test(`${interfaceName} enforces the complete transition matrix from ${from}`, async () => {
  const f = await fixture(); const mcp = await f.mcp();
  for (const to of states) {
    const { input, current } = await prepareState(f, from);
    const change = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: current.value.task.revision, expectedContractRevision: 1, ...transitionFields(to),
      ...(from === "blocked" && to === "todo" ? { blockerResolutions: [{ blockerIndex: 0, evidence: "Test service started." }] } : {}),
      ...(from === "done" && to === "todo" ? { reason: "A regression appeared.", failureEvidence: ["The read failed after restart."] } : {}),
      ...(from === "cancelled" && to === "todo" ? { approval: { source: "Resume this task." } } : {}) };
    const result = interfaceName === "CLI" ? await f.task("transition", change) : await mcp("task_transition", { root: f.project, ...change });
    if (edges.has(`${from}/${to}`)) {
      expect(result.error).toBeUndefined();
      expect(result.value.task.state).toBe(to);
      expect(result.value.task.contract).toEqual(contract);
      expect(result.value.task.revision).toBe(current.value.task.revision + 1);
      expect(result.value.checkpointCount).toBe(current.value.checkpointCount + 1);
      expect(result.value.checkpoint.content).toEqual(change.checkpoint);
      expect(await f.task("read", { taskId: input.taskId })).toEqual(result);
    } else {
      expect(result).toMatchObject({ error: { code: "INVALID_TRANSITION" } });
      expect(await f.task("read", { taskId: input.taskId })).toEqual(current);
    }
  }
}, 30000);

test("state controls apply to checkpoint saves and required dependency evidence before starting", async () => {
  const f = await fixture(); const input = { ...createInput(), contract: { ...contract, dependencyConditions: ["The dependency ticket is accepted."] } };
  expect((await f.task("create", input)).error).toBeUndefined();
  await f.task("approve", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, expectedContractRevision: 1, contract: input.contract, approval: { source: "Implement after acceptance." } });
  const start = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 2, expectedContractRevision: 1, ...transitionFields("in-progress") };
  expect(await f.task("transition", start)).toMatchObject({ error: { code: "DEPENDENCY_EVIDENCE_REQUIRED" } });
  const started = await f.task("transition", { ...start, dependencyEvidence: [{ conditionIndex: 0, evidence: "Maintainer accepted the dependency in its completion report." }] });
  expect(started.value.task.state).toBe("in-progress");
  const mcp = await f.mcp();
  for (const state of states) {
    const { input, current } = await prepareState(f, state);
    const update = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: current.value.task.revision, expectedContractRevision: 1, checkpoint: { ...current.value.checkpoint.content, nextAction: null } };
    const result = await mcp("task_save", { root: f.project, ...update });
    if (state === "done" || state === "cancelled") {
      expect(result.error).toBeUndefined(); expect(result.value.task.state).toBe(state);
    } else {
      expect(result).toMatchObject({ error: { code: "INVALID_TASK_INPUT" } });
      expect(await f.task("read", { taskId: input.taskId })).toEqual(current);
    }
  }
});

test("ordinary blocked saves cannot erase unresolved blockers before returning to todo", async () => {
  const f = await fixture(); const { input, current } = await prepareState(f, "blocked");
  const replacement = { ...current.value.checkpoint.content, blockers: [{ reason: "A different obstacle.", continuationCondition: "A different condition." }] };
  const update = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: current.value.task.revision, expectedContractRevision: 1, checkpoint: replacement };
  const mcp = await f.mcp();
  expect(await f.task("save", update)).toMatchObject({ error: { code: "RESOLUTION_REQUIRED" } });
  expect(await mcp("task_save", { root: f.project, ...update })).toMatchObject({ error: { code: "RESOLUTION_REQUIRED" } });
  expect(await f.task("read", { taskId: input.taskId })).toEqual(current);
  const added = await f.task("save", { ...update, checkpoint: { ...replacement, blockers: [...current.value.checkpoint.content.blockers, ...replacement.blockers] } });
  expect(added.error).toBeUndefined();
  const resume = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: added.value.task.revision, expectedContractRevision: 1, ...transitionFields("todo"), blockerResolutions: [{ blockerIndex: 1, evidence: "Only the second obstacle is resolved." }] };
  expect(await f.task("transition", resume)).toMatchObject({ error: { code: "RESOLUTION_REQUIRED" } });
  expect(await f.task("read", { taskId: input.taskId })).toEqual(added);
});

test("terminal checkpoint saves retain cancellation evidence and reject new completion blockers", async () => {
  const f = await fixture(); const cancelled = await prepareState(f, "cancelled"); const mcp = await f.mcp();
  const updated = await f.task("save", { taskId: cancelled.input.taskId, retryKey: crypto.randomUUID(), expectedRevision: cancelled.current.value.task.revision, expectedContractRevision: 1, checkpoint: { ...cancelled.current.value.checkpoint.content, evidence: ["Recorded cancellation for the next session."] } });
  expect(updated.value.task.lastTransition).toMatchObject({ from: "todo", to: "cancelled", reason: "Work withdrawn.", approval: { source: "Maintainer requested cancellation." } });
  f.daemon.kill("SIGKILL"); await f.daemon.exited; await f.start();
  expect(await mcp("task_read", { root: f.project, taskId: cancelled.input.taskId })).toEqual(updated);
  const done = await prepareState(f, "done");
  const invalid = { taskId: done.input.taskId, retryKey: crypto.randomUUID(), expectedRevision: done.current.value.task.revision, expectedContractRevision: 1, checkpoint: { ...done.current.value.checkpoint.content, blockers: [{ reason: "A relevant read failed.", continuationCondition: "The read passes." }] } };
  expect(await mcp("task_save", { root: f.project, ...invalid })).toMatchObject({ error: { code: "UNRESOLVED_BLOCKER" } });
  expect(await f.task("read", { taskId: done.input.taskId })).toEqual(done.current);
});

test("completion distinguishes reported unrelated blockers and rejects irrelevant transition evidence", async () => {
  const f = await fixture(); const { input, current } = await prepareState(f, "in-progress"); const mcp = await f.mcp();
  const complete = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: current.value.task.revision, expectedContractRevision: 1, ...transitionFields("done") };
  const unrelated = { reason: "An excluded memory service is stopped.", continuationCondition: "The memory service starts.", affectsCompletion: false };
  const done = await f.task("transition", { ...complete, checkpoint: { ...complete.checkpoint, blockers: [unrelated] } });
  expect(done.error).toBeUndefined(); expect(done.value.task.state).toBe("done");
  const reopen = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: done.value.task.revision, expectedContractRevision: 1, ...transitionFields("todo"), reason: "A read failed.", failureEvidence: ["The regression check returned a failure."] };
  expect(await mcp("task_transition", { root: f.project, ...reopen, acceptanceEvidence: complete.acceptanceEvidence })).toMatchObject({ error: { code: "INVALID_TASK_INPUT" } });
  expect(await f.task("read", { taskId: input.taskId })).toEqual(done);
  expect((await f.task("transition", reopen)).value.task.state).toBe("todo");
});

test("overlapping transitions and changed retries cannot replace a committed state or checkpoint", async () => {
  const f = await fixture(); const { input, current } = await prepareState(f, "todo"); const mcp = await f.mcp();
  const first = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: current.value.task.revision, expectedContractRevision: 1, ...transitionFields("blocked") };
  const second = { ...first, retryKey: crypto.randomUUID(), ...transitionFields("cancelled") };
  const results = await Promise.all([f.task("transition", first), mcp("task_transition", { root: f.project, ...second })]);
  expect(results.filter(result => result.error).map(result => result.error.code)).toEqual(["STALE_REVISION"]);
  const winner = results.find(result => !result.error); const request = results[0].error ? second : first;
  expect(winner.value.task.revision).toBe(3); expect(winner.value.checkpointCount).toBe(2);
  expect(await f.task("read", { taskId: input.taskId })).toEqual(winner);
  expect(await f.task("transition", { ...request, checkpoint: { ...request.checkpoint, progress: "Changed retry content." } })).toMatchObject({ error: { code: "RETRY_CONFLICT" } });
  f.daemon.kill("SIGKILL"); await f.daemon.exited; await f.start();
  expect(await mcp("task_transition", { root: f.project, ...request })).toEqual(winner);
  expect(await f.task("read", { taskId: input.taskId })).toEqual(winner);
  const otherRoot = join(f.root, "other-workflow-project"); mkdirSync(otherRoot);
  await f.cli("project", "register", "--instance", "test", "--root", otherRoot);
  expect(await f.task("transition", request, "test", otherRoot)).toMatchObject({ error: { code: "TASK_NOT_FOUND" } });
  await f.cli("instance", "create", "--instance", "other-workflow"); await f.start("other-workflow");
  await f.cli("project", "register", "--instance", "other-workflow", "--root", f.project);
  expect(await f.task("transition", request, "other-workflow")).toMatchObject({ error: { code: "TASK_NOT_FOUND" } });
  expect(await f.task("read", { taskId: input.taskId })).toEqual(winner);
});

test("revised requirements prevent stale starts and completion until checkpoint reconciliation", async () => {
  const f = await fixture(); const { input } = await prepareState(f, "todo"); const mcp = await f.mcp();
  const changed = { ...contract, acceptanceChecks: ["A different acceptance check."] }; const proposalId = crypto.randomUUID();
  await f.task("propose", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 2, expectedContractRevision: 1, proposalId, contract: changed });
  const adopted = await f.task("approve", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 3, expectedContractRevision: 1, proposalId, contract: changed, approval: { source: "Use the different acceptance check." } });
  expect(adopted.value.contractMismatch).toBe(true);
  const start = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 4, expectedContractRevision: 1, ...transitionFields("in-progress") };
  expect(await f.task("transition", start)).toMatchObject({ error: { code: "STALE_CONTRACT_REVISION" } });
  expect(await mcp("task_transition", { root: f.project, ...start, expectedContractRevision: 2 })).toMatchObject({ error: { code: "CHECKPOINT_CONTRACT_MISMATCH" } });
  expect(await f.task("read", { taskId: input.taskId })).toEqual(adopted);
  await f.task("save", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 4, expectedContractRevision: 2, checkpoint: { ...checkpoint, progress: "Compared the new acceptance check." } });
  const started = await f.task("transition", { ...start, expectedRevision: 5, expectedContractRevision: 2 }); expect(started.error).toBeUndefined();
  const secondId = crypto.randomUUID();
  await f.task("propose", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 6, expectedContractRevision: 2, proposalId: secondId, contract });
  const next = await f.task("approve", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 7, expectedContractRevision: 2, proposalId: secondId, contract, approval: { source: "Use the original acceptance check again." } });
  const complete = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 8, expectedContractRevision: 3, ...transitionFields("done") };
  expect(await f.task("transition", complete)).toMatchObject({ error: { code: "CHECKPOINT_CONTRACT_MISMATCH" } });
  expect(await f.task("read", { taskId: input.taskId })).toEqual(next);
  await f.task("save", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 8, expectedContractRevision: 3, checkpoint });
  expect((await mcp("task_transition", { root: f.project, ...complete, expectedRevision: 9 })).value.task.state).toBe("done");
});

test("CLI and MCP reject missing or malformed transition evidence without writes", async () => {
  const f = await fixture(); const { input, current } = await prepareState(f, "todo"); const mcp = await f.mcp();
  const cancel = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: current.value.task.revision, expectedContractRevision: 1, ...transitionFields("cancelled") };
  for (const change of [{ approval: undefined }, { approval: null }, { approval: { source: " " } }, { reason: " " }, { checkpoint: { ...cancel.checkpoint, nextAction: undefined } }, { checkpoint: { ...cancel.checkpoint, blockers: [{ reason: "Waiting.", continuationCondition: " " }] } }]) {
    const request = { ...cancel, ...change };
    const cli = await f.task("transition", request);
    expect(cli.error).toBeDefined();
    const result = await mcp("task_transition", { root: f.project, ...JSON.parse(JSON.stringify(request)) });
    if (cli.error.code === "INVALID_TASK_INPUT") expect(result.error?.code === "INVALID_TASK_INPUT" || result.isError === true).toBe(true);
    else expect(result).toMatchObject({ error: { code: cli.error.code } });
    expect(await f.task("read", { taskId: input.taskId })).toEqual(current);
  }
});
