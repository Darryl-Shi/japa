// `japa uninstall [--purge]` (design doc §8): stops and removes the service, removes a launcher that points at
// this checkout, and removes the install dir when it's a managed install. The runtime home (`japaHome()`) is kept
// unless `--purge` is given and the user confirms; PATH lines install.sh added to a shell rc file are never touched.
// With `--purge`, confirmation happens before anything is touched: an answer other than "delete" removes nothing.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { launcherPointsAt, type Layout } from "./layout.ts";
import { type ServiceEnv, uninstallService } from "./service.ts";

export type UninstallOptions = {
  purge: boolean;
  /** Resolves to the user's typed confirmation; only called when `purge` is true. "delete" removes `home`. */
  confirm: () => Promise<string>;
  serviceEnv: ServiceEnv;
  log: (s: string) => void;
};

export async function uninstall(layout: Layout, home: string, o: UninstallOptions): Promise<void> {
  if (o.purge && (await o.confirm()) !== "delete") {
    o.log("purge cancelled; nothing was removed");
    return;
  }

  await uninstallService(o.serviceEnv, o.log);

  if (launcherPointsAt(layout)) rmSync(layout.launcher, { force: true });

  if (layout.installDir !== undefined) {
    // Bound the blast radius to this install: remove only app/ and node/, and the install dir itself only once
    // it's empty -- a dev checkout at e.g. ~/src/app must never take its sibling projects under ~/src with it.
    rmSync(layout.app, { recursive: true, force: true });
    if (layout.nodeDir !== undefined) rmSync(layout.nodeDir, { recursive: true, force: true });
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

  o.log("PATH lines added to a shell rc file by install.sh were left in place");
}
