import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProvider, envApiKeyAuth, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { LocalBackend } from "../src/backends/local.ts";
import { Approvals } from "../src/core/approvals.ts";
import { approvalsExtension } from "../src/pi/approvals.ts";
import { CLAUDE_CODE, CODEX, codingAgentExtension } from "../src/pi/coding-agents.ts";
import type { Channel, JapaExtension } from "../src/pi/extension.ts";
import { problems } from "../src/pi/installer.ts";
import { webExtension } from "../src/pi/web.ts";
import { agent, call, context, say, sleep } from "./helpers.ts";

/** A tool that acts on the world, counting its runs. */
function emailExtension(sent: string[]): JapaExtension {
	const extension = defineExtension({
		name: "test.email",
		tools: [
			defineTool({
				name: "send_email",
				description: "Send an email.",
				parameters: Type.Object({ to: Type.String(), body: Type.String() }),
				execute: async (args) => {
					sent.push(`${args.to}: ${args.body}`);
					return { content: [{ type: "text", text: "Email sent." }] };
				},
			}),
			defineTool({ name: "list_inbox", description: "List the inbox.", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "3 unread." }] }) }),
		],
	});
	return { name: "email", title: "Email", about: "", safeTools: ["list_inbox"], chief: [extension], jobs: [extension] };
}

const isReview = (request: string) => request.includes("You review one action");

