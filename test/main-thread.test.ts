import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
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

test("after a quiet gap the next message starts from a short handoff note", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "jarvis-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const replies = ["alpha ".repeat(5000), "beta ".repeat(5000), "Done."];
	const respond: FauxResponseFactory = (request) =>
		fauxAssistantMessage(JSON.stringify(request).includes("<conversation>") ? "HANDOFF: nothing open." : (replies.shift() ?? "?"));
	faux.setResponses(Array.from({ length: 10 }, () => respond));

	const live = { ...settings(), context: { restAfterMinutes: 60, maxTokens: 1_000_000 } };
	const thread = await MainThread.open({ dataDir, models, settings: () => live }, context);
	const target = { chatId: 1, messageId: 1 };
	await thread.ask("a", "first", target, context);
	await thread.ask("b", "second", target, context);

	// The cache has gone cold by the time the next message arrives.
	live.context = { ...live.context, restAfterMinutes: 0.0001 };
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(await thread.ask("c", "third", target, context), { text: "Done." });

	const sent = JSON.stringify((await thread.root.context(context)).messages);
	assert.ok(sent.includes("HANDOFF"), "the handoff note is in context");
	assert.ok(!sent.includes("alpha"), "the old exchange is not resent");
	await thread.close(context);
	await rm(dataDir, { recursive: true, force: true });
});
