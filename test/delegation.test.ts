import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, JsonObject, Context as PiContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { OpenItems, WorkingSetFile } from "../src/core/state.ts";
import { delegationExtensions, type OutboxMessage } from "../src/pi/delegation.ts";
import { MainThread } from "../src/pi/harness.ts";
import { stateExtension } from "../src/pi/state.ts";
import { DEFAULTS } from "../src/settings.ts";

const context = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Role = "chief" | "job" | "subagent";
type Turn = { role: Role; job?: string; text: string; model: string; request: string };

/** Who a request is from, and the newest message it answers (a user input, report, or tool result). */
function read(request: PiContext, modelId: string): Turn {
	const sent = JSON.stringify(request);
	const job = /Your job \(([\w.]+)\)/.exec(sent)?.[1];
	const last = [...request.messages].reverse().find((message) => message.role === "user" || message.role === "toolResult");
	const text = last === undefined ? "" : typeof last.content === "string" ? last.content : last.content.map((part) => ("text" in part ? part.text : "")).join("");
	return { role: job === undefined ? "chief" : job.includes(".") ? "subagent" : "job", ...(job === undefined ? {} : { job }), text, model: modelId, request: sent };
}

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(text);

async function setup(script: (turn: Turn) => AssistantMessage | Promise<AssistantMessage>) {
	const dataDir = await mkdtemp(join(tmpdir(), "jarvis-"));
	const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-fast" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const turns: Turn[] = [];
	const respond: FauxResponseFactory = async (request, _options, _state, model) => {
		const turn = read(request, model.id);
		if (turn.request.includes("<previous_working_set>")) return say(JSON.stringify({ working_set: "", memory_edits: [] }));
		turns.push(turn);
		return script(turn);
	};
	faux.setResponses(Array.from({ length: 300 }, () => respond));
	const state = { openItems: new OpenItems(join(dataDir, "open-items.json")), workingSet: new WorkingSetFile(join(dataDir, "working-set.json")) };
	const stateTools = stateExtension(state);
	let thread: MainThread | undefined;
	const team = delegationExtensions({
		openItems: state.openItems,
		settings: () => ({ delegateModel: { provider: "faux", modelId: "faux-1" }, jobModels: { fast: { provider: "faux", modelId: "faux-fast" } } }),
		origin: (callContext) => thread!.origin(callContext),
		withhold: () => [thread!.core, stateTools, team.chief],
	});
	const settings = () => ({ ...DEFAULTS, model: { provider: "faux", modelId: "faux-1" }, context: { idleMinutes: 60, sliceTokens: 1_000_000 } });
	thread = await MainThread.open({ dataDir, models, settings, installed: [stateTools, team.chief, team.job, team.helper], selected: () => [stateTools, team.chief], state }, context);
	const sent: OutboxMessage[] = [];
	await thread.deliverOutbox(async (message) => (sent.push(message), 1000 + sent.length - 1), context);
	const until = async (check: () => boolean, what: string) => {
		for (let i = 0; i < 500 && !check(); i++) await sleep(10);
		assert.ok(check(), `timed out waiting for ${what}`);
	};
	return {
		thread,
		state,
		sent,
		turns,
		until,
		done: async () => {
			await thread!.close(context);
			await rm(dataDir, { recursive: true, force: true });
		},
	};
}

const target = (messageId: number) => ({ chatId: 1, messageId });

test("a job reports to the chief of staff, who decides what the user hears; the job stays open until concluded", async () => {
	const h = await setup((turn) => {
		if (turn.role === "job") return turn.text.startsWith("Find three") ? call("report", { kind: "done", text: "Three venues: A, B, C. B is closest." }) : say("ok");
		if (turn.text.includes("research the venue")) return call("delegate", { title: "Venue research", brief: "Find three venues near the office." });
		if (turn.text.startsWith("Started job")) return say("On it.");
		if (turn.text.startsWith("[Report from job t1")) return call("message_user", { text: "Venues: A, B, C. I'd pick B, it's closest.", urgency: "silent", job: "t1" });
		if (turn.text === "Sent.") return say("(handled)");
		if (turn.text.includes("go with B")) return call("conclude_job", { id: "t1", outcome: "B chosen" });
		return say("Done.");
	});
	assert.deepEqual(await h.thread.ask("tg:1:7", "[Mon 10:00] research the venue", target(7), context), { text: "On it." });
	await h.until(() => h.sent.length === 1, "the chief of staff's message");
	assert.deepEqual(h.sent[0], { text: "Venues: A, B, C. I'd pick B, it's closest.", buzz: false, replyTo: { chatId: 1, messageId: 7 }, itemId: "t1" });
	assert.ok(h.turns.some((turn) => turn.role === "chief" && turn.text.startsWith('[Report from job t1 "Venue research" — done] Three venues')), "the report went to the chief of staff");
	assert.equal(h.state.openItems.open().length, 1, "the job stays open until the user accepts it");

	await h.thread.ask("tg:1:9", "[Mon 10:05] great, go with B", target(9), context);
	assert.equal(h.state.openItems.open().length, 0);
	assert.equal(h.state.openItems.forMessage(1000)?.outcome, "B chosen", "a reply to the result finds its job");
	await h.done();
});

