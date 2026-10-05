import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProvider, envApiKeyAuth, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Approvals } from "../src/core/approvals.ts";
import { approvalsExtension } from "../src/pi/approvals.ts";
import type { Channel, JapaExtension } from "../src/pi/extension.ts";
import { webExtension } from "../src/pi/web.ts";
import { agent, call, context, say, sleep } from "./helpers.ts";

/** A tool that acts on the world, counting its runs. */
function emailExtension(sent: string[]): JapaExtension {
	const extension = defineExtension({
		name: "email",
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
	return { ...extension, title: "Email", about: "" };
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
	// Reading reaches beyond the machine too, so it's reviewed, and goes ahead without asking.
	assert.ok(h.turns.some((turn) => isReview(turn.request) && turn.request.includes("list_inbox")), "every tool that acts is reviewed");
	assert.equal(h.cards.length, 0);

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
	assert.deepEqual(audit, ["allowed", "asked", "approve", "ran-approved"]);
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
			{ name: "model", description: "The models it and its jobs use" },
			{ name: "thinking", description: "How hard each model thinks" },
			{ name: "login", description: "Log in to a model provider" },
			{ name: "logout", description: "Log out of a model provider" },
			{ name: "jobs", description: "What the team is working on" },
			{ name: "session", description: "What it has spent, by job" },
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
	await press("Models ▸");
	await press("Chief of staff: faux/faux-1");
	assert.deepEqual(labels(), ["✅ faux-1 👁", "faux-fast 👁", "⌨ Type an id", "« Back"], "one provider: straight to its models, the current one ticked");
	await press("faux-fast 👁");
	assert.deepEqual(h.settings.get().model, { provider: "faux", modelId: "faux-fast" });
	assert.ok(labels().includes("Chief of staff: faux/faux-fast"), "back on the page, showing the choice");
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

	// /session: what it has spent, by job (pi's ledger of each job's conversation), the chief of staff's in one line.
	await ui.run("session", at);
	const spend = h.cards.at(-1)!.card.text.split("\n");
	assert.match(spend[0]!, /^Spent so far: \$0\.00, [1-9]\d*k? tokens\.$/);
	assert.equal(spend[1], "By job:");
	const job = (title: string) => spend.slice(2, 4).find((each) => each.startsWith(`• ${title} (`));
	assert.match(job("Flights to Tokyo")!, /: \$0\.00, [1-9]\d*k? tokens$/);
	assert.match(job("Hotel")!, /: \$0\.00, \d+k? tokens$/, "cancelled mid-turn: what it finished");
	assert.match(spend[4]!, /^Chief of staff: \$0\.00, [1-9]\d*k? tokens$/);
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

test("modalities: a photo is shown to a model that takes images and kept on its computer; a voice note is kept there with its path", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "japa-"));
	const home = join(dataDir, "machine");
	const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
	const voice = Uint8Array.from({ length: 3000 }, (_, i) => i % 251);
	const h = await agent({ home, dataDir, extensions: () => [], script: () => say("Got it.") });
	assert.deepEqual(
		await h.ask("1", { text: "[Mon 10:00] what's this, and transcribe the note", attachments: [{ name: "photo.png", mimeType: "image/png", data: png }, { name: "voice.ogg", mimeType: "audio/ogg", data: voice }] }),
		{ text: "Got it." },
	);
	const request = h.turns.at(-1)!.request;
	assert.match(request, /"type":"image","data":"iVBORw0KGgo/, "the photo itself, for the model to see");
	const photo = /\[Attached: photo\.png \(image\/png, 1 KB\), shown here; on your computer at ([^\]]+)\]/.exec(request);
	const note = /\[Attached: voice\.ogg \(audio\/ogg, 3 KB\); on your computer at ([^\]]+)\]/.exec(request);
	assert.ok(photo !== null && note !== null, "each file's path is in the message");
	assert.ok(photo[1]!.startsWith(join(home, "inbox")), "in inbox/ under its home");
	assert.deepEqual(new Uint8Array(await readFile(photo[1]!)), png, "byte for byte");
	assert.deepEqual(new Uint8Array(await readFile(note[1]!)), voice);
	await h.done();
});

