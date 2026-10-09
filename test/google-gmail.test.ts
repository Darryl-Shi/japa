import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type Api, GoogleError } from "../extensions/google/api.ts";
import { GMAIL_ACTIONS, GMAIL_DESCRIPTION, gmail, gmailParameters } from "../extensions/google/gmail.ts";
import { schemaProblems } from "../src/kernel/tool-schema.ts";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me";

type Call = [string, string, unknown];
type Route = unknown | ((opts: any) => unknown);

/**
 * An Api whose `json` answers from `routes`, keyed "METHOD path" (relative to the Gmail base), and whose `upload`
 * answers from "UPLOAD path" (relative to the upload base); it records calls.
 */
function fake(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const api = {
    json: async (method: string, url: string, opts?: unknown) => {
      calls.push([method, url.replace(BASE + "/", ""), opts]);
      const key = `${method} ${url.replace(BASE + "/", "")}`;
      if (!(key in routes)) throw new Error(`unexpected request: ${key}`);
      const route = routes[key];
      if (route instanceof Error) throw route;
      return typeof route === "function" ? route(opts) : route;
    },
    bytes: async () => {
      throw new Error("unexpected bytes");
    },
    upload: async (url: string, metadata: object, data: Buffer, type: string, query?: unknown) => {
      const path = url.replace(UPLOAD + "/", "");
      calls.push(["UPLOAD", path, { metadata, data, type, query }]);
      const key = `UPLOAD ${path}`;
      if (!(key in routes)) throw new Error(`unexpected upload: ${key}`);
      const route = routes[key];
      return typeof route === "function" ? route(metadata) : route;
    },
    raw: async () => {
      throw new Error("unexpected raw");
    },
  } as unknown as Api;
  return { api, calls };
}

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const header = (name: string, value: string) => ({ name, value });
const home = () => mkdtempSync(join(tmpdir(), "japa-gmail-"));

type Upload = { metadata: object; data: Buffer; type: string; query?: unknown };

/** The header block of an uploaded RFC 2822 message and its body. */
const decodeRaw = (data: Buffer) => {
  const text = data.toString("utf8");
  const at = text.indexOf("\r\n\r\n");
  return { head: text.slice(0, at).split("\r\n"), body: text.slice(at + 4) };
};

test("the parameters are a portable schema with every action", () => {
  expect(schemaProblems(gmailParameters)).toEqual([]);
  expect(GMAIL_ACTIONS).toEqual(["search", "read", "send", "draft", "modify", "labels", "attachment"]);
  for (const action of GMAIL_ACTIONS) expect(GMAIL_DESCRIPTION).toContain(action);
});

test("search lists each message's subject, sender, date, snippet and ids", async () => {
  const meta = (id: string, threadId: string, subject: string, from: string, date: string, snippet: string) => ({
    id,
    threadId,
    snippet,
    payload: { headers: [header("Subject", subject), header("From", from), header("Date", date)] },
  });
  const { api, calls } = fake({
    "GET messages": { messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }] },
    "GET messages/m1": meta("m1", "t1", "Lunch", "Ann <ann@x.com>", "Mon, 6 Oct 2026 10:00:00 +0000", "See you"),
    "GET messages/m2": meta("m2", "t2", "Invoice", "Bob <bob@y.com>", "Tue, 7 Oct 2026 09:00:00 +0000", "It&#39;s due"),
  });
  const out = await gmail(api, home(), { action: "search", query: "from:ann", max: 5 });
  expect(calls[0]).toEqual(["GET", "messages", { query: { q: "from:ann", maxResults: 5 } }]);
  const metadata = { query: { format: "metadata", metadataHeaders: ["From", "Subject", "Date"] } };
  expect(calls.slice(1)).toEqual([
    ["GET", "messages/m1", metadata],
    ["GET", "messages/m2", metadata],
  ]);
  expect(out).toBe(
    "1. Lunch — Ann <ann@x.com> — Mon, 6 Oct 2026 10:00:00 +0000\n   See you\n   id m1 thread t1\n" +
      "2. Invoice — Bob <bob@y.com> — Tue, 7 Oct 2026 09:00:00 +0000\n   It's due\n   id m2 thread t2",
  );
});

