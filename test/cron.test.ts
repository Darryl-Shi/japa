import { expect, test } from "vitest";
import { nextAfter } from "../extensions/schedule/cron.ts";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test("*/15 gives the next quarter hour", () => {
  expect(nextAfter("*/15 * * * *", at(2026, 10, 9, 10, 7) + 30_000)).toBe(at(2026, 10, 9, 10, 15));
  expect(nextAfter("*/15 * * * *", at(2026, 10, 9, 10, 15))).toBe(at(2026, 10, 9, 10, 30));
});

test("weekdays at 9 from Friday 10:00 give Monday 09:00", () => {
  expect(new Date(at(2026, 10, 9)).getDay()).toBe(5);
  expect(nextAfter("0 9 * * 1-5", at(2026, 10, 9, 10))).toBe(at(2026, 10, 12, 9));
});

test("the first of the month crosses month and year boundaries", () => {
  expect(nextAfter("0 0 1 * *", at(2026, 10, 9))).toBe(at(2026, 11, 1));
  expect(nextAfter("0 0 1 * *", at(2026, 12, 15))).toBe(at(2027, 1, 1));
});

test("Feb 29 gives the next leap day", () => {
  expect(nextAfter("30 8 29 2 *", at(2027, 3, 15))).toBe(at(2028, 2, 29, 8, 30));
});

test("invalid expressions throw", () => {
  expect(() => nextAfter("61 * * * *", 0)).toThrow(/^invalid cron: /);
  expect(() => nextAfter("* * *", 0)).toThrow(/^invalid cron: /);
  expect(() => nextAfter("0 0 30 2 *", 0)).toThrow(/^invalid cron: /);
});

test("in a DST fall-back hour the next time is still after the given one", () => {
  const tz = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const est130 = Date.UTC(2026, 10, 1, 6, 30); // 01:30 EST on 2026-11-01, the repeated hour
    expect(nextAfter("*/15 * * * *", est130)).toBeGreaterThan(est130);
  } finally {
    process.env.TZ = tz;
  }
});
