import assert from "node:assert/strict";
import { test } from "node:test";
import { duration, nextFire } from "../src/core/schedule.ts";

test("schedule: durations, local times of day across zones and DST, weekdays", () => {
	assert.equal(duration("15m"), 900_000);
	assert.equal(duration("1d"), 86_400_000);
	assert.throws(() => duration("soon"));
	const at = Date.parse("2026-10-05T10:00:00Z"); // a Monday
	assert.equal(nextFire({ every: "2h" }, at), at + 7_200_000);
	assert.equal(new Date(nextFire({ at: "09:00" }, at, "UTC")!).toISOString(), "2026-10-06T09:00:00.000Z", "already past today: tomorrow");
	assert.equal(new Date(nextFire({ at: "21:30" }, at, "UTC")!).toISOString(), "2026-10-05T21:30:00.000Z");
	assert.equal(new Date(nextFire({ at: "09:00" }, at, "Asia/Singapore")!).toISOString(), "2026-10-06T01:00:00.000Z", "09:00 in Singapore");
	assert.equal(new Date(nextFire({ at: "09:00", days: ["Fri"] }, at, "UTC")!).toISOString(), "2026-10-09T09:00:00.000Z", "next Friday");
	// Across the end of daylight saving in London (25 Oct 2026): 09:00 local is 08:00Z before and 09:00Z after.
	assert.equal(new Date(nextFire({ at: "09:00" }, Date.parse("2026-10-24T12:00:00Z"), "Europe/London")!).toISOString(), "2026-10-25T09:00:00.000Z");
	assert.equal(new Date(nextFire({ at: "09:00" }, Date.parse("2026-10-23T12:00:00Z"), "Europe/London")!).toISOString(), "2026-10-24T08:00:00.000Z");
	assert.equal(nextFire({ event: "mail" }, at), undefined);
});