test("search fetches metadata 10 at a time, in order", async () => {
  const ids = Array.from({ length: 25 }, (_, i) => `m${i + 1}`);
  let running = 0;
  let most = 0;
  const routes: Record<string, Route> = { "GET messages": { messages: ids.map((id) => ({ id, threadId: "t" })) } };
  for (const [i, id] of ids.entries()) {
    routes[`GET messages/${id}`] = async () => {
      most = Math.max(most, ++running);
      // Later ones answer first: the order must come from the ids, not the replies.
      await new Promise((resolve) => setTimeout(resolve, 25 - i));
      running--;
      return { id, threadId: "t", payload: { headers: [header("Subject", `S${i + 1}`)] } };
    };
  }
  const { api } = fake(routes);
  const out = await gmail(api, home(), { action: "search", query: "x", max: 25 });
  expect(most).toBe(10);
  expect(out.split("\n").filter((line) => /^\d+\./.test(line))).toEqual(ids.map((_, i) => `${i + 1}. S${i + 1} —  — `));
});

test("search defaults to 10 results and says when there are none", async () => {
  const { api, calls } = fake({ "GET messages": { resultSizeEstimate: 0 } });
  expect(await gmail(api, home(), { action: "search", query: "nothing" })).toBe("No messages.");
  expect(calls).toEqual([["GET", "messages", { query: { q: "nothing", maxResults: 10 } }]]);
});

test("search needs a query", async () => {
  const { api } = fake({});
  await expect(gmail(api, home(), { action: "search" })).rejects.toThrow(new GoogleError("search needs query"));
});

const message = (id: string, payload: object) => ({ id, threadId: "t1", payload });
const headers = (from: string, subject: string) => [
  header("From", from),
  header("To", "me@x.com"),
  header("Date", "Mon, 6 Oct 2026 10:00:00 +0000"),
  header("Subject", subject),
];

test("read shows a thread: headers, the plain-text body and attachments", async () => {
  const { api, calls } = fake({
    "GET threads/t1": {
      id: "t1",
      messages: [
        message("m1", {
          mimeType: "text/plain",
          headers: [...headers("Ann <ann@x.com>", "Lunch"), header("Cc", "bob@y.com")],
          body: { size: 5, data: b64u("Noon?") },
        }),
        message("m2", {
          mimeType: "multipart/mixed",
          headers: headers("me@x.com", "Re: Lunch"),
          parts: [
            { mimeType: "text/plain", filename: "", body: { size: 6, data: b64u("Sure.\n") } },
            { mimeType: "application/pdf", filename: "menu.pdf", body: { size: 1234, attachmentId: "A1" } },
            { mimeType: "image/png", filename: "map.png", body: { size: 99, attachmentId: "A2" } },
          ],
        }),
      ],
    },
  });
  const out = await gmail(api, home(), { action: "read", id: "t1" });
  expect(calls).toEqual([["GET", "threads/t1", { query: { format: "full" } }]]);
  expect(out).toBe(
    [
      "From: Ann <ann@x.com>",
      "To: me@x.com",
      "Cc: bob@y.com",
      "Date: Mon, 6 Oct 2026 10:00:00 +0000",
      "Subject: Lunch",
      "id m1",
      "",
      "Noon?",
      "",
      "---",
      "",
      "From: me@x.com",
      "To: me@x.com",
      "Date: Mon, 6 Oct 2026 10:00:00 +0000",
      "Subject: Re: Lunch",
      "id m2",
      "",
      "Sure.",
      "",
      "Attachments: menu.pdf (A1, 1234 bytes), map.png (A2, 99 bytes)",
    ].join("\n"),
  );
});

test("read takes a message id: a 404 for the thread looks up the message's thread", async () => {
  const { api, calls } = fake({
    "GET threads/m9": new GoogleError("Not found: m9"),
    "GET messages/m9": { id: "m9", threadId: "t9" },
    "GET threads/t9": {
      id: "t9",
      messages: [
        message("m9", { mimeType: "text/plain", headers: headers("a@x.com", "Hi"), body: { data: b64u("Hello") } }),
      ],
    },
  });
  const out = await gmail(api, home(), { action: "read", id: "m9" });
  expect(calls).toEqual([
    ["GET", "threads/m9", { query: { format: "full" } }],
    ["GET", "messages/m9", { query: { format: "minimal" } }],
    ["GET", "threads/t9", { query: { format: "full" } }],
  ]);
  expect(out).toContain("id m9\n\nHello");
});

