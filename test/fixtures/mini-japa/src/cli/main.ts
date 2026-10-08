#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// A minimal stand-in for src/cli/main.ts, used by test/install-sh.test.ts so install.sh's git clone, Node
// detection, `npm ci` and launcher steps can be exercised end to end without cloning the real japa repo.
const [, , command, ...args] = process.argv;

if (command === "--version") {
  console.log("japa 0.0.0 (fixture)");
} else if (command === "update") {
  console.log(`update called ${args.join(" ")}`);
} else if (command === "setup") {
  console.log(`setup called ${args.join(" ")}`);
} else {
  console.error("Usage: japa <command>");
  process.exitCode = 1;
}
