// Memory as an extension: the agent's memory of the user in the system prompt, cited search over everything said
// before, and, when an exchange with the user ends, a reflection that keeps memory current and short. `remember` is for
// when the user asks. Turned off, all of it stops: no section, no tools, no edits. The formats live in src/core.
import type { Context } from "@earendil-works/chord";
import { type Models, Type } from "@earendil-works/pi-ai";
import { type Conversation, defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import type { History, HistoryLine, HistoryHit } from "../core/history.ts";
import { type MemoryEdit, type Portrait, wordCount } from "../core/portrait.ts";
import type { ModelChoice } from "../settings.ts";
import type { ExchangeEnd, Host, JapaExtension } from "./extension.ts";
import { parseJson } from "./state.ts";

const GUIDE = [
	"<memory> is your own memory of the user and their world. It's kept up in the background after each exchange, so",
	"don't record things as you go: call remember only when the user asks you to remember, correct or forget something.",
	"For anything said before, call search_history and cite the date, e.g. \"(from our Sep 12 chat)\".",
].join(" ");

const reflectPrompt = (words: number, limit: number) =>
	[
		"You are the reflective side of the user's chief of staff. An exchange with the user just ended. Return JSON only:",
		'{"memory_edits": [{"add": string} | {"replace": string, "with": string}]}: changes to your memory of the user and',
		"their world. Memory holds only what would change how you help them weeks from now: who they are, how they work,",
		"the people in their life, their commitments and plans. Not what matters only today, what open items already",
		"track, how-to steps or rules, or anything already there. Write dates into the text. When something in memory",
		'stopped being true, replace it (past tense, with when it ended) or remove it (replace with ""); `replace` must',
		"quote memory exactly. Sharpen or merge an existing line rather than add one. Memory is",
		`${words} of at most ${limit} words; an addition past that is refused unless your replacements make room.`,
		"Most exchanges need no edits: return []. Never more than a few.",
	].join(" ");

/** Its settings when settings.json says nothing. */
export const DEFAULTS = { words: 300 };

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/**
 * The tools and sections: `search` finds earlier lines of the main conversation (the core keeps that record); `words`
 * is how long memory may get.
 */
export function memoryTools(options: { portrait: Portrait; search: (query: string, context: Context) => Promise<HistoryHit[]>; words?: () => number }): Extension {
	const { portrait } = options;
	return defineExtension({
		name: "memory",
		sections: [section("memory_guide", () => GUIDE, { tag: false }), section("memory", () => portrait.read() || undefined)],
		tools: [
			defineTool({
				name: "remember",
				description: "When the user asks: add something to your memory, or correct it. To correct or forget, pass the exact existing text as `replaces` (an empty `note` forgets it).",
				parameters: Type.Object({ note: Type.String(), replaces: Type.Optional(Type.String()) }),
				execute: async (args) => {
					const current = portrait.read();
					if (args.replaces === undefined && current.includes(args.note.trim())) return text("Already in memory.");
					if (args.replaces !== undefined && !current.includes(args.replaces)) return text("That text isn't in memory; read <memory> and quote it exactly.");
					const edit = args.replaces === undefined ? { add: args.note } : { replace: args.replaces, with: args.note };
					const words = options.words?.();
					if (portrait.apply([edit], "conversation", words === undefined ? {} : { words }).length > 0) return text("Saved.");
					return text(`Memory is full (${wordCount(current)} of ${words} words): make room first by merging or removing something (remember with \`replaces\`).`);
				},
			}),
			defineTool({
				name: "search_history",
				description: "Full-text search over everything said in earlier conversations with the user. Returns dated snippets; cite the date.",
				parameters: Type.Object({ query: Type.String({ description: "Distinctive words likely to appear in the messages" }) }),
				replay: "safe",
				execute: async (args, _api, context) => {
					const hits = await options.search(args.query, context);
					if (hits.length === 0) return text("No matches.");
					return text(hits.map((hit) => `${new Date(hit.at).toISOString().slice(0, 16).replace("T", " ")} ${hit.role === "user" ? "User" : "You"}: ${hit.snippet}`).join("\n"));
				},
			}),
		],
	});
}

/** One cheap call over the exchange that ended: small edits to memory, if any. */
export async function reflectOnMemory(models: Models, choice: ModelChoice | undefined, input: { memory: string; words: number } & ExchangeEnd): Promise<MemoryEdit[]> {
	const model = choice === undefined ? undefined : models.getModel(choice.provider, choice.modelId);
	if (model === undefined) return [];
	const content = [
		`<today>${input.today}</today>`,
		`<memory>\n${input.memory || "(empty)"}\n</memory>`,
		`<open_items>\n${input.openItems ?? "(none)"}\n</open_items>`,
		`<conversation>\n${input.conversation}\n</conversation>`,
	].join("\n");
	const answer = await models.completeSimple(model, { systemPrompt: reflectPrompt(wordCount(input.memory), input.words), messages: [{ role: "user", content, timestamp: Date.now() }] });
	if (answer.stopReason === "error") return [];
	const edits = parseJson(answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""))?.memory_edits;
	if (!Array.isArray(edits)) return [];
	return edits.flatMap((edit): MemoryEdit[] => {
		if (typeof edit !== "object" || edit === null) return [];
		const { add, replace, with: replacement } = edit as Record<string, unknown>;
		if (typeof add === "string") return [{ add }];
		if (typeof replace === "string" && typeof replacement === "string") return [{ replace, with: replacement }];
		return [];
	});
}

export function memoryExtension(host: Host, portrait: Portrait): JapaExtension {
	const words = () => Number(host.settings.options("memory", DEFAULTS).words) || DEFAULTS.words;
	return {
		...memoryTools({ portrait, search: (query, context) => host.searchHistory(query, context), words }),
		title: "Memory",
		about: `Its memory of you (${portrait.path}, yours to edit), kept short and current after each exchange, and search over everything said before.`,
		for: "chief",
		settings: [{ key: "words", label: "Memory size (words)", kind: "number" }],
		defaults: DEFAULTS,
		safeTools: ["remember", "search_history"],
		onExchangeEnd: async (exchange) => {
			const edits = await reflectOnMemory(host.models, host.settings.get().model, { memory: portrait.read(), words: words(), ...exchange });
			const applied = portrait.apply(edits, "reflection", { words: words() });
			if (applied.length > 0) host.log(`memory: ${applied.length} edit(s) from reflection`);
		},
	};
}

/** Index transcript entries the search has not seen yet. Compacted entries stay in storage, so they are found too. */
export async function indexHistory(conversation: Conversation, history: History, context: Context): Promise<void> {
	const after = history.lastEntry();
	const lines: HistoryLine[] = [];
	let newest = after;
	let cursor: Parameters<Conversation["entries"]>[2];
	do {
		const page = await conversation.entries({ minEntryId: (after + 1) as never }, 200, cursor, context);
		for (const entry of page.items) {
			newest = Math.max(newest, entry.id);
			if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") continue;
			for (const message of entry.model ?? []) {
				if (message.role !== "user" && message.role !== "assistant") continue;
				const content = typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
				if (content.trim() !== "") lines.push({ entry: entry.id, at: message.timestamp, role: message.role, text: content });
			}
		}
		cursor = page.next;
	} while (cursor !== undefined);
	if (newest > after) history.add(lines, newest);
}
