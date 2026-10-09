import { existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach } from "vitest";

// `boot` narrows the daemon's own PATH for the rest of the process; a test that boots in-process gets it back.
const path = process.env.PATH;
afterEach(() => {
  if (path === undefined) delete process.env.PATH;
  else process.env.PATH = path;
});

// Jobs get Node's `<prefix>/lib/node` read-only, and bwrap leaves an empty mount point there when it's missing: no
// test may leave one in the real prefix. Every job sandbox a test starts, through `boot` too, gets this stand-in.
const realNodeLib = resolve(dirname(realpathSync(process.execPath)), "..", "lib", "node");
const hadNodeLib = existsSync(realNodeLib);
// Made only when a sandbox starts: a file whose tests are all skipped runs no `afterAll` to remove it.
const nodePrefix = join(realpathSync(tmpdir()), `japa-node-prefix-${process.pid}`);
process.env.JAPA_NODE_LIB = join(nodePrefix, "lib", "node");
afterAll(() => {
  rmSync(nodePrefix, { recursive: true, force: true });
  if (!hadNodeLib && existsSync(realNodeLib)) throw new Error(`A test left ${realNodeLib} behind`);
});
