import { expect, test } from "vitest";
import { type Api, GoogleError } from "../extensions/google/api.ts";
import {
  CALENDAR_ACTIONS,
  CALENDAR_DESCRIPTION,
  calendar,
  calendarParameters,
  midnight,
} from "../extensions/google/calendar.ts";
import { schemaProblems } from "../src/kernel/tool-schema.ts";

const BASE = "https://www.googleapis.com/calendar/v3";

type Call = [string, string, unknown];
type Route = unknown | ((opts: any) => unknown);

const rel = (url: string) => url.replace(BASE + "/", "");

/** An Api answering json requests from `routes`, keyed "METHOD path" (relative to the Calendar base). */
function fake(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const api = {
    json: async (method: string, url: string, opts?: unknown) => {
      calls.push([method, rel(url), opts]);
      const key = `${method} ${rel(url)}`;
      if (!(key in routes)) throw new Error(`unexpected request: ${key}`);
      const route = routes[key];
      if (route instanceof Error) throw route;
      return typeof route === "function" ? route(opts) : route;
    },
    bytes: async () => {
      throw new Error("unexpected bytes");
    },
    upload: async () => {
      throw new Error("unexpected upload");
    },
    raw: async () => {
      throw new Error("unexpected raw");
    },
  } as unknown as Api;
  return { api, calls };
}

const NOW = new Date("2026-10-09T12:00:00.000Z");
const now = () => NOW;

test("the parameters are a portable schema with every action", () => {
  expect(schemaProblems(calendarParameters)).toEqual([]);
  expect(CALENDAR_ACTIONS).toEqual(["calendars", "list", "create", "update", "delete", "freebusy"]);
  for (const action of CALENDAR_ACTIONS) expect(CALENDAR_DESCRIPTION).toContain(action);
});

test("calendars: one line per calendar, the primary marked", async () => {
  const { api, calls } = fake({
    "GET users/me/calendarList": {
      items: [
        { id: "me@example.com", summary: "Me", primary: true },
        { id: "family#abc@group.calendar.google.com", summary: "Family" },
      ],
    },
  });
  expect(await calendar(api, { action: "calendars" }, now)).toBe(
    "Me (me@example.com) primary\nFamily (family#abc@group.calendar.google.com)",
  );
  expect(calls).toEqual([["GET", "users/me/calendarList", undefined]]);
});

test("calendars: none", async () => {
  const { api } = fake({ "GET users/me/calendarList": { items: [] } });
  expect(await calendar(api, { action: "calendars" }, now)).toBe("No calendars.");
});

const LIST = { singleEvents: true, orderBy: "startTime", maxResults: 50 };

test("list: the next 7 days from now on primary by default, times in the calendar's zone", async () => {
  const { api, calls } = fake({
    "GET calendars/primary/events": {
      timeZone: "America/New_York",
      items: [
        {
          id: "e1",
          summary: "Standup",
          start: { dateTime: "2026-10-09T15:00:00Z" },
          end: { dateTime: "2026-10-09T15:30:00Z" },
          location: "Room 4",
          attendees: [{ email: "a@example.com" }, { email: "b@example.com" }],
        },
        {
          id: "e2",
          summary: "Lunch",
          start: { dateTime: "2026-10-10T12:00:00-04:00" },
          end: { dateTime: "2026-10-10T13:00:00-04:00" },
        },
      ],
    },
  });
  const out = await calendar(api, { action: "list" }, now);
  expect(calls).toEqual([
    [
      "GET",
      "calendars/primary/events",
      {
        query: {
          timeMin: "2026-10-09T12:00:00.000Z",
          timeMax: "2026-10-16T12:00:00.000Z",
          q: undefined,
          ...LIST,
        },
      },
    ],
  ]);
  expect(out).toBe(
    "1. Standup — Oct 9, 2026, 11:00 AM to Oct 9, 2026, 11:30 AM @ Room 4\n" +
      "   id e1 attendees: a@example.com, b@example.com\n" +
      "2. Lunch — Oct 10, 2026, 12:00 PM to Oct 10, 2026, 1:00 PM\n   id e2",
  );
});

test("list: the zone changes the shown times", async () => {
  const event = {
    id: "e1",
    summary: "Call",
    start: { dateTime: "2026-10-09T15:00:00Z" },
    end: { dateTime: "2026-10-09T16:00:00Z" },
  };
  const { api } = fake({ "GET calendars/primary/events": { timeZone: "Asia/Tokyo", items: [event] } });
  expect(await calendar(api, { action: "list" }, now)).toBe(
    "1. Call — Oct 10, 2026, 12:00 AM to Oct 10, 2026, 1:00 AM\n   id e1",
  );
});

