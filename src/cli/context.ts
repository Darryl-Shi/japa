// Opens what `japa setup` needs without a running daemon: manifests, the configured secrets store and a `Models`
// with every discovered provider registered (see docs/superpowers/specs/2026-10-08-japa-install-design.md §4.1).
import { createModels, type Models, type Provider } from "@earendil-works/pi-ai";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { findAdapter } from "../kernel/boot.ts";
import type { SecretsAdapter, SecretsStore } from "../kernel/contracts.ts";
import { secretsCredentialStore } from "../kernel/credentials.ts";
import type { JapaExtension } from "../kernel/extension.ts";
import { discoverExtensions, loadExtensions } from "../kernel/loader.ts";
import { loadSettings } from "../kernel/settings.ts";
import { ensureWorkspace } from "../kernel/workspace.ts";
import { APP } from "./layout.ts";

export type SetupContext = { home: string; extensions: JapaExtension[]; secrets: SecretsStore; models: Models };

/**
 * Opens `home` for `japa setup`: creates it and the workspace if missing, loads the extension manifests (packaged
 * and workspace, `extensionDirs` default `[<APP>/extensions, <home>/extensions]`), opens the configured secrets
 * adapter, and registers every discovered `provider` contribution.
 */
export async function openSetupContext(home: string, extensionDirs?: string[]): Promise<SetupContext> {
  mkdirSync(home, { recursive: true });
  ensureWorkspace(home);

  const dirs = extensionDirs ?? [join(APP, "extensions"), join(home, "extensions")];
  const { extensions } = await loadExtensions(discoverExtensions(dirs));

  const settings = loadSettings(home);
  const secrets = await findAdapter<SecretsAdapter>(extensions, "secrets", settings.secrets.adapter).open(
    settings.secrets,
    { home },
  );

  const models = createModels({ credentials: secretsCredentialStore(secrets) });
  for (const e of extensions) for (const p of (e.provides?.provider ?? []) as Provider[]) models.setProvider(p);

  return { home, extensions, secrets, models };
}
