import { createHash } from "node:crypto";
import { StatewellError } from "./errors.ts";

export function claimOwnership(key: string) {
  try {
    const server = Bun.serve({ unix: `\0statewell-${createHash("sha256").update(key).digest("hex")}`, fetch: () => new Response(null, { status: 404 }) });
    return () => { server.stop(true); };
  } catch { throw new StatewellError("INSTANCE_BUSY", "Another process owns this instance or endpoint."); }
}
