import { linkSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  liveness,
  patchUpdateState,
  readUpdateState,
  updateFile,
  updateLog,
  type UpdateState,
  writeUpdateState,
} from "../src/kernel/update-state.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "japa-update-state-"));

const STATE: UpdateState = {
  state: "running",
  started: 1_000_000,
  chat: { adapter: "telegram", chat: "42" },
  from: "a".repeat(40),
  to: "b".repeat(40),
  rollback: false,
  reported: false,
};

test("the state file and the log live in the japa home", () => {
  expect(updateFile("/h")).toBe(join("/h", "update.json"));
  expect(updateLog("/h")).toBe(join("/h", "logs", "update.log"));
});

test("a missing, empty or corrupt update.json reads as undefined", () => {
  const home = tmp();
  expect(readUpdateState(home)).toBeUndefined();
  for (const text of ["", "{", "[]", '{"state":1}', '{"state":"running"}', "null"]) {
    writeFileSync(updateFile(home), text);
    expect(readUpdateState(home), text).toBeUndefined();
  }
});

test("an update.json whose pid isn't a positive integer reads as undefined", () => {
  const home = tmp();
  for (const pid of [0, -1, 1.5, "7", null]) {
    writeFileSync(updateFile(home), JSON.stringify({ ...STATE, pid }));
    expect(readUpdateState(home), String(pid)).toBeUndefined();
  }
  writeFileSync(updateFile(home), JSON.stringify({ ...STATE, pid: 7 }));
  expect(readUpdateState(home)).toEqual({ ...STATE, pid: 7 });
});

test("write then read round-trips, via a temp file in the same directory", () => {
  const home = tmp();
  writeFileSync(updateFile(home), "old\n");
  // A second name for the old file: an in-place write would change it too, a rename leaves it alone.
  linkSync(updateFile(home), join(home, "old-link"));
  const before = statSync(updateFile(home)).ino;

  writeUpdateState(home, STATE);

  expect(readUpdateState(home)).toEqual(STATE);
  expect(statSync(updateFile(home)).ino).not.toBe(before);
  expect(readFileSync(join(home, "old-link"), "utf8")).toBe("old\n");
  expect(readdirSync(home).sort()).toEqual(["old-link", "update.json"]); // no temp file left behind
});

test("patch merges into the file and does nothing without one", () => {
  const home = tmp();
  patchUpdateState(home, { pid: 7 });
  expect(readdirSync(home)).toEqual([]);

  writeUpdateState(home, STATE);
  patchUpdateState(home, { pid: 7 });
  patchUpdateState(home, { state: "updated", finished: 1_000_500, commits: ["abc1234 two"] });

  expect(readUpdateState(home)).toEqual({
    ...STATE,
    pid: 7,
    state: "updated",
    finished: 1_000_500,
    commits: ["abc1234 two"],
  });
});

test("liveness: a live pid runs, a dead one is interrupted, no pid is interrupted only after 60 s", () => {
  const now = STATE.started + 1_000;
  const alive = (pid: number) => pid === 7;

  expect(liveness({ ...STATE, pid: 7 }, now, alive)).toBe("running");
  expect(liveness({ ...STATE, pid: 8 }, now, alive)).toBe("interrupted");
  expect(liveness(STATE, STATE.started + 59_000, alive)).toBe("running");
  expect(liveness(STATE, STATE.started + 61_000, alive)).toBe("interrupted");
  for (const state of ["updated", "up to date", "failed"] as const) {
    expect(liveness({ ...STATE, state, pid: 8 }, now, alive), state).toBe("finished");
  }
});

test("liveness: a running update started over an hour ago is interrupted, even with a live pid", () => {
  const alive = () => true;
  expect(liveness({ ...STATE, pid: 7 }, STATE.started + 3_599_000, alive)).toBe("running");
  expect(liveness({ ...STATE, pid: 7 }, STATE.started + 3_601_000, alive)).toBe("interrupted");
  expect(liveness({ ...STATE, state: "updated", pid: 7 }, STATE.started + 3_601_000, alive)).toBe("finished");
});

test("liveness checks the pid itself by default", () => {
  expect(liveness({ ...STATE, pid: process.pid }, STATE.started)).toBe("running");
  expect(liveness({ ...STATE, pid: 2 ** 22 + 1 }, STATE.started)).toBe("interrupted"); // above Linux's pid_max
});
