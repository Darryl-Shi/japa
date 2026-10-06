// pi's ExtensionAPI, as japa implements it on Pi Durable: each part an extension written for pi would use.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Message, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../src/pi/extension.ts";
import { agent, call, context, say, sleep } from "./helpers.ts";

const echo = (pi: ExtensionAPI) =>
	pi.registerTool({
		name: "echo",
		description: "Echo the text.",
		parameters: Type.Object({ text: Type.String() }),
		annotations: { readOnlyHint: true },
		execute: async (_id, params, _signal, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: "ech" }] });
			return { content: [{ type: "text", text: `echo ${params.text}` }], details: { length: params.text.length } };
		},
	});

test("tool events: tool_call patches the input in place, tool_result replaces the result, tool_execution_* see both", async () => {
	const seen: string[] = [];
	const h = await agent({
		extensions: {
			echo,
			patch: (pi) => {
				pi.on("tool_call", (event) => {
					if (event.toolName === "echo") event.input.text = "patched";
				});
				pi.on("tool_execution_start", (event) => void seen.push(`start ${JSON.stringify(event.args)}`));
				pi.on("tool_result", (event) => ({ content: [{ type: "text", text: `${event.content.map((part) => (part.type === "text" ? part.text : "")).join("")} (${JSON.stringify(event.details)})` }] }));
				pi.on("tool_execution_end", (event) => void seen.push(`end ${event.isError}`));
			},
		},
		script: (turn) => (turn.text.endsWith("go") ? call("echo", { text: "original" }) : say(turn.text)),
	});
	assert.deepEqual(await h.ask("1", "[Mon 10:00] go"), { text: 'echo patched ({"length":7})' });
	assert.deepEqual(seen, ['start {"text":"patched"}', "end false"]);
	await h.done();
});

test("a tool's terminate ends the run without another request", async () => {
	const h = await agent({
		extensions: {
			done: (pi) =>
				pi.registerTool({
					name: "finish",
					description: "Finish.",
					parameters: Type.Object({}),
					annotations: { readOnlyHint: true },
					execute: async () => ({ content: [{ type: "text", text: "Finished." }], terminate: true }),
				}),
		},
		script: (turn) => (turn.text.endsWith("go") ? call("finish", {}) : say("asked again")),
	});
	void h.ask("1", "[Mon 10:00] go");
	await h.until(() => h.turns.length >= 1, "the first request");
	await sleep(300);
	assert.ok(!h.turns.some((turn) => turn.text === "Finished."), "no request after it");
	await h.done();
});

test("turn events: context replaces a request's messages; turn_start, turn_end, message_end and agent_end follow the run", async () => {
	const seen: string[] = [];
	const h = await agent({
		extensions: {
			echo,
			watch: (pi) => {
				pi.on("context", (event) => ({ messages: [...event.messages, { role: "user", content: "(a note from context)", timestamp: Date.now() } satisfies Message] }));
				pi.on("turn_start", (event) => void seen.push(`turn_start ${event.turnIndex}`));
				pi.on("message_end", (event) => void seen.push(`message_end ${event.message.role}`));
				pi.on("turn_end", (event) => void seen.push(`turn_end ${event.turnIndex} ${event.message?.role} ${event.toolResults.map((result) => result.role).join(",")}`));
				pi.on("agent_end", (event) => void seen.push(`agent_end ${event.messages.length}`));
			},
		},
		script: (turn) => (turn.request.includes("[Mon 10:00] go") && !turn.request.includes("echo it") ? call("echo", { text: "it" }) : say("done")),
	});
	assert.deepEqual(await h.ask("1", "[Mon 10:00] go"), { text: "done" });
	assert.ok(h.turns.every((turn) => turn.text === "(a note from context)"), "every request has what context added");
	assert.deepEqual(seen, ["turn_start 0", "message_end assistant", "turn_end 0 assistant toolResult", "turn_start 1", "message_end assistant", "agent_end 1"]);
	await h.done();
});

