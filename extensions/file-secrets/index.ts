import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineJapaExtension, type SecretsAdapter, type SecretsStore } from "../../src/sdk.ts";

const SECRET_NAME = /^[a-zA-Z0-9._-]+$/;

/** A secrets store keeping each secret in its own private file under `dir`. */
async function openFileSecrets(dir: string): Promise<SecretsStore> {
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const path = (name: string): string => {
    if (!SECRET_NAME.test(name) || name === "." || name === "..") throw new Error("Invalid secret name");
    return join(dir, name);
  };

  return {
    get: async (name) => {
      const file = path(name);
      try {
        return await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    set: async (name, value) => writeFile(path(name), value, { mode: 0o600 }),
    delete: async (name) => rm(path(name), { force: true }),
    list: async () => (await readdir(dir)).sort(),
  };
}

const secrets: SecretsAdapter = {
  name: "file",
  open: async (config, { home }) =>
    openFileSecrets(typeof config.dir === "string" ? config.dir.replace(/^~/, homedir()) : join(home, "secrets")),
};

export default defineJapaExtension({
  name: "file-secrets",
  summary: "Keeps japa's credentials in private files on this machine",
  provides: { secrets: [secrets] },
});
