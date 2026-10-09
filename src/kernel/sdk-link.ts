// How a japa home imports "japa/sdk": what `linkSdk` writes there. Apart from loader.ts so a job's sandbox (narrow.ts)
// can tell its artifacts without loading the extension machinery.
import { existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The `package.json` `linkSdk` writes where there's none. */
export const SDK_PACKAGE_JSON = `{"type":"module"}\n`;

/** The symlink `linkSdk` makes, relative to the home. */
export const SDK_LINK = "node_modules/japa";

/**
 * Ensures `<home>/node_modules/japa` is a symlink to `packageRoot`, so extensions can import "japa/sdk",
 * and that `<home>/package.json` exists (written as `{"type":"module"}` if absent) so Node loads extensions as ESM.
 */
export function linkSdk(home: string, packageRoot: string): void {
  const pkg = join(home, "package.json");
  if (!existsSync(pkg)) {
    mkdirSync(home, { recursive: true });
    writeFileSync(pkg, SDK_PACKAGE_JSON);
  }
  const link = join(home, SDK_LINK);
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