test("appendEntry keeps state in the session, read back through ctx.sessionManager after a restart", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "japa-"));
	const read: unknown[] = [];
	const counter = (pi: ExtensionAPI) => {
		pi.on("session_start", (_event, ctx) => void read.push(ctx.sessionManager.getEntries().map((entry) => [entry.customType, entry.data])));
		pi.registerTool({
			name: "count",
			description: "Count one.",
			parameters: Type.Object({}),
			annotations: { readOnlyHint: true },
			execute: async (_id, _params, _signal, _onUpdate, ctx) => {
				pi.appendEntry("counter", { count: ctx.sessionManager.getEntries().length + 1 });
				return { content: [{ type: "text", text: "Counted." }] };
			},
		});
	};
	const script = (turn: { text: string }) => (turn.text.endsWith("count") ? call("count", {}) : say("ok"));
	const h = await agent({ dataDir, extensions: { counter }, script });
	await h.ask("1", "[Mon 10:00] count");
	await h.ask("2", "[Mon 10:01] count");
	await h.japa.close(context);
	const again = await agent({ dataDir, extensions: { counter }, script });
	assert.deepEqual(read, [[], [["counter", { count: 1 }], ["counter", { count: 2 }]]]);
	await again.done();
});

test("sendMessage: kept for the next turn without starting one, or (triggerTurn) starting one", async () => {
	let api: ExtensionAPI | undefined;
	const h = await agent({
		extensions: { notes: (pi) => void (api = pi) },
		script: (turn) => (turn.text.includes("Oven's on.") ? say("About the oven.") : say("ok")),
	});
	api!.sendMessage({ customType: "note", content: "The milk's out." });
	await sleep(300);
	assert.equal(h.turns.length, 0, "no turn of its own");
	await h.ask("1", "[Mon 10:00] anything new?");
	assert.match(h.turns[0]!.request, /The milk's out\./, "the next turn has it");
	api!.sendMessage({ customType: "note", content: "Oven's on." }, { triggerTurn: true });
	await h.until(() => h.cards.some((shown) => shown.card.text === "About the oven."), "a turn on it, answered to the user");
	await h.done();
});

test("active tools: defaultActive false is offered only once setActiveTools names it, with its guidelines", async () => {
	let api: ExtensionAPI | undefined;
	const h = await agent({
		extensions: {
			hidden: (pi) => {
				api = pi;
				pi.registerTool({
					name: "rare_tool",
					description: "Zq7 does the rare thing.",
					promptGuidelines: ["Use rare_tool only for Zq8."],
					parameters: Type.Object({}),
					defaultActive: false,
					execute: async () => ({ content: [{ type: "text", text: "Rare." }] }),
				});
			},
		},
		script: () => say("ok"),
	});
	assert.ok(!api!.getActiveTools().includes("rare_tool"));
	assert.ok(api!.getAllTools().some((tool) => tool.name === "rare_tool"));
	await h.ask("1", "[Mon 10:00] hi");
	assert.doesNotMatch(h.turns[0]!.request, /Zq7|Zq8/);
	api!.setActiveTools([...api!.getActiveTools(), "rare_tool"]);
	await sleep(100);
	await h.ask("2", "[Mon 10:01] hi");
	assert.match(h.turns[1]!.request, /Zq7/);
	assert.match(h.turns[1]!.request, /- Use rare_tool only for Zq8\./);
	await h.done();
});

test("what japa doesn't have of pi's API fails at once, saying so, and the chief of staff hears it", async () => {
	const h = await agent({
		extensions: {
			forky: (pi) => void pi.on("session_before_fork" as "session_start", () => {}),
			naming: (pi) => void (pi as unknown as { setSessionName(name: string): void }).setSessionName("trip"),
			terminal: (pi) => {
				pi.registerShortcut("ctrl+x", { handler: () => {} });
				pi.registerFlag("verbose", { type: "boolean", default: true });
				pi.registerTool({ name: "flagged", description: "Says the flag.", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: String(pi.getFlag("verbose")) }] }) });
			},
		},
		script: (turn) => (turn.text.startsWith("[Problem with") ? say(turn.text) : say("ok")),
	});
	await h.until(() => h.cards.filter((shown) => shown.card.text.startsWith("[Problem with")).length >= 2, "both problems");
	const told = h.cards.map((shown) => shown.card.text).join("\n");
	assert.match(told, /\[Problem with extension forky\].*japa has no "session_before_fork" event/);
	assert.match(told, /\[Problem with extension naming\].*pi\.setSessionName isn't available in japa/);
	assert.doesNotMatch(told, /extension terminal/, "what only a terminal shows is accepted");
	assert.ok(h.japa.extensions.get("terminal"));
	await h.done();
});
