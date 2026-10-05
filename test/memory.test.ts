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
import { indexHistory, memoryExtension, memoryTools } from "../src/pi/memory.ts";
import { agent } from "./helpers.ts";
import { DEFAULTS } from "../src/settings.ts";

const context = BACKGROUND_CONTEXT;
const settings = () => ({ ...DEFAULTS, model: { provider: "faux", modelId: "faux-1" } });

test("the portrait records, corrects and forgets", async () => {
	const home = await mkdtemp(join(tmpdir(), "japa-home-"));
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

test("memory stays within its size: past the limit, only what makes room gets in", async () => {
	const home = await mkdtemp(join(tmpdir(), "japa-home-"));
	const portrait = new Portrait(home);
	assert.equal(portrait.apply([{ add: "one two three" }], "test", { words: 5 }).length, 1);
	assert.equal(portrait.apply([{ add: "four five six" }], "test", { words: 5 }).length, 0, "an addition past the limit is refused");
	assert.equal(portrait.apply([{ replace: "one two three", with: "one two three four five six" }], "test", { words: 5 }).length, 0, "so is a correction that grows past it");
	// Corrections go first, so one that makes room lets an addition in.
	assert.equal(portrait.apply([{ add: "four five" }, { replace: "one two three", with: "one" }], "test", { words: 5 }).length, 2);
	assert.equal(portrait.read(), "- one\n- four five");
	await rm(home, { recursive: true, force: true });
});

test("the agent remembers into its prompt and finds earlier slices in history, with dates", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "japa-"));
	const home = await mkdtemp(join(tmpdir(), "japa-home-"));
	const history = new History(join(dataDir, "history.sqlite"));
	const portrait = new Portrait(home);
	let thread: MainThread | undefined;
	const memory = memoryTools({
		portrait,
		search: async (query, callContext) => {
			await indexHistory(thread!.root, history, callContext);
			return history.search(query);
		},
	});

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
	const target = { channel: "test", chatId: "1", messageId: "1" };
	await thread.ask("1", "Remember that my sister is Mia.", target, context);
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

test("reflection (the memory extension's exchange-end hook) keeps memory current, and marks what stopped being true; turned off, it edits nothing", async () => {
	const home = await mkdtemp(join(tmpdir(), "japa-home-"));
	const portrait = new Portrait(home);
	portrait.remember("Runs two LLM research labs.");
	const reflections = [
		[{ add: "In Tokyo for the launch until Oct 14 (on Japan time)." }],
		[{ replace: "In Tokyo for the launch until Oct 14 (on Japan time).", with: "Was in Tokyo for the launch, early to mid Oct 2026." }, { replace: "not in memory", with: "x" }],
		[{ add: "Should never be written." }],
	];
	const h = await agent({
		extensions: (host) => [memoryExtension(host, portrait)],
		script: (turn) => (turn.request.includes("reflective side") ? fauxAssistantMessage(JSON.stringify({ memory_edits: reflections.shift() })) : fauxAssistantMessage("ok")),
	});

	await h.ask("1", "[Mon 6 Oct 09:00] book dinner, I'm in Tokyo till the 14th");
	await h.ask("2", "[Wed 15 Oct 09:00] back home now", 2, { newTopic: true });
	await h.thread.settled();
	assert.match(portrait.read(), /- In Tokyo for the launch until Oct 14/);

	await h.ask("3", "[Wed 15 Oct 10:00] something else", 3, { newTopic: true });
	await h.thread.settled();
	assert.equal(portrait.read(), "- Runs two LLM research labs.\n- Was in Tokyo for the launch, early to mid Oct 2026.");
	// Every change is logged for the weekly check-in; an edit quoting text that isn't there is skipped, not guessed.
	const log = (await import("node:fs")).readFileSync(join(home, "memory-changes.jsonl"), "utf8").trim().split("\n");
	assert.equal(log.length, 2);

	// Off: no section, no tools, and no reflection.
	h.settings.setOption("memory", "enabled", false);
	await h.ask("4", "[Wed 15 Oct 11:00] I moved to Lisbon", 4, { newTopic: true });
	await h.ask("5", "[Wed 15 Oct 12:00] ok", 5, { newTopic: true });
	await h.thread.settled();
	assert.ok(!portrait.read().includes("Should never"), "memory untouched while off");
	assert.equal(reflections.length, 1, "the reflection wasn't even asked");
	assert.ok(!(await h.thread.root.agent(context)).tools.some((tool) => tool.name === "remember"));
	await h.done();
	await rm(home, { recursive: true, force: true });
});

test("reflection waits for the exchange to end: a slice cut for size isn't one, and the reflection sees all of it", async () => {
	const home = await mkdtemp(join(tmpdir(), "japa-home-"));
	const portrait = new Portrait(home);
	const asked: string[] = [];
	const h = await agent({
		settings: { context: { idleMinutes: 60, sliceTokens: 200 } },
		extensions: (host) => [memoryExtension(host, portrait)],
		script: (turn) => {
			if (!turn.request.includes("reflective side")) return fauxAssistantMessage("ok");
			asked.push(turn.request);
			return fauxAssistantMessage(JSON.stringify({ memory_edits: [] }));
		},
	});
	const long = "plans ".repeat(300).trim();
	await h.ask("1", `[Mon 6 Oct 09:00] I'm in Tokyo till the 14th. ${long}`);
	await h.ask("2", "[Mon 6 Oct 09:05] and the launch is on the 10th", 2);
	await h.thread.settled();
	assert.ok(!JSON.stringify((await h.thread.root.context(context)).messages).includes(long), "the first slice was cut for size");
	assert.equal(asked.length, 0, "cut for size mid-exchange: no reflection yet");

	await h.ask("3", "[Mon 6 Oct 11:00] something else", 3, { newTopic: true });
	await h.thread.settled();
	assert.equal(asked.length, 1);
	// The first slice in full (a new slice's handoff only quotes the start of a long message), and the second.
	assert.ok(asked[0]!.includes(long) && asked[0]!.includes("the launch is on the 10th"));
	await h.done();
	await rm(home, { recursive: true, force: true });
});
