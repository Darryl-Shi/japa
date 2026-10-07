import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Contract } from "./contracts.ts";
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

/**
 * Imports and validates extensions. Pass 1 imports every manifest; pass 2 validates each against
 * `contracts` plus the contracts defined by any loaded extension. Failures go to `errors`.
 */
export async function loadExtensions(
  found: FoundExtension[],
  contracts: ReadonlyMap<string, Contract>,
  version?: string,
): Promise<{ extensions: JapaExtension[]; errors: LoadError[] }> {
  const imported: JapaExtension[] = [];
  const errors: LoadError[] = [];

  for (const { name, file } of found) {
    try {
      const mod = await import(pathToFileURL(file).href + (version ? "?v=" + version : ""));
      if (mod.default?.name !== name) throw new Error("manifest name must match directory");
      imported.push(mod.default);
    } catch (err) {
      errors.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const merged = new Map(contracts);
  for (const c of imported.flatMap((e) => e.contracts ?? [])) if (!merged.has(c.name)) merged.set(c.name, c);

  const extensions: JapaExtension[] = [];
  for (const e of imported) {
    const duplicates = (e.contracts ?? []).filter((c) => merged.get(c.name) !== c);
    const problems = [
      ...duplicates.map((c) => `contract "${c.name}" is already defined`),
      ...validateExtension(e, merged),
    ];
    if (problems.length > 0) errors.push({ name: e.name, error: problems.join("; ") });
    else extensions.push(e);
  }
  return { extensions, errors };
}

/** Ensures `<home>/node_modules/japa` is a symlink to `packageRoot`, so extensions can import "japa/sdk". */
export function linkSdk(home: string, packageRoot: string): void {
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
