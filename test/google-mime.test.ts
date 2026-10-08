import { expect, test } from "vitest";
import { base64url, buildMessage } from "../extensions/google/mime.ts";

/** The header block of a message (or part) and its body. */
const split = (text: string) => {
  const at = text.indexOf("\r\n\r\n");
  return { head: text.slice(0, at).split("\r\n"), body: text.slice(at + 4) };
};

const b64 = (s: string) => Buffer.from(s).toString("base64");

test("a plain message: headers, then the base64 body, with CRLF line endings", () => {
  const message = buildMessage({ to: "a@x.com", subject: "Hello", body: "Hi there\nbye" });
  const { head, body } = split(message);
  expect(head).toEqual([
    "To: a@x.com",
    "Subject: Hello",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ]);
  expect(body.trim()).toBe(b64("Hi there\r\nbye"));
  expect(message.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
});

test("cc, bcc and reply headers are emitted when set", () => {
  const { head } = split(
    buildMessage({
      to: "a@x.com",
      cc: "c@x.com",
      bcc: "b@x.com",
      subject: "Re: x",
      body: "",
      inReplyTo: "<m1@mail.gmail.com>",
      references: "<m0@mail.gmail.com> <m1@mail.gmail.com>",
    }),
  );
  expect(head).toContain("Cc: c@x.com");
  expect(head).toContain("Bcc: b@x.com"); // Gmail strips it before delivery
  expect(head).toContain("In-Reply-To: <m1@mail.gmail.com>");
  expect(head).toContain("References: <m0@mail.gmail.com> <m1@mail.gmail.com>");
  const { head: plain } = split(buildMessage({ to: "a@x.com", subject: "s", body: "" }));
  expect(plain.some((h) => /^(Cc|Bcc|In-Reply-To|References):/.test(h))).toBe(false);
});

test("a non-ASCII subject is an RFC 2047 encoded word", () => {
  const { head } = split(buildMessage({ to: "a@x.com", subject: "Café", body: "" }));
  expect(head).toContain(`Subject: =?UTF-8?B?${b64("Café")}?=`);
});

test("a long non-ASCII subject is folded into encoded words of at most 75 characters", () => {
  const subject = "Réunion ".repeat(20).trim();
  const message = buildMessage({ to: "a@x.com", subject, body: "" });
  const lines = message.slice(message.indexOf("Subject: "), message.indexOf("\r\nMIME-Version")).split("\r\n");
  expect(lines.length).toBeGreaterThan(1);
  const words = lines.map((line, i) => (i === 0 ? line.slice("Subject: ".length) : line.slice(1)));
  for (const line of lines.slice(1)) expect(line.startsWith(" ")).toBe(true);
  for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
  const decoded = words.map((w) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(w)![1]!, "base64")).map(String);
  expect(decoded.join("")).toBe(subject);
});

test("a non-ASCII display name is encoded, the address left alone", () => {
  const { head } = split(buildMessage({ to: "José <j@x.com>, b@x.com", subject: "s", body: "" }));
  expect(head).toContain(`To: =?UTF-8?B?${b64("José")}?= <j@x.com>, b@x.com`);
});

test("line breaks in header values can't inject headers", () => {
  const { head } = split(buildMessage({ to: "a@x.com", subject: "hi\r\nBcc: evil@x.com", body: "" }));
  expect(head.some((h) => h.startsWith("Bcc:"))).toBe(false);
  expect(head).toContain("Subject: hi Bcc: evil@x.com");
});

test("attachments make multipart/mixed: the text part, then each file", () => {
  const message = buildMessage(
    {
      to: "a@x.com",
      subject: "Files",
      body: "See attached",
      attachments: [
        { name: "r.pdf", type: "application/pdf", data: Buffer.from("PDF") },
        { name: "résumé.pdf", type: "application/pdf", data: Buffer.from("CV") },
        { name: 'say "hi".txt', type: "text/plain", data: Buffer.from("hi") },
      ],
    },
    "b",
  );
  const { head, body } = split(message);
  expect(head).toContain("MIME-Version: 1.0");
  expect(head).toContain('Content-Type: multipart/mixed; boundary="b"');
  const parts = body.split("--b");
  expect(parts).toHaveLength(6); // "", text, three files, "--\r\n"
  expect(parts[5]).toBe("--\r\n");

  const text = split(parts[1]!.replace(/^\r\n/, ""));
  expect(text.head).toEqual(["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"]);
  expect(text.body.trim()).toBe(b64("See attached"));

  const pdf = split(parts[2]!.replace(/^\r\n/, ""));
  expect(pdf.head).toEqual([
    'Content-Type: application/pdf; name="r.pdf"',
    'Content-Disposition: attachment; filename="r.pdf"',
    "Content-Transfer-Encoding: base64",
  ]);
  expect(pdf.body.trim()).toBe(b64("PDF"));

  const cv = split(parts[3]!.replace(/^\r\n/, ""));
  expect(cv.head).toContain(`Content-Type: application/pdf; name="=?UTF-8?B?${b64("résumé.pdf")}?="`);
  expect(cv.head).toContain("Content-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");

  const quoted = split(parts[4]!.replace(/^\r\n/, ""));
  expect(quoted.head).toContain("Content-Disposition: attachment; filename*=UTF-8''say%20%22hi%22.txt");
  expect(quoted.head.join("\n")).not.toContain('"hi"');
});

test("base64 bodies are wrapped at 76 characters", () => {
  const { body } = split(buildMessage({ to: "a@x.com", subject: "s", body: "z".repeat(200) }));
  const lines = body.trim().split("\r\n");
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
  expect(Buffer.from(lines.join(""), "base64").toString()).toBe("z".repeat(200));
});

test("base64url has no +, / or =", () => {
  const data = Buffer.from([0xfb, 0xff, 0xfe, 0x3e, 0x3f]);
  const encoded = base64url(data);
  expect(encoded).not.toMatch(/[+/=]/);
  expect(Buffer.from(encoded, "base64url")).toEqual(data);
  expect(base64url("?>?")).toBe(Buffer.from("?>?").toString("base64url"));
});
