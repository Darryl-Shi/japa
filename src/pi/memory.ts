// Memory as an extension: the agent's memory of the user in the chief of staff's prompt, and, when an exchange with
// the user ends, a reflection that keeps memory current and short. `remember` is for when the user asks. Turned off,
// all of it stops: no section, no tool, no edits. The formats live in src/core.
import { type Models, Type } from "@earendil-works/pi-ai";
import { type MemoryEdit, type MemoryFile, wordCount } from "../core/memory.ts";
import type { ModelChoice } from "../settings.ts";
import type { ExchangeEnd, ExtensionFactory } from "./extension.ts";
import { reasoningOf } from "./models.ts";
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

/** How long memory may get, in words, unless its settings say. */
export const WORDS = 300;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

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
	const answer = await models.completeSimple(model, { systemPrompt: reflectPrompt(wordCount(input.memory), input.words), messages: [{ role: "user", content, timestamp: Date.now() }] }, reasoningOf(models, choice));
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

/** `log`: the core's log. */
export const memoryExtension =
	(memory: MemoryFile, log: (line: string) => void = () => {}): ExtensionFactory =>
	(pi) => {
		pi.registerFlag("words", { description: "How long memory may get (words)", type: "string", default: String(WORDS) });
		const words = () => Number(pi.getFlag("words")) || WORDS;

		pi.on("before_agent_start", (event, ctx) => {
			if (ctx.agent !== "chief") return;
			event.systemPromptOptions.sections.memory_guide = GUIDE;
			const remembered = memory.read();
			if (remembered !== "") event.systemPromptOptions.sections.memory = remembered;
		});

		pi.registerTool({
			name: "remember",
			label: "Remember",
			description: "When the user asks: add something to your memory, or correct it. To correct or forget, pass the exact existing text as `replaces` (an empty `note` forgets it).",
			parameters: Type.Object({ note: Type.String(), replaces: Type.Optional(Type.String()) }),
			// Only its own memory of the user.
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			execute: async (_id, args) => {
				const current = memory.read();
				if (args.replaces === undefined && current.includes(args.note.trim())) return text("Already in memory.");
				if (args.replaces !== undefined && !current.includes(args.replaces)) return text("That text isn't in memory; read <memory> and quote it exactly.");
				const edit = args.replaces === undefined ? { add: args.note } : { replace: args.replaces, with: args.note };
				if (memory.apply([edit], "conversation", { words: words() }).length > 0) return text("Saved.");
				return text(`Memory is full (${wordCount(current)} of ${words()} words): make room first by merging or removing something (remember with \`replaces\`).`);
			},
		});

		pi.on("exchange_end", async (exchange, ctx) => {
			const edits = await reflectOnMemory(ctx.modelRegistry, pi.getSettings().model, { memory: memory.read(), words: words(), ...exchange });
			const applied = memory.apply(edits, "reflection", { words: words() });
			if (applied.length > 0) log(`memory: ${applied.length} edit(s) from reflection`);
		});
	};
