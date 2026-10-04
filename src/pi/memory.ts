// Memory as an extension: the agent's memory of the user in the system prompt, `remember` to record into it, cited
// search over everything said before, and, when a slice ends, a reflection that keeps memory current from what was
// said in passing. Turned off, all of it stops: no section, no tools, no edits. The formats live in src/core.
import type { Context } from "@earendil-works/chord";
import { type Models, Type } from "@earendil-works/pi-ai";
import { type Conversation, defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import type { History, HistoryLine, HistoryHit } from "../core/history.ts";
import type { MemoryEdit, Portrait } from "../core/portrait.ts";
import type { ModelChoice } from "../settings.ts";
import type { Host, JarvisExtension, SliceEnd } from "./extension.ts";
import { parseJson } from "./state.ts";

const GUIDE = [
	"<memory> is your own memory of the user and their world, organized however serves you: who they are and how they work,",
	"what they're in the middle of, people, plans, this week or this season — whatever you'd want to know weeks from now.",
	"When they tell you something worth keeping, call remember and end your reply with one line: \"Noted: …\". Write dates",
	"into the text (\"until Oct 14\", \"since early Sept\"), and when something stops being true, correct it rather than",
	"adding a contradiction. Memory is also kept up in the background after each stretch of conversation. For anything",
	"said before, call search_history and cite the date, e.g. \"(from our Sep 12 chat)\".",
].join(" ");

const REFLECT_PROMPT = [
	"You are the reflective side of the user's chief of staff. A stretch of conversation just ended. Return JSON only:",
	'{"memory_edits": [{"add": string} | {"replace": string, "with": string}]}: small changes to your memory of the user',
	"and their world, organized however serves you — anything you'd want to know in days, weeks or months: who they are,",
	"how they work, what they're in the middle of, people, plans, seasons. Write dates into the text. When something in",
	"memory is no longer true, replace it (e.g. past tense with when it ended) or remove it (replace with \"\"); `replace`",
	"must quote memory exactly. Only what the conversation supports; no how-to steps or rules, nothing only relevant",
	"today, nothing already there. Keep memory under about 600 words: merge and compress when it grows. Most stretches",
	"need no edits: return [].",
].join(" ");

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/** The tools and sections: `search` finds earlier lines of the main conversation (the core keeps that record). */
export function memoryTools(options: { portrait: Portrait; search: (query: string, context: Context) => Promise<HistoryHit[]> }): Extension {
	const { portrait } = options;
	return defineExtension({
		name: "jarvis.memory",
		sections: [section("memory_guide", () => GUIDE, { tag: false }), section("memory", () => portrait.read() || undefined)],
		tools: [
			defineTool({
				name: "remember",
				description: "Add something to your memory, or correct it. To correct or forget, pass the exact existing text as `replaces` (an empty `note` forgets it).",
				parameters: Type.Object({ note: Type.String(), replaces: Type.Optional(Type.String()) }),
				execute: async (args) => {
					const edit = args.replaces === undefined ? { add: args.note } : { replace: args.replaces, with: args.note };
					return text(portrait.apply([edit], "conversation").length > 0 ? "Saved." : args.replaces === undefined ? "Already in memory." : "That text isn't in memory; read <memory> and quote it exactly.");
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

/** One cheap call over the departing slice: small edits to memory. */
export async function reflectOnMemory(models: Models, choice: ModelChoice, input: { memory: string } & SliceEnd): Promise<MemoryEdit[]> {
	const model = models.getModel(choice.provider, choice.modelId);
	if (model === undefined) return [];
	const content = [
		`<today>${input.today}</today>`,
		`<memory>\n${input.memory || "(empty)"}\n</memory>`,
		`<open_items>\n${input.openItems ?? "(none)"}\n</open_items>`,
		`<conversation>\n${input.conversation}\n</conversation>`,
	].join("\n");
	const answer = await models.completeSimple(model, { systemPrompt: REFLECT_PROMPT, messages: [{ role: "user", content, timestamp: Date.now() }] });
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

export function memoryExtension(host: Host, portrait: Portrait): JarvisExtension {
	return {
		name: "memory",
		title: "Memory",
		about: `Its memory of you (${portrait.path}, yours to edit), search over everything said before, and reflection after each conversation.`,
		safeTools: ["remember", "search_history"],
		chief: [memoryTools({ portrait, search: (query, context) => host.searchHistory(query, context) })],
		onSliceEnd: async (slice) => {
			const edits = await reflectOnMemory(host.models, host.settings.get().model, { memory: portrait.read(), ...slice });
			const applied = portrait.apply(edits, "reflection");
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
