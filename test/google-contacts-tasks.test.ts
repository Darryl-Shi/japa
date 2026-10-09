import { expect, test } from "vitest";
import { type Api, GoogleError } from "../extensions/google/api.ts";
import {
  CONTACTS_ACTIONS,
  CONTACTS_DESCRIPTION,
  contacts,
  contactsParameters,
} from "../extensions/google/contacts.ts";
import { TASKS_ACTIONS, TASKS_DESCRIPTION, tasks, tasksParameters } from "../extensions/google/tasks.ts";
import { schemaProblems } from "../src/kernel/tool-schema.ts";

const PEOPLE = "https://people.googleapis.com/v1";
const TASKS = "https://tasks.googleapis.com/tasks/v1";

type Call = [string, string, unknown];
type Route = unknown | ((opts: any) => unknown);

const rel = (url: string) => url.replace(PEOPLE + "/", "").replace(TASKS + "/", "");

/** An Api answering json requests from `routes`, keyed "METHOD path" (relative to the People or Tasks base). */
function fake(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const api = {
    json: async (method: string, url: string, opts?: unknown) => {
      if (!url.startsWith(PEOPLE + "/") && !url.startsWith(TASKS + "/")) throw new Error(`wrong base: ${url}`);
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

const FIELDS = "names,emailAddresses,phoneNumbers,organizations,biographies";

// contacts

test("contacts: the parameters are a portable schema with every action", () => {
  expect(schemaProblems(contactsParameters)).toEqual([]);
  expect(CONTACTS_ACTIONS).toEqual(["search", "read", "create", "update"]);
  for (const action of CONTACTS_ACTIONS) expect(CONTACTS_DESCRIPTION).toContain(action);
});

const ADA = {
  resourceName: "people/c1",
  etag: "%EgUBAj",
  names: [{ displayName: "Ada Lovelace", unstructuredName: "Ada Lovelace" }],
  emailAddresses: [{ value: "ada@example.com" }, { value: "ada@work.example" }],
  phoneNumbers: [{ value: "+44 20 7946 0000" }],
  organizations: [{ name: "Analytical Engines", title: "Programmer" }, { name: "Royal Society" }],
  biographies: [{ value: "Met at the salon.", contentType: "TEXT_PLAIN" }],
};

test("search: numbered people with emails, phones and ids", async () => {
  const { api, calls } = fake({
    "GET people:searchContacts": {
      results: [
        { person: ADA },
        { person: { resourceName: "people/c2", names: [{ displayName: "Charles Babbage" }] } },
      ],
    },
  });
  const out = await contacts(api, { action: "search", query: "ada" });
  expect(calls).toEqual([["GET", "people:searchContacts", { query: { query: "ada", readMask: FIELDS, pageSize: 10 } }]]);
  expect(out).toBe(
    "1. Ada Lovelace — ada@example.com, ada@work.example — +44 20 7946 0000\n   id people/c1\n" +
      "2. Charles Babbage\n   id people/c2",
  );
});

test("search: no results warms the cache up with an empty query, then retries once", async () => {
  let searches = 0;
  const { api, calls } = fake({
    "GET people:searchContacts": (opts: { query: { query: string } }) => {
      if (opts.query.query === "") return {};
      searches++;
      return searches === 1 ? {} : { results: [{ person: ADA }] };
    },
  });
  const out = await contacts(api, { action: "search", query: "ada" });
  expect(calls).toEqual([
    ["GET", "people:searchContacts", { query: { query: "ada", readMask: FIELDS, pageSize: 10 } }],
    ["GET", "people:searchContacts", { query: { query: "", readMask: FIELDS, pageSize: 10 } }],
    ["GET", "people:searchContacts", { query: { query: "ada", readMask: FIELDS, pageSize: 10 } }],
  ]);
  expect(out).toContain("1. Ada Lovelace");
});

test("search: still nothing after the warm-up", async () => {
  const { api, calls } = fake({ "GET people:searchContacts": { results: [] } });
  expect(await contacts(api, { action: "search", query: "zed" })).toBe("No contacts.");
  expect(calls).toHaveLength(3);
});

test("search: needs query", async () => {
  const { api } = fake({});
  await expect(contacts(api, { action: "search" })).rejects.toThrow(new GoogleError("search needs query"));
});

test("read: every field present, for a bare id or a people/ id", async () => {
  for (const id of ["c1", "people/c1"]) {
    const { api, calls } = fake({ "GET people/c1": ADA });
    const out = await contacts(api, { action: "read", id });
    expect(calls).toEqual([["GET", "people/c1", { query: { personFields: FIELDS } }]]);
    expect(out).toBe(
      "Ada Lovelace\nid people/c1\nemails: ada@example.com, ada@work.example\nphones: +44 20 7946 0000\n" +
        "org: Analytical Engines, Programmer\norg: Royal Society\nnotes: Met at the salon.",
    );
  }
});

test("read: only the fields the person has; ids are encoded", async () => {
  const { api, calls } = fake({ "GET people/c%2F9": { resourceName: "people/c/9" } });
  expect(await contacts(api, { action: "read", id: "people/c/9" })).toBe("(no name)\nid people/c/9");
  expect(calls[0][1]).toBe("people/c%2F9");
});

test("read: needs id", async () => {
  const { api } = fake({});
  await expect(contacts(api, { action: "read" })).rejects.toThrow(new GoogleError("read needs id"));
});

test("create: the given fields as the People API's", async () => {
  const { api, calls } = fake({
    "POST people:createContact": { resourceName: "people/c7", names: [{ displayName: "Grace Hopper" }] },
  });
  const out = await contacts(api, {
    action: "create",
    name: "Grace Hopper",
    emails: ["grace@example.com"],
    phones: ["+1 555 0100", "+1 555 0101"],
    notes: "Navy.",
  });
  expect(calls).toEqual([
    [
      "POST",
      "people:createContact",
      {
        body: {
          names: [{ unstructuredName: "Grace Hopper" }],
          emailAddresses: [{ value: "grace@example.com" }],
          phoneNumbers: [{ value: "+1 555 0100" }, { value: "+1 555 0101" }],
          biographies: [{ value: "Navy.", contentType: "TEXT_PLAIN" }],
        },
      },
    ],
  ]);
  expect(out).toBe("Created Grace Hopper (id people/c7)");
});

test("create: a name alone; needs a name", async () => {
  const { api, calls } = fake({ "POST people:createContact": { resourceName: "people/c8" } });
  expect(await contacts(api, { action: "create", name: "Solo" })).toBe("Created Solo (id people/c8)");
  expect(calls[0][2]).toEqual({ body: { names: [{ unstructuredName: "Solo" }] } });
  await expect(contacts(api, { action: "create", emails: ["x@example.com"] })).rejects.toThrow(
    new GoogleError("create needs name"),
  );
});

test("update: reads the etag, then patches only the changed fields", async () => {
  const { api, calls } = fake({
    "GET people/c1": ADA,
    "PATCH people/c1:updateContact": {
      ...ADA,
      names: [{ displayName: "Ada King" }],
      emailAddresses: [{ value: "ada@king.example" }],
    },
  });
  const out = await contacts(api, {
    action: "update",
    id: "people/c1",
    name: "Ada King",
    emails: ["ada@king.example"],
  });
  expect(calls).toEqual([
    ["GET", "people/c1", { query: { personFields: FIELDS } }],
    [
      "PATCH",
      "people/c1:updateContact",
      {
        query: { updatePersonFields: "names,emailAddresses" },
        body: {
          etag: "%EgUBAj",
          names: [{ unstructuredName: "Ada King" }],
          emailAddresses: [{ value: "ada@king.example" }],
        },
      },
    ],
  ]);
  expect(out).toBe("Updated Ada King (id people/c1)");
});

test("update: phones and notes alone", async () => {
  const { api, calls } = fake({ "GET people/c1": ADA, "PATCH people/c1:updateContact": ADA });
  await contacts(api, { action: "update", id: "c1", phones: [], notes: "Poet's daughter." });
  expect(calls[1][2]).toEqual({
    query: { updatePersonFields: "phoneNumbers,biographies" },
    body: {
      etag: "%EgUBAj",
      phoneNumbers: [],
      biographies: [{ value: "Poet's daughter.", contentType: "TEXT_PLAIN" }],
    },
  });
});

test("update: needs id and a field to change", async () => {
  const { api, calls } = fake({});
  await expect(contacts(api, { action: "update", id: "c1" })).rejects.toThrow(
    new GoogleError("update needs id and a field to change"),
  );
  await expect(contacts(api, { action: "update", name: "x" })).rejects.toThrow(
    new GoogleError("update needs id and a field to change"),
  );
  expect(calls).toEqual([]);
});

test("update: a missing contact fails before the patch", async () => {
  const { api, calls } = fake({ "GET people/c404": new GoogleError("Not found: c404") });
  await expect(contacts(api, { action: "update", id: "c404", name: "x" })).rejects.toThrow("Not found: c404");
  expect(calls).toHaveLength(1);
});

test("contacts: unknown action", async () => {
  const { api } = fake({});
  await expect(contacts(api, { action: "nope" } as never)).rejects.toThrow(new GoogleError("Unknown action: nope"));
});

// tasks

test("tasks: the parameters are a portable schema with every action", () => {
  expect(schemaProblems(tasksParameters)).toEqual([]);
  expect(TASKS_ACTIONS).toEqual(["lists", "list", "add", "update", "delete"]);
  for (const action of TASKS_ACTIONS) expect(TASKS_DESCRIPTION).toContain(action);
});

test("lists: numbered task lists with ids", async () => {
  const { api, calls } = fake({
    "GET users/@me/lists": { items: [{ id: "L1", title: "My Tasks" }, { id: "L2", title: "Errands" }] },
  });
  expect(await tasks(api, { action: "lists" })).toBe("1. My Tasks\n   id L1\n2. Errands\n   id L2");
  expect(calls).toEqual([["GET", "users/@me/lists", undefined]]);
});

test("lists: none", async () => {
  const { api } = fake({ "GET users/@me/lists": {} });
  expect(await tasks(api, { action: "lists" })).toBe("No task lists.");
});

test("list: the default list's open tasks, done marks and due dates", async () => {
  const { api, calls } = fake({
    "GET lists/%40default/tasks": {
      items: [
        { id: "t1", title: "Buy milk", status: "needsAction", due: "2026-10-12T00:00:00.000Z" },
        { id: "t2", title: "File taxes", status: "completed" },
        { id: "t3", status: "needsAction" },
      ],
    },
  });
  const out = await tasks(api, { action: "list" });
  expect(calls).toEqual([
    ["GET", "lists/%40default/tasks", { query: { showCompleted: false, showHidden: false } }],
  ]);
  expect(out).toBe(
    "1. [ ] Buy milk due 2026-10-12\n   id t1\n2. [x] File taxes\n   id t2\n3. [ ] (no title)\n   id t3",
  );
});

test("list: another list, completed tasks shown", async () => {
  const { api, calls } = fake({ "GET lists/L%2F2/tasks": { items: [] } });
  expect(await tasks(api, { action: "list", list: "L/2", showCompleted: true })).toBe("No tasks.");
  expect(calls[0][2]).toEqual({ query: { showCompleted: true, showHidden: true } });
});

test("add: a date-only due becomes midnight UTC", async () => {
  const { api, calls } = fake({
    "POST lists/%40default/tasks": { id: "t9", title: "Call mum", due: "2026-10-12T00:00:00.000Z" },
  });
  const out = await tasks(api, { action: "add", title: "Call mum", notes: "Sunday", due: "2026-10-12" });
  expect(calls).toEqual([
    [
      "POST",
      "lists/%40default/tasks",
      { body: { title: "Call mum", notes: "Sunday", due: "2026-10-12T00:00:00.000Z" } },
    ],
  ]);
  expect(out).toBe("Added Call mum (id t9)");
});

test("add: a full timestamp passes through, to a given list; needs title", async () => {
  const { api, calls } = fake({ "POST lists/L2/tasks": { id: "t10", title: "Ship" } });
  await tasks(api, { action: "add", title: "Ship", due: "2026-10-12T09:30:00+02:00", list: "L2" });
  expect(calls[0][2]).toEqual({ body: { title: "Ship", due: "2026-10-12T09:30:00+02:00" } });
  await expect(tasks(api, { action: "add", notes: "x" })).rejects.toThrow(new GoogleError("add needs title"));
});

test("update: done marks the task completed", async () => {
  const { api, calls } = fake({
    "PATCH lists/%40default/tasks/t1": { id: "t1", title: "Buy milk", status: "completed" },
  });
  expect(await tasks(api, { action: "update", id: "t1", done: true })).toBe("Updated Buy milk (id t1)");
  expect(calls).toEqual([["PATCH", "lists/%40default/tasks/t1", { body: { status: "completed" } }]]);
});

test("update: not done reopens it and clears the completion time, with other fields", async () => {
  const { api, calls } = fake({ "PATCH lists/L2/tasks/t%231": { id: "t#1", title: "Renamed" } });
  const out = await tasks(api, {
    action: "update",
    id: "t#1",
    list: "L2",
    title: "Renamed",
    notes: "n",
    due: "2026-11-01",
    done: false,
  });
  expect(calls[0][2]).toEqual({
    body: { title: "Renamed", notes: "n", due: "2026-11-01T00:00:00.000Z", status: "needsAction", completed: null },
  });
  expect(out).toBe("Updated Renamed (id t#1)");
});

test("update: needs id and a field to change", async () => {
  const { api, calls } = fake({});
  await expect(tasks(api, { action: "update", id: "t1" })).rejects.toThrow(
    new GoogleError("update needs id and a field to change"),
  );
  await expect(tasks(api, { action: "update", done: true })).rejects.toThrow(
    new GoogleError("update needs id and a field to change"),
  );
  expect(calls).toEqual([]);
});

test("delete: removes the task; needs id", async () => {
  const { api, calls } = fake({ "DELETE lists/L2/tasks/t1": undefined });
  expect(await tasks(api, { action: "delete", id: "t1", list: "L2" })).toBe("Deleted t1.");
  expect(calls).toEqual([["DELETE", "lists/L2/tasks/t1", undefined]]);
  await expect(tasks(api, { action: "delete" })).rejects.toThrow(new GoogleError("delete needs id"));
});

test("tasks: unknown action", async () => {
  const { api } = fake({});
  await expect(tasks(api, { action: "nope" } as never)).rejects.toThrow(new GoogleError("Unknown action: nope"));
});
