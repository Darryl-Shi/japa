// The web, through Parallel (docs.parallel.ai): search with several queries at once, and reading pages. A default
// extension. Parallel is an account (its API key, through /login, or PARALLEL_API_KEY in the environment); its mode
// (fast by default, the most accurate of the $1-per-1000 modes, ~700ms) and results per search are its settings, on
// its page in /settings.
import { envApiKeyAuth, Type } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "./extension.ts";

const API = "https://api.parallel.ai/v1";
const ACCOUNT = "parallel";
/** Results per search, unless its settings say. */
const RESULTS = 8;
const OUTPUT_CHARS = 12_000;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

type Page = { url: string; title?: string | null; publish_date?: string | null; excerpts?: string[]; full_content?: string | null };

function render(pages: readonly Page[], full = false): string {
	let out = "";
	for (const page of pages) {
		const body = full && page.full_content ? page.full_content : (page.excerpts ?? []).join("\n…\n");
		const block = `## ${page.title ?? page.url}\n${page.url}${page.publish_date ? ` (${page.publish_date})` : ""}\n${body}\n\n`;
		if (out.length + block.length > OUTPUT_CHARS) {
			out += block.slice(0, Math.max(0, OUTPUT_CHARS - out.length));
			return `${out}\n[cut at ${OUTPUT_CHARS} characters]`;
		}
		out += block;
	}
	return out.trim();
}

export const webExtension =
	(options: { fetch?: typeof fetch } = {}): ExtensionFactory =>
	(pi) => {
		pi.registerAccount({ id: ACCOUNT, name: "Parallel (web search)", auth: { apiKey: envApiKeyAuth("Parallel API key", ["PARALLEL_API_KEY"]) } });
		pi.registerFlag("mode", { description: "Search mode (fast, one-shot or agentic)", type: "string", default: "fast" });
		pi.registerFlag("maxResults", { description: "Results per search", type: "string", default: String(RESULTS) });

		const request = async (path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> => {
			const apiKey = (await pi.accounts.get(ACCOUNT, signal === undefined ? {} : { signal })).auth.apiKey ?? "";
			const response = await (options.fetch ?? fetch)(`${API}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": apiKey },
				body: JSON.stringify(body),
				...(signal === undefined ? {} : { signal }),
			});
			if (!response.ok) throw new Error(`Parallel ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`);
			return (await response.json()) as Record<string, unknown>;
		};

		pi.registerTool({
			name: "web_search",
			label: "Web search",
			description: "Search the web. Give the objective in a sentence and several short queries; they run at once. Returns pages with the relevant excerpts.",
			parameters: Type.Object({
				objective: Type.String({ description: "What you're trying to find out, and any freshness or source preferences" }),
				queries: Type.Array(Type.String(), { description: "2–5 keyword queries" }),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true },
			execute: async (_id, args, signal) => {
				const maxResults = Number(pi.getFlag("maxResults")) || RESULTS;
				const result = await request("/search", { objective: args.objective, search_queries: args.queries, mode: pi.getFlag("mode"), advanced_settings: { max_results: maxResults } }, signal);
				const pages = (result.results ?? []) as Page[];
				return text(pages.length === 0 ? "No results." : render(pages));
			},
		});

		pi.registerTool({
			name: "web_fetch",
			label: "Read web pages",
			description: "Read web pages. With an objective, returns the relevant passages; with full: true, the whole page as markdown.",
			parameters: Type.Object({
				urls: Type.Array(Type.String()),
				objective: Type.Optional(Type.String()),
				full: Type.Optional(Type.Boolean()),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true },
			execute: async (_id, args, signal) => {
				const full = args.full === true || args.objective === undefined;
				const result = await request("/extract", { urls: args.urls, ...(args.objective === undefined ? {} : { objective: args.objective }), advanced_settings: { full_content: full } }, signal);
				const errors = ((result.errors ?? []) as Array<{ url: string; error_type: string }>).map((error) => `${error.url}: couldn't read (${error.error_type})`);
				return text([render((result.results ?? []) as Page[], full), ...errors].filter(Boolean).join("\n\n") || "Nothing read.");
			},
		});
	};
