import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const roots: string[] = [];
const daemons: Bun.Subprocess[] = [];
const entry = resolve("src/cli.ts");
function fixture() {
  const root = mkdtempSync(join("/dev/shm", "statewell-test-"));
  roots.push(root);
  const home = join(root, "state");
  async function cli(...args: string[]) {
    const process = Bun.spawn([Bun.env.STATEWELL_TEST_BINARY ?? Bun.argv[0]!, ...(Bun.env.STATEWELL_TEST_BINARY ? [] : [entry]), ...args], {
      cwd: root, env: { ...Bun.env, STATEWELL_HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    return { code, result: JSON.parse(out || err) };
  }
  async function start(name: string) {
    const daemon = Bun.spawn([Bun.env.STATEWELL_TEST_BINARY ?? Bun.argv[0]!, ...(Bun.env.STATEWELL_TEST_BINARY ? [] : [entry]), "instance", "start", "--instance", name], {
      cwd: root, env: { ...Bun.env, STATEWELL_HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    daemons.push(daemon);
    const reader = daemon.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    if (!first.value) throw new Error(await new Response(daemon.stderr).text());
    expect(JSON.parse(new TextDecoder().decode(first.value)).ready).toBe(true);
    return daemon;
  }
  return { root, home, cli, start };
}
afterEach(async () => { for (const daemon of daemons.splice(0)) { daemon.kill(); await daemon.exited; } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("queries before setup do not create an instance", async () => {
  const f = fixture();
  const reply = await f.cli("instance", "inspect");
  expect(reply.code).toBe(1);
  expect(reply.result.error.code).toBe("SETUP_REQUIRED");
  expect(existsSync(f.home)).toBe(false);
});

test("explicit setup preserves identity and rejects a conflicting directory", async () => {
  const f = fixture();
  const directory = join(f.root, "data");
  const first = await f.cli("instance", "create", "--instance", "test", "--data-dir", directory);
  expect(first.code).toBe(0);
  expect(first.result.instance.name).toBe("test");
  expect(first.result.instance.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(await f.cli("instance", "create", "--instance", "test", "--data-dir", directory)).toEqual(first);
  const conflict = await f.cli("instance", "create", "--instance", "test", "--data-dir", join(f.root, "other"));
  expect(conflict.result.error.code).toBe("DIRECTORY_CONFLICT");
  expect(existsSync(join(f.root, "other"))).toBe(false);
});

test("foreground access keeps identity across restarts and never falls back", async () => {
  const f = fixture();
  const created = await f.cli("instance", "create", "--instance", "test");
  expect(created.code).toBe(0);
  expect((await f.cli("instance", "inspect", "--instance", "test")).result.error.code).toBe("INSTANCE_UNAVAILABLE");
  const daemon = await f.start("test");
  expect((await f.cli("instance", "inspect", "--instance", "test")).result.instance).toEqual(created.result.instance);
  daemon.kill(); await daemon.exited;
  await f.start("test");
  expect((await f.cli("instance", "inspect", "--instance", "test")).result.instance).toEqual(created.result.instance);
  expect((await f.cli("instance", "start", "--instance", "unknown")).result.error.code).toBe("SETUP_REQUIRED");
});

test("project registration is explicit, persistent, and independent per instance", async () => {
  const f = fixture();
  const project = join(f.root, "project with spaces");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(project);
  for (const name of ["first", "second"]) { expect((await f.cli("instance", "create", "--instance", name)).code).toBe(0); await f.start(name); }
  const missing = await f.cli("project", "register", "--instance", "first");
  expect(missing.result.error.code).toBe("PROJECT_SELECTION_REQUIRED");
  expect(existsSync(join(f.root, ".statewell.json"))).toBe(false);
  const registered = await f.cli("project", "register", "--instance", "first", "--root", project);
  expect(registered.code).toBe(0);
  const id = registered.result.value.project.id;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect((await f.cli("project", "inspect", "--instance", "first", "--root", project)).result.value.project).toEqual({ id, root: project });
  expect((await f.cli("project", "inspect", "--instance", "second", "--root", project)).result.error.code).toBe("PROJECT_NOT_REGISTERED");
  expect((await f.cli("project", "register", "--instance", "second", "--root", project)).result.value.project.id).toBe(id);
  const conflict = await f.cli("project", "register", "--instance", "first", "--root", project, "--project-id", "00000000-0000-4000-8000-000000000001");
  expect(conflict.result.error.code).toBe("PROJECT_CONFLICT");
});

test("MCP initializes and shares selected instance projects with CLI", async () => {
  const f = fixture();
  expect((await f.cli("instance", "create", "--instance", "mcp-test")).code).toBe(0);
  await f.start("mcp-test");
  const { mkdirSync } = await import("node:fs");
  const root = join(f.root, "workspace"); mkdirSync(root);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: Bun.env.STATEWELL_TEST_BINARY ?? Bun.argv[0]!,
    args: [...(Bun.env.STATEWELL_TEST_BINARY ? [] : [entry]), "mcp", "--instance", "mcp-test"],
    env: { PATH: process.env.PATH!, STATEWELL_HOME: f.home }, stderr: "pipe",
  });
  const client = new Client({ name: "statewell-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe("statewell");
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(["instance_inspect", "project_inspect", "project_register", "project_resolve", "task_approve", "task_check", "task_contract", "task_create", "task_proposal", "task_propose", "task_read", "task_save", "task_transition"]);
    const missing = await client.callTool({ name: "project_register", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(JSON.parse((missing.content as any[])[0].text).error.code).toBe("PROJECT_SELECTION_REQUIRED");
    const saved = await client.callTool({ name: "project_register", arguments: { root } });
    const result = JSON.parse((saved.content as any[])[0].text);
    expect((await f.cli("project", "inspect", "--instance", "mcp-test", "--root", root)).result).toEqual(result);
    const cli = await f.cli("instance", "inspect", "--instance", "mcp-test");
    const inspected = await client.callTool({ name: "instance_inspect", arguments: {} });
    expect(JSON.parse((inspected.content as any[])[0].text)).toEqual(cli.result);
  } finally { await client.close(); }
});

test("setup rejects database aliases and preserves unrelated files", async () => {
  const f = fixture();
  const { mkdirSync, writeFileSync, readFileSync, symlinkSync } = await import("node:fs");
  const directory = join(f.root, "unsafe"); mkdirSync(directory, { mode: 0o700 });
  const target = join(f.root, "unrelated"); writeFileSync(target, "preserve this content");
  symlinkSync(target, join(directory, "state.sqlite"));
  const reply = await f.cli("instance", "create", "--data-dir", directory);
  expect(reply.result.error.code).toBe("INVALID_STORE");
  expect(readFileSync(target, "utf8")).toBe("preserve this content");
  expect(existsSync(join(f.home, "instances", "main.json"))).toBe(false);
});

test("project discovery returns the nearest Git root without creating a marker", async () => {
  const f = fixture();
  const { mkdirSync } = await import("node:fs");
  const repo = join(f.root, "repo"); const child = join(repo, "nested"); mkdirSync(child, { recursive: true });
  expect(Bun.spawnSync(["git", "init", repo]).exitCode).toBe(0);
  expect((await f.cli("instance", "create", "--instance", "test")).code).toBe(0); await f.start("test");
  const found = await f.cli("project", "resolve", "--instance", "test", "--root", child);
  expect(found.code).toBe(0);
  expect(found.result.value.root).toBe(repo);
  expect(found.result.value.registrationRequired).toBe(true);
  expect(existsSync(join(repo, ".statewell.json"))).toBe(false);
  expect((await f.cli("project", "register", "--instance", "test", "--root", repo)).code).toBe(0);
  expect((await f.cli("project", "resolve", "--instance", "test", "--root", child)).result.value.registrationRequired).toBe(false);
  expect((await f.cli("project", "resolve", "--instance", "test", "--root", f.root)).result.error.code).toBe("PROJECT_SELECTION_REQUIRED");
});

test("MCP rejects an oversized input frame with a bounded failure", async () => {
  const f = fixture();
  const child = Bun.spawn([Bun.env.STATEWELL_TEST_BINARY ?? Bun.argv[0]!, ...(Bun.env.STATEWELL_TEST_BINARY ? [] : [entry]), "mcp"], {
    env: { ...Bun.env, STATEWELL_HOME: f.home }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write("x".repeat(20000) + "\n"); child.stdin.end();
  const error = await new Response(child.stderr).text();
  expect(await child.exited).toBe(2);
  expect(error).toContain("MCP_INPUT_TOO_LARGE");
  expect(existsSync(f.home)).toBe(false);
});

test("a competing foreground daemon cannot replace the current owner", async () => {
  const f = fixture();
  const created = await f.cli("instance", "create", "--instance", "test");
  await f.start("test");
  const competing = await f.cli("instance", "start", "--instance", "test");
  expect(competing.code).toBe(1);
  expect(competing.result.error.code).toBe("INSTANCE_BUSY");
  expect((await f.cli("instance", "inspect", "--instance", "test")).result.instance).toEqual(created.result.instance);
});

test("setup with no directory reuses the custom directory without erasing projects", async () => {
  const f = fixture();
  const first = await f.cli("instance", "create", "--data-dir", join(f.root, "custom"));
  expect((await f.cli("instance", "create")).result).toEqual(first.result);
  const project = join(f.root, "project");
  (await import("node:fs")).mkdirSync(project);
  const daemon = await f.start("main");
  const registered = await f.cli("project", "register", "--root", project);
  expect(registered.code).toBe(0);
  daemon.kill(); await daemon.exited;
  expect((await f.cli("instance", "create")).result).toEqual(first.result);
  await f.start("main");
  expect((await f.cli("project", "inspect", "--root", project)).result).toEqual(registered.result);
});

test("malformed markers and regular-file endpoints remain unchanged", async () => {
  const f = fixture();
  const { writeFileSync, readFileSync } = await import("node:fs");
  const created = await f.cli("instance", "create");
  const socket = join(created.result.instance.directory, "daemon.sock");
  writeFileSync(socket, "keep endpoint");
  expect((await f.cli("instance", "start")).result.error.code).toBe("ENDPOINT_CONFLICT");
  expect(readFileSync(socket, "utf8")).toBe("keep endpoint");
  rmSync(socket); await f.start("main");
  const marker = join(f.root, ".statewell.json"); writeFileSync(marker, "invalid marker");
  expect((await f.cli("project", "register", "--root", f.root)).result.error.code).toBe("INVALID_MARKER");
  expect(readFileSync(marker, "utf8")).toBe("invalid marker");
});

test("an existing MCP connection rejects replacement of its instance identity", async () => {
  const f = fixture();
  for (const name of ["first", "replacement"]) { expect((await f.cli("instance", "create", "--instance", name)).code).toBe(0); await f.start(name); }
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "statewell-test", version: "0.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: Bun.env.STATEWELL_TEST_BINARY ?? Bun.argv[0]!, args: [...(Bun.env.STATEWELL_TEST_BINARY ? [] : [entry]), "mcp", "--instance", "first"], env: { PATH: process.env.PATH!, STATEWELL_HOME: f.home } }));
    expect((await client.callTool({ name: "instance_inspect", arguments: {} })).isError).toBeUndefined();
    const { readFileSync, writeFileSync } = await import("node:fs");
    const replacement = JSON.parse(readFileSync(join(f.home, "instances", "replacement.json"), "utf8"));
    writeFileSync(join(f.home, "instances", "first.json"), JSON.stringify({ ...replacement, name: "first" }));
    const result = await client.callTool({ name: "instance_inspect", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as any[])[0].text).error.code).toBe("IDENTITY_CHANGED");
  } finally { await client.close(); }
});

test("concurrent project registration preserves one marker identity", async () => {
  const f = fixture();
  const project = join(f.root, "project"); (await import("node:fs")).mkdirSync(project);
  for (const name of ["first", "second"]) { await f.cli("instance", "create", "--instance", name); await f.start(name); }
  const results = await Promise.all(["first", "second"].map(name => f.cli("project", "register", "--instance", name, "--root", project)));
  expect(results.map(result => result.code)).toEqual([0, 0]);
  expect(results[0]!.result.value.project).toEqual(results[1]!.result.value.project);
});

test("a registration-directory symlink cannot write records into a repository", async () => {
  const f = fixture();
  const { mkdirSync, symlinkSync, readdirSync } = await import("node:fs");
  const repo = join(f.root, "repo"); mkdirSync(repo);
  expect(Bun.spawnSync(["git", "init", repo]).exitCode).toBe(0);
  const registrations = join(repo, "registrations"); mkdirSync(registrations);
  mkdirSync(f.home); symlinkSync(registrations, join(f.home, "instances"));
  const result = await f.cli("instance", "create");
  expect(result.code).toBe(1);
  expect(result.result.error.code).toBe("DATA_IN_REPOSITORY");
  expect(readdirSync(registrations)).toEqual([]);
  expect(existsSync(join(f.home, "data"))).toBe(false);
});