test("login: /login runs a provider's own login from chat; then its models are offered; /logout removes the credential", async () => {
	const big = { id: "dyn-big", name: "Dyn Big", api: "openai-completions" as const, provider: "dyn", baseUrl: "http://dyn.invalid", input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1000, maxTokens: 100 };
	const unused = () => {
		throw new Error("not in this test");
	};
	const h = await agent({
		extensions: () => [],
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
	await ui.run("model", at);
	await press("Chief of staff: faux/faux-1");
	await press("dyn (1)");
	assert.ok(labels().includes("Dyn Big"), "its models are in the picker");

	await ui.run("logout", at);
	assert.deepEqual(labels(), ["✕ Dyn"], "only the providers with a credential");
	await press("✕ Dyn");
	await press("Yes, log out");
	assert.equal(h.cards.at(-1)!.card.text, "Logged out of Dyn.");
	assert.equal(await h.host.models.checkAuth("dyn"), undefined, "its credential is gone");
	await h.done();
});

test("thinking: each model slot has its own level, from the ones its model supports; the chief of staff and its jobs think at theirs", async () => {
	const h = await agent({
		extensions: () => [],
		script: (turn) => {
			if (turn.job === undefined && turn.text.includes("start it")) return call("delegate", { title: "Dig", brief: "Dig in." });
			if (turn.job !== undefined && turn.text.includes("Dig in")) return call("report", { kind: "done", text: "Dug." });
			return say("ok");
		},
	});
	const ui = h.host.ui;
	const labels = () => h.cards.at(-1)!.card.buttons!.flat().map((button) => button.text);
	const press = (label: string) => {
		const last = h.cards.at(-1)!;
		const button = last.card.buttons!.flat().find((candidate) => candidate.text === label);
		assert.ok(button !== undefined, `no button "${label}" in ${labels().join(" | ")}`);
		return ui.press(button.data, last.ref);
	};
	await ui.run("thinking", { channel: "test", chatId: "7", messageId: "1" });
	assert.deepEqual(labels(), ["Chief of staff: off", "Jobs (blank: the chief of staff's): off", "Fast (approvals, summaries): off", "« Back"]);
	await press("Chief of staff: off");
	assert.deepEqual(labels(), ["✅ off", "minimal", "low", "medium", "high", "« Back"], "the levels its model supports");
	await press("high");
	await press("Jobs (blank: the chief of staff's): off");
	await press("low");
	await press("Fast (approvals, summaries): off");
	assert.deepEqual(labels(), ["✅ off", "« Back"], "a model that doesn't reason has only off");
	assert.deepEqual(h.settings.get().model, { provider: "faux", modelId: "faux-1", thinking: "high" });
	assert.equal((await h.thread.root.agent(context)).thinkingLevel, "high");

	await h.ask("1", "[Mon 10:00] start it");
	await h.until(() => h.turns.some((turn) => turn.job !== undefined), "the job's turn");
	await h.thread.settled();
	assert.ok(h.turns.filter((turn) => turn.job === undefined && turn.text.includes("start it")).every((turn) => turn.reasoning === "high"), "the chief of staff thinks at its level");
	assert.ok(h.turns.filter((turn) => turn.job !== undefined).every((turn) => turn.reasoning === "low"), "its job at the jobs' level");
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
	assert.match(chief, /clone .* on your computer/, "the how-to is in install_extension's description");
	assert.doesNotMatch(chief, /Telegram|faux-1/, "no channel or setup named");
	const job = h.turns.find((turn) => turn.job !== undefined)!.request;
	assert.ok(!job.includes("You are built to be customized") && !job.includes("Your role is to answer"), "job agents aren't the chief of staff");
	await h.done();
});

/** An extension as a job would write it on its computer: one file, values imported only from packages. */
const greetSource = (version: string) => `import { createProvider, envApiKeyAuth, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Host, JapaExtension } from "../src/pi/extension.ts";

export default function (host: Host): JapaExtension {
	const extension = defineExtension({
		name: "greet",
		tools: [defineTool({ name: "greet", description: "Say hi.", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "Hi from greet ${version}" }] }) })],
	});
	return { ...extension, title: "Greet", about: "Says hi.", for: "chief" };
}
`;

test("installer: an extension written on its computer is checked, installed from chat on the user's tap, hot, replaced in place, and back after a restart", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "japa-"));
	const home = join(dataDir, "machine");
	await mkdir(home, { recursive: true });
	const file = join(home, "greet.ts");
	const script = (turn: { text: string }) => {
		if (turn.text.includes("install greet")) return call("install_extension", { path: file, name: "greet", summary: "Says hi." });
		if (turn.text.startsWith("Checking it")) return say("I've asked you.");
		if (turn.text.includes("[Extension greet]")) return say(turn.text.includes("Installed") ? "Greet is on." : `Not installed: ${turn.text}`);
		if (turn.text.includes("say hi")) return call("greet", {});
		if (turn.text.startsWith("Hi from greet")) return say(turn.text);
		return say("ok");
	};
	const h = await agent({ home, dataDir, extensions: () => [], script });
	const install = async (id: string) => {
		const before = h.cards.length;
		assert.deepEqual(await h.ask(id, "[Mon 10:00] install greet"), { text: "I've asked you." });
		await h.until(() => h.cards.slice(before).some((shown) => shown.card.buttons !== undefined), "the install card");
		const card = h.cards.slice(before).find((shown) => shown.card.buttons !== undefined)!;
		assert.match(card.card.text, /^Install extension\? greet/);
		assert.match(card.card.text, /It runs inside the agent, with its settings and keys\./);
		assert.doesNotMatch(card.card.text, /npm packages/, "it uses only what japa has");
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
	assert.equal((await readdir(join(dataDir, "extensions", "greet"))).length, 1, "the old version is gone");

	await h.japa.close(context);
	const again = await agent({ home, dataDir, extensions: () => [], script });
	assert.deepEqual(await again.ask("5", "[Mon 10:05] say hi"), { text: "Hi from greet v2" }, "loaded again at start");
	await again.done();
});

