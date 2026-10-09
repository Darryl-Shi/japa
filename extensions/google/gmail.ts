// The `gmail` tool: search, read threads as text, send and draft (replies threaded), labels, and attachments saved
// to files (spec §4.4).
import { StringEnum, type Static } from "@earendil-works/pi-ai";
import { Type } from "../../src/sdk.ts";
import { htmlToText } from "../web/html.ts";
import { type Api, GoogleError } from "./api.ts";
import { readUpload, saveFile } from "./files.ts";
import { buildMessage, type Mail } from "./mime.ts";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Send and draft go through the media upload endpoints: a JSON `raw` is capped near 1 MB, attachments included. */
const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me";

/** How many messages' metadata search fetches at once. */
const BATCH = 10;

export const GMAIL_ACTIONS = ["search", "read", "send", "draft", "modify", "labels", "attachment"] as const;

export const gmailParameters = Type.Object({
  action: StringEnum(GMAIL_ACTIONS),
  query: Type.Optional(Type.String({ description: "Gmail search syntax" })),
  max: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "results (default 10)" })),
  id: Type.Optional(Type.String({ description: "thread or message id" })),
  to: Type.Optional(Type.String({ description: "comma-separated addresses" })),
  cc: Type.Optional(Type.String()),
  bcc: Type.Optional(Type.String()),
  subject: Type.Optional(Type.String()),
  body: Type.Optional(Type.String({ description: "plain text" })),
  attachments: Type.Optional(Type.Array(Type.String(), { description: "file paths on the japa host" })),
  replyTo: Type.Optional(Type.String({ description: "id of the message being answered" })),
  ids: Type.Optional(Type.Array(Type.String(), { description: "message ids" })),
  add: Type.Optional(Type.Array(Type.String(), { description: "label names or ids" })),
  remove: Type.Optional(Type.Array(Type.String(), { description: "label names or ids" })),
  messageId: Type.Optional(Type.String()),
  attachmentId: Type.Optional(Type.String()),
});

export type GmailArgs = Static<typeof gmailParameters>;

export const GMAIL_DESCRIPTION = [
  "The user's Gmail. Actions:",
  "search { query, max? = 10 } — Gmail search syntax (from:, subject:, newer_than:2d, is:unread…); " +
    "message and thread ids",
  "read { id } — a whole thread as text (a thread id, or any message id in it)",
  "send { to, cc?, bcc?, subject, body, attachments?, replyTo? } — attachments are file paths on the japa host; " +
    "replyTo (a message id) threads the reply",
  "draft { …as send } — saves a draft instead of sending",
  "modify { ids, add?, remove? } — label names or ids; archive = remove INBOX, read = remove UNREAD, TRASH to trash",
  "labels — every label's name and id",
  "attachment { messageId, attachmentId } — saves an attachment to a file and returns its path",
  "Ids come from earlier search and read results.",
].join("\n");

type Header = { name: string; value: string };
type Part = {
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: Part[];
};
type Message = { id: string; threadId?: string; snippet?: string; payload?: Part };

const path = (...segments: string[]) => `${BASE}/${segments.map(encodeURIComponent).join("/")}`;

const header = (headers: Header[] | undefined, name: string) =>
  headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

/** A part and every part nested in it, depth first. */
const walk = (part: Part | undefined): Part[] => (part ? [part, ...(part.parts ?? []).flatMap(walk)] : []);

/** A part's data as text, in the charset its Content-Type declares (UTF-8 when none or unknown). */
function decode(part: Part): string {
  const data = Buffer.from(part.body?.data ?? "", "base64url");
  const charset = /charset="?([^";\s]+)/i.exec(header(part.headers, "Content-Type") ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(data);
  } catch {
    return data.toString("utf8");
  }
}

/** htmlToText runs everything onto one line: line breaks and block ends become newlines first. */
const htmlBody = (html: string) =>
  htmlToText(html.replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "$&\n"));

const typeOf = (part: Part) => part.mimeType?.toLowerCase() ?? "";

/**
 * The inline text parts to show, in order: within each multipart/alternative one alternative (text/plain preferred,
 * else the first with text), elsewhere every one (a mailing list's plain footer after an HTML body, say).
 */
