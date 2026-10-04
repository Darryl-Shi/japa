// Slice state as a Pi extension: open items and the working set as system-prompt sections (a mid-slice change is
// appended by Pi as a positional delta, so it doesn't break the cached prefix), tools to keep open items current,
// and the background summary that writes the working set when a slice is left.
import type { Message, Models } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import type { OpenItems, WorkingSetFile } from "../core/state.ts";
import type { ModelChoice } from "../settings.ts";

const GUIDE = [
	"<open_items> lists what is still open: tasks in flight, things waiting on Darryl, promises you made. When you",
	"promise something, ask him something that needs an answer, or start work that will report back, call track; when",
	"it's done or answered, call resolve. <working_set> is where the last topic stood. Earlier turns are not in your",
	"context: if he refers to something you can't see, call search_history; if it's still ambiguous and matters, ask.",
].join(" ");

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export function stateExtension(options: { openItems: OpenItems; workingSet: WorkingSetFile }): Extension {
	const { openItems, workingSet } = options;
	return defineExtension({
		name: "jarvis.state",
		sections: [
			section("state_guide", () => GUIDE, { tag: false }),
			section("open_items", () => openItems.projection()),
			section("working_set", () => workingSet.read()?.text),
		],
		tools: [
			defineTool({
				name: "track",
				description: "Add an open item: task (work in flight), waiting (a question or proposal waiting on Darryl), or promise (something you said you'd do).",
				parameters: Type.Object({ kind: Type.Union([Type.Literal("task"), Type.Literal("waiting"), Type.Literal("promise")]), text: Type.String() }),
				execute: async (args) => text(`Tracked as ${openItems.add(args.kind, args.text).id}.`),
			}),
			defineTool({
				name: "resolve",
				description: "Close an open item by id once it's done, answered, or no longer relevant.",
				parameters: Type.Object({ id: Type.String(), outcome: Type.Optional(Type.String()) }),
				execute: async (args) => {
					openItems.close(args.id, args.outcome);
					return text("Resolved.");
				},
			}),
			defineTool({
				name: "list_open_items",
				description: "Every open item, including older tasks left out of <open_items>.",
				parameters: Type.Object({}),
				execute: async () => text(openItems.open().map((item) => `${item.id} [${item.kind}] ${item.text}`).join("\n") || "Nothing open."),
			}),
		],
	});
}

const SUMMARY_PROMPT = [
	"You keep the working set for a chief of staff's chat with Darryl. Given the previous working set and the latest",
	"stretch of conversation, write the new working set: where the current topic stands — options on the table (and",
	"ones rejected), constraints, decisions made, and the last open question. Keep what still matters from the",
	"previous one; drop what's finished. No timestamps, no narrative of who said what. Under 120 words.",
].join(" ");

/** Serialize a slice's conversation as plain text for the summarizer. Tool traffic is cut short. */
export function transcriptText(messages: readonly Message[]): string {
	return messages
		.flatMap((message) => {
			if (message.role === "system") return [];
			const content = typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
			if (content.trim() === "") return [];
			const who = message.role === "user" ? "Darryl" : message.role === "assistant" ? "You" : "Tool";
			return [`${who}: ${message.role === "toolResult" ? content.slice(0, 300) : content}`];
		})
		.join("\n");
}

/** One cheap call over the departing slice only, never the whole history. */
export async function summarizeSlice(models: Models, choice: ModelChoice, previous: string | undefined, conversation: string): Promise<string | undefined> {
	const model = models.getModel(choice.provider, choice.modelId);
	if (model === undefined) return undefined;
	const answer = await models.completeSimple(model, {
		systemPrompt: SUMMARY_PROMPT,
		messages: [{ role: "user", content: `<previous>\n${previous ?? "(none)"}\n</previous>\n<conversation>\n${conversation}\n</conversation>`, timestamp: Date.now() }],
	});
	if (answer.stopReason === "error") return undefined;
	return answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("").trim() || undefined;
}