test("read: other failures are not swallowed", async () => {
  const { api } = fake({ "GET threads/t1": new GoogleError("Google replied HTTP 400: bad") });
  await expect(gmail(api, home(), { action: "read", id: "t1" })).rejects.toThrow("Google replied HTTP 400: bad");
});

test("read walks nested multipart/alternative inside multipart/mixed and prefers text/plain", async () => {
  const { api } = fake({
    "GET threads/t1": {
      messages: [
        message("m1", {
          mimeType: "multipart/mixed",
          headers: headers("a@x.com", "Nested"),
          parts: [
            {
              mimeType: "multipart/alternative",
              filename: "",
              body: { size: 0 },
              parts: [
                { mimeType: "text/html", filename: "", body: { data: b64u("<p>HTML version</p>") } },
                { mimeType: "text/plain", filename: "", body: { data: b64u("Plain version") } },
              ],
            },
            { mimeType: "text/plain", filename: "notes.txt", body: { size: 3, attachmentId: "A1" } },
          ],
        }),
      ],
    },
  });
  const out = await gmail(api, home(), { action: "read", id: "t1" });
  expect(out).toContain("id m1\n\nPlain version\n\nAttachments: notes.txt (A1, 3 bytes)");
  expect(out).not.toContain("HTML version");
});

test("read shows every inline text part outside alternatives: HTML body and mailing-list plain footer", async () => {
  const { api } = fake({
    "GET threads/t1": {
      messages: [
        message("m1", {
          mimeType: "multipart/mixed",
          headers: headers("list@x.com", "Digest"),
          parts: [
            { mimeType: "text/html", filename: "", body: { data: b64u("<p>Big news</p>") } },
            { mimeType: "text/plain", filename: "", body: { data: b64u("--\nUnsubscribe: https://x/u\n") } },
          ],
        }),
      ],
    },
  });
  expect(await gmail(api, home(), { action: "read", id: "t1" })).toContain(
    "id m1\n\nBig news\n\n--\nUnsubscribe: https://x/u",
  );
});

test("read chooses one alternative per multipart/alternative group: plain where there is one", async () => {
  const alternative = (plain: string | undefined, html: string) => ({
    mimeType: "multipart/alternative",
    parts: [
      ...(plain === undefined ? [] : [{ mimeType: "text/plain", body: { data: b64u(plain) } }]),
      {
        mimeType: "multipart/related",
        parts: [
          { mimeType: "text/html", body: { data: b64u(html) } },
          { mimeType: "image/png", filename: "logo.png", body: { size: 1, attachmentId: "A1" } },
        ],
      },
    ],
  });
  const { api } = fake({
    "GET threads/t1": {
      messages: [
        message("m1", {
          mimeType: "multipart/mixed",
          headers: headers("a@x.com", "Two"),
          parts: [alternative("First plain", "<p>First HTML</p>"), alternative(undefined, "<p>Second HTML</p>")],
        }),
      ],
    },
  });
  const out = await gmail(api, home(), { action: "read", id: "t1" });
  expect(out).toContain("id m1\n\nFirst plain\n\nSecond HTML\n\nAttachments: logo.png");
  expect(out).not.toContain("First HTML");
});

test("read converts an HTML-only body to text", async () => {
  const { api } = fake({
    "GET threads/t1": {
      messages: [
        message("m1", {
          mimeType: "multipart/mixed",
          headers: headers("a@x.com", "HTML"),
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [
                {
                  mimeType: "text/html",
                  body: { data: b64u("<html><style>p{}</style><p>Hello &amp; welcome</p>\n<p>Bye</p></html>") },
                },
              ],
            },
          ],
        }),
      ],
    },
  });
  const out = await gmail(api, home(), { action: "read", id: "t1" });
  expect(out).toContain("id m1\n\nHello & welcome\nBye");
});

