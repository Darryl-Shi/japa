import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { OpenItems, WorkingSetFile } from "../src/core/state.ts";
import { delegationExtension, type OutboxMessage } from "../src/pi/delegation.ts";
import { MainThread } from "../src/pi/harness.ts";
import { stateExtension } from "../src/pi/state.ts";
import { DEFAULTS } from "../src/settings.ts";

const context = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One scripted model for both sides: requests whose system prompt carries the subagent instructions go to `child`,
 * everything else to `main`. Counts main-model requests, which is what a report must not cause.
 */
async function setup(main: (text: string, request: unknown) => AssistantMessage, child: (brief: string) => Promise<AssistantMessage>) {
	const dataDir = await mkdtemp(join(tmpdir(), "jarvis-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let mainCalls = 0;
	const respond: FauxResponseFactory = async (request) => {
		const sent = JSON.stringify(request);
		const last = [...request.messages].reverse().find((message) => message.role === "user" || message.role === "toolResult");
		const text = last === undefined ? "" : typeof last.content === "string" ? last.content : last.content.map((part) => ("text" in part ? part.text : "")).join("");
		if (sent.includes("delegated task for Darryl")) return child(text);
		mainCalls++;
		return main(text, request);
	};
	faux.setResponses(Array.from({ length: 200 }, () => respond));
	const state = { openItems: new OpenItems(join(dataDir, "open-items.json")), workingSet: new WorkingSetFile(join(dataDir, "working-set.json")) };
	const stateTools = stateExtension(state);
	let thread: MainThread | undefined;
	const delegation = delegationExtension({
		openItems: state.openItems,
		delegateModel: () => ({ provider: "faux", modelId: "faux-1" }),
		origin: (callContext) => thread!.origin(callContext),
		withhold: () => [stateTools, delegation],
	});
	const settings = () => ({ ...DEFAULTS, model: { provider: "faux", modelId: "faux-1" }, context: { idleMinutes: 60, sliceTokens: 1_000_000 } });
	thread = await MainThread.open({ dataDir, models, settings, extensions: [stateTools, delegation], state }, context);
	const sent: Array<OutboxMessage & { id: number }> = [];
	await thread.deliverOutbox(async (message) => {
		sent.push({ ...message, id: 1000 + sent.length });
		return 1000 + sent.length - 1;
	}, context);
	const until = async (check: () => boolean) => {
		for (let i = 0; i < 500 && !check(); i++) await sleep(10);
		assert.ok(check(), "timed out waiting");
	};
	return {
		thread: thread,
		state,
		sent,
		until,
		mainCalls: () => mainCalls,
		done: async () => {
			await thread!.close(context);
			await rm(dataDir, { recursive: true, force: true });
		},
	};
}

const delegate = (title: string, brief: string) => fauxAssistantMessage(fauxToolCall("delegate", { title, brief }), { stopReason: "toolUse" });
const target = (messageId: number) => ({ chatId: 1, messageId });

test("a finished subagent's report reaches Darryl as a reply to his message, without waking the main model", async () => {
	const h = await setup(
		(text) => (text.startsWith("[") && text.includes("research the venue") ? delegate("Venue research", "Find three venues.") : text.includes("Started as") ? fauxAssistantMessage("On it.") : fauxAssistantMessage("Noted.")),
		async () => fauxAssistantMessage("Three venues: A, B, C."),
	);
	assert.deepEqual(await h.thread.ask("tg:1:7", "[Sat 4 Oct 10:00] research the venue", target(7), context), { text: "On it." });
	await h.until(() => h.sent.length === 1);
	assert.deepEqual(
		{ text: h.sent[0]?.text, replyTo: h.sent[0]?.replyTo, buzz: h.sent[0]?.buzz },
		{ text: "Three venues: A, B, C.", replyTo: { chatId: 1, messageId: 7 }, buzz: false },
	);
	assert.equal(h.mainCalls(), 2, "only the user's message ran the main model");
	assert.equal(h.state.openItems.open().length, 0, "the task's open item is closed");
	assert.equal(h.state.openItems.forMessage(1000)?.outcome, "Three venues: A, B, C.", "a reply to the report finds its item");

	// The next time Darryl writes, the main model sees the report's note.
	await h.thread.ask("tg:1:9", "[Sat 4 Oct 10:05] thanks", target(9), context);
	assert.match(JSON.stringify((await h.thread.root.context(context)).messages), /\[Done: t1 Venue research\] Three venues/);
	await h.done();
});

test("a subagent that needs a decision buzzes, and its item waits on Darryl", async () => {
	const h = await setup(
		(text) => (text.includes("book it") ? delegate("Book flight", "Book the 9am flight.") : fauxAssistantMessage("On it.")),
		async () => fauxAssistantMessage("DECISION NEEDED: The 9am is full. Take the 11am ($40 more) or wait-list?"),
	);
	await h.thread.ask("tg:1:3", "[Sat 4 Oct 10:00] book it", target(3), context);
	await h.until(() => h.sent.length === 1);
	assert.equal(h.sent[0]?.buzz, true);
	assert.match(h.sent[0]?.text ?? "", /^Book flight: needs you\.\n\nThe 9am is full/);
	const item = h.state.openItems.forMessage(1000);
	assert.equal(item?.kind, "waiting");
	assert.equal(item?.closedAt, undefined);
	await h.done();
});

test("a storm of finished subagents does not delay one simple question", async () => {
	let release = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	const h = await setup(
		(text) => {
			if (text.includes("five things")) {
				return fauxAssistantMessage(
					Array.from({ length: 5 }, (_, i) => fauxToolCall("delegate", { title: `Job ${i}`, brief: `Do job ${i}.` })),
					{ stopReason: "toolUse" },
				);
			}
			if (text.includes("Started as")) return fauxAssistantMessage("All five started.");
			return fauxAssistantMessage("It's 10:01.");
		},
		async (brief) => {
			await gate;
			return fauxAssistantMessage(`Finished: ${brief}`);
		},
	);
	await h.thread.ask("tg:1:1", "[Sat 4 Oct 10:00] do five things", target(1), context);
	assert.equal(h.mainCalls(), 2);

	// All five finish together while a simple question is asked.
	release();
	const started = Date.now();
	assert.deepEqual(await h.thread.ask("tg:1:2", "[Sat 4 Oct 10:01] what time is it?", target(2), context), { text: "It's 10:01." });
	const answeredIn = Date.now() - started;
	await h.until(() => h.sent.length === 5);
	assert.equal(h.mainCalls(), 3, "five reports, zero extra main-model runs");
	assert.ok(answeredIn < 1000, `the simple question answered in ${answeredIn}ms`);
	assert.deepEqual(new Set(h.sent.map((message) => message.replyTo?.messageId)), new Set([1]), "every report replies to the message that asked");
	await h.done();
});

test("a delegated task keeps running across a new slice, and its report still lands", async () => {
	let release = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	const h = await setup(
		(text) => (text.includes("look into it") ? delegate("Look into it", "Investigate.") : text.includes("Started as") ? fauxAssistantMessage("On it.") : fauxAssistantMessage("Fresh topic.")),
		async () => {
			await gate;
			return fauxAssistantMessage("Investigated: all fine.");
		},
	);
	await h.thread.ask("tg:1:1", "[Sat 4 Oct 10:00] look into it", target(1), context);
	// A new slice (reset) while the subagent is still working.
	await h.thread.ask("tg:1:2", "[Sat 4 Oct 10:02] something else", target(2), context, { newTopic: true });
	release();
	await h.until(() => h.sent.length === 1);
	assert.equal(h.sent[0]?.text, "Investigated: all fine.");
	assert.equal(h.state.openItems.open().length, 0);
	await h.done();
});
