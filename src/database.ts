import { Worker } from "node:worker_threads";
import { StatewellError } from "./errors.ts";

export async function openDatabase(directory: string, create = false) {
  const worker = new Worker(new URL("./database-worker.ts", import.meta.url), { workerData: { directory, create } });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let sequence = 0;
  let failed = false;
  const fail = () => {
    failed = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new StatewellError("WORKER_FAILED", "The database worker stopped. The write result can be uncertain.")); }
    pending.clear();
  };
  worker.on("error", fail);
  worker.on("exit", fail);
  const id = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { void worker.terminate(); reject(new StatewellError("WORKER_TIMEOUT", "The database worker did not start.")); }, 3000);
    worker.once("error", reject);
    worker.once("message", (message) => {
      clearTimeout(timer);
      if (message.ready) resolve(message.id);
      else { void worker.terminate(); reject(new StatewellError(message.error?.code ?? "STORE_ERROR", message.error?.message ?? "Cannot open the database.")); }
    });
  });
  worker.on("message", (message) => {
    const request = pending.get(message.requestId);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.requestId);
    if (message.error) request.reject(new StatewellError(message.error.code, message.error.message, message.error.details));
    else request.resolve(message.value);
  });
  return {
    id,
    async close() { await worker.terminate(); },
    request(operation: string, input: unknown): Promise<any> {
      if (failed) return Promise.reject(new StatewellError("WORKER_FAILED", "Restart the instance after database worker failure."));
      if (pending.size >= 4) return Promise.reject(new StatewellError("OVERLOADED", "The instance has too many pending requests."));
      return new Promise((resolve, reject) => {
        const requestId = ++sequence;
        const timer = setTimeout(() => { fail(); void worker.terminate(); }, 2000);
        pending.set(requestId, { resolve, reject, timer });
        worker.postMessage({ requestId, operation, input });
      });
    },
  };
}
