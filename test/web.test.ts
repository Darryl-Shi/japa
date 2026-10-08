import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { htmlToText } from "../extensions/web/html.ts";
import { bootTest, stage } from "./helpers.ts";
import { tool } from "./jobs-helpers.ts";

afterEach(() => vi.unstubAllGlobals());

test("htmlToText drops script and style, strips tags, decodes entities and collapses whitespace", () => {
  const html =
    "<html><head><style>p { color: red }</style><script>alert('x')</script></head>\n" +
    "<body><p>Fish   &amp; chips &lt;3 &quot;yes&quot; &#39;ok&#39;&nbsp;&#65;&#x42;&#x110000;</p>\n\n\n  <p>next</p></body></html>";
  expect(htmlToText(html)).toBe(`Fish & chips <3 "yes" 'ok' AB\ufffd\nnext`);
});

test("web_fetch returns a page's text, and refuses errors and binary types", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/page") res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<p>Hello <b>world</b></p>");
    else if (req.url === "/big") res.writeHead(200, { "content-type": "text/plain" }).end("x".repeat(50_010));
    else if (req.url === "/image") res.writeHead(200, { "content-type": "image/png" }).end("png");
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { daemon, faux } = await bootTest();
  expect(await tool(daemon, faux, "web_fetch", { url: `${base}/page` })).toBe("Hello world");
  expect(await tool(daemon, faux, "web_fetch", { url: `${base}/missing` })).toBe(`HTTP 404 for ${base}/missing`);
  expect(await tool(daemon, faux, "web_fetch", { url: `${base}/image` })).toBe("Not a text page (image/png).");
  expect(await tool(daemon, faux, "web_fetch", { url: `${base}/big` })).toBe(`${"x".repeat(50_000)}\n[truncated: 10 more characters]`);
  server.close();
  expect(await tool(daemon, faux, "web_fetch", { url: `${base}/page` })).toMatch(/^Fetch failed: (?!fetch failed)/);
  await daemon.close();
});

test("web provides only its tools, and defines no contract or settings", async () => {
  const { default: web } = await import("../extensions/web/index.ts");
  expect(Object.keys(web.provides ?? {})).toEqual(["tool"]);
  expect(web.settings).toBeUndefined();
  expect("contracts" in web).toBe(false);
});

test("a leftover extensions.web.engine setting is ignored", async () => {
  const { daemon, faux } = await bootTest({ extensions: { web: { engine: "fake" } } });
  expect(daemon.status().errors).toEqual([]);
  expect(await tool(daemon, faux, "web_search", { query: "cats" })).toMatch(/^web_search needs a Brave Search API key/);
  await daemon.close();
});

test("web_search still works after an extension install reloads the registry", { timeout: 60_000 }, async () => {
  const { daemon, faux, home } = await bootTest();
  stage(home, "extensions/dice/index.ts",
    `import { defineJapaExtension } from "japa/sdk";\nexport default defineJapaExtension({ name: "dice", summary: "Dice", examples: ["roll"], docs: "Dice." });\n`);
  expect(await tool(daemon, faux, "install", { kind: "extension", name: "dice" })).toBe("Installed extension dice. (change 1)");
  expect(await tool(daemon, faux, "web_search", { query: "cats" })).toMatch(/^web_search needs a Brave Search API key/);
  await daemon.close();
});

test("Brave Search asks for its key when it is missing", async () => {
  const { daemon, faux } = await bootTest();
  expect(await tool(daemon, faux, "web_search", { query: "cats" })).toBe(
    'web_search needs a Brave Search API key. Ask the user for it with secret_request({ name: "web.brave.apiKey", why: "..." }), then try again.',
  );
  await daemon.close();
});

test("Brave Search sends the key and parses the results", async () => {
  const { daemon, faux, home } = await bootTest();
  writeFileSync(join(home, "secrets/web.brave.apiKey"), "bk-1");
  const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({ web: { results: [{ title: "Cats", url: "https://cats.example", description: "All about cats" }] } }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await tool(daemon, faux, "web_search", { query: "cats & dogs" })).toBe(
    "1. Cats\nhttps://cats.example\nAll about cats",
  );
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe("https://api.search.brave.com/res/v1/web/search?q=cats+%26+dogs&count=5");
  expect(new Headers(init.headers).get("X-Subscription-Token")).toBe("bk-1");
  await daemon.close();
});
