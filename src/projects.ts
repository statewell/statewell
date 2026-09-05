import { constants, fstatSync, closeSync, openSync, readFileSync, writeFileSync, linkSync, unlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { Database } from "bun:sqlite";
import { StatewellError } from "./errors.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function readMarker(path: string): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new StatewellError("INVALID_MARKER", "The project marker cannot be read safely."); }
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.size > 4096) throw new Error();
    const text = readFileSync(fd, "utf8");
    if (text.length > 4096) throw new Error();
    const marker = JSON.parse(text);
    if (marker.schemaVersion !== 1 || typeof marker.projectId !== "string" || !uuid.test(marker.projectId)) throw new Error();
    return marker.projectId;
  } catch { throw new StatewellError("INVALID_MARKER", "The project marker is invalid. Resolve it before registration."); }
  finally { closeSync(fd); }
}
export function projectOperation(db: Database, directory: string, operation: string, input: unknown) {
  const { root, projectId } = (input ?? {}) as { root?: unknown; projectId?: unknown };
  if (typeof root !== "string" || !isAbsolute(root)) throw new StatewellError("PROJECT_SELECTION_REQUIRED", "Select an exact absolute project root with --root.");
  const canonical = realpathSync(root);
  if (!statSync(canonical).isDirectory() || canonical === "/" || canonical === realpathSync(homedir())) throw new StatewellError("PROJECT_SELECTION_REQUIRED", "Select a project directory other than the home or filesystem root.");
  const relation = relative(directory, canonical);
  if (relation === "" || (relation !== ".." && !relation.startsWith("../") && !isAbsolute(relation))) throw new StatewellError("PROJECT_CONFLICT", "The data directory cannot contain a project.");
  if (projectId !== undefined && (typeof projectId !== "string" || !uuid.test(projectId))) throw new StatewellError("PROJECT_CONFLICT", "Supply a valid project identifier.");
  const path = join(canonical, ".statewell.json");
  let id = readMarker(path);
  const existing = db.query("SELECT id FROM projects WHERE root = ?").get(canonical) as { id: string } | null;
  if ((id && projectId && id !== projectId) || (existing && id !== existing.id)) throw new StatewellError("PROJECT_CONFLICT", "The marker and selected project identity conflict.");
  if (operation === "project.register") {
    if (!id) {
      const selected = (projectId as string | undefined) ?? crypto.randomUUID();
      const temporary = join(canonical, `.statewell-${crypto.randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, projectId: selected }) + "\n", { flag: "wx", mode: 0o644 });
      try {
        if (realpathSync(root) !== canonical) throw new StatewellError("PROJECT_CONFLICT", "The project root changed during registration.");
        try { linkSync(temporary, path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      } finally { unlinkSync(temporary); }
      id = readMarker(path);
      if (!id || (projectId && id !== projectId)) throw new StatewellError("PROJECT_CONFLICT", "The project marker changed during registration.");
    }
    db.transaction(() => {
      db.query("INSERT INTO projects (root, id) VALUES (?, ?) ON CONFLICT(root) DO NOTHING").run(canonical, id!);
      if (readMarker(path) !== id) throw new StatewellError("PROJECT_CONFLICT", "The marker changed. Inspect the project before retrying.");
    })();
  } else {
    if (!id) throw new StatewellError("PROJECT_INIT_REQUIRED", "Register the selected project explicitly.");
    if (!existing) throw new StatewellError("PROJECT_NOT_REGISTERED", "Register this project in the selected instance.");
  }
  return { project: { id, root: canonical } };
}

export function resolveProject(db: Database, input: unknown) {
  const { root } = (input ?? {}) as { root?: unknown };
  if (typeof root !== "string" || !isAbsolute(root)) throw new StatewellError("PROJECT_SELECTION_REQUIRED", "Supply an absolute workspace path.");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  let result;
  try { result = Bun.spawnSync(["git", "-C", realpathSync(root), "rev-parse", "--show-toplevel"], { env: environment, timeout: 1000, maxBuffer: 4096 }); }
  catch { throw new StatewellError("PROJECT_SELECTION_REQUIRED", "Git discovery failed. Select the exact root for explicit registration."); }
  if (result.exitCode !== 0) throw new StatewellError("PROJECT_SELECTION_REQUIRED", "Git discovery failed. Select the exact root for explicit registration.");
  const selected = realpathSync(result.stdout.toString().trim());
  if (selected === "/" || selected === realpathSync(homedir())) throw new StatewellError("PROJECT_SELECTION_REQUIRED", "Select a project directory other than the home or filesystem root.");
  const id = readMarker(join(selected, ".statewell.json"));
  const registered = db.query("SELECT id FROM projects WHERE root = ?").get(selected) as { id: string } | null;
  if (registered && registered.id !== id) throw new StatewellError("PROJECT_CONFLICT", "The marker and registered project identity conflict.");
  return { root: selected, projectId: id ?? null, registrationRequired: !registered };
}
