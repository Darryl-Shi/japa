import { defineJapaExtension, defineTool, type KernelContext, Type } from "../../src/sdk.ts";
import { brave, MissingKey } from "./brave.ts";
import { htmlToText } from "./html.ts";

let secret: KernelContext["secret"] = () => {
  throw new Error("web is not set up");
};

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
const MAX = 50_000;
const truncate = (text: string) =>
  text.length > MAX ? `${text.slice(0, MAX)}\n[truncated: ${text.length - MAX} more characters]` : text;
/** Node's fetch reports "fetch failed" with the reason in `cause`. */
const reason = (error: unknown) => ((error as Error).cause as Error | undefined)?.message ?? (error as Error).message;

const webFetch = defineTool({
  name: "web_fetch",
  description: "Fetch a web page or text file and return its text.",
  parameters: Type.Object({ url: Type.String() }),
  execute: async ({ url }) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return reply(`HTTP ${response.status} for ${url}`);
      const type = response.headers.get("content-type") ?? "";
      if (!/^text\/|json|xml/.test(type)) return reply(`Not a text page (${type}).`);
      const text = await response.text();
      return reply(truncate(type.startsWith("text/html") ? htmlToText(text) : text));
    } catch (error) {
      return reply(`Fetch failed: ${reason(error)}`);
    }
  },
});

const webSearch = defineTool({
  name: "web_search",
  description: "Search the web; returns the title, URL and snippet of each result.",
  parameters: Type.Object({ query: Type.String(), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
  execute: async ({ query, count = 5 }) => {
    try {
      const results = await brave.search(query, count, secret);
      return reply(results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n"));
    } catch (error) {
      if (error instanceof MissingKey) {
        return reply(
          'web_search needs a Brave Search API key. Ask the user for it with secret_request({ name: "web.brave.apiKey", why: "..." }), then try again.',
        );
      }
      return reply(`Search failed: ${reason(error)}`);
    }
  },
});

export default defineJapaExtension({
  name: "web",
  summary: "Fetches web pages and searches the web",
  examples: ["what's the latest release of Node.js?", "summarize https://example.com/article"],
  docs:
    "web_fetch({ url }) returns a page's text (HTML is converted; other text, JSON and XML as is; binary is refused; truncated at 50,000 characters). " +
    "web_search({ query, count? = 5 }) returns numbered results: title, URL and snippet. " +
    "web_search uses Brave Search and needs the secret web.brave.apiKey.",
  provides: { tool: [webFetch, webSearch] },
  secrets: ["web.brave.apiKey"],
  setup: (ctx) => {
    secret = ctx.secret;
  },
});
