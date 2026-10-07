import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);

test("installer stages a private copy, handles spaces, and preserves the old app on dependency failure", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "japa install "));
  t.after(() => rm(home, { recursive: true, force: true }));
  const tools = join(home, "tools");
  const app = join(home, "my app");
  const bin = join(home, "my bin");
  await mkdir(tools);
  await writeFile(
    join(tools, "npm"),
    '#!/bin/sh\n[ "${FAIL_NPM:-}" != 1 ] || exit 7\n[ "$1" = ci ] || exit 8\n[ "$2" = --prefix ] || exit 9\ntouch "$3/dependencies-installed"\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH}`,
    JAPA_INSTALL_DIR: app,
    JAPA_BIN_DIR: bin,
  };
  await exec("bash", [resolve("install.sh"), "--no-start"], { env });
  assert.equal(
    (await stat(join(app, "dependencies-installed"))).isFile(),
    true,
  );
  assert.equal((await stat(app)).mode & 0o777, 0o700);
  const launcher = await readFile(join(bin, "japa"), "utf8");
  assert.match(launcher, /Japa managed launcher/);
  assert.match(launcher, /JAPA_HOME/);
  await exec("bash", ["-n", join(bin, "japa")]);
  await writeFile(join(app, "preserve-me"), "old app");
  await assert.rejects(
    exec("bash", [resolve("install.sh"), "--no-start"], {
      env: { ...env, FAIL_NPM: "1" },
    }),
  );
  assert.equal(await readFile(join(app, "preserve-me"), "utf8"), "old app");
  assert(
    !(await readdir(home)).some((name) => name.startsWith(".japa-install.")),
  );
  await exec("bash", [resolve("install.sh"), "--no-start"], { env });
  const previous = (await readdir(home)).find((name) =>
    name.startsWith("my app.previous."),
  );
  assert(previous);
  assert.equal(
    await readFile(join(home, previous, "preserve-me"), "utf8"),
    "old app",
  );
});

test("installer refuses to overwrite an unrelated directory", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "japa-install-refuse-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const app = join(home, "unrelated");
  await mkdir(app);
  await writeFile(join(app, "important"), "keep");
  await assert.rejects(
    exec("bash", [resolve("install.sh"), "--no-start"], {
      env: {
        ...process.env,
        JAPA_INSTALL_DIR: app,
        JAPA_BIN_DIR: join(home, "bin"),
      },
    }),
    /unmanaged/,
  );
  assert.equal(await readFile(join(app, "important"), "utf8"), "keep");
});