function textParts(part: Part | undefined): Part[] {
  if (!part) return [];
  const type = typeOf(part);
  if (type === "multipart/alternative") {
    const options = (part.parts ?? []).map(textParts).filter((parts) => parts.length > 0);
    const isPlain = (p: Part) => typeOf(p) === "text/plain";
    const chosen = options.find((parts) => parts.every(isPlain)) ?? options.find((parts) => parts.some(isPlain));
    return chosen ?? options[0] ?? [];
  }
  if (type.startsWith("multipart/")) return (part.parts ?? []).flatMap(textParts);
  const text = type === "text/plain" || type === "text/html";
  return text && !part.filename && part.body?.data ? [part] : [];
}

/** The message's text: its inline text parts, HTML converted to text (attachments aside). */
function bodyText(payload: Part | undefined): string {
  const text = textParts(payload)
    .map((part) => (typeOf(part) === "text/html" ? htmlBody(decode(part)) : decode(part)).trim())
    .filter(Boolean)
    .join("\n\n");
  return text || "(no text)";
}

const attachmentsOf = (payload: Part | undefined) =>
  walk(payload).filter((part) => part.filename && part.body?.attachmentId);

function messageText(message: Message): string {
  const headers = message.payload?.headers;
  const lines = ["From", "To", "Cc", "Date", "Subject"].flatMap((name) => {
    const value = header(headers, name);
    return value === undefined ? [] : [`${name}: ${value}`];
  });
  lines.push(`id ${message.id}`, "", bodyText(message.payload));
  const files = attachmentsOf(message.payload);
  if (files.length > 0) {
    const list = files.map((f) => `${f.filename} (${f.body!.attachmentId}, ${f.body!.size ?? 0} bytes)`);
    lines.push("", `Attachments: ${list.join(", ")}`);
  }
  return lines.join("\n");
}

async function search(api: Api, args: GmailArgs): Promise<string> {
  if (!args.query) throw new GoogleError("search needs query");
  const found = await api.json<{ messages?: { id: string }[] }>("GET", path("messages"), {
    query: { q: args.query, maxResults: args.max ?? 10 },
  });
  const ids = (found?.messages ?? []).map((m) => m.id);
  if (ids.length === 0) return "No messages.";
  const metadata = (id: string) =>
    api.json<Message>("GET", path("messages", id), {
      query: { format: "metadata", metadataHeaders: ["From", "Subject", "Date"] },
    });
  // A few at a time: up to 100 requests at once would run into Gmail's per-user rate limit.
  const messages: Message[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    messages.push(...(await Promise.all(ids.slice(i, i + BATCH).map(metadata))));
  }
  return messages
    .map((m, i) => {
      const h = m.payload?.headers;
      const subject = header(h, "Subject") || "(no subject)";
      const snippet = htmlToText(m.snippet ?? "");
      const line = `${i + 1}. ${subject} — ${header(h, "From") ?? ""} — ${header(h, "Date") ?? ""}`;
      return `${line}\n   ${snippet}\n   id ${m.id} thread ${m.threadId}`;
    })
    .join("\n");
}

async function read(api: Api, id: string | undefined): Promise<string> {
  if (!id) throw new GoogleError("read needs id");
  const thread = (threadId: string) =>
    api.json<{ messages?: Message[] }>("GET", path("threads", threadId), { query: { format: "full" } });
  let found;
  try {
    found = await thread(id);
  } catch (error) {
    // Not a thread id: a message id, then, read as its whole thread.
    if (!(error instanceof GoogleError && error.message.startsWith("Not found"))) throw error;
    const message = await api.json<Message>("GET", path("messages", id), { query: { format: "minimal" } });
    found = await thread(message.threadId ?? id);
  }
  return (found?.messages ?? []).map(messageText).join("\n\n---\n\n");
}

