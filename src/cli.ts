import { failure, StatewellError } from "./errors.ts";
import { loadInstance } from "./instances.ts";
import { startDaemon } from "./daemon.ts";
import { InstanceClient } from "./client.ts";
import { stopInstance, launchDetached } from "./lifecycle.ts";
import { createInstance } from "./setup.ts";

process.umask(0o077);
try {
  if (process.platform !== "linux" || process.arch !== "x64") throw new StatewellError("UNSUPPORTED_PLATFORM", "This version requires Linux x64.");
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log(`Statewell instance and project commands

instance create [--instance NAME] [--data-dir PATH]
instance start [--instance NAME] [--detached]
instance stop [--instance NAME]
instance remove [--instance NAME]
instance inspect [--instance NAME]
project resolve [--instance NAME] [--root PATH]
project register --root PATH [--instance NAME] [--project-id ID]
project inspect --root PATH [--instance NAME] [--project-id ID]
mcp [--instance NAME]

Use STATEWELL_HOME to select the local registration directory.
Keep data outside repositories. Only an existing main instance starts automatically.
Other instances require explicit startup. Removal preserves data.
Project registration requires an exact absolute root. Queries do not create stores.`);
    process.exit(0);
  }
  const options: Record<string, string> = {};
  const commands: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--detached") { if (options[arg]) throw new StatewellError("USAGE", "Supply each option only once."); options[arg] = "true"; }
    else if (arg.startsWith("--")) {
      if (!["--instance", "--data-dir", "--root", "--project-id"].includes(arg) || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new StatewellError("USAGE", "Supply a value for a supported option.");
      if (options[arg] !== undefined) throw new StatewellError("USAGE", "Supply each option only once.");
      options[arg] = args[++index]!;
    } else commands.push(arg);
  }
  const name = options["--instance"] ?? "main";
  const command = commands.join(" ");
  const allowed = command === "instance create" ? ["--instance", "--data-dir"] : command === "instance start" ? ["--instance", "--detached"] : command.startsWith("project ") ? ["--instance", "--root", "--project-id"] : ["--instance"];
  if (Object.keys(options).some(option => !allowed.includes(option))) throw new StatewellError("USAGE", "The command does not accept this option.");
  if (command === "instance create") console.log(JSON.stringify({ instance: await createInstance(name, options["--data-dir"]) }));
  else if (command === "instance inspect") console.log(JSON.stringify(await new InstanceClient(name).request("instance.inspect")));
  else if (command === "instance stop" || command === "instance remove") console.log(JSON.stringify(await stopInstance(loadInstance(name), command === "instance remove")));
  else if (command === "instance start") {
    const instance = loadInstance(name);
    if (process.env.STATEWELL_LAUNCH_INSTANCE) {
      const expected = JSON.parse(process.env.STATEWELL_LAUNCH_INSTANCE);
      if (expected.name !== instance.name || expected.id !== instance.id || expected.directory !== instance.directory) throw new StatewellError("IDENTITY_CHANGED", "The instance identity changed. Reconnect explicitly.");
    }
    if (options["--detached"]) { await launchDetached(instance); console.log(JSON.stringify({ ready: true, instance })); }
    else await startDaemon(instance);
  }
  else if (command === "mcp") await (await import("./mcp.ts")).startMcp(name);
  else if (command === "project register" || command === "project inspect" || command === "project resolve") console.log(JSON.stringify(await new InstanceClient(name).request(command.replace(" ", "."), { root: options["--root"] ?? (command === "project resolve" ? process.cwd() : undefined), projectId: options["--project-id"] })));
  else throw new StatewellError("USAGE", "Use --help to list the supported commands.");
} catch (error) {
  console.error(JSON.stringify(failure(error)));
  process.exitCode = 1;
}
