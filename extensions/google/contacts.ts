// The `contacts` tool: searching, reading, creating and changing the user's Google Contacts through the People API
// (spec §4.4).
import { StringEnum, type Static } from "@earendil-works/pi-ai";
import { Type } from "../../src/sdk.ts";
import { type Api, GoogleError } from "./api.ts";

const BASE = "https://people.googleapis.com/v1";
const FIELDS = "names,emailAddresses,phoneNumbers,organizations,biographies";

export const CONTACTS_ACTIONS = ["search", "read", "create", "update"] as const;

export const contactsParameters = Type.Object({
  action: StringEnum(CONTACTS_ACTIONS),
  query: Type.Optional(Type.String({ description: "name, email or phone to look for" })),
  id: Type.Optional(Type.String({ description: "contact id (people/…)" })),
  name: Type.Optional(Type.String({ description: "full name" })),
  emails: Type.Optional(Type.Array(Type.String(), { description: "email addresses" })),
  phones: Type.Optional(Type.Array(Type.String(), { description: "phone numbers" })),
  notes: Type.Optional(Type.String()),
});

export type ContactsArgs = Static<typeof contactsParameters>;

export const CONTACTS_DESCRIPTION = [
  "The user's Google Contacts. Actions:",
  "search { query } — matching contacts with their emails, phones and ids",
  "read { id } — a contact's names, emails, phones, organizations and notes",
  "create { name, emails?, phones?, notes? }",
  "update { id, name?, emails?, phones?, notes? } — only the given fields change; emails and phones replace the lists",
  "Contact ids (people/…) come from earlier search results.",
].join("\n");

type Person = {
  resourceName?: string;
  etag?: string;
  names?: { displayName?: string; unstructuredName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
  organizations?: { name?: string; title?: string }[];
  biographies?: { value?: string }[];
};

/** The bare id of `people/<id>` or `<id>`. */
const bare = (id: string) => id.replace(/^people\//, "");

const person = (id: string) => `${BASE}/people/${encodeURIComponent(bare(id))}`;

const nameOf = (p: Person) => p.names?.[0]?.displayName || p.names?.[0]?.unstructuredName || "(no name)";

const values = (list?: { value?: string }[]) => (list ?? []).map((v) => v.value).filter(Boolean).join(", ");

/** "<name> (id people/<id>)". */
const named = (p: Person, id: string) => `${nameOf(p)} (id ${p.resourceName ?? `people/${bare(id)}`})`;

async function search(api: Api, args: ContactsArgs): Promise<string> {
  if (!args.query) throw new GoogleError("search needs query");
  const find = (query: string) =>
    api.json<{ results?: { person: Person }[] }>("GET", `${BASE}/people:searchContacts`, {
      query: { query, readMask: FIELDS, pageSize: 10 },
    });
  let found = await find(args.query);
  // Search reads a cache Google fills on demand: an empty query warms it up, then the search is worth one retry.
  if ((found?.results ?? []).length === 0) {
    await find("");
    found = await find(args.query);
  }
  const results = found?.results ?? [];
  if (results.length === 0) return "No contacts.";
  return results
    .map(({ person: p }, i) => {
      const line = [nameOf(p), values(p.emailAddresses), values(p.phoneNumbers)].filter(Boolean).join(" — ");
      return `${i + 1}. ${line}\n   id ${p.resourceName}`;
    })
    .join("\n");
}

async function read(api: Api, args: ContactsArgs): Promise<string> {
  if (!args.id) throw new GoogleError("read needs id");
  const p = await api.json<Person>("GET", person(args.id), { query: { personFields: FIELDS } });
  const lines = [nameOf(p), `id ${p.resourceName ?? `people/${bare(args.id)}`}`];
  const emails = values(p.emailAddresses);
  if (emails) lines.push(`emails: ${emails}`);
  const phones = values(p.phoneNumbers);
  if (phones) lines.push(`phones: ${phones}`);
  for (const org of p.organizations ?? []) {
    const what = [org.name, org.title].filter(Boolean).join(", ");
    if (what) lines.push(`org: ${what}`);
  }
  for (const bio of p.biographies ?? []) if (bio.value) lines.push(`notes: ${bio.value}`);
  return lines.join("\n");
}

/** The person fields the caller gave, as the API's body. */
function fields(args: ContactsArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.name !== undefined) body.names = [{ unstructuredName: args.name }];
  if (args.emails !== undefined) body.emailAddresses = args.emails.map((value) => ({ value }));
  if (args.phones !== undefined) body.phoneNumbers = args.phones.map((value) => ({ value }));
  if (args.notes !== undefined) body.biographies = [{ value: args.notes, contentType: "TEXT_PLAIN" }];
  return body;
}

async function create(api: Api, args: ContactsArgs): Promise<string> {
  if (!args.name) throw new GoogleError("create needs name");
  const made = await api.json<Person>("POST", `${BASE}/people:createContact`, { body: fields(args) });
  return `Created ${made?.names?.[0]?.displayName || args.name} (id ${made?.resourceName})`;
}

async function update(api: Api, args: ContactsArgs): Promise<string> {
  const body = fields(args);
  if (!args.id || Object.keys(body).length === 0) throw new GoogleError("update needs id and a field to change");
  // The People API refuses an update without the contact's current etag.
  const current = await api.json<Person>("GET", person(args.id), { query: { personFields: FIELDS } });
  const changed = await api.json<Person>("PATCH", `${person(args.id)}:updateContact`, {
    query: { updatePersonFields: Object.keys(body).join(",") },
    body: { etag: current?.etag, ...body },
  });
  return `Updated ${named(changed ?? {}, args.id)}`;
}

/** Runs one contacts action; throws GoogleError with the reply for a request it can't make. */
export async function contacts(api: Api, args: ContactsArgs): Promise<string> {
  switch (args.action) {
    case "search":
      return search(api, args);
    case "read":
      return read(api, args);
    case "create":
      return create(api, args);
    case "update":
      return update(api, args);
    default:
      throw new GoogleError(`Unknown action: ${String(args.action)}`);
  }
}