test("list: all-day events show the date (and the last day for several)", async () => {
  const { api } = fake({
    "GET calendars/primary/events": {
      timeZone: "America/New_York",
      items: [
        { id: "h1", summary: "Holiday", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } },
        { id: "t1", summary: "Trip", start: { date: "2026-10-14" }, end: { date: "2026-10-17" } },
        { id: "n1", start: { date: "2026-10-15" }, end: { date: "2026-10-16" } },
      ],
    },
  });
  expect(await calendar(api, { action: "list" }, now)).toBe(
    "1. Holiday — Oct 12, 2026 (all day)\n   id h1\n" +
      "2. Trip — Oct 14, 2026 to Oct 16, 2026 (all day)\n   id t1\n" +
      "3. (no title) — Oct 15, 2026 (all day)\n   id n1",
  );
});

test("list: from, to, query and calendar pass through; a bare date is midnight in the calendar's zone", async () => {
  const { api, calls } = fake({
    "GET calendars/team%23x%40group.calendar.google.com": { timeZone: "America/Los_Angeles" },
    "GET calendars/team%23x%40group.calendar.google.com/events": { items: [] },
  });
  const out = await calendar(
    api,
    {
      action: "list",
      calendar: "team#x@group.calendar.google.com",
      from: "2026-11-01",
      to: "2026-11-03T09:00:00-05:00",
      query: "dentist",
    },
    now,
  );
  expect(out).toBe("No events.");
  expect(calls).toEqual([
    ["GET", "calendars/team%23x%40group.calendar.google.com", { query: { fields: "timeZone" } }],
    [
      "GET",
      "calendars/team%23x%40group.calendar.google.com/events",
      {
        query: { timeMin: "2026-11-01T00:00:00-07:00", timeMax: "2026-11-03T09:00:00-05:00", q: "dentist", ...LIST },
      },
    ],
  ]);
});

test("list: a from without a to looks 7 days ahead of it; a bad from is a reply", async () => {
  const { api, calls } = fake({ "GET calendars/primary/events": { items: [] } });
  await calendar(api, { action: "list", from: "2026-11-01", timeZone: "Europe/Paris" }, now);
  // The given zone: no lookup of the calendar's.
  expect(calls).toHaveLength(1);
  expect(calls[0][2]).toMatchObject({
    query: { timeMin: "2026-11-01T00:00:00+01:00", timeMax: "2026-11-07T23:00:00.000Z" },
  });
  await expect(calendar(api, { action: "list", from: "next week" }, now)).rejects.toThrow(
    new GoogleError("Not a date or time: next week"),
  );
});

test("list: a bare date in Los Angeles is local midnight there; times alone fetch no zone", async () => {
  const { api, calls } = fake({
    "GET calendars/primary": { timeZone: "America/Los_Angeles" },
    "GET calendars/primary/events": { items: [] },
  });
  await calendar(api, { action: "list", from: "2026-10-16", to: "2026-10-17" }, now);
  expect(calls.map((c) => c[1])).toEqual(["calendars/primary", "calendars/primary/events"]);
  expect(calls[1][2]).toMatchObject({
    query: { timeMin: "2026-10-16T00:00:00-07:00", timeMax: "2026-10-17T00:00:00-07:00" },
  });
  calls.length = 0;
  await calendar(api, { action: "list", from: "2026-10-16T09:00:00Z", to: "2026-10-17T09:00:00Z" }, now);
  expect(calls.map((c) => c[1])).toEqual(["calendars/primary/events"]);
});

test("midnight: the zone's offset at that local midnight, across DST changes", () => {
  expect(midnight("2026-10-16", "America/Los_Angeles")).toBe("2026-10-16T00:00:00-07:00");
  // DST starts 2026-03-08 and ends 2026-11-01 at 2 AM in Los Angeles: midnight is before each change.
  expect(midnight("2026-03-08", "America/Los_Angeles")).toBe("2026-03-08T00:00:00-08:00");
  expect(midnight("2026-03-09", "America/Los_Angeles")).toBe("2026-03-09T00:00:00-07:00");
  expect(midnight("2026-11-01", "America/Los_Angeles")).toBe("2026-11-01T00:00:00-07:00");
  expect(midnight("2026-11-02", "America/Los_Angeles")).toBe("2026-11-02T00:00:00-08:00");
  expect(midnight("2026-07-01", "Asia/Kathmandu")).toBe("2026-07-01T00:00:00+05:45");
  expect(midnight("2026-07-01", "UTC")).toBe("2026-07-01T00:00:00+00:00");
  expect(() => midnight("2026-07-01", "Mars/Olympus")).toThrow(new GoogleError("Unknown time zone: Mars/Olympus"));
});

