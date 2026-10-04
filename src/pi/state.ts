// Slice state as a Pi extension: open items and the working set as system-prompt sections (a mid-slice change is
// appended by Pi as a positional delta, so it doesn't break the cached prefix), tools to keep open items current,
// and the background summary that writes the working set when a slice is left.
import type { Message, Models } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import type { MemoryEdit } from "../core/portrait.ts";
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

const REFLECT_PROMPT = [
	"You are the reflective side of Darryl's chief of staff. A stretch of conversation just ended. Return JSON only:",
	'{"working_set": string, "memory_edits": [{"add": string} | {"replace": string, "with": string}]}.',
	"working_set: where the latest topic stands — options on the table (and ones rejected), constraints, decisions, the",
	"last open question. Keep what still matters from the previous working set; drop what's finished. Under 120 words.",
	"memory_edits: small changes to your memory of Darryl and his world, organized however serves you — anything you'd",
	"want to know in days, weeks or months: who he is, how he works, what he's in the middle of, people, plans, seasons.",
	"Write dates into the text. When something in memory is no longer true, replace it (e.g. past tense with when it",
	"ended) or remove it (replace with \"\"); `replace` must quote memory exactly. Only what the conversation supports;",
	"no how-to steps or rules (skills and behaviours hold those), nothing only relevant today, nothing already there.",
	"Keep memory under about 600 words: merge and compress when it grows. Most stretches need no edits: return [].",
].join(" ");

/** Serialize a slice's conversation as plain text for reflection. Tool traffic is cut short. */
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

export type Reflection = { workingSet?: string; memoryEdits: MemoryEdit[] };

/** One cheap call over the departing slice only (never the whole history): the new working set and memory edits. */
export async function reflectOnSlice(
	models: Models,
	choice: ModelChoice,
	input: { workingSet: string | undefined; memory: string; openItems: string | undefined; conversation: string; today: string },
): Promise<Reflection | undefined> {
	const model = models.getModel(choice.provider, choice.modelId);
	if (model === undefined) return undefined;
	const content = [
		`<today>${input.today}</today>`,
		`<memory>\n${input.memory || "(empty)"}\n</memory>`,
		`<open_items>\n${input.openItems ?? "(none)"}\n</open_items>`,
		`<previous_working_set>\n${input.workingSet ?? "(none)"}\n</previous_working_set>`,
		`<conversation>\n${input.conversation}\n</conversation>`,
	].join("\n");
	const answer = await models.completeSimple(model, { systemPrompt: REFLECT_PROMPT, messages: [{ role: "user", content, timestamp: Date.now() }] });
	if (answer.stopReason === "error") return undefined;
	const raw = answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
	const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
	try {
		const parsed = JSON.parse(json) as { working_set?: unknown; memory_edits?: unknown };
		const edits = Array.isArray(parsed.memory_edits) ? parsed.memory_edits : [];
		return {
			...(typeof parsed.working_set === "string" && parsed.working_set.trim() !== "" ? { workingSet: parsed.working_set.trim() } : {}),
			memoryEdits: edits.flatMap((edit): MemoryEdit[] => {
				if (typeof edit !== "object" || edit === null) return [];
				const { add, replace, with: replacement } = edit as Record<string, unknown>;
				if (typeof add === "string") return [{ add }];
				if (typeof replace === "string" && typeof replacement === "string") return [{ replace, with: replacement }];
				return [];
			}),
		};
	} catch {
		return undefined;
	}
}
