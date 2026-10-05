// The record of the conversation, searchable: every line said to and by the chief of staff, indexed from the
// transcript (compacted entries stay in storage, so they're found too), and the search_history tool over it. Part of
// the core: the record is the core's.
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { type Conversation, defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { History, HistoryHit, HistoryLine } from "../core/history.ts";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/** Index transcript entries the search has not seen yet. */
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

/** search_history, over `search` (the main conversation's record). */
export function historyExtension(search: (query: string, context: Context) => Promise<HistoryHit[]>): Extension {
	return defineExtension({
		name: "jarvis.history",
		tools: [
			defineTool({
				name: "search_history",
				description: "Full-text search over everything said in earlier conversations with the user. Returns dated snippets; cite the date.",
				parameters: Type.Object({ query: Type.String({ description: "Distinctive words likely to appear in the messages" }) }),
				replay: "safe",
				execute: async (args, _api, context) => {
					const hits = await search(args.query, context);
					if (hits.length === 0) return text("No matches.");
					return text(hits.map((hit) => `${new Date(hit.at).toISOString().slice(0, 16).replace("T", " ")} ${hit.role === "user" ? "User" : "You"}: ${hit.snippet}`).join("\n"));
				},
			}),
		],
	});
}
