// `japa uninstall [--purge]` (design doc §8): stops and removes the service, removes a launcher that points at
// this checkout, and removes the install dir when it's a managed install. The runtime home (`japaHome()`) is kept
// unless `--purge` is given and the user confirms; PATH lines install.sh added to a shell rc file are never touched,
// only named. With `--purge`, confirmation happens before anything is touched: an answer other than "delete" removes
// nothing.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { launcherPointsAt, type Layout } from "./layout.ts";
import { isPrivateNode } from "./node.ts";
import { type ServiceEnv, uninstallService } from "./service.ts";

export type UninstallOptions = {
  purge: boolean;
  /** Resolves to the user's typed confirmation; only called when `purge` is true. "delete" removes `home`. */
  confirm: () => Promise<string>;
  serviceEnv: ServiceEnv;
  log: (s: string) => void;
};

/** The line install.sh appends to each shell's rc file (under the user's home) when ~/.local/bin isn't on PATH. */
const PATH_LINES: [file: string, line: string][] = [
  [".bashrc", 'export PATH="$HOME/.local/bin:$PATH"'],
  [".zshrc", 'export PATH="$HOME/.local/bin:$PATH"'],
  [join(".config", "fish", "config.fish"), "fish_add_path $HOME/.local/bin"],
];

/** The rc files under `userHome` still holding install.sh's PATH line. */
function rcFilesWithPathLine(userHome: string): string[] {
  const holds = (path: string, line: string) => existsSync(path) && readFileSync(path, "utf8").includes(line);
  return PATH_LINES.map(([file, line]) => [join(userHome, file), line] as const)
    .filter(([path, line]) => holds(path, line))
    .map(([path]) => path);
}

export async function uninstall(layout: Layout, home: string, o: UninstallOptions): Promise<void> {
  if (o.purge && (await o.confirm()) !== "delete") {
    o.log("purge cancelled; nothing was removed");
    return;
  }

  await uninstallService(o.serviceEnv, o.log);

  if (launcherPointsAt(layout)) rmSync(layout.launcher, { force: true });

  if (layout.installDir !== undefined) {
    // Bound the blast radius to this install: remove only app/ and japa's own node/, and the install dir itself
    // only once it's empty -- a dev checkout at e.g. ~/src/app must never take its sibling projects under ~/src
    // with it, nor a node/ beside it that japa didn't install.
    rmSync(layout.app, { recursive: true, force: true });
    if (layout.nodeDir !== undefined && isPrivateNode(layout.nodeDir)) {
      rmSync(layout.nodeDir, { recursive: true, force: true });
    }
    if (existsSync(layout.installDir) && readdirSync(layout.installDir).length === 0) {
      rmSync(layout.installDir, { recursive: true, force: true });
    }
  } else {
    o.log(`not an installed copy; left ${layout.app} in place`);
  }

  if (o.purge) {
    rmSync(home, { recursive: true, force: true });
    o.log(`removed ${home}`);
  } else {
    o.log(`kept ${home}`);
  }

  const rcFiles = rcFilesWithPathLine(o.serviceEnv.userHome);
  if (rcFiles.length > 0) o.log(`the PATH line install.sh added is still in ${rcFiles.join(", ")}`);
}