test("read keeps an HTML body's paragraphs and line breaks on their own lines", async () => {
  const { api } = fake({
    "GET threads/t1": {
      messages: [
        message("m1", {
          mimeType: "text/html",
          headers: headers("a@x.com", "Blocks"),
          body: { data: b64u("<div>One</div><div>Two<br>Three</div><p>Four</p>") },
        }),
      ],
    },
  });
  expect(await gmail(api, home(), { action: "read", id: "t1" })).toContain("id m1\n\nOne\nTwo\nThree\nFour");
});

test("read decodes a body in its declared charset", async () => {
  const { api } = fake({
    "GET threads/t1": {
      messages: [
        message("m1", {
          mimeType: "text/plain",
          headers: [...headers("a@x.com", "Latin"), header("Content-Type", "text/plain; charset=ISO-8859-1")],
          body: { data: b64u(Buffer.from([0x63, 0x61, 0x66, 0xe9])) },
        }),
      ],
    },
  });
  expect(await gmail(api, home(), { action: "read", id: "t1" })).toContain("id m1\n\ncafé");
});

test("read needs an id", async () => {
  const { api } = fake({});
  await expect(gmail(api, home(), { action: "read" })).rejects.toThrow(new GoogleError("read needs id"));
});

test("send builds the message with cc, bcc and attachments, and sends it", async () => {
  const dir = home();
  const file = join(dir, "notes.txt");
  writeFileSync(file, "hello");
  const { api, calls } = fake({ "UPLOAD messages/send": { id: "s1", threadId: "t5" } });
  const out = await gmail(api, dir, {
    action: "send",
    to: "a@x.com, b@y.com",
    cc: "c@z.com",
    bcc: "d@w.com",
    subject: "Notes",
    body: "Attached.",
    attachments: [file],
  });
  expect(out).toBe("Sent (id s1).");
  expect(calls).toHaveLength(1);
  const [method, path, opts] = calls[0]!;
  expect([method, path]).toEqual(["UPLOAD", "messages/send"]);
  const upload = opts as Upload;
  expect(upload.metadata).toEqual({});
  expect(upload.type).toBe("message/rfc822");
  expect(upload.query).toBeUndefined();
  const { head } = decodeRaw(upload.data);
  expect(head).toContain("To: a@x.com, b@y.com");
  expect(head).toContain("Cc: c@z.com");
  expect(head).toContain("Bcc: d@w.com");
  expect(head).toContain("Subject: Notes");
  const text = upload.data.toString("utf8");
  expect(text).toContain('filename="notes.txt"');
  expect(text).toContain(Buffer.from("hello").toString("base64"));
});

test("send with replyTo threads the reply: In-Reply-To, References, Re: subject and threadId", async () => {
  const { api, calls } = fake({
    "GET messages/m1": {
      id: "m1",
      threadId: "t1",
      payload: {
        headers: [
          header("Subject", "Lunch"),
          header("Message-Id", "<orig@mail.x.com>"),
          header("References", "<first@mail.x.com>"),
        ],
      },
    },
    "UPLOAD messages/send": { id: "s2" },
  });
  const args = { to: "ann@x.com", subject: "lunch", body: "Yes!", replyTo: "m1" };
  const out = await gmail(api, home(), { action: "send", ...args });
  expect(out).toBe("Sent (id s2).");
  expect(calls[0]).toEqual([
    "GET",
    "messages/m1",
    { query: { format: "metadata", metadataHeaders: ["Message-ID", "References", "Subject"] } },
  ]);
  expect(calls[1]!.slice(0, 2)).toEqual(["UPLOAD", "messages/send"]);
  const upload = calls[1]![2] as Upload;
  expect(upload.metadata).toEqual({ threadId: "t1" });
  expect(upload.type).toBe("message/rfc822");
  const { head } = decodeRaw(upload.data);
  expect(head).toContain("Subject: Re: Lunch");
  expect(head).toContain("In-Reply-To: <orig@mail.x.com>");
  expect(head).toContain("References: <first@mail.x.com> <orig@mail.x.com>");
});

