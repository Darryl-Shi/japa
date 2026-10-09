import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type JapaExtension, validateExtension } from "./extension.ts";

export type FoundExtension = { name: string; file: string };
export type LoadError = { name: string; error: string };

/** Finds `<dir>/<name>/index.ts` in each dir; a later dir overrides an earlier one by name. Sorted by name. */
export function discoverExtensions(dirs: string[]): FoundExtension[] {
  const found = new Map<string, string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name, "index.ts");
      if (entry.isDirectory() && existsSync(file)) found.set(entry.name, file);
    }
  }
  return [...found].sort(([a], [b]) => a.localeCompare(b)).map(([name, file]) => ({ name, file }));
}

/** The message of a thrown value. */
export const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Imports and validates extensions independently; never throws. Failures go to `errors`. */
export async function loadExtensions(found: FoundExtension[]): Promise<{ extensions: JapaExtension[]; errors: LoadError[] }> {
  const extensions: JapaExtension[] = [];
  const errors: LoadError[] = [];

  for (const { name, file } of found) {
    try {
      const mod = await import(pathToFileURL(file).href);
      const e = mod.default;
      if (e === undefined) throw new Error("missing default export");
      if (e?.name !== name) throw new Error("manifest name must match directory");
      const problems = validateExtension(e);
      if (problems.length > 0) throw new Error(problems.join("; "));
      extensions.push(e);
    } catch (err) {
      errors.push({ name, error: message(err) });
    }
  }
  return { extensions, errors };
}

export { linkSdk } from "./sdk-link.ts";
