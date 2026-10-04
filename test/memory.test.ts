import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { History } from "../src/core/history.ts";
import { Portrait } from "../src/core/portrait.ts";
import { MainThread } from "../src/pi/harness.ts";
import { indexHistory, memoryExtension } from "../src/pi/memory.ts";
import { DEFAULTS } from "../src/settings.ts";

const context = BACKGROUND_CONTEXT;
const settings = () => ({ ...DEFAULTS, model: { provider: "faux", modelId: "faux-1" } });

test("the portrait records, corrects and forgets", async () => {
	const home = await mkdtemp(join(tmpdir(), "jarvis-home-"));
	const portrait = new Portrait(home);
	portrait.remember("Sister: Mia");
	portrait.remember("Terse when things are fine");
	portrait.remember("Sister: Mia, a nurse", "Sister: Mia");
	assert.equal(portrait.read(), "- Sister: Mia, a nurse\n- Terse when things are fine");
	portrait.remember("", "Terse when things are fine");
	assert.equal(portrait.read(), "- Sister: Mia, a nurse");
	assert.throws(() => portrait.remember("x", "not there"));
	await rm(home, { recursive: true, force: true });
});

test("the agent remembers into its prompt and finds earlier slices in history, with dates", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "jarvis-"));
	const home = await mkdtemp(join(tmpdir(), "jarvis-home-"));
	const history = new History(join(dataDir, "history.sqlite"));
	const portrait = new Portrait(home);
	let thread: MainThread | undefined;
	const memory = memoryExtension({ portrait, history, catchUp: (callContext) => indexHistory(thread!.root, history, callContext) });

	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const script = [
		fauxAssistantMessage(fauxToolCall("remember", { note: "Sister: Mia" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Noted: your sister is Mia."),
		fauxAssistantMessage("Pricing stays at $29 until launch."),
		fauxAssistantMessage("filler ".repeat(5000)),
		fauxAssistantMessage(fauxToolCall("search_history", { query: "pricing launch" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Hold at $29 until launch (from our earlier chat)."),
	];
	const respond: FauxResponseFactory = (request) =>
		JSON.stringify(request).includes("<conversation>") ? fauxAssistantMessage("Handoff: nothing open.") : (script.shift() ?? fauxAssistantMessage("?"));
	faux.setResponses(Array.from({ length: 12 }, () => respond));

	thread = await MainThread.open({ dataDir, models, settings, installed: [memory] }, context);
	const target = { chatId: 1, messageId: 1 };
	await thread.ask("1", "My sister is Mia.", target, context);
	assert.equal(portrait.read(), "- Sister: Mia");

	await thread.ask("2", "What did we decide on pricing?", target, context);
	await thread.ask("2b", "Tell me something long.", target, context);

	// A new slice: the earlier entries leave the model's context but stay searchable.
	assert.deepEqual(await thread.ask("3", "Remind me about pricing?", target, context, { newTopic: true }), {
		text: "Hold at $29 until launch (from our earlier chat).",
	});
	const after = JSON.stringify((await thread.root.context(context)).messages);
	assert.ok(after.includes("Sister: Mia"), "the portrait is in the system prompt after compaction");
	assert.match(after, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} You: «Pricing» stays at \$29 until «launch»/);

	await thread.close(context);
	history.close();
	await rm(dataDir, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
});

test("reflection keeps memory current from what was said in passing, and marks what stopped being true", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "jarvis-"));
	const home = await mkdtemp(join(tmpdir(), "jarvis-home-"));
	const portrait = new Portrait(home);
	portrait.remember("Runs two LLM research labs.");
	const { OpenItems, WorkingSetFile } = await import("../src/core/state.ts");
	const state = { openItems: new OpenItems(join(dataDir, "o.json")), workingSet: new WorkingSetFile(join(dataDir, "w.json")), memory: portrait };
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const reflections = [
		{ working_set: "Booking dinner.", memory_edits: [{ add: "In Tokyo for the launch until Oct 14 (on Japan time)." }] },
		{ working_set: "Back home.", memory_edits: [{ replace: "In Tokyo for the launch until Oct 14 (on Japan time).", with: "Was in Tokyo for the launch, early to mid Oct 2026." }, { replace: "not in memory", with: "x" }] },
	];
	const respond: FauxResponseFactory = (request) =>
		JSON.stringify(request).includes("<previous_working_set>") ? fauxAssistantMessage(JSON.stringify(reflections.shift())) : fauxAssistantMessage("ok");
	faux.setResponses(Array.from({ length: 20 }, () => respond));
	const thread = await MainThread.open({ dataDir, models, settings, state }, context);
	const target = { chatId: 1, messageId: 1 };

	await thread.ask("1", "[Mon 6 Oct 09:00] book dinner, I'm in Tokyo till the 14th", target, context);
	await thread.ask("2", "[Wed 15 Oct 09:00] back home now", target, context, { newTopic: true });
	await thread.settled();
	assert.match(portrait.read(), /- In Tokyo for the launch until Oct 14/);

	await thread.ask("3", "[Wed 15 Oct 10:00] something else", target, context, { newTopic: true });
	await thread.settled();
	assert.equal(portrait.read(), "- Runs two LLM research labs.\n- Was in Tokyo for the launch, early to mid Oct 2026.");
	// Every change is logged for the weekly check-in; an edit quoting text that isn't there is skipped, not guessed.
	const log = (await import("node:fs")).readFileSync(join(home, "memory-changes.jsonl"), "utf8").trim().split("\n");
	assert.equal(log.length, 2);
	await thread.close(context);
	await rm(dataDir, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
});
