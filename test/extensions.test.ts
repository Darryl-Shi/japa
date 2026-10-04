import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, type JsonObject, type Context as PiContext, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { LocalBackend } from "../src/backends/local.ts";
import { SettingsMenu, type View } from "../src/channels/settings-menu.ts";
import { type ApprovalRequest, Approvals } from "../src/core/approvals.ts";
import { OpenItems, WorkingSetFile } from "../src/core/state.ts";
import { SecretsFile } from "../src/credentials.ts";
import { approvalsExtension, decisionText } from "../src/pi/approvals.ts";
import { CLAUDE_CODE, CODEX, codingAgentExtension } from "../src/pi/coding-agents.ts";
import { delegationExtensions } from "../src/pi/delegation.ts";
import { ExtensionSet, type JarvisExtension } from "../src/pi/extension.ts";
import { MainThread } from "../src/pi/harness.ts";
import { stateExtension } from "../src/pi/state.ts";
import { webExtension } from "../src/pi/web.ts";
import { SettingsFile } from "../src/settings.ts";

const context = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(text);
const target = (messageId: number) => ({ chatId: 1, messageId });

type Turn = { text: string; job?: string; request: string; review: boolean };

function lastText(request: PiContext): string {
	const last = [...request.messages].reverse().find((message) => message.role === "user" || message.role === "toolResult");
	if (last === undefined) return "";
	return typeof last.content === "string" ? last.content : last.content.map((part) => ("text" in part ? part.text : "")).join("");
}

/** A main thread with the given extension entries, settings in a temp dir, and a scripted model. */
async function setup(
	makeEntries: (deps: { settings: SettingsFile; secrets: SecretsFile; models: ReturnType<typeof createModels>; dataDir: string; safeTools: () => ReadonlySet<string> }) => JarvisExtension[],
	script: (turn: Turn) => AssistantMessage | Promise<AssistantMessage>,
	options: { team?: boolean; approvals?: Approvals } = {},
) {
	const dataDir = await mkdtemp(join(tmpdir(), "jarvis-"));
	const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-fast" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const turns: Turn[] = [];
	const respond: FauxResponseFactory = async (request) => {
		const sent = JSON.stringify(request);
		if (sent.includes("<previous_working_set>")) return say(JSON.stringify({ working_set: "", memory_edits: [] }));
		const turn: Turn = { text: lastText(request), request: sent, review: sent.includes("You review one action"), ...(/Your job \(([\w.]+)\)/.exec(sent) === null ? {} : { job: /Your job \(([\w.]+)\)/.exec(sent)![1]! }) };
		turns.push(turn);
		return script(turn);
	};
	faux.setResponses(Array.from({ length: 300 }, () => respond));
	const settings = new SettingsFile(dataDir);
	settings.update({ model: { provider: "faux", modelId: "faux-1" }, delegateModel: { provider: "faux", modelId: "faux-1" }, jobModels: { fast: { provider: "faux", modelId: "faux-fast" } }, context: { idleMinutes: 60, sliceTokens: 1_000_000 } });
	const secrets = new SecretsFile(join(dataDir, "secrets.json"));
	const state = { openItems: new OpenItems(join(dataDir, "open-items.json")), workingSet: new WorkingSetFile(join(dataDir, "working-set.json")) };
	const stateTools = stateExtension(state);
	let thread: MainThread | undefined;
	let set: ExtensionSet | undefined;
	const team = delegationExtensions({
		openItems: state.openItems,
		settings: () => settings.get(),
		origin: (callContext) => thread!.origin(callContext),
		withhold: () => [thread!.core, ...set!.withheldFromJobs()],
		waitingOnUser: (conversationId) => options.approvals?.waiting(String(conversationId)) ?? false,
	});
	const entries = makeEntries({ settings, secrets, models, dataDir, safeTools: () => set!.safeTools() });
	if (options.team === true) {
		entries.unshift(
			{ name: "team", title: "Team", about: "", required: true, safeTools: ["delegate", "check_job", "conclude_job", "message_user", "report"], chief: [team.chief], jobs: [team.job, team.helper] },
			{ name: "open-items", title: "Open items", about: "", required: true, safeTools: ["track", "resolve"], chief: [stateTools] },
		);
	}
	set = new ExtensionSet(entries, settings);
	thread = await MainThread.open({ dataDir, models, settings: () => settings.get(), installed: set.installed(), selected: () => set!.forChief(), state }, context);
	await thread.deliverOutbox(async () => 1, context);
	const until = async (check: () => boolean, what: string) => {
		for (let i = 0; i < 500 && !check(); i++) await sleep(10);
		assert.ok(check(), `timed out waiting for ${what}`);
	};
	return {
		thread,
		team,
		settings,
		secrets,
		extensions: set,
		turns,
		dataDir,
		until,
		done: async () => {
			await thread!.close(context);
			await rm(dataDir, { recursive: true, force: true });
		},
	};
}

