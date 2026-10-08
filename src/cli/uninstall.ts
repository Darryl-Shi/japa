// `japa uninstall [--purge]` (design doc §8): stops and removes the service, removes a launcher that points at
// this checkout, and removes the install dir when it's a managed install. The runtime home (`japaHome()`) is kept
// unless `--purge` is given and the user confirms; PATH lines install.sh added to a shell rc file are never touched.
import { rmSync } from "node:fs";
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
  await uninstallService(o.serviceEnv, o.log);

  if (launcherPointsAt(layout)) rmSync(layout.launcher, { force: true });

  if (layout.installDir !== undefined) {
    rmSync(layout.installDir, { recursive: true, force: true });
  } else {
    o.log(`not an installed copy; left ${layout.app} in place`);
  }

  if (o.purge && (await o.confirm()) === "delete") {
    rmSync(home, { recursive: true, force: true });
  } else {
    o.log(`kept ${home}`);
  }

  o.log("PATH lines added to a shell rc file by install.sh were left in place");
}
