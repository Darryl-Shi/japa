// The web, through Parallel (docs.parallel.ai): search with several queries at once, and reading pages. A default
// extension; fast mode by default, the most accurate of the $1-per-1000 modes (~700ms). Its key is set with its own
// command, /web; its mode and results per search are its options in settings.json (extensions.web).
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "./extension.ts";

const API = "https://api.parallel.ai/v1";
const DEFAULTS = { mode: "fast", maxResults: 8 };
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

/** Its options: settings.json's extensions.web, over the defaults. */
const optionsOf = (pi: ExtensionAPI) => ({ ...DEFAULTS, ...pi.getSettings().extensions.web });

export const webExtension =
	(options: { fetch?: typeof fetch } = {}): ExtensionFactory =>
	(pi) => {
		const key = () => pi.secrets.get("apiKey", "PARALLEL_API_KEY");
		const request = async (path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> => {
			const apiKey = key();
			if (apiKey === undefined) throw new Error("No Parallel API key: the user sets one with /web.");
			const response = await (options.fetch ?? fetch)(`${API}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": apiKey },
				body: JSON.stringify(body),
				...(signal === undefined ? {} : { signal }),
			});
			if (!response.ok) throw new Error(`Parallel ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`);
			return (await response.json()) as Record<string, unknown>;
		};

		// Read now, so its environment variable is kept out of commands' environment from the start.
		pi.on("session_start", () => void key());

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
				const { mode, maxResults } = optionsOf(pi);
				const result = await request("/search", { objective: args.objective, search_queries: args.queries, mode, advanced_settings: { max_results: Number(maxResults) } }, signal);
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

		pi.registerCommand("web", {
			description: "Web search: its Parallel API key",
			handler: async (_args, ctx) => {
				const setKey = `Parallel API key: ${key() === undefined ? "not set" : "set"}`;
				const choice = await ctx.ui.select(`Web search (Parallel), ${optionsOf(pi).mode} mode. Fast costs about $1 per 1000 searches.`, [setKey, "Done"]);
				if (choice !== setKey) return;
				const value = await ctx.ui.input("Send your Parallel API key as a reply to this message.", "Parallel API key", { secret: true });
				if (value === undefined || value.trim() === "") return;
				pi.secrets.set("apiKey", value.trim());
				ctx.ui.notify("Parallel API key saved.");
			},
		});
	};