test("approvals: a consequential call waits for the user's tap on a card, then goes through exactly once", async () => {
	const emails: string[] = [];
	const store = new Approvals(join(tmpdir(), `approvals-${process.pid}-1.json`), join(tmpdir(), `audit-${process.pid}-1.jsonl`));
	const h = await agent({
		extensions: (host) => [approvalsExtension(host, store), emailExtension(emails)],
		script: (turn) => {
			if (isReview(turn.request)) return say(JSON.stringify({ ask: turn.request.includes("send_email"), summary: "Email Bob the draft", rule: "Email people on the user's behalf" }));
			if (turn.text.includes("check my inbox")) return call("list_inbox", {});
			if (turn.text === "3 unread.") return say("Three unread.");
			if (turn.text.includes("email bob")) return call("send_email", { to: "bob", body: "Draft attached." });
			if (turn.text.includes("Needs the user's approval")) return say("I've asked you to approve it.");
			if (turn.text.includes("[Approval") && turn.text.includes("approved")) return call("send_email", { to: "bob", body: "Draft attached." });
			if (turn.text === "Email sent.") return say("Sent to Bob.");
			return say("ok");
		},
	});
	assert.deepEqual(await h.ask("1", "[Mon 10:00] check my inbox"), { text: "Three unread." });
	assert.ok(!h.turns.some((turn) => isReview(turn.request)), "a safe tool is never reviewed");

	assert.deepEqual(await h.ask("2", "[Mon 10:01] email bob the draft", 2), { text: "I've asked you to approve it." });
	assert.equal(emails.length, 0, "nothing was sent before approval");
	await h.until(() => h.cards.length === 1, "the approval card");
	const card = h.cards[0]!;
	assert.match(card.card.text, /^Approve\? Email Bob the draft/);
	assert.deepEqual(card.card.buttons?.flat().map((button) => button.text), ["Approve", "Deny", "Always: Email people on the user's behalf"]);

	await h.host.ui.press(card.card.buttons![0]![0]!.data, card.ref);
	await h.until(() => h.cards.some((shown) => shown.card.text === "Sent to Bob."), "the answer after approval");
	assert.match(h.cards[1]!.card.text, /^Approved\./, "the card now shows the decision");
	assert.deepEqual(h.cards.find((shown) => shown.card.text === "Sent to Bob.")?.card.replyTo, card.ref, "the answer is threaded under the card");
	assert.deepEqual(emails, ["bob: Draft attached."]);
	const audit = (await readFile(join(tmpdir(), `audit-${process.pid}-1.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line).verdict);
	assert.deepEqual(audit, ["asked", "approve", "ran-approved"]);
	await h.done();
});

test("approvals: a review that fails is tried again, so a provider's hiccup doesn't ask the user about a benign call", async () => {
	const emails: string[] = [];
	const store = new Approvals(join(tmpdir(), `approvals-${process.pid}-3.json`), join(tmpdir(), `audit-${process.pid}-3.jsonl`));
	let reviews = 0;
	const h = await agent({
		extensions: (host) => [approvalsExtension(host, store), emailExtension(emails)],
		script: (turn) => {
			if (isReview(turn.request)) {
				reviews++;
				return reviews === 1 ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }) : say(JSON.stringify({ ask: false, summary: "Email a note to self", rule: "Email self" }));
			}
			if (turn.text.includes("note to self")) return call("send_email", { to: "me", body: "Remember the milk." });
			if (turn.text === "Email sent.") return say("Noted.");
			return say("ok");
		},
	});
	assert.deepEqual(await h.ask("1", "[Mon 10:00] email me a note to self"), { text: "Noted." });
	assert.equal(reviews, 2, "the failed review was tried again");
	assert.equal(h.cards.length, 0, "and the user wasn't asked");
	assert.deepEqual(emails, ["me: Remember the milk."]);
	await h.done();
});

test("approvals: a job agent waiting on the user is held (not reported as gone quiet), and the tap resumes it", async () => {
	const emails: string[] = [];
	const store = new Approvals(join(tmpdir(), `approvals-${process.pid}-2.json`), join(tmpdir(), `audit-${process.pid}-2.jsonl`));
	const h = await agent({
		extensions: (host) => [approvalsExtension(host, store), emailExtension(emails)],
		script: (turn) => {
			if (isReview(turn.request)) return say(JSON.stringify({ ask: true, summary: "Email the venue", rule: "Email venues" }));
			if (turn.job !== undefined) {
				if (turn.text.startsWith("Book")) return call("send_email", { to: "venue", body: "Booking for 12." });
				if (turn.text.includes("Needs the user's approval")) return say("Waiting for approval.");
				if (turn.text.includes("[Approval")) return call("send_email", { to: "venue", body: "Booking for 12." });
				if (turn.text === "Email sent.") return call("report", { kind: "done", text: "Booking email sent." });
				return say("ok");
			}
			if (turn.text.includes("book the venue")) return call("delegate", { title: "Booking", brief: "Book the venue for 12." });
			if (turn.text.startsWith("Started job")) return say("On it.");
			return say("(noted)");
		},
	});
	await h.ask("1", "[Mon 10:00] book the venue");
	await h.until(() => h.cards.length === 1, "the approval card");
	await h.until(() => h.turns.some((turn) => turn.job === "t1" && turn.text.includes("Needs the user's approval")), "the job to see the block");
	await sleep(200);
	const early = h.turns.filter((turn) => turn.job === undefined && turn.text.startsWith("[Report from job")).map((turn) => turn.text);
	assert.deepEqual(early, [], "no automatic report while it waits on the user");

	await h.host.ui.press(h.cards[0]!.card.buttons![0]![0]!.data, h.cards[0]!.ref);
	await h.until(() => h.turns.some((turn) => turn.job === undefined && turn.text.startsWith('[Report from job t1 "Booking" — done]')), "the job's report");
	assert.deepEqual(emails, ["venue: Booking for 12."]);
	await h.done();
});

test("web: one search sends the objective and all queries in fast mode, and renders pages with excerpts", async () => {
	const requests: Array<{ url: string; body: Record<string, unknown>; key: string | null }> = [];
	const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
		requests.push({ url: String(url), body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("x-api-key") });
		const results = String(url).endsWith("/search")
			? [{ url: "https://a.example", title: "A", publish_date: "2026-10-01", excerpts: ["Alpha fact."] }]
			: [{ url: "https://b.example", title: "B", excerpts: [], full_content: "# B\nWhole page." }];
		return new Response(JSON.stringify({ results, errors: [] }), { status: 200 });
	}) as typeof fetch;
	const h = await agent({
		extensions: (host) => [webExtension(host, { fetch: fakeFetch })],
		script: (turn) => {
			if (turn.text.includes("look it up")) return call("web_search", { objective: "Find alpha", queries: ["alpha", "alpha fact"] });
			if (turn.text.includes("No Parallel API key")) return say("No key.");
			if (turn.text.includes("Alpha fact.")) return call("web_fetch", { urls: ["https://b.example"] });
			if (turn.text.includes("Whole page.")) return say("Found it.");
			return say("?");
		},
	});
	assert.deepEqual(await h.ask("1", "[Mon 10:00] look it up"), { text: "No key." });
	h.secrets.set("web.apiKey", "pk-test");
	assert.deepEqual(await h.ask("2", "[Mon 10:01] look it up again"), { text: "Found it." });
	assert.deepEqual(requests[0], { url: "https://api.parallel.ai/v1/search", body: { objective: "Find alpha", search_queries: ["alpha", "alpha fact"], mode: "fast", advanced_settings: { max_results: 8 } }, key: "pk-test" });
	assert.deepEqual(requests[1]?.body, { urls: ["https://b.example"], advanced_settings: { full_content: true } });
	await h.done();
});

test("coding agents: Claude Code and Codex run on the workbench with the key passed to that run only, and sessions continue", async () => {
	const dir = await mkdtemp(join(tmpdir(), "japa-machine-"));
	const machine = new LocalBackend(join(dir, "machine"));
	const bin = join(machine.home, ".local/bin");
	await mkdir(bin, { recursive: true });
	// Fakes that echo what they were given, in each tool's real output format.
	await writeFile(join(bin, "claude"), `#!/bin/bash\nprintf '{"type":"result","subtype":"success","is_error":false,"result":"did: %s in %s token=%s args=%s","session_id":"s-123"}\\n' "$2" "$(basename "$PWD")" "$CLAUDE_CODE_OAUTH_TOKEN" "$*"\n`);
	await writeFile(join(bin, "codex"), `#!/bin/bash\necho '{"type":"thread.started","thread_id":"th-9"}'\necho '{"type":"item.completed","item":{"type":"error","message":"config warning"}}'\necho "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"codex key=$CODEX_API_KEY resume=$3\\"}}"\n`);
	await chmod(join(bin, "claude"), 0o755);
	await chmod(join(bin, "codex"), 0o755);
	// Claude Code installs into ~/.local/bin (its command puts that on PATH); codex wherever npm puts globals, on PATH.
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	const h = await agent({
		workbench: machine,
		// Coding agents are for job agents; here the chief of staff gets them too.
		extensions: (host) => [codingAgentExtension(CLAUDE_CODE, host), codingAgentExtension(CODEX, host)].map((entry) => ({ ...entry, chief: entry.jobs ?? [] })),
		script: (turn) => {
			if (turn.text.includes("fix the bug")) return call("claude_code", { task: "Fix the bug", dir: "repo" });
			if (turn.text.startsWith("did: Fix the bug")) return call("claude_code", { task: "Add a test", dir: "repo", session: "s-123" });
			if (turn.text.startsWith("did: Add a test")) return call("codex", { task: "Review it", session: "th-9" });
			if (turn.text.startsWith("codex")) return say("All done.");
			return say("?");
		},
	});
	h.secrets.set("claude-code.oauthToken", "tok-abc");
	h.secrets.set("codex.apiKey", "sk-codex");
	assert.deepEqual(await h.ask("1", "[Mon 10:00] fix the bug"), { text: "All done." });
	const results = h.turns.map((turn) => turn.text);
	assert.match(results[1]!, /^did: Fix the bug in repo token=tok-abc args=.*--dangerously-skip-permissions\n\n\(session s-123\)$/);
	assert.match(results[2]!, /--resume s-123/);
	assert.equal(results[3], "codex key=sk-codex resume=th-9\n\n(session th-9)");
	process.env.PATH = path;
	await h.done();
	await rm(dir, { recursive: true, force: true });
});

test("settings: /settings is a card; extensions turn on and off (tools follow, start/stop run), options and secrets are set by reply; the last channel stays on", async () => {
	const lifecycle: string[] = [];
	const h = await agent({
		extensions: (host) => [
			{ ...webExtension(host), start: () => void lifecycle.push("web on"), stop: () => void lifecycle.push("web off") },
			emailExtension([]),
		],
		script: () => say("ok"),
	});
	const ui = h.host.ui;
	const tools = async () => (await h.thread.root.agent(context)).tools.map((tool) => tool.name);
	const labels = () => h.cards.at(-1)!.card.buttons!.flat().map((button) => button.text);
	const press = (label: string) => {
		const last = h.cards.at(-1)!;
		const button = last.card.buttons!.flat().find((candidate) => candidate.text === label);
		assert.ok(button !== undefined, `no button "${label}" in ${labels().join(" | ")}`);
		return ui.press(button.data, last.ref);
	};

	assert.deepEqual(lifecycle, ["web on"], "started at startup");
	assert.deepEqual(
		ui.commands(),
		[
			{ name: "settings", description: "Models, extensions and their options" },
			{ name: "login", description: "Log in to a model provider" },
			{ name: "jobs", description: "What the team is working on" },
		],
		"advertised, with what they do",
	);
	assert.equal(await ui.run("settings", { channel: "test", chatId: "7", messageId: "1" }), true);
	assert.deepEqual(labels(), ["General", "✅ Test channel", "✅ Web (Parallel)", "⚙", "✅ Email"]);
	assert.ok((await tools()).includes("web_search"));

	await press("✅ Web (Parallel)");
	assert.deepEqual(labels().slice(2, 3), ["⬜ Web (Parallel)"]);
	assert.ok(!(await tools()).includes("web_search"), "turned off: gone from the chief of staff's tools");
	assert.deepEqual(lifecycle, ["web on", "web off"], "and stopped");
	await press("✅ Test channel");
	assert.match(h.cards.at(-1)!.card.text, /only channel/);
	assert.deepEqual(labels().slice(1, 2), ["✅ Test channel"], "the last channel can't be turned off");

	await press("⚙");
	assert.deepEqual(labels(), ["Search mode: fast ▸", "Results per search: 8", "Parallel API key: not set", "« Back"]);
	await press("Search mode: fast ▸");
	assert.equal(h.settings.options("web", {}).mode, "turbo", "a choice cycles");
	await press("Parallel API key: not set");
	const prompt = h.cards.at(-1)!.card;
	assert.ok(prompt.ask?.secret === true);
	await ui.reply(prompt.ask!.data, "pk-live", { channel: "test", chatId: "7", messageId: "99" });
	assert.equal(h.secrets.get("web.apiKey"), "pk-live");
	assert.ok(!JSON.stringify(h.settings.get()).includes("pk-live"), "secrets never land in settings.json");
	assert.ok(!JSON.stringify(h.cards.map((shown) => shown.card)).includes("allowlist"), "the allowlist isn't in the menu");

	// A model is picked from the models pi can use, not typed.
	await ui.run("settings", { channel: "test", chatId: "7", messageId: "1" });
	await press("General");
	await press("Chief of staff model: faux/faux-1");
	assert.deepEqual(labels(), ["✅ faux-1 👁", "faux-fast 👁", "⌨ Type an id", "« Back"], "one provider: straight to its models, the current one ticked");
	await press("faux-fast 👁");
	assert.deepEqual(h.settings.get().model, { provider: "faux", modelId: "faux-fast" });
	assert.ok(labels().includes("Chief of staff model: faux/faux-fast"), "back on the page, showing the choice");
	assert.equal((await h.thread.root.agent(context)).model?.modelId, "faux-fast", "and the chief of staff switched to it");
	await h.done();
});

test("channels: the core opens each with its inbox and shows cards on it while it's on; off, it's detached and closed; one that fails to open isn't shown on", async () => {
	const events: string[] = [];
	const other = (platform: string, fails = false): Channel => ({
		platform,
		open: ({ inbox }) => {
			if (fails) throw new Error("no token");
			events.push(`${platform} open, gate for ${inbox.platform}`);
		},
		show: async (card) => (events.push(`${platform} shows ${card.text}`), { channel: platform, chatId: "1", messageId: "1" }),
		close: () => void events.push(`${platform} closed`),
	});
	const h = await agent({
		extensions: () => [
			{ name: "other", title: "Other", about: "", channel: other("other") },
			{ name: "broken", title: "Broken", about: "", channel: other("broken", true) },
		],
		script: () => say("ok"),
	});
	assert.deepEqual(events, ["other open, gate for other"]);
	await h.host.ui.show({ text: "hello", replyTo: { channel: "other", chatId: "1", messageId: "9" } });
	await h.host.ui.show({ text: "lost", replyTo: { channel: "broken", chatId: "1", messageId: "9" } });
	assert.deepEqual(events.slice(1), ["other shows hello"], "threaded on its own channel; the broken one gets nothing");

	h.settings.update({ extensions: { other: { enabled: false } } });
	await h.japa.apply(context);
	await h.host.ui.show({ text: "again", replyTo: { channel: "other", chatId: "1", messageId: "9" } });
	assert.deepEqual(events.slice(2), ["other closed"], "off: closed, and its cards go to a channel that's on");
	assert.equal(h.cards.at(-1)!.card.text, "again");
	await h.done();
});

test("problems: an extension that fails to start is reported to the chief of staff once, not just logged, and its answer reaches the user", async () => {
	let fail = true;
	const h = await agent({
		extensions: () => [{ name: "flaky", title: "Flaky", about: "", start: () => {
			if (fail) throw new Error("Cannot find package 'left-pad'");
		} }],
		script: (turn) => (turn.text.startsWith("[Problem with extension flaky]") ? say("Flaky didn't start (a missing package); I'll have it fixed.") : say("ok")),
	});
	await h.until(() => h.cards.some((card) => card.card.text.startsWith("Flaky didn't start")), "the chief of staff's word on it");
	const problems = () => h.turns.filter((turn) => turn.text.startsWith("[Problem with extension flaky]"));
	assert.match(problems()[0]!.text, /it didn't start: Cannot find package 'left-pad'$/);
	assert.equal(h.japa.extensions.failure("flaky"), "it didn't start: Cannot find package 'left-pad'");

	// The same problem again (turned off and on) isn't news; working again clears it, so a new failure would be.
	h.settings.update({ extensions: { flaky: { enabled: false } } });
	await h.japa.apply(context);
	h.settings.update({ extensions: { flaky: { enabled: true } } });
	await h.japa.apply(context);
	await sleep(300);
	assert.equal(problems().length, 1, "heard once");
	fail = false;
	h.settings.update({ extensions: { flaky: { enabled: false } } });
	await h.japa.apply(context);
	h.settings.update({ extensions: { flaky: { enabled: true } } });
	await h.japa.apply(context);
	assert.equal(h.japa.extensions.failure("flaky"), undefined, "working now");
	await h.done();
});

test("jobs: /jobs lists what the team is working on, shows a job's detail and recent activity; one that has reported can be closed", async () => {
	const h = await agent({
		extensions: () => [],
		script: async (turn) => {
			if (turn.job !== undefined) {
				if (turn.text.includes("Compare fares")) return call("report", { kind: "decision needed", text: "Two airlines checked. Window or aisle?" });
				if (turn.text.includes("Shinjuku")) await new Promise((resolve) => turn.signal?.addEventListener("abort", resolve)); // working till cancelled
				return say("Waiting for the answer.");
			}
			if (turn.text.includes("look into flights")) return call("delegate", { title: "Flights to Tokyo", brief: "Compare fares for May." });
			if (turn.text.includes("find a hotel")) return call("delegate", { title: "Hotel", brief: "Find a hotel in Shinjuku." });
			if (turn.text.startsWith("Started job")) return say("On it.");
			return say("Noted.");
		},
	});
	const ui = h.host.ui;
	const at = { channel: "test", chatId: "7", messageId: "1" };
	const labels = () => h.cards.at(-1)!.card.buttons!.flat().map((button) => button.text);
	const press = (label: string) => {
		const last = h.cards.at(-1)!;
		const button = last.card.buttons!.flat().find((candidate) => candidate.text === label);
		assert.ok(button !== undefined, `no button "${label}" in ${labels().join(" | ")}`);
		return ui.press(button.data, last.ref);
	};

	await ui.run("jobs", at);
	assert.equal(h.cards.at(-1)!.card.text, "No jobs running.");

	assert.deepEqual(await h.ask("1", "[Mon 10:00] look into flights"), { text: "On it." });
	await h.until(() => h.turns.some((turn) => turn.text.startsWith("[Report from job")), "the job's question");
	await ui.run("jobs", at);
	assert.match(h.cards.at(-1)!.card.text, /^Jobs running:\n• Flights to Tokyo \(\w+\): reported, waiting on the chief of staff, started just now$/);
	await press("Flights to Tokyo");
	const detail = h.cards.at(-1)!.card.text;
	assert.match(detail, /Model: faux\/faux-1/);
	assert.match(detail, /← .*Compare fares for May\./, "what it was told");
	assert.match(detail, /→ report \{"kind":"decision needed","text":"Two airlines checked\. Window or aisle\?"\}/, "what it ran");

	assert.ok(!labels().includes("Cancel job"), "it isn't working: it has reported");
	await press("Close job");
	assert.match(h.cards.at(-1)!.card.text, /^Closed\.\n\nFlights to Tokyo .*\nStatus: concluded/);
	assert.ok(!labels().includes("Close job"), "nothing left to close");

	// A job still working (it hasn't reported) is cancelled instead, after a confirming tap.
	await h.ask("2", "[Mon 10:02] find a hotel");
	await h.until(() => h.turns.some((turn) => turn.text.includes("Shinjuku")), "the hotel job at work");
	await ui.run("jobs", at);
	await press("Hotel");
	await press("Cancel job");
	assert.match(h.cards.at(-1)!.card.text, /^Cancel job \w+ and its subagents\?$/);
	await press("Yes, cancel it");
	assert.match(h.cards.at(-1)!.card.text, /^Cancelled\.\n\nHotel .*\nStatus: cancelled/);
	await press("« Jobs");
	assert.equal(h.cards.at(-1)!.card.text, "No jobs running.");
	assert.ok(labels().includes("Finished (2)"));
	await h.done();
});

test("messages: an answer goes back the way its input came, once; message_job reaches the job, never the user", async () => {
	let job = "";
	const h = await agent({
		extensions: () => [],
		script: (turn) => {
			if (turn.job !== undefined) {
				if (turn.text.includes("From the chief of staff: Check May 3 too.")) return call("report", { kind: "done", text: "May 3 is cheaper." });
				return say("Working on it.");
			}
			if (turn.text.includes("look into flights")) return call("delegate", { title: "Flights", brief: "Compare fares for May." });
			if (turn.text.startsWith("Started job")) {
				job = /Started job (\w+)/.exec(turn.text)![1]!;
				return say("On it.");
			}
			if (turn.text.includes("— done] Working on it.")) return call("message_job", { id: job, text: "Check May 3 too." });
			if (turn.text.startsWith("Sent to")) return say("");
			if (turn.text.includes("May 3 is cheaper.")) return say("May 3 is the cheaper day.");
			return say("Noted.");
		},
	});
	assert.deepEqual(await h.ask("1", "[Mon 10:00] look into flights"), { text: "On it." });
	await h.until(() => h.cards.some((card) => card.card.text === "May 3 is the cheaper day."), "the answer to the job's report");
	await sleep(200);
	const shown = h.cards.map((card) => card.card.text);
	assert.deepEqual(shown, ["May 3 is the cheaper day."], "the empty answer said nothing; the message to the job never reached the user; the answer went once");
	assert.deepEqual(h.cards[0]!.card.replyTo, { channel: "test", chatId: "1", messageId: "1" }, "threaded under the request");
	await h.done();
});

test("modalities: a photo is shown to a model that takes images and kept on the workbench; a voice note is kept there with its path; without a workbench, the agent is told", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "japa-"));
	const machine = new LocalBackend(join(dataDir, "machine"));
	const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
	const voice = Uint8Array.from({ length: 3000 }, (_, i) => i % 251);
	const h = await agent({ workbench: machine, extensions: () => [], script: () => say("Got it.") });
	assert.deepEqual(
		await h.ask("1", { text: "[Mon 10:00] what's this, and transcribe the note", attachments: [{ name: "photo.png", mimeType: "image/png", data: png }, { name: "voice.ogg", mimeType: "audio/ogg", data: voice }] }),
		{ text: "Got it." },
	);
	const request = h.turns.at(-1)!.request;
	assert.match(request, /"type":"image","data":"iVBORw0KGgo/, "the photo itself, for the model to see");
	const photo = /\[Attached: photo\.png \(image\/png, 1 KB\), shown here; on your computer at ~\/(inbox\/[\w.-]+)\]/.exec(request);
	const note = /\[Attached: voice\.ogg \(audio\/ogg, 3 KB\); on your computer at ~\/(inbox\/[\w.-]+)\]/.exec(request);
	assert.ok(photo !== null && note !== null, "each file's path is in the message");
	assert.deepEqual(new Uint8Array(await readFile(join(machine.home, photo[1]!))), png, "byte for byte");
	assert.deepEqual(new Uint8Array(await readFile(join(machine.home, note[1]!))), voice);
	await h.done();
	await rm(dataDir, { recursive: true, force: true });

	const bare = await agent({ extensions: () => [], script: () => say("Noted.") });
	await bare.ask("1", { text: "[Mon 10:01] here", attachments: [{ name: "voice.ogg", mimeType: "audio/ogg", data: voice }] });
	assert.match(bare.turns.at(-1)!.request, /\[Attached: voice\.ogg \(audio\/ogg, 3 KB\); there's no computer to keep it on\]/);
	await bare.done();
});

test("login: /login runs a provider's own login from chat, here one an extension adds; then its models are offered", async () => {
	const big = { id: "dyn-big", name: "Dyn Big", api: "openai-completions" as const, provider: "dyn", baseUrl: "http://dyn.invalid", input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1000, maxTokens: 100 };
	const unused = () => {
		throw new Error("not in this test");
	};
	const h = await agent({
		extensions: () => [
			{
				name: "dyn",
				title: "Dyn",
				about: "",
				providers: [
					createProvider({
						id: "dyn",
						name: "Dyn",
						auth: { apiKey: envApiKeyAuth("Dyn API key", ["JAPA_TEST_DYN_KEY_UNSET"]) },
						models: [],
						fetchModels: async (context) => (context.credential?.type === "api_key" && context.credential.key === "dk-1" ? [big] : []),
						api: { stream: unused, streamSimple: unused },
					}),
				],
			},
		],
		script: () => say("ok"),
	});
	const ui = h.host.ui;
	const labels = () => h.cards.at(-1)!.card.buttons!.flat().map((button) => button.text);
	const press = (label: string) => {
		const last = h.cards.at(-1)!;
		const button = last.card.buttons!.flat().find((candidate) => candidate.text === label);
		assert.ok(button !== undefined, `no button "${label}" in ${labels().join(" | ")}`);
		return ui.press(button.data, last.ref);
	};
	const at = { channel: "test", chatId: "7", messageId: "1" };

	await ui.run("login", at);
	assert.ok(labels().includes("Dyn"), "offered, without a tick");
	const pressed = press("Dyn");
	await h.until(() => h.cards.at(-1)!.card.ask !== undefined, "the provider's own prompt for its key");
	assert.equal(h.cards.at(-1)!.card.ask!.secret, true, "asked for as a secret");
	await ui.reply(h.cards.at(-1)!.card.ask!.data, "dk-1", { channel: "test", chatId: "7", messageId: "99" });
	await pressed;
	assert.equal(h.cards.at(-1)!.card.text, "Logged in to Dyn.");

	await ui.run("settings", at);
	await press("General");
	await press("Chief of staff model: faux/faux-1");
	await press("dyn (1)");
	assert.ok(labels().includes("Dyn Big"), "its models are in the picker");

	h.settings.update({ extensions: { dyn: { enabled: false } } });
	await h.japa.apply(context);
	assert.equal(h.host.models.getProvider("dyn"), undefined, "off: its provider is gone");
	await h.done();
});

test("triggers: a time trigger wakes the chief of staff on schedule (durably), an event trigger when emitted; off means no more", async () => {
	const h = await agent({
		extensions: () => [
			{ name: "pinger", title: "Pinger", about: "", triggers: [{ name: "tick", when: { every: "1s" }, prompt: "Check the oven." }, { name: "mail", when: { event: "mail.arrived" }, prompt: "New mail; decide if it matters." }] },
		],
		script: (turn) => (turn.text.startsWith("[Trigger") ? say(`About: ${turn.text.slice(0, 60)}`) : say("ok")),
	});
	await h.until(() => h.turns.some((turn) => turn.text.startsWith("[Trigger pinger/tick,") && turn.text.endsWith("] Check the oven.")), "the time trigger");
	await h.until(() => h.cards.some((shown) => shown.card.text.startsWith("About: [Trigger pinger/tick")), "the chief of staff's message about it");
	h.host.emit("mail.arrived", "From: Sam — Re: launch");
	await h.until(() => h.turns.some((turn) => turn.text.startsWith("[Trigger pinger/mail,") && turn.text.endsWith("decide if it matters.\nFrom: Sam — Re: launch")), "the event trigger");

	h.settings.setOption("pinger", "enabled", false);
	await h.japa.apply(context);
	await sleep(1300);
	const ticks = h.turns.filter((turn) => turn.text.startsWith("[Trigger pinger/tick")).length;
	await sleep(1300);
	assert.equal(h.turns.filter((turn) => turn.text.startsWith("[Trigger pinger/tick")).length, ticks, "turned off: no more ticks");
	await h.done();
});

test("prompt: the chief of staff gets its role and how it extends itself, naming no channel or setup; job agents don't", async () => {
	const h = await agent({
		extensions: () => [emailExtension([])],
		script: (turn) => {
			if (turn.job !== undefined) return call("report", { summary: "Done." });
			if (turn.text.includes("hand it off")) return call("delegate", { title: "Errand", brief: "Do the errand." });
			return say("ok");
		},
	});
	await h.ask("1", "[Mon 10:00] hand it off");
	await h.until(() => h.turns.some((turn) => turn.job !== undefined), "the job agent's turn");
	const chief = h.turns.find((turn) => turn.job === undefined)!.request;
	assert.match(chief, /Your role is to answer, decide, delegate, and synthesize/);
	assert.match(chief, /You are built to be customized/);
	assert.match(chief, /clone .* on the workbench/, "the how-to is in install_extension's description");
	assert.doesNotMatch(chief, /Telegram|faux-1/, "no channel or setup named");
	const job = h.turns.find((turn) => turn.job !== undefined)!.request;
	assert.ok(!job.includes("You are built to be customized") && !job.includes("Your role is to answer"), "job agents aren't the chief of staff");
	await h.done();
});

/** An extension as a job would write it on the workbench: one file, values imported only from packages. */
const greetSource = (version: string) => `import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Host, JapaExtension } from "../src/pi/extension.ts";

export default function (host: Host): JapaExtension {
	const extension = defineExtension({
		name: "ext.greet",
		tools: [defineTool({ name: "greet", description: "Say hi.", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "Hi from greet ${version}" }] }) })],
	});
	return { name: "greet", title: "Greet", about: "Says hi.", chief: [extension] };
}
`;

test("installer: an extension written on the workbench is installed from chat on the user's tap, hot, replaced in place, and back after a restart", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "japa-"));
	const workbench = new LocalBackend(join(dataDir, "machine"));
	const file = join(workbench.home, "greet.ts");
	const script = (turn: { text: string }) => {
		if (turn.text.includes("install greet")) return call("install_extension", { path: file, name: "greet", summary: "Says hi." });
		if (turn.text.startsWith("Asked the user")) return say("I've asked you.");
		if (turn.text.includes("[Extension greet]")) return say(turn.text.includes("Installed") ? "Greet is on." : `Not installed: ${turn.text}`);
		if (turn.text.includes("say hi")) return call("greet", {});
		if (turn.text.startsWith("Hi from greet")) return say(turn.text);
		return say("ok");
	};
	const h = await agent({ workbench, dataDir, extensions: () => [], script });
	const install = async (id: string) => {
		const before = h.cards.length;
		assert.deepEqual(await h.ask(id, "[Mon 10:00] install greet"), { text: "I've asked you." });
		await h.until(() => h.cards.slice(before).some((shown) => shown.card.buttons !== undefined), "the install card");
		const card = h.cards.slice(before).find((shown) => shown.card.buttons !== undefined)!;
		assert.match(card.card.text, /^Install extension\? greet/);
		await h.host.ui.press(card.card.buttons![0]![0]!.data, card.ref);
		await h.until(() => h.cards.slice(before).some((shown) => shown.card.text === "Greet is on."), "the chief of staff hearing it's installed");
	};

	await writeFile(file, greetSource("v1"));
	assert.ok(!(await h.ask("0", "[Mon 09:59] say hi").then((answer) => JSON.stringify(answer))).includes("Hi from"), "not there before");
	await install("1");
	assert.deepEqual(await h.ask("2", "[Mon 10:01] say hi"), { text: "Hi from greet v1" });
	assert.ok(h.japa.extensions.get("greet"), "it shows in /settings like any other");

	await writeFile(file, greetSource("v2"));
	await install("3");
	assert.deepEqual(await h.ask("4", "[Mon 10:03] say hi"), { text: "Hi from greet v2" }, "a new version replaces the old one, no restart");

	await h.japa.close(context);
	const again = await agent({ workbench, dataDir, extensions: () => [], script });
	assert.deepEqual(await again.ask("5", "[Mon 10:05] say hi"), { text: "Hi from greet v2" }, "loaded again at start");
	await again.done();
});

test("installer: the user saying no installs nothing, and a built-in can't be replaced from chat", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "japa-"));
	const workbench = new LocalBackend(join(dataDir, "machine"));
	const file = join(workbench.home, "greet.ts");
	await writeFile(file, greetSource("v1"));
	const h = await agent({
		workbench,
		dataDir,
		extensions: (host) => [webExtension(host)],
		script: (turn) => {
			if (turn.text.includes("install greet")) return call("install_extension", { path: file, name: "greet", summary: "Says hi." });
			if (turn.text.includes("replace web")) return call("install_extension", { path: file, name: "web", summary: "A new web." });
			if (turn.text.startsWith("Asked the user")) return say("I've asked you.");
			if (turn.text.includes("[Extension greet]")) return say(turn.text.includes("chose not") ? "Okay, not installed." : "?");
			return say(turn.text);
		},
	});
	await h.ask("1", "[Mon 10:00] install greet");
	const card = h.cards.find((shown) => shown.card.buttons !== undefined)!;
	await h.host.ui.press(card.card.buttons![0]![1]!.data, card.ref);
	await h.until(() => h.cards.some((shown) => shown.card.text === "Okay, not installed."), "the chief of staff hearing no");
	assert.equal(h.japa.extensions.get("greet"), undefined);
	assert.deepEqual(await h.ask("2", "[Mon 10:01] replace web"), { text: '"web" is built in; pick another name.' });
	await h.done();
});

