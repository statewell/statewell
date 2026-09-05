import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { waitForOwnership } from "./ownership.ts";
import { endpoint, registrationPath, requireSameInstance, lifecycleKey, type Instance } from "./instances.ts";
import { sendRequest } from "./transport.ts";
import { StatewellError } from "./errors.ts";

export async function launchDetached(instance: Instance, joinExisting = false) {
  const deadline = Date.now() + 5000;
  const args = [...(import.meta.url.startsWith("file:///$bunfs/") ? [] : [new URL("./cli.ts", import.meta.url).pathname]), "instance", "start", "--instance", instance.name];
  const child = spawn(process.execPath, args, { detached: true, env: { ...process.env, STATEWELL_LAUNCH_INSTANCE: JSON.stringify(instance) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new StatewellError("START_TIMEOUT", "The daemon did not start within five seconds.")), 5000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      child.once("error", fail);
      child.stderr!.on("data", chunk => { errors = (errors + chunk.toString()).slice(0, 65536); });
      child.stdout!.on("data", chunk => {
        output += chunk.toString();
        if (output.length > 65536) return fail(new StatewellError("START_FAILED", "The daemon startup response is too large."));
        if (!output.includes("\n")) return;
        try {
          const ready = JSON.parse(output.split("\n")[0]!);
          if (!ready.ready || ready.instance.id !== instance.id || ready.instance.directory !== instance.directory) throw new StatewellError("IDENTITY_CHANGED", "The instance identity changed. Reconnect explicitly.");
          clearTimeout(timer); resolve();
        } catch (error) { fail(error as Error); }
      });
      child.once("exit", () => {
        let error;
        try { error = JSON.parse(errors).error; } catch {}
        fail(new StatewellError(error?.code ?? "START_FAILED", error?.message ?? "The daemon exited before startup completed."));
      });
    });
    child.stdout!.destroy(); child.stderr!.destroy(); child.unref();
  } catch (error) {
    const exited = new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    child.kill("SIGKILL"); child.stdout!.destroy(); child.stderr!.destroy();
    await Promise.race([exited, Bun.sleep(1000)]);
    if (joinExisting && (error as StatewellError).code === "INSTANCE_BUSY") {
      while (Date.now() < deadline) {
        try { await sendRequest(instance, "instance.inspect", {}, Math.max(1, Math.min(200, deadline - Date.now()))); return; } catch {}
        await Bun.sleep(50);
      }
    }
    throw error;
  }
}

export async function stopInstance(instance: Instance, remove = false) {
  const unlock = await waitForOwnership(lifecycleKey());
  try {
    requireSameInstance(instance);
    try { await sendRequest(instance, "instance.stop"); }
    catch (error) {
      const cause = (error as Error).cause as NodeJS.ErrnoException | undefined;
      if (!["ENOENT", "ECONNREFUSED"].includes(cause?.code ?? "")) throw error;
    }
    const release = await waitForOwnership(`endpoint:${endpoint(instance)}`);
    try {
      requireSameInstance(instance);
      if (remove) unlinkSync(registrationPath(instance.name));
      return { instance, value: { stopped: true, removed: remove } };
    } finally { release(); }
  } finally { unlock(); }
}
