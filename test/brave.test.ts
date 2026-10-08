import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { bootTest, stage } from "./helpers.ts";
import { tool } from "./jobs-helpers.ts";

afterEach(() => vi.unstubAllGlobals());

test("brave_search asks for its key when it is missing", async () => {
  const { daemon, faux } = await bootTest();
  expect(await tool(daemon, faux, "brave_search", { query: "cats" })).toBe(
    'brave_search needs a Brave Search API key. Ask the user for it with secret_request({ name: "brave.apiKey", why: "..." }), then try again.',
  );
  await daemon.close();
});

test("brave_search still works after an extension install reloads the registry", { timeout: 60_000 }, async () => {
  const { daemon, faux, home } = await bootTest();
  stage(home, "extensions/dice/index.ts",
    `import { defineJapaExtension } from "japa/sdk";\nexport default defineJapaExtension({ name: "dice", summary: "Dice", examples: ["roll"], docs: "Dice." });\n`);
  expect(await tool(daemon, faux, "install", { kind: "extension", name: "dice" })).toBe("Installed extension dice. (change 1)");
  expect(await tool(daemon, faux, "brave_search", { query: "cats" })).toMatch(/^brave_search needs a Brave Search API key/);
  await daemon.close();
});

test("brave_search sends the key and parses the results", async () => {
  const { daemon, faux, home } = await bootTest();
  writeFileSync(join(home, "secrets/brave.apiKey"), "bk-1");
  const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({ web: { results: [{ title: "Cats", url: "https://cats.example", description: "All about cats" }] } }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await tool(daemon, faux, "brave_search", { query: "cats & dogs" })).toBe(
    "1. Cats\nhttps://cats.example\nAll about cats",
  );
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe("https://api.search.brave.com/res/v1/web/search?q=cats+%26+dogs&count=5");
  expect(new Headers(init.headers).get("X-Subscription-Token")).toBe("bk-1");
  await daemon.close();
});

test("brave_search reports HTTP errors and no results", async () => {
  const { daemon, faux, home } = await bootTest();
  writeFileSync(join(home, "secrets/brave.apiKey"), "bk-1");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 429 })));
  expect(await tool(daemon, faux, "brave_search", { query: "cats" })).toBe("Search failed: Brave Search replied HTTP 429");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
  expect(await tool(daemon, faux, "brave_search", { query: "cats" })).toBe("No results.");
  await daemon.close();
});
