// The `calendar` tool: the user's calendars, events in a window, creating, changing and deleting events, and
// free/busy times (spec §4.4).
import { StringEnum, type Static } from "@earendil-works/pi-ai";
import { Type } from "../../src/sdk.ts";
import { type Api, GoogleError } from "./api.ts";

const BASE = "https://www.googleapis.com/calendar/v3";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const CALENDAR_ACTIONS = ["calendars", "list", "create", "update", "delete", "freebusy"] as const;

export const calendarParameters = Type.Object({
  action: StringEnum(CALENDAR_ACTIONS),
  calendar: Type.Optional(Type.String({ description: 'calendar id (default "primary")' })),
  id: Type.Optional(Type.String({ description: "event id" })),
  from: Type.Optional(Type.String({ description: "RFC 3339 time or YYYY-MM-DD" })),
  to: Type.Optional(Type.String({ description: "RFC 3339 time or YYYY-MM-DD" })),
  query: Type.Optional(Type.String({ description: "words to look for in events" })),
  summary: Type.Optional(Type.String({ description: "event title" })),
  start: Type.Optional(Type.String({ description: "YYYY-MM-DD (all day) or RFC 3339 time" })),
  end: Type.Optional(Type.String({ description: "YYYY-MM-DD (all day, exclusive) or RFC 3339 time" })),
  timeZone: Type.Optional(Type.String({ description: "IANA zone, e.g. Europe/Paris" })),
  attendees: Type.Optional(Type.Array(Type.String(), { description: "email addresses" })),
  location: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  emails: Type.Optional(Type.Array(Type.String(), { description: "people or calendar ids (default primary)" })),
});

export type CalendarArgs = Static<typeof calendarParameters>;

export const CALENDAR_DESCRIPTION = [
  "The user's Google Calendar. Actions:",
  "calendars — the user's calendars and their ids",
  'list { from?, to?, calendar? = "primary", query?, timeZone? } — events, by default the next 7 days; event ids ' +
    "and times in the calendar's time zone",
  "create { summary, start, end, attendees?, location?, description?, timeZone?, calendar? } — YYYY-MM-DD dates " +
    "make an all-day event (end is the day after the last); RFC 3339 times otherwise",
  "update { id, calendar?, summary?, start?, end?, attendees?, location?, description?, timeZone? } — only the " +
    "given fields change; attendees replaces the list",
  "delete { id, calendar? }",
  "freebusy { from, to, emails?, timeZone? } — busy times of people's calendars (default the user's)",
  "A bare YYYY-MM-DD in from or to is that day's midnight in timeZone, else in the calendar's time zone.",
  "Event ids come from earlier list results; calendar ids from calendars. Attendees are emailed on create, update " +
    "and delete.",
].join("\n");

type When = { date?: string; dateTime?: string; timeZone?: string };
type Event = {
  id: string;
  summary?: string;
  start?: When;
  end?: When;
  location?: string;
  attendees?: { email?: string }[];
  htmlLink?: string;
};

const events = (calendar = "primary", id?: string) =>
  [BASE, "calendars", encodeURIComponent(calendar), "events", ...(id ? [encodeURIComponent(id)] : [])].join("/");

/** "Oct 9, 2026, 3:00 PM" in `timeZone`; some ICU versions put a narrow no-break space before AM/PM. */
const formatter = (timeZone: string, time = true) => {
  const style = time ? { timeStyle: "short" as const } : {};
  const format = new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", ...style });
  return (date: Date) => format.format(date).replace(/[\u202f\u00a0]/g, " ");
};

