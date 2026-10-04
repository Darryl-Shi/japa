// Memory as a Pi extension: the portrait in the system prompt, a tool to record into it, and cited search over
// everything said before. The formats live in src/core.
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { type Conversation, defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import type { History, HistoryLine } from "../core/history.ts";
import type { Portrait } from "../core/portrait.ts";

const GUIDE = [
	"<memory> is your own memory of Darryl and his world, organized however serves you: who he is and how he works,",
	"what he's in the middle of, people, plans, this week or this season — whatever you'd want to know weeks from now.",
	"When he tells you something worth keeping, call remember and end your reply with one line: \"Noted: …\". Write dates",
	"into the text (\"until Oct 14\", \"since early Sept\"), and when something stops being true, correct it rather than",
	"adding a contradiction. Memory is also kept up in the background after each stretch of conversation. For anything",
	"said before, call search_history and cite the date, e.g. \"(from our Sep 12 chat)\".",
].join(" ");

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export function memoryExtension(options: { portrait: Portrait; history: History; catchUp: (context: Context) => Promise<void> }): Extension {
	const { portrait, history } = options;
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
				description: "Full-text search over everything said in earlier conversations with Darryl. Returns dated snippets; cite the date.",
				parameters: Type.Object({ query: Type.String({ description: "Distinctive words likely to appear in the messages" }) }),
				replay: "safe",
				execute: async (args, _api, context) => {
					await options.catchUp(context);
					const hits = history.search(args.query);
					if (hits.length === 0) return text("No matches.");
					return text(hits.map((hit) => `${new Date(hit.at).toISOString().slice(0, 16).replace("T", " ")} ${hit.role === "user" ? "Darryl" : "you"}: ${hit.snippet}`).join("\n"));
				},
			}),
		],
	});
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
			if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant" && entry.kind !== "jarvis.report") continue;
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
