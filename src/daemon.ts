import { createServer, createConnection, type Socket } from "node:net";
import { chmodSync, lstatSync, unlinkSync, realpathSync } from "node:fs";
import { openDatabase } from "./database.ts";
import { claimOwnership } from "./ownership.ts";
import { failure, StatewellError } from "./errors.ts";
import { endpoint, requirePrivateDirectory, type Instance } from "./instances.ts";

async function removeStaleEndpoint(path: string) {
  let before;
  try { before = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!before.isSocket()) throw new StatewellError("ENDPOINT_CONFLICT", "The endpoint is not a socket. Select another data directory.");
  const refused = await new Promise<boolean>((resolve) => {
    const socket = createConnection(path);
    socket.setTimeout(200);
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "ECONNREFUSED"));
  });
  if (!refused) throw new StatewellError("ENDPOINT_CONFLICT", "Another server can own this endpoint.");
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino) throw new StatewellError("ENDPOINT_CONFLICT", "The endpoint changed during startup.");
  unlinkSync(path);
}
export async function startDaemon(instance: Instance) {
  if (realpathSync(instance.directory) !== instance.directory) throw new StatewellError("DIRECTORY_CONFLICT", "The instance directory changed.");
  requirePrivateDirectory(instance.directory);
  const database = await openDatabase(instance.directory);
  if (database.id !== instance.id) { await database.close(); throw new StatewellError("IDENTITY_CHANGED", "The instance identity changed. Reconnect explicitly."); }
  let release: (() => void) | undefined;
  const sockets = new Set<Socket>();
  try {
    const path = endpoint(instance);
    if (Buffer.byteLength(path) > 100) throw new StatewellError("PATH_TOO_LONG", "Select a shorter instance data directory.");
    release = claimOwnership(`endpoint:${path}`);
    await removeStaleEndpoint(path);
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.on("close", () => sockets.delete(socket));
      socket.setTimeout(3000, () => socket.destroy());
      let buffer = Buffer.alloc(0);
      let dispatched = false;
      socket.on("data", async (chunk) => {
        if (dispatched) return;
        if (buffer.length + chunk.length > 16384) {
          dispatched = true; socket.end(JSON.stringify(failure(new StatewellError("REQUEST_TOO_LARGE", "The request exceeds 16384 bytes."))) + "\n"); return;
        }
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        const end = buffer.indexOf(10);
        if (end < 0) return;
        dispatched = true;
        try {
          const request = JSON.parse(buffer.subarray(0, end).toString());
          if (request.identity !== instance.id) throw new StatewellError("IDENTITY_CHANGED", "The instance identity changed. Reconnect explicitly.");
          const value = await database.request(request.operation, request.input);
          socket.end(JSON.stringify({ instance, value }) + "\n");
        } catch (error) { socket.end(JSON.stringify(failure(error)) + "\n"); }
      });
    });
    server.maxConnections = 16;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    chmodSync(path, 0o600);
    console.log(JSON.stringify({ ready: true, instance }));
    let stopping = false;
    const stop = async () => {
      if (stopping) return; stopping = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await database.close(); release!();
    };
    process.once("SIGTERM", () => void stop());
    process.once("SIGINT", () => void stop());
  } catch (error) { await database.close(); release?.(); throw error; }
}
