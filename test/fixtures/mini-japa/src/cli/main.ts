#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// A minimal stand-in for src/cli/main.ts, used by test/install-sh.test.ts so install.sh's git clone, Node
// detection, `npm ci` and launcher steps can be exercised end to end without cloning the real japa repo.
// A real dependency, so deleting node_modules breaks `--version` the way it breaks the real japa (install.sh's
// uninstall probe).
import { fixture } from "mini-dep";

const [, , command, ...args] = process.argv;

if (command === "--version") {
  console.log(`japa 0.0.0 (${fixture})`);
} else if (command === "update") {
  console.log(`update called ${args.join(" ")}`);
} else if (command === "setup") {
  console.log(`setup called ${args.join(" ")}`);
} else if (command === "uninstall") {
  // Stand-in for src/cli/uninstall.ts: reports how it was called and, with --purge, the confirmation it read from
  // stdin; removes nothing, so tests can tell the delegated path from install.sh's fallback.
  console.log(`uninstall called ${args.join(" ")}`);
  if (args.includes("--purge")) {
    const { readFileSync } = await import("node:fs");
    const line = readFileSync(0, "utf8").split("\n")[0];
    console.log(`uninstall confirm: ${line}`);
  }
} else {
  console.error("Usage: japa <command>");
  process.exitCode = 1;
}
