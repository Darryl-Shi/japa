// RFC 2822 messages for Gmail's send and draft: UTF-8 headers as RFC 2047 encoded words, a base64 text/plain body,
// multipart/mixed with attachments (RFC 2231 file names when they need it).
import { randomBytes } from "node:crypto";

export type Mail = {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  attachments?: { name: string; type: string; data: Buffer }[];
  inReplyTo?: string;
  references?: string;
};

const NON_ASCII = /[^\x00-\x7f]/;
/** A line break in a header value would start a new header: it becomes a space. */
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ");

/** `text` as RFC 2047 encoded words, each at most 75 characters (45 UTF-8 bytes), never splitting a character. */
function encodedWords(text: string): string[] {
  const words: string[] = [];
  let chunk = "";
  for (const char of text) {
    if (Buffer.byteLength(chunk + char) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`);
}

/** A free-text header value: as is when ASCII, else encoded words folded onto continuation lines. */
const text = (value: string) => (NON_ASCII.test(value) ? encodedWords(value).join("\r\n ") : value);

/** Splits an address list on the commas outside quotes and angle brackets. */
function addresses(list: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (const char of list) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "<") angle = true;
    else if (!quoted && char === ">") angle = false;
    if (char === "," && !quoted && !angle) {
      out.push(current);
      current = "";
    } else current += char;
  }
  out.push(current);
  return out.map((a) => a.trim()).filter(Boolean);
}

/** An address list with each non-ASCII display name encoded; the addresses themselves are left alone. */
const addressList = (list: string) =>
  addresses(list)
    .map((one) => {
      const match = /^(.*?)\s*<([^<>]*)>$/.exec(one);
      if (!match || !NON_ASCII.test(match[1]!)) return one;
      const name = match[1]!.replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1");
      return `${encodedWords(name).join(" ")} <${match[2]}>`;
    })
    .join(", ");

/** Base64 in lines of 76 characters. */
const base64 = (data: string | Buffer) => (Buffer.from(data).toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");

/** RFC 5987 percent-encoding: only attr-chars stay literal. */
const percent = (value: string) =>
  encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function attachmentPart(file: { name: string; type: string; data: Buffer }): string {
  const name = oneLine(file.name);
  // A quote, backslash or non-ASCII character can't go in a plain quoted file name.
  const plain = !NON_ASCII.test(name) && !/["\\]/.test(name);
  return [
    `Content-Type: ${oneLine(file.type)}; name="${plain ? name : encodedWords(name).join(" ")}"`,
    `Content-Disposition: attachment; ${plain ? `filename="${name}"` : `filename*=UTF-8''${percent(name)}`}`,
    "Content-Transfer-Encoding: base64",
    "",
    base64(file.data),
  ].join("\r\n");
}

/** An RFC 2822 message with CRLF line endings. Bcc is kept: Gmail delivers to it and strips the header. */
export function buildMessage(mail: Mail, boundary = `japa-${randomBytes(16).toString("hex")}`): string {
  const headers = [
    `To: ${addressList(oneLine(mail.to))}`,
    ...(mail.cc ? [`Cc: ${addressList(oneLine(mail.cc))}`] : []),
    ...(mail.bcc ? [`Bcc: ${addressList(oneLine(mail.bcc))}`] : []),
    `Subject: ${text(oneLine(mail.subject))}`,
    ...(mail.inReplyTo ? [`In-Reply-To: ${oneLine(mail.inReplyTo)}`] : []),
    ...(mail.references ? [`References: ${oneLine(mail.references)}`] : []),
    "MIME-Version: 1.0",
  ];
  const body = [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64(mail.body.replace(/\r?\n/g, "\r\n")),
  ].join("\r\n");
  const files = mail.attachments ?? [];
  if (files.length === 0) return `${headers.join("\r\n")}\r\n${body}\r\n`;
  const parts = [body, ...files.map(attachmentPart)].map((part) => `--${boundary}\r\n${part}\r\n`);
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `${parts.join("")}--${boundary}--`,
    "",
  ].join("\r\n");
}

/** Gmail's `raw`: base64url without padding. */
export const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");
