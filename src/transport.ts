import { createConnection } from "node:net";
import { endpoint, type Instance } from "./instances.ts";
import { StatewellError } from "./errors.ts";

export async function sendRequest(current: Instance, operation: string, input: unknown = {}, timeout = 4000) {
    return new Promise<{ instance: Instance; value: any }>((resolve, reject) => {
      const socket = createConnection(endpoint(current));
      let buffer = Buffer.alloc(0);
      let finished = false;
      let connected = false;
      const fail = (error: Error) => { if (finished) return; finished = true; clearTimeout(deadline); socket.destroy(); reject(error); };
      const deadline = setTimeout(() => fail(new StatewellError("REQUEST_TIMEOUT", "The request timed out. Its write result can be uncertain.")), timeout);
      socket.on("error", (error: NodeJS.ErrnoException) => { const failure = new StatewellError("INSTANCE_UNAVAILABLE", `Start instance '${current.name}' explicitly.`); if (!connected) failure.cause = error; fail(failure); });
      socket.on("connect", () => { connected = true; socket.write(JSON.stringify({ identity: current.id, operation, input }) + "\n"); });
      socket.on("data", (chunk) => {
        if (buffer.length + chunk.length > 65536) return fail(new StatewellError("RESPONSE_TOO_LARGE", "The response exceeds 65536 bytes."));
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        const end = buffer.indexOf(10);
        if (end < 0) return;
        try {
          const result = JSON.parse(buffer.subarray(0, end).toString());
          if (result.error) return fail(new StatewellError(result.error.code, result.error.message));
          if (result.instance?.id !== current.id) return fail(new StatewellError("IDENTITY_CHANGED", "The instance identity changed. Reconnect explicitly."));
          finished = true; clearTimeout(deadline); socket.destroy(); resolve(result);
        } catch { fail(new StatewellError("INVALID_RESPONSE", "The daemon response is invalid.")); }
      });
      socket.on("close", () => { if (!finished) fail(new StatewellError("RESPONSE_INTERRUPTED", "The response ended early. Its write result can be uncertain.")); });
    });
}
