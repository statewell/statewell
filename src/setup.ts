import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openDatabase } from "./database.ts";
import { loadInstance, requirePrivateDirectory, registrationPath, stateHome, type Instance } from "./instances.ts";
import { claimOwnership } from "./ownership.ts";
import { StatewellError } from "./errors.ts";

export function outsideRepository(path: string) {
  let current = path;
  while (true) {
    if (existsSync(join(current, ".git"))) throw new StatewellError("DATA_IN_REPOSITORY", "Select a data directory outside repositories.");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function canonicalTarget(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  return join(canonicalTarget(dirname(path)), path.slice(dirname(path).length + (dirname(path) === "/" ? 0 : 1)));
}
export async function createInstance(name: string, dataDirectory?: string) {
  const registration = registrationPath(name);
  const directory = canonicalTarget(resolve(dataDirectory ?? join(stateHome(), "data", name)));
  const release = claimOwnership(`setup:${canonicalTarget(stateHome())}`);
  try {
    if (existsSync(registration)) {
      const existing = loadInstance(name);
      if (dataDirectory !== undefined && existing.directory !== directory) throw new StatewellError("DIRECTORY_CONFLICT", "This instance uses another data directory.");
      return existing;
    }
    outsideRepository(directory); outsideRepository(canonicalTarget(stateHome()));
    const registrations = dirname(registration);
    if (existsSync(registrations)) for (const file of readdirSync(registrations).filter(file => file.endsWith(".json"))) {
      const other = JSON.parse(readFileSync(join(registrations, file), "utf8")) as Instance;
      if (other.directory === directory) throw new StatewellError("DIRECTORY_CONFLICT", "Another instance uses this data directory.");
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    requirePrivateDirectory(directory);
    const database = await openDatabase(directory, true);
    const instance = { name, directory: realpathSync(directory), id: database.id };
    await database.close();
    mkdirSync(registrations, { recursive: true, mode: 0o700 });
    const temporary = `${registration}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(instance), { mode: 0o600, flag: "wx" });
    renameSync(temporary, registration);
    return instance;
  } finally { release(); }
}
