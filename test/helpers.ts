import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Creates a temp `japa` home dir; writes `settings.json` when `settings` is given. */
export function tempHome(settings?: object): string {
  const home = mkdtempSync(join(tmpdir(), "japa-"));
  if (settings !== undefined) {
    writeFileSync(join(home, "settings.json"), JSON.stringify(settings));
  }
  return home;
}