test("a reply whose subject already starts with re: keeps it", async () => {
  const { api, calls } = fake({
    "GET messages/m1": {
      id: "m1",
      threadId: "t1",
      payload: { headers: [header("Subject", "Lunch"), header("Message-ID", "<o@x>")] },
    },
    "UPLOAD messages/send": { id: "s3" },
  });
  await gmail(api, home(), { action: "send", to: "a@x.com", subject: "RE: lunch plans", body: "ok", replyTo: "m1" });
  const { head } = decodeRaw((calls[1]![2] as Upload).data);
  expect(head).toContain("Subject: RE: lunch plans");
  expect(head).toContain("References: <o@x>");
});

test("draft saves the message, threaded when replying", async () => {
  const { api, calls } = fake({
    "GET messages/m1": {
      id: "m1",
      threadId: "t1",
      payload: { headers: [header("Subject", "Plan"), header("Message-ID", "<p@x>")] },
    },
    "UPLOAD drafts": { id: "d1", message: { id: "m7" } },
  });
  const args = { to: "a@x.com", subject: "Plan", body: "Draft", replyTo: "m1" };
  const out = await gmail(api, home(), { action: "draft", ...args });
  expect(out).toBe("Draft saved (id d1).");
  expect(calls[1]!.slice(0, 2)).toEqual(["UPLOAD", "drafts"]);
  const upload = calls[1]![2] as Upload;
  expect(upload.metadata).toEqual({ message: { threadId: "t1" } });
  expect(upload.type).toBe("message/rfc822");
  const { head } = decodeRaw(upload.data);
  expect(head).toContain("Subject: Re: Plan");
  expect(head).toContain("In-Reply-To: <p@x>");
});

test("draft without replyTo uploads the message with empty metadata", async () => {
  const { api, calls } = fake({ "UPLOAD drafts": { id: "d2" } });
  const out = await gmail(api, home(), { action: "draft", to: "a@x.com", subject: "Hi", body: "Body" });
  expect(out).toBe("Draft saved (id d2).");
  expect(calls).toHaveLength(1);
  const upload = calls[0]![2] as Upload;
  expect(upload.metadata).toEqual({});
  expect(upload.type).toBe("message/rfc822");
  const { head, body } = decodeRaw(upload.data);
  expect(head).toContain("To: a@x.com");
  expect(head).toContain("Subject: Hi");
  expect(body).toContain(Buffer.from("Body").toString("base64"));
});

test("send and draft need to, subject and body", async () => {
  const { api, calls } = fake({});
  await expect(gmail(api, home(), { action: "send", to: "a@x.com", body: "hi" })).rejects.toThrow(
    new GoogleError("send needs to, subject and body"),
  );
  await expect(gmail(api, home(), { action: "draft", subject: "s", body: "hi" })).rejects.toThrow(
    new GoogleError("draft needs to, subject and body"),
  );
  expect(calls).toEqual([]);
});

const LABELS = {
  labels: [
    { id: "INBOX", name: "INBOX" },
    { id: "TRASH", name: "TRASH" },
    { id: "UNREAD", name: "UNREAD" },
    { id: "Label_1", name: "Receipts" },
  ],
};

test("modify resolves label names case-insensitively and batch-modifies", async () => {
  const { api, calls } = fake({ "GET labels": LABELS, "POST messages/batchModify": undefined });
  const args = { ids: ["m1", "m2"], add: ["receipts"], remove: ["inbox", "UNREAD"] };
  const out = await gmail(api, home(), { action: "modify", ...args });
  expect(out).toBe("Updated 2 message(s).");
  expect(calls).toEqual([
    ["GET", "labels", undefined],
    [
      "POST",
      "messages/batchModify",
      { body: { ids: ["m1", "m2"], addLabelIds: ["Label_1"], removeLabelIds: ["INBOX", "UNREAD"] } },
    ],
  ]);
});

test("modify with TRASH trashes each message, then applies the rest", async () => {
  const { api, calls } = fake({
    "GET labels": LABELS,
    "POST messages/m1/trash": { id: "m1" },
    "POST messages/m%2F2/trash": { id: "m/2" },
    "POST messages/batchModify": undefined,
  });
  const out = await gmail(api, home(), { action: "modify", ids: ["m1", "m/2"], add: ["trash", "Label_1"] });
  expect(out).toBe("Updated 2 message(s).");
  expect(calls.slice(1)).toEqual([
    ["POST", "messages/m1/trash", undefined],
    ["POST", "messages/m%2F2/trash", undefined],
    ["POST", "messages/batchModify", { body: { ids: ["m1", "m/2"], addLabelIds: ["Label_1"], removeLabelIds: [] } }],
  ]);
});

