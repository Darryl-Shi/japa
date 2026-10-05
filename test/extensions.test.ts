import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { LocalBackend } from "../src/backends/local.ts";
import { Approvals } from "../src/core/approvals.ts";
import { approvalsExtension } from "../src/pi/approvals.ts";
import { CLAUDE_CODE, CODEX, codingAgentExtension } from "../src/pi/coding-agents.ts";
import type { JarvisExtension } from "../src/pi/extension.ts";
import { webExtension } from "../src/pi/web.ts";
import { agent, call, context, say, sleep } from "./helpers.ts";

/** A tool that acts on the world, counting its runs. */
function emailExtension(sent: string[]): JarvisExtension {
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
	assert.deepEqual(requests[0], { url: "https://api.parallel.ai/v1/search", body: { objective: "Find alpha", search_queries: ["alpha", "alpha fact"], mode: "fast", max_results: 8 }, key: "pk-test" });
	assert.deepEqual(requests[1]?.body, { urls: ["https://b.example"], advanced_settings: { full_content: true } });
	await h.done();
});

test("coding agents: Claude Code and Codex run on the workbench with the key passed to that run only, and sessions continue", async () => {
	const dir = await mkdtemp(join(tmpdir(), "jarvis-machine-"));
	const machine = new LocalBackend(join(dir, "machine"));
	const bin = join(machine.home, ".local/bin");
	await mkdir(bin, { recursive: true });
	// Fakes that echo what they were given, in each tool's real output format.
	await writeFile(join(bin, "claude"), `#!/bin/bash\nprintf '{"type":"result","subtype":"success","is_error":false,"result":"did: %s in %s token=%s args=%s","session_id":"s-123"}\\n' "$2" "$(basename "$PWD")" "$CLAUDE_CODE_OAUTH_TOKEN" "$*"\n`);
	await writeFile(join(bin, "codex"), `#!/bin/bash\necho '{"type":"thread.started","thread_id":"th-9"}'\necho '{"type":"item.completed","item":{"type":"error","message":"config warning"}}'\necho "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"codex key=$CODEX_API_KEY resume=$3\\"}}"\n`);
	await chmod(join(bin, "claude"), 0o755);
	await chmod(join(bin, "codex"), 0o755);
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
	assert.deepEqual(ui.commands(), [{ name: "settings", description: "Models, extensions and their options" }], "advertised, with what it does");
	assert.equal(await ui.run("settings", { channel: "test", chatId: 7, messageId: 1 }), true);
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
	await ui.reply(prompt.ask!.data, "pk-live", { channel: "test", chatId: 7, messageId: 99 });
	assert.equal(h.secrets.get("web.apiKey"), "pk-live");
	assert.ok(!JSON.stringify(h.settings.get()).includes("pk-live"), "secrets never land in settings.json");
	assert.ok(!JSON.stringify(h.cards.map((shown) => shown.card)).includes("allowlist"), "the allowlist isn't in the menu");

	// A model is picked from the models pi can use, not typed.
	await ui.run("settings", { channel: "test", chatId: 7, messageId: 1 });
	await press("General");
	await press("Chief of staff model: faux/faux-1");
	assert.deepEqual(labels(), ["✅ faux-1 👁", "faux-fast 👁", "⌨ Type an id", "« Back"], "one provider: straight to its models, the current one ticked");
	await press("faux-fast 👁");
	assert.deepEqual(h.settings.get().model, { provider: "faux", modelId: "faux-fast" });
	assert.ok(labels().includes("Chief of staff model: faux/faux-fast"), "back on the page, showing the choice");
	assert.equal((await h.thread.root.agent(context)).model?.modelId, "faux-fast", "and the chief of staff switched to it");
	await h.done();
});

test("triggers: a time trigger wakes the chief of staff on schedule (durably), an event trigger when emitted; off means no more", async () => {
	const h = await agent({
		extensions: () => [
			{ name: "pinger", title: "Pinger", about: "", triggers: [{ name: "tick", when: { every: "1s" }, prompt: "Check the oven." }, { name: "mail", when: { event: "mail.arrived" }, prompt: "New mail; decide if it matters." }] },
		],
		script: (turn) => (turn.text.startsWith("[Trigger") ? call("message_user", { text: `About: ${turn.text.slice(0, 60)}`, urgency: "silent" }) : say("ok")),
	});
	await h.until(() => h.turns.some((turn) => turn.text.startsWith("[Trigger pinger/tick,") && turn.text.endsWith("] Check the oven.")), "the time trigger");
	await h.until(() => h.cards.some((shown) => shown.card.text.startsWith("About: [Trigger pinger/tick")), "the chief of staff's message about it");
	h.host.emit("mail.arrived", "From: Sam — Re: launch");
	await h.until(() => h.turns.some((turn) => turn.text.startsWith("[Trigger pinger/mail,") && turn.text.endsWith("decide if it matters.\nFrom: Sam — Re: launch")), "the event trigger");

	h.settings.setOption("pinger", "enabled", false);
	await h.jarvis.apply(context);
	await sleep(1300);
	const ticks = h.turns.filter((turn) => turn.text.startsWith("[Trigger pinger/tick")).length;
	await sleep(1300);
	assert.equal(h.turns.filter((turn) => turn.text.startsWith("[Trigger pinger/tick")).length, ticks, "turned off: no more ticks");
	await h.done();
});

test("setup: the chief of staff is told how it's set up from live state; job agents aren't", async () => {
	const h = await agent({
		extensions: () => [emailExtension([]), { name: "calendar", title: "Calendar", about: "Your calendar.", enabledByDefault: false }],
		script: (turn) => {
			if (turn.job !== undefined) return call("report", { summary: "Done." });
			if (turn.text.includes("hand it off")) return call("delegate", { title: "Errand", brief: "Do the errand." });
			return say("ok");
		},
	});
	await h.ask("1", "[Mon 10:00] hand it off");
	await h.until(() => h.turns.some((turn) => turn.job !== undefined), "the job agent's turn");
	const chief = h.turns.find((turn) => turn.job === undefined)!.request;
	assert.match(chief, /You are japa/);
	assert.match(chief, /you run on faux\/faux-1/);
	assert.match(chief, /Calendar \(off\): Your calendar\./);
	assert.match(chief, /Email \(on\)/);
	assert.ok(!h.turns.find((turn) => turn.job !== undefined)!.request.includes("You are japa"), "job agents aren't told");
	await h.done();
});