test("create: dates make an all-day event, attendees become objects", async () => {
  const { api, calls } = fake({
    "POST calendars/primary/events": {
      id: "new1",
      summary: "Offsite",
      htmlLink: "https://calendar.google.com/e/new1",
    },
  });
  const out = await calendar(
    api,
    {
      action: "create",
      summary: "Offsite",
      start: "2026-10-20",
      end: "2026-10-22",
      attendees: ["a@example.com", "b@example.com"],
      location: "Lake house",
      description: "Bring boots",
    },
    now,
  );
  expect(calls).toEqual([
    [
      "POST",
      "calendars/primary/events",
      {
        query: { sendUpdates: "all" },
        body: {
          summary: "Offsite",
          start: { date: "2026-10-20" },
          end: { date: "2026-10-22" },
          attendees: [{ email: "a@example.com" }, { email: "b@example.com" }],
          location: "Lake house",
          description: "Bring boots",
        },
      },
    ],
  ]);
  expect(out).toBe("Created Offsite (id new1) https://calendar.google.com/e/new1");
});

test("create: times become dateTime, with the time zone only when given", async () => {
  const { api, calls } = fake({ "POST calendars/work%40example.com/events": { id: "new2", summary: "Call" } });
  const call = { action: "create", calendar: "work@example.com", summary: "Call" } as const;
  await calendar(
    api,
    { ...call, start: "2026-10-20T10:00:00", end: "2026-10-20T11:00:00", timeZone: "Europe/Paris" },
    now,
  );
  await calendar(api, { ...call, start: "2026-10-20T10:00:00Z", end: "2026-10-20T11:00:00Z" }, now);
  expect(calls.map((c) => c[2])).toEqual([
    {
      query: { sendUpdates: "all" },
      body: {
        summary: "Call",
        start: { dateTime: "2026-10-20T10:00:00", timeZone: "Europe/Paris" },
        end: { dateTime: "2026-10-20T11:00:00", timeZone: "Europe/Paris" },
      },
    },
    {
      query: { sendUpdates: "all" },
      body: { summary: "Call", start: { dateTime: "2026-10-20T10:00:00Z" }, end: { dateTime: "2026-10-20T11:00:00Z" } },
    },
  ]);
});

test("create needs summary, start and end", async () => {
  const { api, calls } = fake({});
  await expect(calendar(api, { action: "create", summary: "x", start: "2026-10-20" }, now)).rejects.toThrow(
    new GoogleError("create needs summary, start and end"),
  );
  expect(calls).toEqual([]);
});

test("update: PATCH with only the given fields", async () => {
  const { api, calls } = fake({ "PATCH calendars/primary/events/e%2F1": { id: "e/1", summary: "Standup" } });
  const args = { action: "update", id: "e/1", start: "2026-10-09T16:00:00Z", location: "Room 5" } as const;
  const out = await calendar(api, args, now);
  expect(calls).toEqual([
    [
      "PATCH",
      "calendars/primary/events/e%2F1",
      { query: { sendUpdates: "all" }, body: { start: { dateTime: "2026-10-09T16:00:00Z" }, location: "Room 5" } },
    ],
  ]);
  expect(out).toBe("Updated Standup (id e/1)");
});

test("update: all-day dates, attendees, and nothing to change", async () => {
  const { api, calls } = fake({ "PATCH calendars/c%40x/events/e1": { id: "e1", summary: "Trip" } });
  await calendar(
    api,
    { action: "update", id: "e1", calendar: "c@x", end: "2026-10-18", attendees: ["z@example.com"] },
    now,
  );
  expect(calls[0][2]).toEqual({
    query: { sendUpdates: "all" },
    body: { end: { date: "2026-10-18" }, attendees: [{ email: "z@example.com" }] },
  });
  await expect(calendar(api, { action: "update", id: "e1" }, now)).rejects.toThrow(
    new GoogleError("update needs id and a field to change"),
  );
  await expect(calendar(api, { action: "update", summary: "x" }, now)).rejects.toThrow(
    new GoogleError("update needs id and a field to change"),
  );
});