test("installer: a directory with its own npm package and files of its own installs like one file; older layouts are moved into place", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "japa-"));
	const home = join(dataDir, "machine");
	await mkdir(home, { recursive: true });
	const code = join(home, "shouter");
	await mkdir(join(code, "vendor", "shout"), { recursive: true });
	await writeFile(join(code, "vendor", "shout", "package.json"), JSON.stringify({ name: "shout", version: "1.0.0", type: "module", main: "index.js" }));
	await writeFile(join(code, "vendor", "shout", "index.js"), "export const shout = (text) => `${text.toUpperCase()}!`;\n");
	await writeFile(join(code, "package.json"), JSON.stringify({ type: "module", dependencies: { shout: "file:./vendor/shout" } }));
	await writeFile(join(code, "words.ts"), 'export const word = "hello";\n');
	await writeFile(
		join(code, "index.ts"),
		`import { createProvider, envApiKeyAuth, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { shout } from "shout";
import { word } from "./words.ts";

export default function () {
	const extension = defineExtension({
		name: "shouter",
		tools: [defineTool({ name: "shout", description: "Shout.", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: shout(word) }] }) })],
	});
	return { ...extension, title: "Shouter", about: "Shouts." };
}
`,
	);
	// Installed before, in the layouts of earlier versions: one file, and code/ beside what a sandbox kept, in the shape
	// from before an extension was a Pi extension itself (the Pi extensions each agent gets).
	await mkdir(join(dataDir, "extensions", "old", "code"), { recursive: true });
	await writeFile(join(dataDir, "extensions", "greet.ts"), greetSource("old"));
	const oldShape = greetSource("sandboxed").replaceAll("greet", "old").replace("return { ...extension,", 'return { name: "old", chief: [extension],');
	assert.ok(oldShape.includes("chief: [extension]"));
	await writeFile(join(dataDir, "extensions", "old", "code", "old.ts"), oldShape);
	await writeFile(join(dataDir, "extensions", "old", "manifest.json"), "{}");
	const h = await agent({
		home,
		dataDir,
		extensions: () => [],
		script: (turn) => {
			if (turn.text.includes("install it")) return call("install_extension", { path: code, name: "shouter", summary: "Shouts." });
			if (turn.text.startsWith("Checking it")) return say("Checking.");
			if (turn.text.includes("[Extension shouter]")) return say(turn.text.includes("Installed") ? "On." : turn.text);
			if (turn.text.includes("shout now")) return call("shout", {});
			if (turn.text.includes("greet now")) return call("greet", {});
			if (turn.text.includes("old now")) return call("old", {});
			return say(turn.text.split("\n")[0]!);
		},
	});
	assert.deepEqual(await h.ask("1", "[Mon 10:00] greet now"), { text: "Hi from greet old" }, "one file, moved into place");
	assert.deepEqual(await h.ask("2", "[Mon 10:00] old now"), { text: "Hi from old sandboxed" }, "a sandbox's code/, moved into place");
	assert.ok(!existsSync(join(dataDir, "extensions", "old", "manifest.json")), "what a sandbox kept is gone");

	await h.ask("3", "[Mon 10:01] install it");
	await h.until(() => h.cards.some((shown) => shown.card.buttons !== undefined), "the install card");
	const card = h.cards.find((shown) => shown.card.buttons !== undefined)!;
	assert.match(card.card.text, /Its own npm packages: shout\./);
	await h.host.ui.press(card.card.buttons![0]![0]!.data, card.ref);
	await h.until(() => h.cards.some((shown) => shown.card.text === "On."), "it being on");
	assert.deepEqual(await h.ask("4", "[Mon 10:02] shout now"), { text: "HELLO!" });
	await h.done();
});

