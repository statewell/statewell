import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const fixtures: { root: string; cli: (...args: string[]) => Promise<any> }[] = [];
function fixture() {
  const root = mkdtempSync("/dev/shm/statewell-lifecycle-");
  const home = join(root, "state");
  const command = [Bun.env.STATEWELL_TEST_BINARY ?? Bun.argv[0]!, ...(Bun.env.STATEWELL_TEST_BINARY ? [] : [resolve("src/cli.ts")])];
  async function cli(...args: string[]) {
    const child = Bun.spawn([...command, ...args], { cwd: root, env: { ...Bun.env, STATEWELL_HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, result: JSON.parse(out || err) };
  }
  const f = { root, home, command, cli };
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.cli("instance", "stop");
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a query starts existing main and preserves its identity", async () => {
  const f = fixture();
  const created = await f.cli("instance", "create");
  const reply = await f.cli("instance", "inspect");
  expect(reply.code).toBe(0);
  expect(reply.result.instance).toEqual(created.result.instance);
});

test("racing clients share main and removal preserves its registered projects", async () => {
  const f = fixture();
  const created = await f.cli("instance", "create");
  const replies = await Promise.all(Array.from({ length: 8 }, () => f.cli("instance", "inspect")));
  expect(replies.map(reply => reply.code)).toEqual(Array(8).fill(0));
  for (const reply of replies) expect(reply.result.instance).toEqual(created.result.instance);
  const saved = await f.cli("project", "register", "--root", f.root);
  expect(saved.code).toBe(0);
  expect((await f.cli("instance", "remove")).code).toBe(0);
  expect((await f.cli("instance", "inspect")).result.error.code).toBe("SETUP_REQUIRED");
  expect((await f.cli("instance", "create", "--data-dir", created.result.instance.directory)).result.instance).toEqual(created.result.instance);
  expect((await f.cli("project", "inspect", "--root", f.root)).result).toEqual(saved.result);
});

test("a named detached instance survives its launcher and requires explicit restart", async () => {
  const f = fixture();
  const created = await f.cli("instance", "create", "--instance", "test");
  try {
    expect((await f.cli("instance", "start", "--instance", "test", "--detached")).code).toBe(0);
    expect((await f.cli("instance", "inspect", "--instance", "test")).result.instance).toEqual(created.result.instance);
    expect((await f.cli("instance", "stop", "--instance", "test")).result.value.stopped).toBe(true);
    expect((await f.cli("instance", "inspect", "--instance", "test")).result.error.code).toBe("INSTANCE_UNAVAILABLE");
    expect((await f.cli("instance", "start", "--instance", "missing", "--detached")).result.error.code).toBe("SETUP_REQUIRED");
  } finally { await f.cli("instance", "stop", "--instance", "test"); }
});

async function mcp(f: ReturnType<typeof fixture>, name = "main") {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "lifecycle-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: f.command[0]!, args: [...f.command.slice(1), "mcp", "--instance", name], env: { PATH: process.env.PATH!, STATEWELL_HOME: f.home }, stderr: "pipe" }));
  return { close: () => client.close(), async call(name: string, args = {}) {
    const reply = await client.callTool({ name, arguments: args });
    return JSON.parse((reply.content as { text: string }[])[0]!.text);
  } };
}

test("MCP starts main and shares projects across detached restart", async () => {
  const f = fixture();
  const created = await f.cli("instance", "create");
  const client = await mcp(f);
  try {
    expect((await client.call("instance_inspect")).instance).toEqual(created.result.instance);
    const saved = await client.call("project_register", { root: f.root });
    expect((await f.cli("project", "inspect", "--root", f.root)).result).toEqual(saved);
    expect((await f.cli("instance", "stop")).code).toBe(0);
    expect((await client.call("project_inspect", { root: f.root }))).toEqual(saved);
  } finally { await client.close(); }
});

test("failed main startup preserves foreign endpoints and cannot write projects", async () => {
  const f = fixture();
  const { createServer } = await import("node:net");
  const { lstatSync, existsSync } = await import("node:fs");
  const created = await f.cli("instance", "create");
  const path = join(created.result.instance.directory, "daemon.sock");
  const server = createServer(socket => { socket.on("error", () => socket.destroy()); socket.end('{"error":{"code":"FOREIGN_ENDPOINT","message":"Foreign server."}}\n', () => socket.destroy()); });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const inode = lstatSync(path).ino;
  try {
    expect((await f.cli("instance", "start", "--detached")).result.error.code).toBe("ENDPOINT_CONFLICT");
    expect((await f.cli("project", "register", "--root", f.root)).code).toBe(1);
    expect((await f.cli("instance", "remove")).code).toBe(1);
    expect(lstatSync(path).ino).toBe(inode);
    expect(existsSync(join(f.root, ".statewell.json"))).toBe(false);
    expect(existsSync(join(f.home, "instances", "main.json"))).toBe(true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("alternate names and directory aliases cannot replace a database owner", async () => {
  const f = fixture();
  const { writeFileSync, symlinkSync } = await import("node:fs");
  const created = await f.cli("instance", "create");
  await f.cli("instance", "inspect");
  const original = created.result.instance;
  writeFileSync(join(f.home, "instances", "alias.json"), JSON.stringify({ ...original, name: "alias" }));
  expect((await f.cli("instance", "start", "--instance", "alias", "--detached")).result.error.code).toBe("INSTANCE_BUSY");
  expect((await f.cli("instance", "start", "--instance", "alias")).result.error.code).toBe("INSTANCE_BUSY");
  const path = join(f.root, "alias"); symlinkSync(original.directory, path);
  writeFileSync(join(f.home, "instances", "alias.json"), JSON.stringify({ ...original, name: "alias", directory: path }));
  expect((await f.cli("instance", "start", "--instance", "alias")).result.error.code).toBe("DIRECTORY_CONFLICT");
  expect((await f.cli("instance", "inspect")).result.instance).toEqual(original);
});

test("worker timeout fails CLI and MCP requests and stop has a bounded outcome", async () => {
  const f = fixture();
  const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const bin = join(f.root, "bin"); mkdirSync(bin);
  const pidFile = join(f.root, "git.pid");
  writeFileSync(join(bin, "git"), `#!/usr/bin/python3\nimport os, signal, time\nopen(${JSON.stringify(pidFile)}, 'w').write(str(os.getpid()))\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(10)\n`, { mode: 0o700 });
  await f.cli("instance", "create", "--instance", "test");
  const daemon = Bun.spawn([...f.command, "instance", "start", "--instance", "test"], { env: { ...Bun.env, STATEWELL_HOME: f.home, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
  const reader = daemon.stdout.getReader(); await reader.read(); reader.releaseLock();
  const client = await mcp(f, "test");
  try {
    const saved = await f.cli("project", "register", "--instance", "test", "--root", f.root);
    expect(saved.code).toBe(0);
    const began = Date.now();
    expect((await client.call("project_resolve", { root: f.root })).error.code).toBe("WORKER_FAILED");
    expect(Date.now() - began).toBeLessThan(3500);
    expect((await f.cli("instance", "inspect", "--instance", "test")).result.error.code).toBe("WORKER_FAILED");
    const stopping = Date.now();
    const stopped = await f.cli("instance", "stop", "--instance", "test");
    expect(stopped.code).toBe(0);
    expect(Date.now() - stopping).toBeLessThan(4500);
    expect((await f.cli("instance", "start", "--instance", "test", "--detached")).code).toBe(0);
    expect((await client.call("project_inspect", { root: f.root }))).toEqual(saved.result);
  } finally {
    await client.close();
    daemon.kill("SIGKILL"); await daemon.exited;
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {} }
    await f.cli("instance", "stop", "--instance", "test");
  }
});

test("process interruption has explicit outcomes and preserves acknowledged projects", async () => {
  const f = fixture();
  await f.cli("instance", "create", "--instance", "test");
  const daemon = Bun.spawn([...f.command, "instance", "start", "--instance", "test"], { env: { ...Bun.env, STATEWELL_HOME: f.home }, stdout: "pipe", stderr: "pipe" });
  const reader = daemon.stdout.getReader(); await reader.read(); reader.releaseLock();
  const client = await mcp(f, "test");
  try {
    const saved = await client.call("project_register", { root: f.root });
    daemon.kill("SIGSTOP");
    const began = Date.now();
    expect((await f.cli("instance", "inspect", "--instance", "test")).result.error.code).toBe("REQUEST_TIMEOUT");
    expect(Date.now() - began).toBeLessThan(5000);
    daemon.kill("SIGKILL"); await daemon.exited;
    expect((await client.call("instance_inspect")).error.code).toBe("INSTANCE_UNAVAILABLE");
    expect((await f.cli("instance", "start", "--instance", "test", "--detached")).code).toBe(0);
    expect(await client.call("project_inspect", { root: f.root })).toEqual(saved);
  } finally { daemon.kill("SIGKILL"); await daemon.exited; await client.close(); await f.cli("instance", "stop", "--instance", "test"); }
});

test("MCP rejects name replacement before registration and permits explicit reconnection", async () => {
  const f = fixture();
  const { mkdirSync } = await import("node:fs");
  const root = join(f.root, "project"); mkdirSync(root);
  await f.cli("instance", "create");
  const client = await mcp(f);
  try {
    const original = await client.call("instance_inspect");
    expect((await f.cli("instance", "remove")).code).toBe(0);
    const replacement = await f.cli("instance", "create", "--data-dir", join(f.root, "replacement"));
    expect(replacement.result.instance.id).not.toBe(original.instance.id);
    expect((await client.call("project_register", { root })).error.code).toBe("IDENTITY_CHANGED");
    const fresh = await mcp(f);
    try {
      expect((await fresh.call("project_inspect", { root })).error.code).toBe("PROJECT_INIT_REQUIRED");
      expect((await fresh.call("project_register", { root })).instance).toEqual(replacement.result.instance);
    } finally { await fresh.close(); }
  } finally { await client.close(); }
});

test("concurrent removal and main access cannot restart an unregistered instance", async () => {
  const f = fixture();
  await f.cli("instance", "create"); await f.cli("instance", "inspect");
  const results = await Promise.all([f.cli("instance", "remove"), ...Array.from({ length: 6 }, () => f.cli("instance", "inspect"))]);
  expect(results[0]!.code).toBe(0);
  for (const reply of results.slice(1)) {
    if (reply.code !== 0) expect(["SETUP_REQUIRED", "RESPONSE_INTERRUPTED", "INSTANCE_STOPPING", "INSTANCE_UNAVAILABLE"]).toContain(reply.result.error.code);
  }
  expect((await f.cli("instance", "inspect")).result.error.code).toBe("SETUP_REQUIRED");
});

test("missing main storage and hard-linked databases fail without fallback", async () => {
  const f = fixture();
  const { unlinkSync, linkSync, existsSync } = await import("node:fs");
  const main = (await f.cli("instance", "create")).result.instance;
  const other = (await f.cli("instance", "create", "--instance", "other")).result.instance;
  unlinkSync(join(main.directory, "state.sqlite"));
  expect((await f.cli("instance", "inspect")).result.error.code).toBe("STORE_MISSING");
  expect(existsSync(join(main.directory, "state.sqlite"))).toBe(false);
  linkSync(join(other.directory, "state.sqlite"), join(main.directory, "state.sqlite"));
  expect((await f.cli("instance", "inspect")).result.error.code).toBe("INVALID_STORE");
  expect((await f.cli("instance", "start", "--instance", "other")).result.error.code).toBe("INVALID_STORE");
  unlinkSync(join(main.directory, "state.sqlite"));
  try {
    expect((await f.cli("instance", "start", "--instance", "other", "--detached")).code).toBe(0);
    expect((await f.cli("instance", "inspect", "--instance", "other")).result.instance).toEqual(other);
  } finally { await f.cli("instance", "stop", "--instance", "other"); }
});

test("a trickling endpoint cannot extend the client deadline or permit removal", async () => {
  const f = fixture();
  const { createServer } = await import("node:net");
  const { existsSync } = await import("node:fs");
  const instance = (await f.cli("instance", "create")).result.instance;
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("error", () => socket.destroy()); socket.resume();
    const timer = setInterval(() => socket.write(" "), 100);
    socket.on("close", () => { clearInterval(timer); sockets.delete(socket); });
  });
  await new Promise<void>(resolve => server.listen(join(instance.directory, "daemon.sock"), resolve));
  try {
    const started = Date.now();
    const outcome = await Promise.race([f.cli("instance", "remove"), Bun.sleep(5000).then(() => ({ code: -1, result: {} }))]);
    expect(outcome.code).toBe(1);
    expect(outcome.result.error.code).toBe("REQUEST_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(existsSync(join(f.home, "instances", "main.json"))).toBe(true);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