test("delete: DELETE the event", async () => {
  const { api, calls } = fake({ "DELETE calendars/primary/events/e1": undefined });
  expect(await calendar(api, { action: "delete", id: "e1" }, now)).toBe("Deleted e1.");
  expect(calls).toEqual([["DELETE", "calendars/primary/events/e1", { query: { sendUpdates: "all" } }]]);
  await expect(calendar(api, { action: "delete" }, now)).rejects.toThrow(new GoogleError("delete needs id"));
});

test("freebusy: primary by default, bare dates in the user's zone, busy times in UTC without a zone", async () => {
  const { api, calls } = fake({
    "GET calendars/primary": { timeZone: "America/Los_Angeles" },
    "POST freeBusy": {
      calendars: {
        primary: {
          busy: [
            { start: "2026-10-09T15:00:00Z", end: "2026-10-09T16:00:00Z" },
            { start: "2026-10-09T18:00:00Z", end: "2026-10-09T18:30:00Z" },
          ],
        },
      },
    },
  });
  const out = await calendar(api, { action: "freebusy", from: "2026-10-09", to: "2026-10-10" }, now);
  expect(calls).toEqual([
    ["GET", "calendars/primary", { query: { fields: "timeZone" } }],
    [
      "POST",
      "freeBusy",
      {
        body: {
          timeMin: "2026-10-09T00:00:00-07:00",
          timeMax: "2026-10-10T00:00:00-07:00",
          items: [{ id: "primary" }],
        },
      },
    ],
  ]);
  expect(out).toBe(
    "primary: busy Oct 9, 2026, 3:00 PM–Oct 9, 2026, 4:00 PM, Oct 9, 2026, 6:00 PM–Oct 9, 2026, 6:30 PM",
  );
});

test("freebusy: several people in a given zone; free and unavailable calendars", async () => {
  const { api, calls } = fake({
    "POST freeBusy": {
      timeZone: "America/New_York",
      calendars: {
        "a@example.com": { busy: [{ start: "2026-10-09T15:00:00Z", end: "2026-10-09T16:00:00Z" }] },
        "b@example.com": { busy: [] },
        "c@example.com": { busy: [], errors: [{ domain: "global", reason: "notFound" }] },
      },
    },
  });
  const out = await calendar(
    api,
    {
      action: "freebusy",
      from: "2026-10-09T00:00:00-04:00",
      to: "2026-10-10T00:00:00-04:00",
      emails: ["a@example.com", "b@example.com", "c@example.com"],
      timeZone: "America/New_York",
    },
    now,
  );
  expect(calls[0][2]).toEqual({
    body: {
      timeMin: "2026-10-09T00:00:00-04:00",
      timeMax: "2026-10-10T00:00:00-04:00",
      timeZone: "America/New_York",
      items: [{ id: "a@example.com" }, { id: "b@example.com" }, { id: "c@example.com" }],
    },
  });
  expect(out).toBe(
    "a@example.com: busy Oct 9, 2026, 11:00 AM–Oct 9, 2026, 12:00 PM\n" +
      "b@example.com: free\n" +
      "c@example.com: unavailable (notFound)",
  );
});

test("freebusy: the asked zone sets bare dates' midnight and formats times when the response has none", async () => {
  const { api, calls } = fake({
    "POST freeBusy": {
      calendars: { primary: { busy: [{ start: "2026-10-09T15:00:00Z", end: "2026-10-09T16:00:00Z" }] } },
    },
  });
  const out = await calendar(
    api,
    { action: "freebusy", from: "2026-10-09", to: "2026-10-10", timeZone: "Asia/Tokyo" },
    now,
  );
  expect(out).toBe("primary: busy Oct 10, 2026, 12:00 AM–Oct 10, 2026, 1:00 AM");
  expect(calls).toHaveLength(1);
  expect(calls[0][2]).toMatchObject({
    body: { timeMin: "2026-10-09T00:00:00+09:00", timeMax: "2026-10-10T00:00:00+09:00" },
  });
});

test("freebusy needs from and to", async () => {
  const { api } = fake({});
  await expect(calendar(api, { action: "freebusy", from: "2026-10-09" }, now)).rejects.toThrow(
    new GoogleError("freebusy needs from and to"),
  );
});

test("an unknown action is a reply", async () => {
  const { api } = fake({});
  await expect(calendar(api, { action: "nope" } as never, now)).rejects.toThrow(
    new GoogleError("Unknown action: nope"),
  );
});