test("a job agent that ends without reporting is reported automatically", async () => {
	const h = await setup((turn) => {
		if (turn.role === "job") return say("I looked; nothing matches.");
		if (turn.text.includes("look for")) return call("delegate", { title: "Search", brief: "Look for a match." });
		if (turn.text.startsWith("Started job")) return say("On it.");
		return say("(noted)");
	});
	await h.thread.ask("tg:1:1", "[Mon 10:00] look for it", target(1), context);
	await h.until(() => h.turns.some((turn) => turn.role === "chief" && turn.text.startsWith("[Report from job t1")), "the automatic report");
	const report = h.turns.find((turn) => turn.role === "chief" && turn.text.startsWith("[Report from job t1"));
	assert.equal(report?.text, '[Report from job t1 "Search" — automatic] Went quiet without reporting. Its last words: I looked; nothing matches.');
	await h.done();
});

test("a job runs on the model it was assigned, and its subagents report to it, not to the chief of staff", async () => {
	const h = await setup((turn) => {
		if (turn.role === "subagent") return turn.text.startsWith("Price A") ? call("report", { kind: "done", text: "A costs $10." }) : say("ok");
		if (turn.role === "job") {
			if (turn.text.startsWith("Compare")) return call("subagent", { title: "Price A", brief: "Price A." });
			if (turn.text.startsWith("Started subagent")) return say("waiting");
			if (turn.text.startsWith("[Report from job t1.1")) return call("report", { kind: "done", text: "A is $10; B is $12. A wins." });
			return say("ok");
		}
		if (turn.text.includes("compare prices")) return call("delegate", { title: "Prices", brief: "Compare A and B.", model: "fast" });
		if (turn.text.startsWith("Started job")) return say("On it.");
		return say("(noted)");
	});
	await h.thread.ask("tg:1:1", "[Mon 10:00] compare prices", target(1), context);
	await h.until(() => h.turns.some((turn) => turn.role === "chief" && turn.text.startsWith("[Report from job t1 ")), "the job's report");
	assert.ok(h.turns.filter((turn) => turn.role !== "chief").every((turn) => turn.model === "faux-fast"), "the job and its subagent ran on the assigned model");
	assert.ok(h.turns.some((turn) => turn.role === "job" && turn.text.startsWith("[Report from job t1.1")), "the subagent reported to the job");
	assert.ok(!h.turns.some((turn) => turn.role === "chief" && turn.text.includes("t1.1")), "the chief of staff never saw the subagent's report");
	await h.done();
});

test("the user comes first: a message isn't stuck behind report handling, and reports that pile up are taken together", async () => {
	let release = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	let reportTurns = 0;
	const h = await setup(async (turn) => {
		if (turn.role === "job") {
			await gate;
			return turn.text.startsWith("Do job") ? call("report", { kind: "done", text: `Finished ${turn.job}.` }) : say("ok");
		}
		if (turn.text.includes("five things")) {
			return fauxAssistantMessage(Array.from({ length: 5 }, (_, i) => fauxToolCall("delegate", { title: `Job ${i}`, brief: `Do job ${i}.` })), { stopReason: "toolUse" });
		}
		if (turn.text.startsWith("Started job")) return say("All five started.");
		if (turn.text.startsWith("[Report from job")) {
			reportTurns++;
			await sleep(300); // a slow look at the reports
			return say("(holding these for a natural pause)");
		}
		if (turn.text.includes("what time")) return say("It's 10:01.");
		return say("ok");
	});
	await h.thread.ask("tg:1:1", "[Mon 10:00] do five things", target(1), context);
	release();
	await h.until(() => reportTurns >= 1, "the chief of staff to start on the reports");
	const started = Date.now();
	assert.deepEqual(await h.thread.ask("tg:1:2", "[Mon 10:01] what time is it?", target(2), context), { text: "It's 10:01." });
	const waited = Date.now() - started;
	assert.ok(waited < 1500, `the user's question was answered in ${waited}ms while reports were being handled`);
	await h.until(() => h.turns.filter((turn) => turn.role === "chief" && turn.request.split("[Report from job").length - 1 >= 5).length > 0, "all five reports seen");
	assert.ok(reportTurns <= 3, `five reports were taken in ${reportTurns} turns, not five`);
	await h.done();
});

test("a job keeps running across a new slice, and its report still reaches the chief of staff", async () => {
	let release = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	const h = await setup(async (turn) => {
		if (turn.role === "job") {
			await gate;
			return turn.text.startsWith("Investigate") ? call("report", { kind: "done", text: "All fine." }) : say("ok");
		}
		if (turn.text.includes("look into it")) return call("delegate", { title: "Look into it", brief: "Investigate." });
		if (turn.text.startsWith("Started job")) return say("On it.");
		return say("Fresh topic.");
	});
	await h.thread.ask("tg:1:1", "[Mon 10:00] look into it", target(1), context);
	await h.thread.ask("tg:1:2", "[Mon 10:02] something else", target(2), context, { newTopic: true });
	release();
	await h.until(() => h.turns.some((turn) => turn.role === "chief" && turn.text.startsWith('[Report from job t1 "Look into it" — done] All fine.')), "the report after the reset");
	await h.done();
});
