import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createApi, GoogleError, MAX, respond, truncate } from "../extensions/google/api.ts";
import { NotSignedIn } from "../extensions/google/auth.ts";
import { mimeType, readUpload, saveFile } from "../extensions/google/files.ts";

afterEach(() => vi.unstubAllGlobals());

const BASE = "https://www.googleapis.com/drive/v3/files";

/** Fake tokens: `access` hands out tok-1, `refresh` tok-2, tok-3... */
function fakeTokens() {
  let n = 1;
  let current = "tok-1";
  return {
    access: vi.fn(async () => current),
    refresh: vi.fn(async () => (current = `tok-${++n}`)),
  };
}

/** Stubs fetch with canned responses, in order; the last repeats. */
function stubFetch(...responses: (Response | (() => Response) | Error)[]) {
  let i = 0;
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = responses[Math.min(i++, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next.clone();
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const googleError = (status: number, error: object, headers?: Record<string, string>) =>
  Response.json({ error: { code: status, ...error } }, { status, headers });

const setup = (...responses: Parameters<typeof stubFetch>) => {
  const tokens = fakeTokens();
  const sleep = vi.fn(async (_ms: number) => {});
  const fetch = stubFetch(...responses);
  return { api: createApi(tokens, { sleep }), tokens, sleep, fetch };
};

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
};

describe("json", () => {
  test("sends the bearer token, the query and a JSON body", async () => {
    const { api, fetch } = setup(Response.json({ id: "f1" }));
    const result = await api.json("POST", `${BASE}?fields=id`, {
      query: { q: "name = 'a b'", ids: ["a", "b"], max: 5, all: true, skip: undefined },
      body: { name: "x" },
    });
    expect(result).toEqual({ id: "f1" });
    const [url, init] = fetch.mock.calls[0]!;
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(BASE);
    expect(parsed.searchParams.get("fields")).toBe("id");
    expect(parsed.searchParams.get("q")).toBe("name = 'a b'");
    expect(parsed.searchParams.getAll("ids")).toEqual(["a", "b"]);
    expect(parsed.searchParams.get("max")).toBe("5");
    expect(parsed.searchParams.get("all")).toBe("true");
    expect(parsed.searchParams.has("skip")).toBe(false);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer tok-1");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ name: "x" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("a GET has no body or content type", async () => {
    const { api, fetch } = setup(Response.json({ ok: 1 }));
    await api.json("GET", BASE);
    const [, init] = fetch.mock.calls[0]!;
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has("content-type")).toBe(false);
  });

  test("204 is undefined", async () => {
    const { api } = setup(new Response(null, { status: 204 }));
    expect(await api.json("DELETE", `${BASE}/f1`)).toBeUndefined();
  });

  test("401 refreshes once and retries with the new token", async () => {
    const { api, fetch, tokens } = setup(googleError(401, { message: "Invalid Credentials" }), Response.json({ a: 1 }));
    expect(await api.json("GET", BASE)).toEqual({ a: 1 });
    expect(tokens.refresh).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[1]![1].headers).get("authorization")).toBe("Bearer tok-2");
  });

  test("a second 401 is the expired reply", async () => {
    const { api, fetch, tokens } = setup(googleError(401, { message: "Invalid Credentials" }));
    const error = await failure(api.json("GET", BASE));
    expect(tokens.refresh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await respond(() => Promise.reject(error))).content[0]!.text).toBe(
      'Not signed in to Google (or the sign-in expired): call connect({ extension: "google" }).',
    );
  });

  test("403 SERVICE_DISABLED names the API and links its activation page", async () => {
    const { api } = setup(
      googleError(403, {
        message: "Gmail API has not been used in project 123 before or it is disabled.",
        status: "PERMISSION_DENIED",
        errors: [{ reason: "accessNotConfigured", domain: "usageLimits" }],
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "SERVICE_DISABLED",
            metadata: {
              service: "gmail.googleapis.com",
              serviceTitle: "Gmail API",
              activationUrl: "https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123",
            },
          },
        ],
      }),
    );
    const error = await failure(api.json("GET", BASE));
    expect(error).toBeInstanceOf(GoogleError);
    expect(error.message).toBe(
      "The Gmail API isn't enabled for this Google project. Enable it at " +
        "https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123, then try again.",
    );
  });

  test("403 SERVICE_DISABLED without a title uses the service name", async () => {
    const { api } = setup(
      googleError(403, {
        message: "disabled",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "SERVICE_DISABLED",
            metadata: { service: "tasks.googleapis.com", activationUrl: "https://example.test/enable" },
          },
        ],
      }),
    );
    expect((await failure(api.json("GET", BASE))).message).toBe(
      "The tasks.googleapis.com API isn't enabled for this Google project. " +
        "Enable it at https://example.test/enable, then try again.",
    );
  });

  test("403 accessNotConfigured without details falls back to Google and the API library", async () => {
    const { api } = setup(googleError(403, { message: "off", errors: [{ reason: "accessNotConfigured" }] }));
    expect((await failure(api.json("GET", BASE))).message).toBe(
      "The Google API isn't enabled for this Google project. " +
        "Enable it at https://console.cloud.google.com/apis/library, then try again.",
    );
  });

  test.each([
    ["errors[].reason", { message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] }],
    [
      "details[].reason",
      {
        message: "Request had insufficient authentication scopes.",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
      },
    ],
  ])("403 insufficient scopes (%s) asks to reconnect", async (_name, error) => {
    const { api } = setup(googleError(403, error));
    expect((await failure(api.json("GET", BASE))).message).toBe(
      'japa lacks access for this; reconnect to grant it: connect({ extension: "google" }).',
    );
  });

  test("another 403 is Google's message", async () => {
    const { api } = setup(googleError(403, { message: "The user does not have sufficient permissions for file x." }));
    expect((await failure(api.json("GET", BASE))).message).toBe(
      "Google replied HTTP 403: The user does not have sufficient permissions for file x.",
    );
  });

  test("404 names the last path segment", async () => {
    const { api } = setup(googleError(404, { message: "File not found: abc." }));
    expect((await failure(api.json("GET", `${BASE}/abc?fields=id`))).message).toBe("Not found: abc");
  });

  test("429 retries once after Retry-After, then reports Google's message", async () => {
    const { api, sleep, fetch } = setup(googleError(429, { message: "Rate Limit Exceeded" }, { "retry-after": "3" }));
    expect((await failure(api.json("GET", BASE))).message).toBe("Google replied HTTP 429: Rate Limit Exceeded");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[3000]]);
  });

  test("5xx retries once after 1 s by default and succeeds", async () => {
    const { api, sleep } = setup(googleError(503, { message: "Backend Error" }), Response.json({ ok: true }));
    expect(await api.json("GET", BASE)).toEqual({ ok: true });
    expect(sleep.mock.calls).toEqual([[1000]]);
  });

  test("Retry-After is capped at 10 s", async () => {
    const { api, sleep } = setup(googleError(500, { message: "x" }, { "retry-after": "120" }), Response.json({}));
    await api.json("GET", BASE);
    expect(sleep.mock.calls).toEqual([[10000]]);
  });

  test("another 4xx is Google's message, without a retry", async () => {
    const { api, fetch, sleep } = setup(googleError(400, { message: "Invalid query" }));
    expect((await failure(api.json("GET", BASE))).message).toBe("Google replied HTTP 400: Invalid query");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("a non-JSON error body still gives the status", async () => {
    const { api } = setup(new Response("<html>bad</html>", { status: 400 }));
    expect((await failure(api.json("GET", BASE))).message).toMatch(/^Google replied HTTP 400/);
  });

  test("a network failure names its cause", async () => {
    const cause = new Error("getaddrinfo ENOTFOUND www.googleapis.com");
    const { api } = setup(new TypeError("fetch failed", { cause }));
    const error = await failure(api.json("GET", BASE));
    expect(error).toBeInstanceOf(GoogleError);
    expect(error.message).toBe("Google request failed: getaddrinfo ENOTFOUND www.googleapis.com");
  });

  test("a sign-in problem propagates", async () => {
    const tokens = { access: async () => Promise.reject(new NotSignedIn("no_token")), refresh: async () => "x" };
    const fetch = stubFetch(Response.json({}));
    const error = await failure(createApi(tokens).json("GET", BASE));
    expect(error).toBeInstanceOf(NotSignedIn);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("bytes, upload, raw", () => {
  test("bytes returns the data and its content type", async () => {
    const { api, fetch } = setup(new Response(Buffer.from([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    const result = await api.bytes(`${BASE}/f1`, { alt: "media" });
    expect(result.type).toBe("image/png");
    expect([...result.data]).toEqual([1, 2, 3]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(url).searchParams.get("alt")).toBe("media");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok-1");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("bytes maps errors too", async () => {
    const { api } = setup(googleError(404, { message: "nope" }));
    expect((await failure(api.bytes(`${BASE}/f9`))).message).toBe("Not found: f9");
  });

  test("upload sends multipart/related: the metadata JSON, then the data", async () => {
    const { api, fetch } = setup(Response.json({ id: "new" }));
    const url = "https://www.googleapis.com/upload/drive/v3/files";
    const result = await api.upload(url, { name: "a.txt", parents: ["p"] }, Buffer.from("hello"), "text/plain", {
      fields: "id",
    });
    expect(result).toEqual({ id: "new" });
    const [sent, init] = fetch.mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect(new URL(sent).searchParams.get("uploadType")).toBe("multipart");
    expect(new URL(sent).searchParams.get("fields")).toBe("id");
    const type = new Headers(init.headers).get("content-type")!;
    const boundary = /^multipart\/related; boundary=(.+)$/.exec(type)?.[1];
    expect(boundary).toBeTruthy();
    const body = Buffer.from(init.body as Uint8Array).toString();
    const parts = body.split(`--${boundary}`);
    expect(parts).toHaveLength(4); // "", metadata, data, "--\r\n"
    expect(parts[1]).toBe(
      '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a.txt","parents":["p"]}\r\n',
    );
    expect(parts[2]).toBe("\r\nContent-Type: text/plain\r\n\r\nhello\r\n");
    expect(parts[3]).toBe("--\r\n");
  });

  test("raw returns HTTP errors as status and body", async () => {
    const { api, sleep } = setup(googleError(400, { message: "bad" }));
    const result = await api.raw("PATCH", `${BASE}/f1`, { query: { fields: "id" }, body: { name: "y" } });
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error.message).toBe("bad");
    expect(sleep).not.toHaveBeenCalled();
  });

  test("raw throws for network errors", async () => {
    const { api } = setup(new TypeError("fetch failed", { cause: new Error("ECONNRESET") }));
    expect((await failure(api.raw("GET", BASE))).message).toBe("Google request failed: ECONNRESET");
  });
});

describe("respond and truncate", () => {
  test("truncate keeps short text and cuts long text at 50,000", () => {
    expect(MAX).toBe(50_000);
    expect(truncate("short")).toBe("short");
    const long = "x".repeat(50_010);
    expect(truncate(long)).toBe(`${"x".repeat(50_000)}\n[truncated: 10 more characters]`);
  });

  test("respond replies with the text, truncated", async () => {
    expect(await respond(async () => "done")).toEqual({ content: [{ type: "text", text: "done" }] });
    const reply = await respond(async () => "y".repeat(50_001));
    expect(reply.content[0]!.text).toBe(`${"y".repeat(50_000)}\n[truncated: 1 more characters]`);
  });

  test("respond maps errors to replies", async () => {
    const text = async (error: unknown) => (await respond(() => Promise.reject(error))).content[0]!.text;
    expect(await text(new NotSignedIn("no_client"))).toBe(
      "Google isn't set up: ask the user for google.clientId and google.clientSecret with secret_request " +
        '(a Desktop app OAuth client; see japa\'s README), then connect({ extension: "google" }).',
    );
    const expired = 'Not signed in to Google (or the sign-in expired): call connect({ extension: "google" }).';
    expect(await text(new NotSignedIn("no_token"))).toBe(expired);
    expect(await text(new NotSignedIn("expired"))).toBe(expired);
    expect(await text(new GoogleError("Not found: x"))).toBe("Not found: x");
    expect(await text(new Error("Google refused to refresh the sign-in: boom"))).toBe(
      "Google refused to refresh the sign-in: boom",
    );
  });
});

describe("files", () => {
  test("saveFile writes under attachments/google/<date>/ and suffixes on collision", () => {
    const home = mkdtempSync(join(tmpdir(), "japa-google-"));
    const dir = join(home, "attachments/google/2026-10-09");
    expect(saveFile(home, "a.txt", Buffer.from("1"), "2026-10-09")).toBe(join(dir, "a.txt"));
    expect(saveFile(home, "a.txt", Buffer.from("2"), "2026-10-09")).toBe(join(dir, "a (1).txt"));
    expect(saveFile(home, "a.txt", Buffer.from("3"), "2026-10-09")).toBe(join(dir, "a (2).txt"));
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("1");
    expect(readFileSync(join(dir, "a (1).txt"), "utf8")).toBe("2");
  });

  test("saveFile defaults to today's local date", () => {
    const home = mkdtempSync(join(tmpdir(), "japa-google-"));
    const now = new Date();
    const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
      .map((n) => String(n).padStart(2, "0"))
      .join("-");
    expect(saveFile(home, "b.pdf", Buffer.from("x"))).toBe(join(home, "attachments/google", today, "b.pdf"));
  });

  test("saveFile keeps a hostile name inside the folder", () => {
    const home = mkdtempSync(join(tmpdir(), "japa-google-"));
    const dir = join(home, "attachments/google/2026-10-09");
    expect(saveFile(home, "../../etc/passwd", Buffer.from("x"), "2026-10-09")).toBe(join(dir, ".._.._etc_passwd"));
    expect(saveFile(home, "..", Buffer.from("x"), "2026-10-09")).toBe(join(dir, "file"));
    expect(saveFile(home, "", Buffer.from("x"), "2026-10-09")).toBe(join(dir, "file (1)"));
  });

  test("readUpload reads a file with its name and type, and names a missing path", () => {
    const dir = mkdtempSync(join(tmpdir(), "japa-google-"));
    writeFileSync(join(dir, "report.PDF"), "pdf");
    expect(readUpload(join(dir, "report.PDF"))).toEqual({
      name: "report.PDF",
      type: "application/pdf",
      data: Buffer.from("pdf"),
    });
    const missing = join(dir, "nope.txt");
    expect(() => readUpload(missing)).toThrow(GoogleError);
    expect(() => readUpload(missing)).toThrow(`No such file: ${missing}`);
    expect(() => readUpload(dir)).toThrow(`Not a file: ${dir}`);
  });

  test("mimeType goes by extension", () => {
    expect(mimeType("a.txt")).toBe("text/plain");
    expect(mimeType("a.png")).toBe("image/png");
    expect(mimeType("a.JPG")).toBe("image/jpeg");
    expect(mimeType("a.docx")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(mimeType("a.unknown")).toBe("application/octet-stream");
    expect(mimeType("noext")).toBe("application/octet-stream");
  });
});
