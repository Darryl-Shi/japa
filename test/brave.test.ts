import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { bootTest, land } from "./helpers.ts";
import { tool } from "./jobs-helpers.ts";

afterEach(() => vi.unstubAllGlobals());

/** Boots with brave's key stored, so brave is available. */
const bootKeyed = () => bootTest({}, [], undefined, { "brave.apiKey": "bk-1" });

test("brave_search asks for its key when it goes missing", async () => {
  const { daemon, faux, home } = await bootKeyed();
  rmSync(join(home, "secrets/brave.apiKey"));
  expect(await tool(daemon, faux, "brave_search", { query: "cats" })).toBe(
    'brave_search needs a Brave Search API key. Ask the user for it with secret_request({ name: "brave.apiKey", why: "..." }), then try again.',
  );
  await daemon.close();
});

test("brave_search still works after a new extension reloads the registry", { timeout: 60_000 }, async () => {
  const { daemon, faux, home } = await bootKeyed();
  const results = [{ title: "Cats", url: "https://c.example", description: "C" }];
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ web: { results } })));
  land(home, "extensions/dice/index.ts",
    `import { defineJapaExtension } from "japa/sdk";\nexport default defineJapaExtension({ name: "dice", summary: "Dice", examples: ["roll"], docs: "Dice." });\n`);
  expect((await daemon.reconcile()).errors).toEqual([]);
  expect(daemon.capabilities()).toContain("- dice: ");
  expect(await tool(daemon, faux, "brave_search", { query: "cats" })).toBe("1. Cats\nhttps://c.example\nC");
  await daemon.close();
});

test("brave_search sends the key and parses the results", async () => {
  const { daemon, faux } = await bootKeyed();
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
  const { daemon, faux } = await bootKeyed();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 429 })));
  expect(await tool(daemon, faux, "brave_search", { query: "cats" })).toBe("Search failed: Brave Search replied HTTP 429");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
  expect(await tool(daemon, faux, "brave_search", { query: "cats" })).toBe("No results.");
  await daemon.close();
});