test("installer: a file that wouldn't load is sent back to the agent with why, before the user is asked", async () => {
	assert.deepEqual(problems(greetSource("v1")), [], "a good one passes (type imports from anywhere are fine)");
	const piStyle = `import {
	createProvider,
	type Model,
} from "@earendil-works/pi-ai";
import { envApiKeyAuth } from "@earendil-works/pi-ai/auth/helpers";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.nope";
import { helper } from "./helper.ts";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export default function (pi: ExtensionAPI) {}
`;
	const found = problems(piStyle);
	assert.equal(found.length, 3, found.join("\n"));
	assert.match(found[0]!, /"@earendil-works\/pi-ai\/auth\/helpers" isn't available \(@earendil-works\/pi-ai exports \., \.\/models/);
	assert.match(found[1]!, /openai-completions\.nope/, "a wildcard export pointing at no file");
	assert.match(found[2]!, /"\.\/helper\.ts": it must be one file/);
	assert.deepEqual(problems("export const x = 1;"), ["it has no default export"]);

	const dataDir = await mkdtemp(join(tmpdir(), "japa-"));
	const workbench = new LocalBackend(join(dataDir, "machine"));
	await writeFile(join(workbench.home, "bad.ts"), piStyle);
	const h = await agent({
		workbench,
		dataDir,
		extensions: () => [],
		script: (turn) => (turn.text.includes("install it") ? call("install_extension", { path: join(workbench.home, "bad.ts"), name: "bad", summary: "Bad." }) : say(turn.text.split("\n")[0]!)),
	});
	assert.deepEqual(await h.ask("1", "[Mon 10:00] install it"), { text: "Not asking the user: it wouldn't load." });
	assert.ok(!h.cards.some((shown) => shown.card.buttons !== undefined), "no card");
	await h.done();
});
