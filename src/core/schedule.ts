// When a time trigger fires next. "every" is a duration ("15m", "2h", "1d"); "at" is a local time of day, optionally
// on given weekdays, in the user's time zone.

export type When = { every: string } | { at: string; days?: readonly Weekday[] } | { event: string };
export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

const UNIT: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function duration(text: string): number {
	const match = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(text.trim());
	if (match === null) throw new Error(`Not a duration: "${text}" (e.g. 15m, 2h, 1d)`);
	return Number(match[1]) * UNIT[match[2]!]!;
}

/** The wall-clock parts of an instant in a time zone. */
function local(at: number, timeZone: string | undefined): { weekday: Weekday; year: number; month: number; day: number; hour: number; minute: number } {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(at);
	const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
	return { weekday: get("weekday") as Weekday, year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")), minute: Number(get("minute")) };
}

/** The instant a local wall-clock time happens in a time zone (DST: the offset of that moment). */
function instant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string | undefined): number {
	const guess = Date.UTC(year, month - 1, day, hour, minute);
	const seen = local(guess, timeZone);
	const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - guess;
	return guess - offset;
}

/** The next time strictly after `after`; undefined for an event trigger. */
export function nextFire(when: When, after: number, timeZone?: string): number | undefined {
	if ("event" in when) return undefined;
	if ("every" in when) return after + duration(when.every);
	const [hour, minute] = when.at.split(":").map(Number) as [number, number];
	for (let offset = 0; offset <= 8; offset++) {
		const day = local(after + offset * 86_400_000, timeZone);
		if (when.days !== undefined && !when.days.includes(day.weekday)) continue;
		const at = instant(day.year, day.month, day.day, hour, minute, timeZone);
		if (at > after) return at;
	}
	return undefined;
}

/** "Sat 4 Oct 14:05" in a time zone: the time stamp on every message the agent gets. */
export function stamp(at: number, timeZone?: string): string {
	const parts = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
	const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return `${part("weekday")} ${part("day")} ${part("month")} ${part("hour")}:${part("minute")}`;
}
