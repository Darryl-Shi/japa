import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { bootTest } from "./helpers.ts";
import { tool } from "./jobs-helpers.ts";

afterEach(() => vi.unstubAllGlobals());

/** Boots with parallel's key stored, so parallel is available. */
const bootKeyed = () => bootTest({}, [], undefined, { "parallel.apiKey": "pk-1" });

test("parallel_search asks for its key when it goes missing", async () => {
  const { daemon, faux, home } = await bootKeyed();
  rmSync(join(home, "secrets/parallel.apiKey"));
  expect(await tool(daemon, faux, "parallel_search", { objective: "cats" })).toBe(
    'parallel_search needs a Parallel API key. Ask the user for it with secret_request({ name: "parallel.apiKey", why: "..." }), then try again.',
  );
  await daemon.close();
});

test("parallel_search sends the key and request, and formats the results", async () => {
  const { daemon, faux } = await bootKeyed();
  const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({
      search_id: "s",
      session_id: "x",
      results: [
        { url: "https://cats.example", title: "Cats", publish_date: "2024-01-15", excerpts: ["All about cats", "More"] },
        { url: "https://dogs.example", title: null, excerpts: [] },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await tool(daemon, faux, "parallel_search", { objective: "learn about cats", queries: ["cats"], count: 2 })).toBe(
    "1. Cats (2024-01-15)\nhttps://cats.example\nAll about cats\nMore\n\n2. https://dogs.example\nhttps://dogs.example",
  );
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe("https://api.parallel.ai/v1/search");
  expect(init.method).toBe("POST");
  expect(new Headers(init.headers).get("x-api-key")).toBe("pk-1");
  expect(JSON.parse(init.body as string)).toEqual({
    objective: "learn about cats",
    search_queries: ["cats"],
    advanced_settings: { max_results: 2 },
  });
  await daemon.close();
});

test("parallel_search uses the objective as the query when none are given, and reports HTTP errors", async () => {
  const { daemon, faux } = await bootKeyed();
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response("no", { status: 401 }));
  vi.stubGlobal("fetch", fetch);
  expect(await tool(daemon, faux, "parallel_search", { objective: "cats" })).toBe("Search failed: Parallel replied HTTP 401");
  expect(JSON.parse(fetch.mock.calls[0]![1].body as string).search_queries).toEqual(["cats"]);
  await daemon.close();
});
