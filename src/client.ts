import { sendRequest } from "./transport.ts";
import { launchDetached } from "./lifecycle.ts";
import { loadInstance, requireSameInstance, type Instance } from "./instances.ts";

export class InstanceClient {
  private instance: Instance | undefined;
  constructor(readonly name: string) {}
  async request(operation: string, input: unknown = {}) {
    const current = this.instance ? requireSameInstance(this.instance) : loadInstance(this.name);
    this.instance = current;
    try { return await sendRequest(current, operation, input); }
    catch (error) {
      const cause = (error as Error).cause as NodeJS.ErrnoException | undefined;
      if (this.name !== "main" || !["ENOENT", "ECONNREFUSED"].includes(cause?.code ?? "")) throw error;
      await launchDetached(current, true);
      requireSameInstance(current);
      return sendRequest(current, operation, input);
    }
  }
}