async function compose(api: Api, args: GmailArgs, action: "send" | "draft"): Promise<string> {
  const { to, subject, body } = args;
  if (!to || !subject || !body) throw new GoogleError(`${action} needs to, subject and body`);
  const attachments = (args.attachments ?? []).map(readUpload);
  const mail: Mail = { to, cc: args.cc, bcc: args.bcc, subject, body, attachments };
  let threadId: string | undefined;
  if (args.replyTo) {
    const original = await api.json<Message>("GET", path("messages", args.replyTo), {
      query: { format: "metadata", metadataHeaders: ["Message-ID", "References", "Subject"] },
    });
    const h = original.payload?.headers;
    const messageId = header(h, "Message-ID");
    const references = [header(h, "References"), messageId].filter(Boolean).join(" ");
    const was = header(h, "Subject") || subject;
    threadId = original.threadId;
    mail.inReplyTo = messageId;
    mail.references = references || undefined;
    if (!/^\s*re:/i.test(subject)) mail.subject = /^\s*re:/i.test(was) ? was : `Re: ${was}`;
  }
  const raw = Buffer.from(buildMessage(mail));
  if (action === "send") {
    const metadata = threadId ? { threadId } : {};
    const sent = await api.upload(`${UPLOAD}/messages/send`, metadata, raw, "message/rfc822");
    return `Sent (id ${sent.id}).`;
  }
  const metadata = threadId ? { message: { threadId } } : {};
  const draft = await api.upload(`${UPLOAD}/drafts`, metadata, raw, "message/rfc822");
  return `Draft saved (id ${draft.id}).`;
}

async function modify(api: Api, args: GmailArgs): Promise<string> {
  const ids = args.ids ?? [];
  const add = args.add ?? [];
  const remove = args.remove ?? [];
  if (ids.length === 0 || add.length + remove.length === 0) throw new GoogleError("modify needs ids and add or remove");
  const { labels = [] } = (await api.json<{ labels?: { id: string; name: string }[] }>("GET", path("labels"))) ?? {};
  // Every label resolved before anything changes, so an unknown one leaves the messages as they were.
  const resolve = (wanted: string) => {
    const lower = wanted.toLowerCase();
    const label = labels.find((l) => l.id.toLowerCase() === lower || l.name.toLowerCase() === lower);
    if (!label) throw new GoogleError(`Unknown label: ${wanted}`);
    return label.id;
  };
  const addIds = add.map(resolve);
  const removeIds = remove.map(resolve);
  // Adding TRASH by label isn't allowed: trashing has its own endpoint.
  const trash = addIds.includes("TRASH");
  if (trash) for (const id of ids) await api.json("POST", path("messages", id, "trash"));
  const rest = addIds.filter((id) => id !== "TRASH");
  if (rest.length + removeIds.length > 0) {
    await api.json("POST", path("messages", "batchModify"), {
      body: { ids, addLabelIds: rest, removeLabelIds: removeIds },
    });
  }
  return `Updated ${ids.length} message(s).`;
}

async function labels(api: Api): Promise<string> {
  const found = await api.json<{ labels?: { id: string; name: string }[] }>("GET", path("labels"));
  const list = found?.labels ?? [];
  return list.length === 0 ? "No labels." : list.map((l) => `${l.name} (${l.id})`).join("\n");
}

async function attachment(api: Api, home: string, args: GmailArgs): Promise<string> {
  const { messageId, attachmentId } = args;
  if (!messageId || !attachmentId) throw new GoogleError("attachment needs messageId and attachmentId");
  const message = await api.json<Message>("GET", path("messages", messageId), { query: { format: "full" } });
  // Gmail may give the same attachment a new id each time it returns the message: then a lone attachment's name.
  const files = attachmentsOf(message?.payload);
  const part = files.find((f) => f.body?.attachmentId === attachmentId) ?? (files.length === 1 ? files[0] : undefined);
  const got = await api.json<{ data?: string }>("GET", path("messages", messageId, "attachments", attachmentId));
  const saved = saveFile(home, part?.filename || "attachment", Buffer.from(got?.data ?? "", "base64url"));
  return `Saved to ${saved}`;
}

/** Runs one gmail action; throws GoogleError with the reply for a request it can't make. */
export async function gmail(api: Api, home: string, args: GmailArgs): Promise<string> {
  switch (args.action) {
    case "search":
      return search(api, args);
    case "read":
      return read(api, args.id);
    case "send":
    case "draft":
      return compose(api, args, args.action);
    case "modify":
      return modify(api, args);
    case "labels":
      return labels(api);
    case "attachment":
      return attachment(api, home, args);
    default:
      throw new GoogleError(`Unknown action: ${String(args.action)}`);
  }
}
