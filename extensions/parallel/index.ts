import { defineJapaExtension, defineTool, type KernelContext, Type } from "../../src/sdk.ts";

const KEY = "parallel.apiKey";
const ENDPOINT = "https://api.parallel.ai/v1/search";

let secret!: KernelContext["secret"];

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
/** Node's fetch reports "fetch failed" with the reason in `cause`. */
const reason = (error: unknown) => ((error as Error).cause as Error | undefined)?.message ?? (error as Error).message;

type Result = { url: string; title?: string | null; publish_date?: string | null; excerpts: string[] };

const format = (results: Result[]) =>
  results.length === 0
    ? "No results."
    : results
        .map((r, i) => {
          const head = `${i + 1}. ${r.title || r.url}${r.publish_date ? ` (${r.publish_date})` : ""}\n${r.url}`;
          return [head, ...r.excerpts].join("\n");
        })
        .join("\n\n");

const parallelSearch = defineTool({
  name: "parallel_search",
  description:
    "Search the web with Parallel; returns ranked results with the title, URL, date and long excerpts of each page.",
  parameters: Type.Object({
    objective: Type.String({ description: "The question or goal behind the search, in plain language" }),
    queries: Type.Optional(Type.Array(Type.String(), { description: "Keyword queries, 3-6 words each" })),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  }),
  execute: async ({ objective, queries, count = 5 }) => {
    const key = await secret(KEY);
    if (!key) {
      return reply(
        `parallel_search needs a Parallel API key. Ask the user for it with secret_request({ name: "${KEY}", why: "..." }), then try again.`,
      );
    }
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify({
          objective,
          search_queries: queries?.length ? queries : [objective],
          advanced_settings: { max_results: count },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) return reply(`Search failed: Parallel replied HTTP ${response.status}`);
      const body = (await response.json()) as { results?: Result[] };
      return reply(format(body.results ?? []));
    } catch (error) {
      return reply(`Search failed: ${reason(error)}`);
    }
  },
});

export default defineJapaExtension({
  name: "parallel",
  summary: "Searches the web with Parallel, returning long page excerpts",
  examples: ["research the latest Node.js release notes", "find recent reviews of the Framework 13 laptop"],
  docs:
    "parallel_search({ objective, queries?, count? = 5 }) returns numbered results: title, publish date if known, URL, " +
    "then excerpts of the page as markdown. objective is the question in plain language; queries are optional keyword " +
    "searches (the objective is used when omitted). Read a page in full with web_fetch. Needs the secret parallel.apiKey.",
  provides: { tool: [parallelSearch] },
  secrets: [{ name: KEY, description: "Parallel API key (platform.parallel.ai), for parallel_search" }],
  setup: (ctx) => {
    secret = ctx.secret;
  },
});