/** A tool that acts on the world, counting its runs. */
function emailEntry(sent: string[]): JarvisExtension {
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
			defineTool({
				name: "list_inbox",
				description: "List the inbox.",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "3 unread." }] }),
			}),
		],
	});
	return { name: "email", title: "Email", about: "", safeTools: ["list_inbox"], chief: [extension], jobs: [extension] };
}

test("approvals: a consequential call is blocked until the user taps Approve, then goes through exactly once", async () => {
	const emails: string[] = [];
	const approvals = new Approvals(join(tmpdir(), `approvals-${process.pid}-1.json`), join(tmpdir(), `audit-${process.pid}-1.jsonl`));
	const asked: ApprovalRequest[] = [];
	approvals.onRequest((request) => asked.push(request));
	const h = await setup(
		({ settings, models, safeTools }) => [approvalsExtension({ approvals, models, settings, safeTools }), emailEntry(emails)],
		(turn) => {
			if (turn.review) return say(JSON.stringify({ ask: turn.request.includes("send_email"), summary: "Email Bob the draft", rule: "Email people on the user's behalf" }));
			if (turn.text.includes("check my inbox")) return call("list_inbox", {});
			if (turn.text === "3 unread.") return say("Three unread.");
			if (turn.text.includes("email bob")) return call("send_email", { to: "bob", body: "Draft attached." });
			if (turn.text.startsWith("Error") || turn.text.includes("Needs the user's approval")) return say("I've asked you to approve it.");
			if (turn.text.includes("[Approval") && turn.text.includes("approved")) return call("send_email", { to: "bob", body: "Draft attached." });
			if (turn.text === "Email sent.") return say("Sent to Bob.");
			return say("ok");
		},
	);
	assert.deepEqual(await h.thread.ask("1", "[Mon 10:00] check my inbox", target(1), context), { text: "Three unread." });
	assert.ok(!h.turns.some((turn) => turn.review), "a safe tool is never reviewed");

	assert.deepEqual(await h.thread.ask("2", "[Mon 10:01] email bob the draft", target(2), context), { text: "I've asked you to approve it." });
	assert.equal(emails.length, 0, "nothing was sent before approval");
	assert.equal(asked.length, 1);
	assert.equal(asked[0]?.summary, "Email Bob the draft");

	const request = approvals.decide(asked[0]!.id, "approve")!;
	assert.deepEqual(await h.thread.ask(`approval:${request.id}`, `[Mon 10:02] ${decisionText(request, "approve")}`, target(3), context), { text: "Sent to Bob." });
	assert.deepEqual(emails, ["bob: Draft attached."]);
	const audit = (await readFile(join(tmpdir(), `audit-${process.pid}-1.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line).verdict);
	assert.deepEqual(audit, ["asked", "approve", "ran-approved"]);
	await h.done();
});

test("approvals: a job agent waiting on the user isn't reported as gone quiet, and the decision resumes it", async () => {
	const emails: string[] = [];
	const approvals = new Approvals(join(tmpdir(), `approvals-${process.pid}-2.json`), join(tmpdir(), `audit-${process.pid}-2.jsonl`));
	const asked: ApprovalRequest[] = [];
	approvals.onRequest((request) => asked.push(request));
	const h = await setup(
		({ settings, models, safeTools }) => [approvalsExtension({ approvals, models, settings, safeTools }), emailEntry(emails)],
		(turn) => {
			if (turn.review) return say(JSON.stringify({ ask: true, summary: "Email the venue", rule: "Email venues" }));
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
		{ team: true, approvals },
	);
	await h.thread.ask("1", "[Mon 10:00] book the venue", target(1), context);
	await h.until(() => asked.length === 1, "the approval request");
	await h.until(() => h.turns.some((turn) => turn.job === "t1" && turn.text.includes("Needs the user's approval")), "the job to see the block");
	await sleep(200);
	const early = h.turns.filter((turn) => turn.job === undefined && turn.text.startsWith("[Report from job")).map((turn) => turn.text);
	assert.deepEqual(early, [], "no automatic report while it waits on the user");

	const request = approvals.decide(asked[0]!.id, "approve")!;
	assert.ok(await h.team.resume(h.thread.root, request.conversationId, decisionText(request, "approve"), context));
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
	const h = await setup(
		({ settings, secrets }) => [webExtension({ settings, secrets, fetch: fakeFetch })],
		(turn) => {
			if (turn.text.includes("look it up")) return call("web_search", { objective: "Find alpha", queries: ["alpha", "alpha fact"] });
			if (turn.text.includes("No Parallel API key")) return say("No key.");
			if (turn.text.includes("Alpha fact.")) return call("web_fetch", { urls: ["https://b.example"] });
			if (turn.text.includes("Whole page.")) return say("Found it.");
			return say("?");
		},
	);
	assert.deepEqual(await h.thread.ask("1", "[Mon 10:00] look it up", target(1), context), { text: "No key." });
	h.secrets.set("web.apiKey", "pk-test");
	assert.deepEqual(await h.thread.ask("2", "[Mon 10:01] look it up again", target(2), context), { text: "Found it." });
	assert.deepEqual(requests[0], { url: "https://api.parallel.ai/v1/search", body: { objective: "Find alpha", search_queries: ["alpha", "alpha fact"], mode: "fast", max_results: 8 }, key: "pk-test" });
	assert.deepEqual(requests[1]?.body, { urls: ["https://b.example"], advanced_settings: { full_content: true } });
	await h.done();
});

test("coding agents: Claude Code and Codex run on the workbench with the key passed to that run only, and sessions continue", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "jarvis-machine-"));
	const machine = new LocalBackend(join(dataDir, "machine"));
	const bin = join(machine.home, ".local/bin");
	await mkdir(bin, { recursive: true });
	// Fakes that echo what they were given, in each tool's real output format.
	await writeFile(join(bin, "claude"), `#!/bin/bash\nprintf '{"type":"result","subtype":"success","is_error":false,"result":"did: %s in %s token=%s args=%s","session_id":"s-123"}\\n' "$2" "$(basename "$PWD")" "$CLAUDE_CODE_OAUTH_TOKEN" "$*"\n`);
	await writeFile(join(bin, "codex"), `#!/bin/bash\necho '{"type":"thread.started","thread_id":"th-9"}'\necho '{"type":"item.completed","item":{"type":"error","message":"config warning"}}'\necho "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"codex key=$CODEX_API_KEY resume=$3\\"}}"\n`);
	await chmod(join(bin, "claude"), 0o755);
	await chmod(join(bin, "codex"), 0o755);
	const h = await setup(
		({ settings, secrets }) => [codingAgentExtension(CLAUDE_CODE, { workbench: machine, settings, secrets }), codingAgentExtension(CODEX, { workbench: machine, settings, secrets })],
		(turn) => {
			if (turn.text.includes("fix the bug")) return call("claude_code", { task: "Fix the bug", dir: "repo" });
			if (turn.text.startsWith("did: Fix the bug")) return call("claude_code", { task: "Add a test", dir: "repo", session: "s-123" });
			if (turn.text.startsWith("did: Add a test")) return call("codex", { task: "Review it", session: "th-9" });
			if (turn.text.startsWith("codex")) return say("All done.");
			return say("?");
		},
	);
	h.secrets.set("claude-code.oauthToken", "tok-abc");
	h.secrets.set("codex.apiKey", "sk-codex");
	// Coding agents are for job agents; for this test the chief of staff gets them too.
	for (const entry of h.extensions.entries) (entry as { chief?: unknown }).chief = entry.jobs;
	await h.thread.applySettings(h.settings.get(), context);
	assert.deepEqual(await h.thread.ask("1", "[Mon 10:00] fix the bug", target(1), context), { text: "All done." });
	const results = h.turns.map((turn) => turn.text);
	assert.match(results[1]!, /^did: Fix the bug in repo token=tok-abc args=.*--dangerously-skip-permissions\n\n\(session s-123\)$/);
	assert.match(results[2]!, /--resume s-123/);
	assert.equal(results[3], "codex key=sk-codex resume=th-9\n\n(session th-9)");
	await h.done();
	await rm(dataDir, { recursive: true, force: true });
});

test("settings: extensions turn on and off from the menu (and the chief of staff's tools follow), options and secrets are set by reply", async () => {
	const emails: string[] = [];
	const h = await setup(({ settings, secrets }) => [webExtension({ settings, secrets }), emailEntry(emails)], () => say("ok"));
	const menu = new SettingsMenu({ settings: h.settings, secrets: h.secrets, extensions: h.extensions, modelExists: (choice) => choice.provider === "faux" });
	const labels = (view: View) => view.buttons.flat().map((button) => button.text);
	const tools = async () => (await h.thread.root.agent(context)).tools.map((tool) => tool.name);

	assert.deepEqual(labels(menu.main()), ["General", "✅ Web (Parallel)", "⚙", "✅ Email"]);
	assert.ok((await tools()).includes("web_search"));
	menu.press("st:t:web");
	assert.deepEqual(labels(menu.main()).slice(1, 2), ["⬜ Web (Parallel)"]);
	await h.thread.applySettings(h.settings.get(), context);
	assert.ok(!(await tools()).includes("web_search"), "turned off: gone from the chief of staff's tools");
	assert.ok((await tools()).includes("send_email"));

	assert.deepEqual(labels(menu.page("web")), ["Search mode: fast ▸", "Results per search: 8", "Parallel API key: not set", "« Back"]);
	menu.press("st:f:web:0");
	assert.equal(h.settings.options("web", {}).mode, "turbo", "a choice cycles");
	const prompt = menu.press("st:f:web:2");
	assert.ok(!("buttons" in prompt) && prompt.secret);
	menu.answer(prompt, "pk-live");
	assert.equal(h.secrets.get("web.apiKey"), "pk-live");
	assert.ok(!JSON.stringify(h.settings.get()).includes("pk-live"), "secrets never land in settings.json");
	assert.deepEqual(menu.answer(menu.press("st:f:web:1") as never, "many"), { error: "That's not a number." });

	const model = menu.press("st:f:general:0");
	assert.deepEqual(menu.answer(model as never, "nope/x"), { error: 'Unknown model "nope/x". Write it as provider/modelId, e.g. anthropic/claude-sonnet-5-5.' });
	menu.answer(model as never, "faux/faux-fast");
	assert.deepEqual(h.settings.get().model, { provider: "faux", modelId: "faux-fast" });
	await h.done();
});
