import { Transform } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

function stop(code: string): never {
  process.stderr.write(JSON.stringify({ error: { code, message: "The MCP transport limit was reached. Reconnect explicitly." } }) + "\n");
  process.exit(2);
}
export class BoundedStdioTransport extends StdioServerTransport {
  private outputCount = 0;
  constructor() {
    let frameBytes = 0;
    const input = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      for (const byte of chunk) {
        if (++frameBytes > 16384) stop("MCP_INPUT_TOO_LARGE");
        if (byte === 10) frameBytes = 0;
      }
      callback(null, chunk);
    } });
    super(input, process.stdout);
    process.stdin.pipe(input);
    process.stdin.once("end", () => { void this.close(); });
  }
  override async send(message: JSONRPCMessage) {
    if (Buffer.byteLength(JSON.stringify(message)) > 65536) stop("MCP_OUTPUT_TOO_LARGE");
    if (++this.outputCount > 16) stop("MCP_OUTPUT_OVERLOADED");
    const timer = setTimeout(() => stop("MCP_OUTPUT_TIMEOUT"), 1000);
    try { await super.send(message); }
    finally { clearTimeout(timer); this.outputCount--; }
  }
}
