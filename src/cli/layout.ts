// The install-dir layout (see docs/superpowers/specs/2026-10-08-japa-install-design.md §2), the launcher script it
// writes, and whether a launcher on disk points at a given checkout.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launcherPath } from "../kernel/sandbox/bwrap.ts";

/** This checkout's root: the directory holding package.json. */
export const APP = fileURLToPath(new URL("../..", import.meta.url));

export type Layout = {
  app: string;
  /** The install dir, only when `app` is a managed install (`<installDir>/app`). */
  installDir: string | undefined;
  /** The private Node dir, only when managed. */
  nodeDir: string | undefined;
  launcher: string;
};

/** `app`'s layout. An install is "managed" (owns its launcher and private Node) only when `basename(app) === "app"`. */
export function layoutOf(app: string, userHome = homedir()): Layout {
  const installDir = basename(app) === "app" ? dirname(app) : undefined;
  return {
    app,
    installDir,
    nodeDir: installDir === undefined ? undefined : join(installDir, "node"),
    launcher: launcherPath(userHome),
  };
}

/** Single-quotes `s` for POSIX sh: wraps it in `'...'`, escaping an embedded `'` as `'\''`. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/** The launcher script's contents: an absolute, quoted `exec` of `node` on `<app>/src/cli/main.ts`. */
export function launcherText(node: string, app: string): string {
  const main = shellQuote(join(app, "src/cli/main.ts"));
  return `#!/bin/sh\nexec ${shellQuote(node)} --disable-warning=ExperimentalWarning ${main} "$@"\n`;
}

/** Writes the launcher (creating its directory as needed) and makes it executable. */
export function writeLauncher(layout: Layout, node: string): void {
  mkdirSync(dirname(layout.launcher), { recursive: true });
  writeFileSync(layout.launcher, launcherText(node, layout.app));
  chmodSync(layout.launcher, 0o755);
}

/** Whether the launcher on disk execs `layout.app`'s main.ts (false if it's missing or points elsewhere). */
export function launcherPointsAt(layout: Layout): boolean {
  if (!existsSync(layout.launcher)) return false;
  return readFileSync(layout.launcher, "utf8").includes(shellQuote(join(layout.app, "src/cli/main.ts")));
}
