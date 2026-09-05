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
  async function start(name = "test", trace?: string) {
    const prefix = trace ? ["strace", "-f", "-yy", "-e", "trace=fsync,pwrite64", "-e", "inject=fsync:signal=SIGKILL:when=1", "-o", trace] : [];
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
      return JSON.parse((result.content as any[])[0].text);
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
  expect(saved.value.task).toEqual({ id: input.taskId, revision: 1, state: "todo", contractRevision: 1, contract });
  expect(saved.value.checkpoint.content).toEqual(checkpoint);
  f.daemon.kill("SIGKILL"); await f.daemon.exited; await f.start();
  const mcp = await f.mcp();
  expect(await mcp("task_read", { root: f.project, taskId: input.taskId })).toEqual(saved);
  const next = { ...checkpoint, progress: "Verified persistence.", evidence: ["A fresh process read the exact content."] };
  const updated = await mcp("task_save", { root: f.project, taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, checkpoint: next });
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
  const update = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, checkpoint: { ...checkpoint, progress: "Saved a second checkpoint." } };
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
    expect(await f.task("save", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, checkpoint: incomplete })).toMatchObject({ error: { code: "INVALID_TASK_INPUT" } });
  }
  for (const change of [{ nextAction: null }, { progress: " " }, { blockers: [{ reason: "Waiting." }] }, { repositoryState: null }, { evidence: null }]) {
    expect(await f.task("save", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, checkpoint: { ...checkpoint, ...change } })).toMatchObject({ error: { code: "INVALID_TASK_INPUT" } });
  }
  for (const extra of [{ state: "done" }, { state: "in-progress" }, { approval: "Approved." }, { contract: { ...contract, goal: "Replace requirements." } }]) {
    expect(await f.task("save", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, checkpoint, ...extra })).toMatchObject({ error: { code: "INVALID_TASK_INPUT" } });
  }
  expect(await f.task("read", { taskId: input.taskId })).toEqual(saved);
});

test("overlapping CLI and MCP saves reject stale revisions with a specific error", async () => {
  const f = await fixture(); const input = createInput(); await f.task("create", input);
  const mcp = await f.mcp();
  const first = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, checkpoint: { ...checkpoint, progress: "CLI update." } };
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
  expect(await f.task("save", { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, checkpoint }, "test", join(f.root, "missing"))).toHaveProperty("error");
  expect(await f.task("read", { taskId: input.taskId })).toEqual(first);
});

test("death before commit preserves the prior task and retry commits one complete update", async () => {
  const f = await fixture(); const input = createInput();
  const prior = await f.task("create", input);
  f.daemon.kill("SIGKILL"); await f.daemon.exited;
  const trace = join(f.root, "before-commit.trace");
  const traced = await f.start("test", trace);
  const update = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, checkpoint: { ...checkpoint, progress: "Atomic update." } };
  const mcp = await f.mcp();
  expect(await mcp("task_save", { root: f.project, ...update })).toMatchObject({ error: { code: "RESPONSE_INTERRUPTED" } });
  await traced.exited;
  const syscalls = readFileSync(trace, "utf8");
  expect(syscalls).toMatch(/fsync\([^\n]*state\.sqlite-journal/);
  expect(syscalls).toContain("SIGKILL");
  expect(syscalls).not.toMatch(/pwrite64\([^\n]*state\.sqlite>/);
  await f.start();
  expect(await f.task("read", { taskId: input.taskId })).toEqual(prior);
  const retried = await f.task("save", update);
  expect(retried.error).toBeUndefined();
  expect(retried.value.task.revision).toBe(2);
  expect(retried.value.checkpoint.content).toEqual(update.checkpoint);
  expect(retried.value.checkpointCount).toBe(2);
  expect(await mcp("task_save", { root: f.project, ...update })).toEqual(retried);
});

test("death after commit with a withheld response preserves the exact retry result", async () => {
  const f = await fixture(); const input = createInput();
  const prior = await f.task("create", input);
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
  const update = { taskId: input.taskId, retryKey: crypto.randomUUID(), expectedRevision: 1, checkpoint: { ...checkpoint, progress: "Committed before response loss." } };
  try {
    expect(await f.task("save", update)).toMatchObject({ error: { code: "RESPONSE_INTERRUPTED" } });
    expect(withheld.error).toBeUndefined();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    rmSync(path, { force: true }); rmSync(upstreamPath, { force: true });
  }
  await f.start(); const mcp = await f.mcp();
  expect(await mcp("task_read", { root: f.project, taskId: input.taskId })).toEqual(withheld);
  expect(await mcp("task_save", { root: f.project, ...update })).toEqual(withheld);
  expect(withheld.value.task.revision).toBe(2);
  expect(withheld.value.checkpointCount).toBe(2);
  expect(withheld.value.checkpoint.content).toEqual(update.checkpoint);
  expect(await f.task("read", { taskId: input.taskId })).toEqual(withheld);
});
