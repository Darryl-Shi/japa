import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** The message of a thrown value. */
export const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const isContract = (c: unknown) =>
  typeof c === "object" &&
  c !== null &&
  typeof (c as Contract).name === "string" &&
  typeof (c as Contract).validate === "function";

/** Checks `e` against `merged` (which holds the contracts of every candidate); never throws. */
function check(e: JapaExtension, merged: ReadonlyMap<string, Contract>): string | undefined {
  try {
    const duplicates = (e.contracts ?? []).filter((c) => merged.get(c.name) !== c);
    const problems = [
      ...duplicates.map((c) => `contract "${c.name}" is already defined`),
      ...validateExtension(e, merged),
    ];
    return problems.length > 0 ? problems.join("; ") : undefined;
  } catch (err) {
    return message(err);
  }
}

/**
 * Imports and validates extensions; never throws. Pass 1 imports every manifest; pass 2 validates
 * each against `contracts` plus the contracts defined by the other candidates, dropping failures and
 * repeating until stable so no extension relies on a contract from a failed one. Failures go to `errors`.
 */
export async function loadExtensions(
  found: FoundExtension[],
  contracts: ReadonlyMap<string, Contract>,
): Promise<{ extensions: JapaExtension[]; errors: LoadError[] }> {
  const imported: JapaExtension[] = [];
  const errors: LoadError[] = [];

  for (const { name, file } of found) {
    try {
      const mod = await import(pathToFileURL(file).href);
      const e = mod.default;
      if (e === undefined) throw new Error("missing default export");
      if (e?.name !== name) throw new Error("manifest name must match directory");
      if (e.contracts !== undefined && !(Array.isArray(e.contracts) && e.contracts.every(isContract))) {
        throw new Error("contracts must be an array of objects with a string name and a validate function");
      }
      imported.push(e);
    } catch (err) {
      errors.push({ name, error: message(err) });
    }
  }

  let extensions = imported;
  for (;;) {
    const merged = new Map(contracts);
    for (const c of extensions.flatMap((e) => e.contracts ?? [])) if (!merged.has(c.name)) merged.set(c.name, c);

    const failed: LoadError[] = [];
    for (const e of extensions) {
      const error = check(e, merged);
      if (error) failed.push({ name: e.name, error });
    }
    if (failed.length === 0) return { extensions, errors };
    errors.push(...failed);
    extensions = extensions.filter((e) => !failed.some((f) => f.name === e.name));
  }
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
