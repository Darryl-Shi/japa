// The web, through Parallel (docs.parallel.ai): search with several queries at once, and reading pages. A default
// extension; fast mode by default, the most accurate of the $1-per-1000 modes (~700ms).
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Host, JapaExtension } from "./extension.ts";

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

export function webExtension(host: Pick<Host, "settings" | "secrets">, options: { fetch?: typeof fetch } = {}): JapaExtension {
	const request = async (path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> => {
		const key = host.secrets.get("web.apiKey", "PARALLEL_API_KEY");
		if (key === undefined) throw new Error("No Parallel API key: set one in /settings → Web.");
		const response = await (options.fetch ?? fetch)(`${API}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": key },
			body: JSON.stringify(body),
			...(signal === undefined ? {} : { signal }),
		});
		if (!response.ok) throw new Error(`Parallel ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`);
		return (await response.json()) as Record<string, unknown>;
	};

	const extension = defineExtension({
		name: "web",
		tools: [
			defineTool({
				name: "web_search",
				description: "Search the web. Give the objective in a sentence and several short queries; they run at once. Returns pages with the relevant excerpts.",
				parameters: Type.Object({
					objective: Type.String({ description: "What you're trying to find out, and any freshness or source preferences" }),
					queries: Type.Array(Type.String(), { description: "2–5 keyword queries" }),
				}),
				replay: "safe",
				execute: async (args, _api, context) => {
					const { mode, maxResults } = host.settings.options("web", DEFAULTS);
					const result = await request("/search", { objective: args.objective, search_queries: args.queries, mode, advanced_settings: { max_results: Number(maxResults) } }, context.abortSignal);
					const pages = (result.results ?? []) as Page[];
					return text(pages.length === 0 ? "No results." : render(pages));
				},
			}),
			defineTool({
				name: "web_fetch",
				description: "Read web pages. With an objective, returns the relevant passages; with full: true, the whole page as markdown.",
				parameters: Type.Object({
					urls: Type.Array(Type.String()),
					objective: Type.Optional(Type.String()),
					full: Type.Optional(Type.Boolean()),
				}),
				replay: "safe",
				execute: async (args, _api, context) => {
					const full = args.full === true || args.objective === undefined;
					const result = await request(
						"/extract",
						{ urls: args.urls, ...(args.objective === undefined ? {} : { objective: args.objective }), advanced_settings: { full_content: full } },
						context.abortSignal,
					);
					const errors = ((result.errors ?? []) as Array<{ url: string; error_type: string }>).map((error) => `${error.url}: couldn't read (${error.error_type})`);
					return text([render((result.results ?? []) as Page[], full), ...errors].filter(Boolean).join("\n\n") || "Nothing read.");
				},
			}),
		],
	});

	return {
		...extension,
		title: "Web (Parallel)",
		about: "Web search and page reading through Parallel. Fast mode costs about $1 per 1000 searches.",
		settings: [
			{ key: "mode", label: "Search mode", kind: "choice", options: ["fast", "turbo", "advanced"] },
			{ key: "maxResults", label: "Results per search", kind: "number" },
			{ key: "apiKey", label: "Parallel API key", kind: "secret", env: "PARALLEL_API_KEY" },
		],
		defaults: DEFAULTS,
	};
}
