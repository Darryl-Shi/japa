// Memory as a Pi extension: the portrait in the system prompt, a tool to record into it, and cited search over
// everything said before. The formats live in src/core.
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { type Conversation, defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import type { History, HistoryLine } from "../core/history.ts";
import type { Portrait } from "../core/portrait.ts";

const GUIDE = [
	"<memory> is your portrait of Darryl: a few facts and, mostly, the nuances of how he is. When you learn something",
	"worth keeping across months, call remember, then say it in one line at the end of your reply: \"Noted: …\". Don't",
	"record what happened (history search finds that), how-to steps, or anything temporary. For anything from earlier",
	"conversations, call search_history and cite the date, e.g. \"(from our Sep 12 chat)\".",
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
				description: "Record a fact or nuance about Darryl in your portrait of him, or correct one. To correct or forget, pass the exact existing text as `replaces` (an empty `note` forgets it).",
				parameters: Type.Object({ note: Type.String(), replaces: Type.Optional(Type.String()) }),
				execute: async (args) => {
					portrait.remember(args.note, args.replaces);
					return text("Saved.");
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
