import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { OpenItems, WorkingSetFile } from "../src/core/state.ts";
import { stateExtension } from "../src/pi/state.ts";
import { MainThread } from "../src/pi/harness.ts";
import { DEFAULTS } from "../src/settings.ts";

const context = BACKGROUND_CONTEXT;
const settings = () => ({ ...DEFAULTS, model: { provider: "faux", modelId: "faux-1" } });

test("answers survive a restart and are delivered once", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "jarvis-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage("Paris.")]);

	let thread = await MainThread.open({ dataDir, models, settings }, context);
	const target = { chatId: 1, messageId: 10 };
	assert.deepEqual(await thread.ask("tg:1:10", "Capital of France?", target, context), { text: "Paris." });
	assert.deepEqual(await thread.pending(context), [{ requestId: "tg:1:10", content: "Capital of France?", ...target }]);
	await thread.close(context);

	// A restart before delivery: the same request finds the stored answer without asking the model again.
	thread = await MainThread.open({ dataDir, models, settings }, context);
	assert.equal((await thread.pending(context)).length, 1);
	assert.deepEqual(await thread.answer("tg:1:10", "Capital of France?", context), { text: "Paris." });
	await thread.delivered("tg:1:10", context);
	assert.deepEqual(await thread.pending(context), []);
	await thread.close(context);
	await rm(dataDir, { recursive: true, force: true });
});

test("the main model follows the settings", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "jarvis-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const thread = await MainThread.open({ dataDir, models, settings }, context);
	await thread.applySettings({ ...settings(), model: { provider: "faux", modelId: "faux-2" } }, context);
	assert.equal((await thread.root.agent(context)).model?.modelId, "faux-2");
	await thread.close(context);
	await rm(dataDir, { recursive: true, force: true });
});

async function sliceHarness(context_: { idleMinutes: number; sliceTokens: number }, replies: string[]) {
	const dataDir = await mkdtemp(join(tmpdir(), "jarvis-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const summaries: string[] = [];
	const respond: FauxResponseFactory = (request) => {
		const sent = JSON.stringify(request);
		if (sent.includes("<previous_working_set>")) {
			summaries.push(sent);
			return fauxAssistantMessage(JSON.stringify({ working_set: "WORKING SET: Option B chosen; waiting on Sam.", memory_edits: [] }));
		}
		return fauxAssistantMessage(replies.shift() ?? "ok");
	};
	faux.setResponses(Array.from({ length: 30 }, () => respond));
	const state = { openItems: new OpenItems(join(dataDir, "open-items.json")), workingSet: new WorkingSetFile(join(dataDir, "working-set.json")) };
	const live = { ...settings(), context: context_ };
	const lines: string[] = [];
	const thread = await MainThread.open({ dataDir, models, settings: () => live, installed: [stateExtension(state)], state, log: (line) => lines.push(line) }, context);
	const sent = async () => JSON.stringify((await thread.root.context(context)).messages);
	const slices = () => lines.flatMap((line) => /slice=(\S+)/.exec(line)?.[1] ?? []);
	const done = async () => {
		await thread.close(context);
		await rm(dataDir, { recursive: true, force: true });
	};
	return { thread, live, sent, slices, summaries, state, done };
}

const target = { chatId: 1, messageId: 1 };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("after an idle gap the next message starts a small slice from state, never waiting for a summary", async () => {
	const h = await sliceHarness({ idleMinutes: 60, sliceTokens: 1_000_000 }, ["alpha ".repeat(3000), "beta ".repeat(3000), "Done.", "Sure."]);
	await h.thread.ask("a", "first", target, context);
	await h.thread.ask("b", "second", target, context);
	h.live.context = { ...h.live.context, idleMinutes: 0.0001 };
	await wait(20);
	assert.deepEqual(await h.thread.ask("c", "third", target, context), { text: "Done." });
	const fresh = await h.sent();
	assert.ok(fresh.length < 8000, `the new slice is small (${fresh.length} chars)`);
	assert.ok(fresh.includes("Earlier turns of this conversation are not in your context"));

	// The departing slice's working set lands in the background and shows up in the next request.
	await h.thread.settled();
	assert.equal(h.summaries.length, 1);
	h.live.context = { ...h.live.context, idleMinutes: 60 };
	await h.thread.ask("d", "and?", target, context);
	assert.ok((await h.sent()).includes("WORKING SET: Option B chosen"));
	assert.deepEqual(h.slices(), ["continued", "continued", "idle", "continued"]);
	await h.done();
});

test("a reply to an earlier slice anchors a new one; /new starts fresh; replies within the slice continue", async () => {
	const h = await sliceHarness({ idleMinutes: 60, sliceTokens: 1_000_000 }, ["Two options: A or B.", "Fresh.", "Going with B.", "Yes."]);
	await h.thread.ask("a", "pricing options?", target, context);
	const optionsAt = Date.now() - 1000;
	await wait(5);
	await h.thread.ask("b", "something else", target, context, { newTopic: true });
	await h.thread.ask("c", "the second one", target, context, { replyTo: { messageId: 2, text: "Two options: A or B.", at: optionsAt } });
	assert.ok((await h.sent()).includes("replies to this earlier message: «Two options: A or B.»"));
	await h.thread.ask("d", "do it", target, context, { replyTo: { messageId: 4, text: "Going with B.", at: Date.now() } });
	assert.deepEqual(h.slices(), ["continued", "new-topic", "reply-to-earlier", "continued"]);
	await h.done();
});

test("a slice that would grow past its budget starts a new one", async () => {
	const h = await sliceHarness({ idleMinutes: 60, sliceTokens: 2000 }, ["gamma ".repeat(3000), "Done."]);
	await h.thread.ask("a", "long one", target, context);
	await h.thread.ask("b", "next", target, context);
	assert.deepEqual(h.slices(), ["continued", "size"]);
	await h.done();
});
