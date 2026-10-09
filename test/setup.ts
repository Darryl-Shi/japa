import { afterEach } from "vitest";

// `boot` narrows the daemon's own PATH for the rest of the process; a test that boots in-process gets it back.
const path = process.env.PATH;
afterEach(() => {
  if (path === undefined) delete process.env.PATH;
  else process.env.PATH = path;
});
