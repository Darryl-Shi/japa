import { defineJapaExtension, defineTool, type KernelContext, Type } from "../../src/sdk.ts";

const KEY = "brave.apiKey";

let secret!: KernelContext["secret"];

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
/** Node's fetch reports "fetch failed" with the reason in `cause`. */
const reason = (error: unknown) => ((error as Error).cause as Error | undefined)?.message ?? (error as Error).message;

type Result = { title: string; url: string; description: string };

const braveSearch = defineTool({
  name: "brave_search",
  description: "Search the web with Brave Search; returns the title, URL and snippet of each result.",
  parameters: Type.Object({ query: Type.String(), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
  execute: async ({ query, count = 5 }) => {
    const key = await secret(KEY);
    if (!key) {
      return reply(
        `brave_search needs a Brave Search API key. Ask the user for it with secret_request({ name: "${KEY}", why: "..." }), then try again.`,
      );
    }
    try {
      const params = new URLSearchParams({ q: query, count: String(count) });
      const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: { Accept: "application/json", "X-Subscription-Token": key },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return reply(`Search failed: Brave Search replied HTTP ${response.status}`);
      const body = (await response.json()) as { web?: { results: Result[] } };
      const results = body.web?.results ?? [];
      if (results.length === 0) return reply("No results.");
      return reply(results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.description}`).join("\n\n"));
    } catch (error) {
      return reply(`Search failed: ${reason(error)}`);
    }
  },
});

export default defineJapaExtension({
  name: "brave",
  summary: "Searches the web with Brave Search",
  examples: ["what's the latest release of Node.js?", "find the docs for the fetch API"],
  docs:
    "brave_search({ query, count? = 5 }) returns numbered results: title, URL and a short snippet; read a result " +
    "with web_fetch. Needs the secret brave.apiKey.",
  provides: { tool: [braveSearch] },
  secrets: [{ name: KEY, description: "Brave Search API key, for brave_search" }],
  setup: (ctx) => {
    secret = ctx.secret;
  },
});
