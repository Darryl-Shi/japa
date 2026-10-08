import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

/** Validates `e` against the core contracts; never throws. */
function check(e: JapaExtension): string | undefined {
  try {
    const problems = validateExtension(e);
    return problems.length > 0 ? problems.join("; ") : undefined;
  } catch (err) {
    return message(err);
  }
}

/** Imports and validates extensions independently; never throws. Failures go to `errors`. */
export async function loadExtensions(found: FoundExtension[]): Promise<{ extensions: JapaExtension[]; errors: LoadError[] }> {
  const imported: JapaExtension[] = [];
  const errors: LoadError[] = [];

  for (const { name, file } of found) {
    try {
      const mod = await import(pathToFileURL(file).href);
      const e = mod.default;
      if (e === undefined) throw new Error("missing default export");
      if (e?.name !== name) throw new Error("manifest name must match directory");
      imported.push(e);
    } catch (err) {
      errors.push({ name, error: message(err) });
    }
  }

  const extensions: JapaExtension[] = [];
  for (const e of imported) {
    const error = check(e);
    if (error) errors.push({ name: e.name, error });
    else extensions.push(e);
  }
  return { extensions, errors };
}

/**
 * Ensures `<home>/node_modules/japa` is a symlink to `packageRoot`, so extensions can import "japa/sdk",
 * and that `<home>/package.json` exists (written as `{"type":"module"}` if absent) so Node loads extensions as ESM.
 */
export function linkSdk(home: string, packageRoot: string): void {
  const pkg = join(home, "package.json");
  if (!existsSync(pkg)) {
    mkdirSync(home, { recursive: true });
    writeFileSync(pkg, `{"type":"module"}\n`);
  }
  const link = join(home, "node_modules", "japa");
  const target = resolve(packageRoot);
  try {
    if (readlinkSync(link) === target) return;
  } catch {
    // missing, or not a symlink: (re)create below
  }
  mkdirSync(join(home, "node_modules"), { recursive: true });
  rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link, "dir");
}