test("modify with only TRASH does not batch-modify", async () => {
  const { api, calls } = fake({ "GET labels": LABELS, "POST messages/m1/trash": { id: "m1" } });
  expect(await gmail(api, home(), { action: "modify", ids: ["m1"], add: ["TRASH"] })).toBe("Updated 1 message(s).");
  expect(calls.map((c) => c[1])).toEqual(["labels", "messages/m1/trash"]);
});

test("modify refuses an unknown label before changing anything", async () => {
  const { api, calls } = fake({ "GET labels": LABELS });
  await expect(gmail(api, home(), { action: "modify", ids: ["m1"], add: ["TRASH"], remove: ["Nope"] })).rejects.toThrow(
    new GoogleError("Unknown label: Nope"),
  );
  expect(calls).toEqual([["GET", "labels", undefined]]);
});

test("modify needs ids and a label to add or remove", async () => {
  const { api } = fake({});
  await expect(gmail(api, home(), { action: "modify", ids: [], add: ["INBOX"] })).rejects.toThrow(
    new GoogleError("modify needs ids and add or remove"),
  );
  await expect(gmail(api, home(), { action: "modify", ids: ["m1"] })).rejects.toThrow(
    new GoogleError("modify needs ids and add or remove"),
  );
});

test("labels lists name (id), one per line", async () => {
  const { api, calls } = fake({ "GET labels": LABELS });
  expect(await gmail(api, home(), { action: "labels" })).toBe(
    "INBOX (INBOX)\nTRASH (TRASH)\nUNREAD (UNREAD)\nReceipts (Label_1)",
  );
  expect(calls).toEqual([["GET", "labels", undefined]]);
});

test("labels says when there are none", async () => {
  const { api } = fake({ "GET labels": {} });
  expect(await gmail(api, home(), { action: "labels" })).toBe("No labels.");
});

test("attachment saves the file under its name from the message", async () => {
  const dir = home();
  const { api, calls } = fake({
    "GET messages/m1": {
      id: "m1",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", filename: "", body: { data: b64u("hi") } },
          {
            mimeType: "multipart/mixed",
            parts: [{ mimeType: "application/pdf", filename: "menu.pdf", body: { size: 4, attachmentId: "A1" } }],
          },
        ],
      },
    },
    "GET messages/m1/attachments/A1": { size: 4, data: b64u(Buffer.from([1, 2, 250, 251])) },
  });
  const out = await gmail(api, dir, { action: "attachment", messageId: "m1", attachmentId: "A1" });
  expect(calls.map((c) => c.slice(0, 2))).toEqual([
    ["GET", "messages/m1"],
    ["GET", "messages/m1/attachments/A1"],
  ]);
  expect(calls[0]![2]).toEqual({ query: { format: "full" } });
  const path = out.replace(/^Saved to /, "");
  expect(out).toMatch(/^Saved to .*\/attachments\/google\/\d{4}-\d{2}-\d{2}\/menu\.pdf$/);
  expect(path.startsWith(dir)).toBe(true);
  expect([...readFileSync(path)]).toEqual([1, 2, 250, 251]);
});

// Gmail may hand out a different attachmentId each time it returns the message.
test("attachment: an id that no longer matches takes the name of the message's only attachment", async () => {
  const { api } = fake({
    "GET messages/m1": {
      payload: { parts: [{ mimeType: "image/png", filename: "map.png", body: { size: 1, attachmentId: "OTHER" } }] },
    },
    "GET messages/m1/attachments/A1": { size: 1, data: b64u("x") },
  });
  expect(await gmail(api, home(), { action: "attachment", messageId: "m1", attachmentId: "A1" })).toMatch(
    /\/map\.png$/,
  );
});

test("attachment needs messageId and attachmentId", async () => {
  const { api } = fake({});
  await expect(gmail(api, home(), { action: "attachment", messageId: "m1" })).rejects.toThrow(
    new GoogleError("attachment needs messageId and attachmentId"),
  );
});
