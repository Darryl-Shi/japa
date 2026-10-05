import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { MemoryFile } from "../src/core/memory.ts";
import { memoryExtension } from "../src/pi/memory.ts";
import { agent, call, say } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

test("the memory records, corrects and forgets", async () => {
	const home = await mkdtemp(join(tmpdir(), "japa-home-"));
	const memory = new MemoryFile(home);
	memory.remember("Sister: Mia");
	memory.remember("Terse when things are fine");
	memory.remember("Sister: Mia, a nurse", "Sister: Mia");
	assert.equal(memory.read(), "- Sister: Mia, a nurse\n- Terse when things are fine");
	memory.remember("", "Terse when things are fine");
	assert.equal(memory.read(), "- Sister: Mia, a nurse");
	assert.throws(() => memory.remember("x", "not there"));
	await rm(home, { recursive: true, force: true });
});

test("memory stays within its size: past the limit, only what makes room gets in", async () => {
	const home = await mkdtemp(join(tmpdir(), "japa-home-"));
	const memory = new MemoryFile(home);
	assert.equal(memory.apply([{ add: "one two three" }], "test", { words: 5 }).length, 1);
	assert.equal(memory.apply([{ add: "four five six" }], "test", { words: 5 }).length, 0, "an addition past the limit is refused");
	assert.equal(memory.apply([{ replace: "one two three", with: "one two three four five six" }], "test", { words: 5 }).length, 0, "so is a correction that grows past it");
	// Corrections go first, so one that makes room lets an addition in.
	assert.equal(memory.apply([{ add: "four five" }, { replace: "one two three", with: "one" }], "test", { words: 5 }).length, 2);
	assert.equal(memory.read(), "- one\n- four five");
	await rm(home, { recursive: true, force: true });
});

test("the agent remembers into its prompt and finds earlier slices in history, with dates", async () => {
	const home = await mkdtemp(join(tmpdir(), "japa-home-"));
	const memory = new MemoryFile(home);
	const h = await agent({
		extensions: { memory: memoryExtension(memory) },
		script: (turn) => {
			if (turn.request.includes("reflective side")) return fauxAssistantMessage(JSON.stringify({ memory_edits: [] }));
			if (turn.text.includes("Remember that my sister")) return call("remember", { note: "Sister: Mia" });
			if (turn.text === "Saved.") return say("Got it: your sister is Mia.");
			if (turn.text.includes("What did we decide on pricing?")) return say("Pricing stays at $29 until launch.");
			if (turn.text.includes("Tell me something long.")) return say("filler ".repeat(5000));
			if (turn.text.includes("Remind me about pricing?")) return call("search_history", { query: "pricing launch" });
			if (turn.text.includes("«Pricing»")) return say("Hold at $29 until launch (from our earlier chat).");
			return say("?");
		},
	});
	await h.ask("1", "Remember that my sister is Mia.");
	assert.equal(memory.read(), "- Sister: Mia");

	await h.ask("2", "What did we decide on pricing?", 2);
	await h.ask("2b", "Tell me something long.", 3);

	// A new slice: the earlier entries leave the model's context but stay searchable.
	assert.deepEqual(await h.ask("3", "Remind me about pricing?", 4, { newTopic: true }), { text: "Hold at $29 until launch (from our earlier chat)." });
	const last = h.turns.at(-1)!;
	assert.ok(last.request.includes("Sister: Mia"), "the memory is in the system prompt after the new slice");
	assert.match(last.text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} You: «Pricing» stays at \$29 until «launch»/);
	await h.done();
	await rm(home, { recursive: true, force: true });
});

test("reflection (the memory extension's exchange-end hook) keeps memory current, and marks what stopped being true; turned off, it edits nothing", async () => {
	const home = await mkdtemp(join(tmpdir(), "japa-home-"));
	const memory = new MemoryFile(home);
	memory.remember("Runs two LLM research labs.");
	const reflections = [
		[{ add: "In Tokyo for the launch until Oct 14 (on Japan time)." }],
		[{ replace: "In Tokyo for the launch until Oct 14 (on Japan time).", with: "Was in Tokyo for the launch, early to mid Oct 2026." }, { replace: "not in memory", with: "x" }],
		[{ add: "Should never be written." }],
	];
	const h = await agent({
		extensions: { memory: memoryExtension(memory) },
		script: (turn) => (turn.request.includes("reflective side") ? fauxAssistantMessage(JSON.stringify({ memory_edits: reflections.shift() })) : fauxAssistantMessage("ok")),
	});

	await h.ask("1", "[Mon 6 Oct 09:00] book dinner, I'm in Tokyo till the 14th");
	await h.ask("2", "[Wed 15 Oct 09:00] back home now", 2, { newTopic: true });
	await h.thread.settled();
	assert.match(memory.read(), /- In Tokyo for the launch until Oct 14/);

	await h.ask("3", "[Wed 15 Oct 10:00] something else", 3, { newTopic: true });
	await h.thread.settled();
	assert.equal(memory.read(), "- Runs two LLM research labs.\n- Was in Tokyo for the launch, early to mid Oct 2026.");
	// Every change is logged for the weekly check-in; an edit quoting text that isn't there is skipped, not guessed.
	const log = (await import("node:fs")).readFileSync(join(home, "memory-changes.jsonl"), "utf8").trim().split("\n");
	assert.equal(log.length, 2);

	// Off: no section, no tools, and no reflection.
	h.settings.setOption("memory", "enabled", false);
	await h.ask("4", "[Wed 15 Oct 11:00] I moved to Lisbon", 4, { newTopic: true });
	await h.ask("5", "[Wed 15 Oct 12:00] ok", 5, { newTopic: true });
	await h.thread.settled();
	assert.ok(!memory.read().includes("Should never"), "memory untouched while off");
	assert.equal(reflections.length, 1, "the reflection wasn't even asked");
	assert.ok(!(await h.thread.root.agent(context)).tools.some((tool) => tool.name === "remember"));
	await h.done();
	await rm(home, { recursive: true, force: true });
});

test("reflection waits for the exchange to end: a slice cut for size isn't one, and the reflection sees all of it", async () => {
	const home = await mkdtemp(join(tmpdir(), "japa-home-"));
	const memory = new MemoryFile(home);
	const asked: string[] = [];
	const h = await agent({
		settings: { context: { idleMinutes: 60, sliceTokens: 200 } },
		extensions: { memory: memoryExtension(memory) },
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
