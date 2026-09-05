import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StatewellError } from "./errors.ts";

export interface Instance { name: string; id: string; directory: string }
export function stateHome() { return resolve(process.env.STATEWELL_HOME ?? join(homedir(), ".local", "share", "statewell")); }
export function validateName(name: string) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new StatewellError("INVALID_NAME", "Use a name with lowercase letters, digits, or hyphens.");
}
export function registrationPath(name: string) { validateName(name); return join(stateHome(), "instances", `${name}.json`); }
export function loadInstance(name: string): Instance {
  const path = registrationPath(name);
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new StatewellError("SETUP_REQUIRED", `Create instance '${name}' with explicit setup.`);
    throw error;
  }
  const record = JSON.parse(text);
  if (record.name !== name || typeof record.id !== "string" || !/^[0-9a-f-]{36}$/.test(record.id) || typeof record.directory !== "string" || !isAbsolute(record.directory)) throw new StatewellError("INVALID_INSTANCE", "The instance registration is invalid.");
  return record;
}


export function requirePrivateDirectory(directory: string) {
  const status = statSync(directory);
  if (!status.isDirectory() || status.uid !== process.getuid!() || (status.mode & 0o077) !== 0) throw new StatewellError("UNSAFE_DIRECTORY", "Use a data directory owned by you with mode 0700.");
}