test("installer: the user saying no installs nothing, and a built-in can't be replaced from chat", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "japa-"));
	const home = join(dataDir, "machine");
	await mkdir(home, { recursive: true });
	const file = join(home, "greet.ts");
	await writeFile(file, greetSource("v1"));
	const h = await agent({
		home,
		dataDir,
		extensions: (host) => [webExtension(host)],
		script: (turn) => {
			if (turn.text.includes("install greet")) return call("install_extension", { path: file, name: "greet", summary: "Says hi." });
			if (turn.text.includes("replace web")) return call("install_extension", { path: file, name: "web", summary: "A new web." });
			if (turn.text.startsWith("Checking it")) return say("I've asked you.");
			if (turn.text.includes("[Extension greet]")) return say(turn.text.includes("chose not") ? "Okay, not installed." : "?");
			return say(turn.text);
		},
	});
	await h.ask("1", "[Mon 10:00] install greet");
	await h.until(() => h.cards.some((shown) => shown.card.buttons !== undefined), "the install card");
	const card = h.cards.find((shown) => shown.card.buttons !== undefined)!;
	await h.host.ui.press(card.card.buttons![0]![1]!.data, card.ref);
	await h.until(() => h.cards.some((shown) => shown.card.text === "Okay, not installed."), "the chief of staff hearing no");
	assert.equal(h.japa.extensions.get("greet"), undefined);
	assert.deepEqual(await h.ask("2", "[Mon 10:01] replace web"), { text: '"web" is built in; pick another name.' });
	await h.done();
});

test("installer: code that wouldn't load goes back to the agent with why, and the user isn't asked", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "japa-"));
	const home = join(dataDir, "machine");
	await mkdir(home, { recursive: true });
	await mkdir(join(home, "bad"));
	await writeFile(
		join(home, "bad", "index.ts"),
		`import { createProvider } from "@earendil-works/pi-ai";
import { envApiKeyAuth } from "@earendil-works/pi-ai/auth/helpers";
import { helper } from "./helper.ts";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export const x = 1;
`,
	);
	const h = await agent({
		home,
		dataDir,
		extensions: () => [],
		script: (turn) => {
			if (turn.text.includes("install it")) return call("install_extension", { path: "bad", name: "bad", summary: "Bad." });
			if (turn.text.startsWith("Checking it")) return say("Checking.");
			if (turn.text.includes("[Extension bad]")) return say(turn.text.slice(turn.text.indexOf("[Extension bad]")));
			return say("Checking.");
		},
	});
	assert.deepEqual(await h.ask("1", "[Mon 10:00] install it"), { text: "Checking." });
	await h.until(() => h.cards.some((shown) => shown.card.text.startsWith("[Extension bad]")), "the agent hearing why");
	const told = h.cards.find((shown) => shown.card.text.startsWith("[Extension bad]"))!.card.text;
	assert.match(told, /It wouldn't load, so the user wasn't asked/);
	assert.match(told, /index\.ts has no default export/);
	assert.match(told, /"@earendil-works\/pi-ai\/auth\/helpers" isn't available \(@earendil-works\/pi-ai exports \., \.\/models/);
	assert.match(told, /"\.\/helper\.ts" isn't there/);
	assert.doesNotMatch(told, /pi-coding-agent/, "a type import is fine from anywhere");
	assert.ok(!h.cards.some((shown) => shown.card.buttons !== undefined), "no card");
	await h.done();
});
