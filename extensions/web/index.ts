import { defineJapaExtension, defineTool, Type } from "../../src/sdk.ts";
import { htmlToText } from "./html.ts";

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

export default defineJapaExtension({
  name: "web",
  summary: "Fetches web pages",
  examples: ["summarize https://example.com/article", "what does this page say? https://nodejs.org/en/blog"],
  docs:
    "web_fetch({ url }) returns a page's text (HTML is converted; other text, JSON and XML as is; binary is refused; " +
    "truncated at 50,000 characters). It needs no key. To search the web, use a search extension's tool.",
  provides: { tool: [webFetch] },
});
