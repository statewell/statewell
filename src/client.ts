import { createConnection } from "node:net";
import { join } from "node:path";
import { loadInstance, type Instance } from "./instances.ts";
import { StatewellError } from "./errors.ts";

export class InstanceClient {
  private instance: Instance | undefined;
  constructor(readonly name: string) {}
  async request(operation: string, input: unknown = {}) {
    const current = loadInstance(this.name);
    if (this.instance && (current.id !== this.instance.id || current.directory !== this.instance.directory)) throw new StatewellError("IDENTITY_CHANGED", "The instance identity changed. Reconnect explicitly.");
    this.instance = current;
    return new Promise<{ instance: Instance; value: any }>((resolve, reject) => {
      const socket = createConnection(join(current.directory, "daemon.sock"));
      let buffer = Buffer.alloc(0);
      let finished = false;
      const fail = (error: Error) => { if (finished) return; finished = true; socket.destroy(); reject(error); };
      socket.setTimeout(4000, () => fail(new StatewellError("REQUEST_TIMEOUT", "The request timed out. Its write result can be uncertain.")));
      socket.on("error", () => fail(new StatewellError("INSTANCE_UNAVAILABLE", `Start instance '${this.name}' in the foreground.`)));
      socket.on("connect", () => socket.write(JSON.stringify({ identity: current.id, operation, input }) + "\n"));
      socket.on("data", (chunk) => {
        if (buffer.length + chunk.length > 65536) return fail(new StatewellError("RESPONSE_TOO_LARGE", "The response exceeds 65536 bytes."));
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        const end = buffer.indexOf(10);
        if (end < 0) return;
        try {
          const result = JSON.parse(buffer.subarray(0, end).toString());
          if (result.error) return fail(new StatewellError(result.error.code, result.error.message));
          if (result.instance?.id !== current.id) return fail(new StatewellError("IDENTITY_CHANGED", "The instance identity changed. Reconnect explicitly."));
          finished = true; socket.destroy(); resolve(result);
        } catch { fail(new StatewellError("INVALID_RESPONSE", "The daemon response is invalid.")); }
      });
      socket.on("close", () => { if (!finished) fail(new StatewellError("RESPONSE_INTERRUPTED", "The response ended early. Its write result can be uncertain.")); });
    });
  }
}
