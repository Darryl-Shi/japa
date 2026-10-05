// Time as the agent is told it: the local time stamped on each message.

/** "Sat 4 Oct 14:05" in a time zone: the time stamp on every message the agent gets. */
export function stamp(at: number, timeZone?: string): string {
	const parts = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
	const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return `${part("weekday")} ${part("day")} ${part("month")} ${part("hour")}:${part("minute")}`;
}
