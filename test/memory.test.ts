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

	thread = await MainThread.open({ dataDir, models, settings, extensions: [memory] }, context);
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
	assert.match(after, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} you: «Pricing» stays at \$29 until «launch»/);

	await thread.close(context);
	history.close();
	await rm(dataDir, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
});