/** `timeZone`'s offset from UTC at `instant`, in minutes. */
function offsetMinutes(instant: Date, timeZone: string): number {
  let name: string;
  try {
    const format = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
    name = format.formatToParts(instant).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  } catch {
    throw new GoogleError(`Unknown time zone: ${timeZone}`);
  }
  // "GMT-07:00", "GMT+05:45", or "GMT" for UTC itself.
  const match = /^GMT([+-])(\d{1,2}):?(\d{2})?$/.exec(name);
  if (!match) return 0;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A bare date's local midnight in `timeZone`, as RFC 3339 with the zone's offset at that moment. */
export function midnight(date: string, timeZone: string): string {
  const utc = new Date(`${date}T00:00:00Z`).getTime();
  // The offset at UTC midnight, then at the local midnight it points to: right across a DST change that day.
  const guess = offsetMinutes(new Date(utc), timeZone);
  const offset = offsetMinutes(new Date(utc - guess * 60_000), timeZone);
  const abs = Math.abs(offset);
  return `${date}T00:00:00${offset < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * The values with each bare date turned into local midnight: in `timeZone` when given, else in the calendar's zone,
 * fetched only when a bare date is there. Anything else passes on as given.
 */
async function toTimes<T extends string | undefined>(
  api: Api,
  values: T[],
  timeZone: string | undefined,
  calendar = "primary",
): Promise<T[]> {
  if (!values.some((value) => value !== undefined && DATE.test(value))) return values;
  let zone = timeZone;
  if (!zone) {
    const found = await api.json<{ timeZone?: string }>("GET", `${BASE}/calendars/${encodeURIComponent(calendar)}`, {
      query: { fields: "timeZone" },
    });
    zone = found?.timeZone ?? "UTC";
  }
  return values.map((value) => (value !== undefined && DATE.test(value) ? midnight(value, zone) : value) as T);
}

/** A date or a time as the API's start/end. */
const when = (value: string, timeZone?: string): When =>
  DATE.test(value) ? { date: value } : { dateTime: value, ...(timeZone ? { timeZone } : {}) };

const people = (emails: string[]) => emails.map((email) => ({ email }));

async function calendars(api: Api): Promise<string> {
  const found = await api.json<{ items?: { id: string; summary?: string; primary?: boolean }[] }>(
    "GET",
    `${BASE}/users/me/calendarList`,
  );
  const items = found?.items ?? [];
  if (items.length === 0) return "No calendars.";
  return items.map((c) => `${c.summary ?? c.id} (${c.id})${c.primary ? " primary" : ""}`).join("\n");
}

/** "<start> to <end>" in the zone; all-day events by date, Google's exclusive end shown as the last day. */
function span(event: Event, timeZone: string): string {
  if (event.start?.date) {
    const day = formatter("UTC", false);
    const first = new Date(`${event.start.date}T00:00:00Z`);
    const last = event.end?.date ? new Date(new Date(`${event.end.date}T00:00:00Z`).getTime() - 86_400_000) : first;
    const range = last > first ? `${day(first)} to ${day(last)}` : day(first);
    return `${range} (all day)`;
  }
  const time = formatter(timeZone);
  const start = event.start?.dateTime ? time(new Date(event.start.dateTime)) : "?";
  const end = event.end?.dateTime ? time(new Date(event.end.dateTime)) : "?";
  return `${start} to ${end}`;
}

async function list(api: Api, args: CalendarArgs, now: () => Date): Promise<string> {
  const [from, to] = await toTimes(api, [args.from, args.to], args.timeZone, args.calendar);
  const timeMin = from ?? now().toISOString();
  let timeMax = to;
  if (!timeMax) {
    const start = new Date(timeMin).getTime();
    if (Number.isNaN(start)) throw new GoogleError(`Not a date or time: ${args.from}`);
    timeMax = new Date(start + WEEK_MS).toISOString();
  }
  const found = await api.json<{ timeZone?: string; items?: Event[] }>("GET", events(args.calendar), {
    query: { timeMin, timeMax, q: args.query, singleEvents: true, orderBy: "startTime", maxResults: 50 },
  });
  const items = found?.items ?? [];
  if (items.length === 0) return "No events.";
  const zone = found?.timeZone ?? "UTC";
  return items
    .map((e, i) => {
      const where = e.location ? ` @ ${e.location}` : "";
      const who = (e.attendees ?? []).map((a) => a.email).filter(Boolean);
      const attendees = who.length > 0 ? ` attendees: ${who.join(", ")}` : "";
      return `${i + 1}. ${e.summary ?? "(no title)"} — ${span(e, zone)}${where}\n   id ${e.id}${attendees}`;
    })
    .join("\n");
}

/** The event fields the caller gave, as the API's body. */
function fields(args: CalendarArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.summary !== undefined) body.summary = args.summary;
  if (args.start !== undefined) body.start = when(args.start, args.timeZone);
  if (args.end !== undefined) body.end = when(args.end, args.timeZone);
  if (args.attendees !== undefined) body.attendees = people(args.attendees);
  if (args.location !== undefined) body.location = args.location;
  if (args.description !== undefined) body.description = args.description;
  return body;
}

/** Changes email the attendees: invitations, updates, cancellations. */
const NOTIFY = { sendUpdates: "all" };

/** "<summary> (id <id>) <link>", the link when Google gives one. */
const named = (event: Partial<Event>) =>
  [`${event.summary ?? "(no title)"} (id ${event.id})`, event.htmlLink].filter(Boolean).join(" ");

async function create(api: Api, args: CalendarArgs): Promise<string> {
  if (!args.summary || !args.start || !args.end) throw new GoogleError("create needs summary, start and end");
  const made = await api.json<Event>("POST", events(args.calendar), { query: NOTIFY, body: fields(args) });
  return `Created ${named(made)}`;
}

async function update(api: Api, args: CalendarArgs): Promise<string> {
  const body = fields(args);
  if (!args.id || Object.keys(body).length === 0) throw new GoogleError("update needs id and a field to change");
  const changed = await api.json<Event>("PATCH", events(args.calendar, args.id), { query: NOTIFY, body });
  return `Updated ${named(changed)}`;
}

async function remove(api: Api, args: CalendarArgs): Promise<string> {
  if (!args.id) throw new GoogleError("delete needs id");
  await api.json("DELETE", events(args.calendar, args.id), { query: NOTIFY });
  return `Deleted ${args.id}.`;
}

type Busy = { busy?: { start: string; end: string }[]; errors?: { reason?: string }[] };

async function freebusy(api: Api, args: CalendarArgs): Promise<string> {
  if (!args.from || !args.to) throw new GoogleError("freebusy needs from and to");
  const ids = args.emails && args.emails.length > 0 ? args.emails : ["primary"];
  const [timeMin, timeMax] = await toTimes(api, [args.from, args.to], args.timeZone);
  const body = {
    timeMin,
    timeMax,
    ...(args.timeZone ? { timeZone: args.timeZone } : {}),
    items: ids.map((id) => ({ id })),
  };
  const found = await api.json<{ timeZone?: string; calendars?: Record<string, Busy> }>(
    "POST",
    `${BASE}/freeBusy`,
    { body },
  );
  const time = formatter(found?.timeZone ?? args.timeZone ?? "UTC");
  return ids
    .map((id) => {
      const one = found?.calendars?.[id];
      if (!one || (one.errors?.length ?? 0) > 0) {
        const why = one?.errors?.map((e) => e.reason).filter(Boolean).join(", ");
        return `${id}: unavailable${why ? ` (${why})` : ""}`;
      }
      const busy = one.busy ?? [];
      if (busy.length === 0) return `${id}: free`;
      return `${id}: busy ${busy.map((b) => `${time(new Date(b.start))}–${time(new Date(b.end))}`).join(", ")}`;
    })
    .join("\n");
}

/** Runs one calendar action; throws GoogleError with the reply for a request it can't make. */
export async function calendar(api: Api, args: CalendarArgs, now: () => Date = () => new Date()): Promise<string> {
  switch (args.action) {
    case "calendars":
      return calendars(api);
    case "list":
      return list(api, args, now);
    case "create":
      return create(api, args);
    case "update":
      return update(api, args);
    case "delete":
      return remove(api, args);
    case "freebusy":
      return freebusy(api, args);
    default:
      throw new GoogleError(`Unknown action: ${String(args.action)}`);
  }
}
