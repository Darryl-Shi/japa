import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { acquireLock } from "../src/kernel/lock.ts";
import { tempHome } from "./helpers.ts";

test("second lock while held fails", () => {
  const home = tempHome();
  const release = acquireLock(home);
  expect(() => acquireLock(home)).toThrow(/already running/);
  release();
  acquireLock(home)();
});

test("stale lock from a dead pid is taken over", () => {
  const home = tempHome();
  writeFileSync(join(home, "daemon.lock"), "999999999");
  expect(() => acquireLock(home)()).not.toThrow();
});
