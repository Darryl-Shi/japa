// Slice state as a Pi extension: open items and the working set as system-prompt sections (a mid-slice change is
// appended by Pi as a positional delta, so it doesn't break the cached prefix), tools to keep open items current,
// and the background summary that writes the working set when a slice is left.
import type { Message, Models } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import type { OpenItems, WorkingSetFile } from "../core/state.ts";
import type { ModelChoice } from "../settings.ts";
import { reasoningOf } from "./models.ts";

const GUIDE = [
	"<open_items> lists what is still open: tasks in flight, things waiting on the user, promises you made. When you",
	"promise something, ask them something that needs an answer, or start work that will report back, call track; when",
	"it's done or answered, call resolve. <working_set> is where the last topic stood. Earlier turns are not in your",
	"context: if they refer to something you can't see, look it up; if it's still ambiguous and matters, ask.",
].join(" ");

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export function stateExtension(options: { openItems: OpenItems; workingSet: WorkingSetFile }): Extension {
	const { openItems, workingSet } = options;
	return defineExtension({
		name: "japa.state",
		sections: [
			section("state_guide", () => GUIDE, { tag: false }),
			section("open_items", () => openItems.projection()),
			section("working_set", () => workingSet.read()?.text),
		],
		tools: [
			defineTool({
				name: "track",
				description: "Add an open item: task (work in flight), waiting (a question or proposal waiting on the user), or promise (something you said you'd do). Not for a job: delegate tracks it already.",
				parameters: Type.Object({ kind: Type.Union([Type.Literal("task"), Type.Literal("waiting"), Type.Literal("promise")]), text: Type.String() }),
				execute: async (args) => text(`Tracked as ${openItems.add(args.kind, args.text).id}.`),
			}),
			defineTool({
				name: "resolve",
				description: "Close an open item by id once it's done, answered, or no longer relevant. A job's item closes by itself when the job reports done.",
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
	"You keep the working set for the user's chief of staff. A stretch of conversation just ended. Return JSON only:",
	'{"working_set": string}: where the latest topic stands — options on the table (and ones rejected), constraints,',
	"decisions, the last open question. Keep what still matters from the previous working set; drop what's finished.",
	"Under 120 words.",
].join(" ");

/** A slice's conversation as plain text, for the working set and the exchange's reflection. Tool traffic is cut short. */
export function transcriptText(messages: readonly Message[]): string {
	return messages
		.flatMap((message) => {
			if (message.role === "system") return [];
			const content = typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
			if (content.trim() === "") return [];
			const who = message.role === "user" ? "User" : message.role === "assistant" ? "You" : "Tool";
			return [`${who}: ${message.role === "toolResult" ? content.slice(0, 300) : content}`];
		})
		.join("\n");
}

/** One cheap call over the departing slice only (never the whole history): the new working set. */
export async function summarizeSlice(
	models: Models,
	choice: ModelChoice | undefined,
	input: { workingSet: string | undefined; openItems: string | undefined; conversation: string; today: string },
): Promise<string | undefined> {
	const model = choice === undefined ? undefined : models.getModel(choice.provider, choice.modelId);
	if (model === undefined) return undefined;
	const content = [
		`<today>${input.today}</today>`,
		`<open_items>\n${input.openItems ?? "(none)"}\n</open_items>`,
		`<previous_working_set>\n${input.workingSet ?? "(none)"}\n</previous_working_set>`,
		`<conversation>\n${input.conversation}\n</conversation>`,
	].join("\n");
	const answer = await models.completeSimple(model, { systemPrompt: SUMMARY_PROMPT, messages: [{ role: "user", content, timestamp: Date.now() }] }, reasoningOf(models, choice));
	if (answer.stopReason === "error") return undefined;
	const parsed = parseJson(answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""));
	const text = parsed?.working_set;
	return typeof text === "string" && text.trim() !== "" ? text.trim() : undefined;
}

/** The JSON object in a model's answer, if there is one. */
export function parseJson(raw: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}
