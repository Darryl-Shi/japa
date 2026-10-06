// The kinds japa adds to pi's API, each through its owner in the core: accounts, environments (the agent's computer),
// schedules and MCP servers; and saved state from before the rename.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { envApiKeyAuth } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ExtensionAPI } from "../src/pi/extension.ts";
import { agent, call, context, say, sleep } from "./helpers.ts";

const at = { channel: "test", chatId: "7", messageId: "1" };

/** Press the button labelled so on the latest card that has it. */
function pressOn(h: Awaited<ReturnType<typeof agent>>, label: string): Promise<void> {
	const shown = [...h.cards].reverse().find((each) => each.card.buttons?.flat().some((button) => button.text === label) === true);
	assert.ok(shown !== undefined, `no button "${label}"`);
	return h.runtime.ui.press(shown.card.buttons!.flat().find((button) => button.text === label)!.data, shown.ref);
}

test("accounts: a channel whose account isn't logged in doesn't open, and the user is asked; logged in through /login, it opens", async () => {
	const opened: string[] = [];
	const h = await agent({
		extensions: {
			bot: (pi) => {
				pi.registerAccount({ id: "bot", name: "Bot", auth: { apiKey: envApiKeyAuth("Bot token", ["JAPA_TEST_NO_SUCH_VARIABLE"]) } });
				pi.registerChannel({
					platform: "botchat",
					open: async () => void opened.push(String((await pi.accounts.get("bot")).auth.apiKey)),
					show: async () => ({ channel: "botchat", chatId: "1", messageId: "1" }),
					close: () => {},
				});
			},
		},
		script: (turn) => say(turn.text.startsWith("[Problem with") ? turn.text : "ok"),
	});
	await h.until(() => h.cards.some((shown) => shown.card.text.startsWith("[Problem with extension bot]")), "the chief of staff hearing it");
	assert.match(h.cards.find((shown) => shown.card.text.startsWith("[Problem with extension bot]"))!.card.text, /its channel botchat didn't start: Not logged in to Bot/);
	assert.deepEqual(opened, []);

	const logging = pressOn(h, "Log in to Bot");
	await h.until(() => h.cards.at(-1)!.card.ask !== undefined, "the question for its token");
	const prompt = h.cards.at(-1)!;
	assert.equal(prompt.card.text, "Enter Bot token");
	await h.runtime.ui.reply(prompt.card.ask!.data, "tok-1", { ...at, messageId: "50" }, prompt.ref);
	await logging;
	await h.until(() => opened.length > 0, "the channel opening");
	assert.deepEqual(opened, ["tok-1"], "with the token it logged in with");
	assert.equal(h.japa.extensions.failure("bot"), undefined, "and it's working now");
	assert.deepEqual(await h.credentials.read("bot"), { type: "api_key", key: "tok-1" }, "kept in auth.json, as pi keeps a model provider's");
	await h.done();
});

test("computer: the environment turned on last is the agent's computer; commands there start without japa's keys, which japa still uses", async () => {
	process.env.JAPA_TEST_SECRET = "s3cret";
	process.env.JAPA_TEST_STORED = "env-copy";
	const elsewhere = await mkdtemp(join(tmpdir(), "elsewhere-"));
	const dataDir = await mkdtemp(join(tmpdir(), "japa-"));
	const home = join(dataDir, "machine");
	await mkdir(home, { recursive: true });
	// Logged in already, and in the environment too: the stored one is used, and the variable is still a key.
	await writeFile(join(dataDir, "auth.json"), JSON.stringify({ stored: { type: "api_key", key: "from-auth" } }));
	let api: ExtensionAPI | undefined;
	const h = await agent({
		home,
		dataDir,
		extensions: {
			stored: (pi) => pi.registerAccount({ id: "stored", name: "Stored", auth: { apiKey: envApiKeyAuth("Stored key", ["JAPA_TEST_STORED"]) } }),
			svc: (pi) => {
				api = pi;
				pi.registerAccount({ id: "svc", name: "Service", auth: { apiKey: envApiKeyAuth("Service key", ["JAPA_TEST_SECRET"]) } });
			},
			elsewhere: (pi) => pi.registerEnvironment(new NodeExecutionEnv({ cwd: elsewhere })),
		},
		settings: { extensions: { elsewhere: { enabled: false } } },
		script: (turn) => {
			if (turn.text.includes("run it")) return call("bash", { command: "echo ${JAPA_TEST_SECRET:-none}; pwd" });
			if (turn.text.includes("none")) return say(turn.text.trim());
			return say("ok");
		},
	});
	try {
		assert.equal((await api!.exec("pwd", [])).stdout.trim(), h.home, "from its home on this machine");
		assert.deepEqual(await api!.exec("sh", ["-c", "echo out; echo err >&2; exit 3"]), { stdout: "out\n", stderr: "err\n", code: 3, killed: false });
		assert.equal((await api!.exec("sh", ["-c", "echo ${JAPA_TEST_SECRET:-none}"])).stdout.trim(), "none", "a key a login reads isn't in a command's environment");
		assert.equal((await api!.accounts.get("svc")).auth.apiKey, "s3cret", "japa still has it");
		assert.equal((await api!.accounts.get("stored")).auth.apiKey, "from-auth");
		assert.equal((await api!.exec("sh", ["-c", "echo ${JAPA_TEST_STORED:-none}"])).stdout.trim(), "none", "nor one a login would read, though a stored credential is used instead");
		const local = h.japa.extensions.get("local")!;
		assert.match(h.japa.extensions.cannotTurnOff(local) ?? "", /only computer/);

		h.settings.update({ extensions: { elsewhere: { enabled: true } } });
		await h.japa.apply(context);
		assert.equal((await api!.exec("pwd", [])).stdout.trim(), elsewhere, "the one turned on last");
		assert.equal(h.japa.extensions.cannotTurnOff(local), undefined, "with another, the first can go");
		const answer = await h.ask("1", "[Mon 10:00] run it");
		assert.ok("text" in answer && answer.text.startsWith(`none\n${elsewhere}`), "the agent's own tools run there too, without the key");

		h.settings.update({ extensions: { elsewhere: { enabled: false } } });
		await h.japa.apply(context);
		assert.equal((await api!.exec("pwd", [])).stdout.trim(), h.home, "off: back to the one before");
	} finally {
		delete process.env.JAPA_TEST_SECRET;
		delete process.env.JAPA_TEST_STORED;
		await h.done();
	}
});

test("schedules: an extension's comes to the chief of staff at its time; the chief of staff's own survives a restart, and a time missed while down runs once", async () => {
	const soon = (ms: number) => new Date(Date.now() + ms).toISOString();
	const dataDir = await mkdtemp(join(tmpdir(), "japa-"));
	const home = join(dataDir, "machine");
	await mkdir(home, { recursive: true });
	const script = (turn: { text: string }) => {
		if (turn.text.includes("remind me")) return call("schedule", { name: "call-mum", when: soon(2500), message: "Call mum." });
		if (turn.text.startsWith("Scheduled call-mum")) return say("I'll remind you.");
		if (turn.text.includes("[Schedule ")) return say(`Reminder: ${turn.text}`);
		return say("ok");
	};
	const h = await agent({ home, dataDir, extensions: { oven: (pi) => pi.registerSchedule("timer", { when: soon(2000), message: "Check the oven." }) }, script });
	await h.until(() => h.turns.some((turn) => turn.text.includes("[Schedule oven/timer] Check the oven.")), "the extension's schedule");
	await h.until(() => h.cards.some((shown) => shown.card.text.startsWith("Reminder: ") && shown.card.text.includes("Check the oven.")), "its answer reaching the user");

	assert.deepEqual(await h.ask("1", "[Mon 10:00] remind me to call mum"), { text: "I'll remind you." });
	assert.match(h.turns.at(-1)!.request, /Scheduled \(each comes to you at its time[^)]*\):\\n- call-mum \(/, "it knows what's scheduled");
	await h.japa.close(context);
	await sleep(3500);
	const again = await agent({ home, dataDir, extensions: {}, script });
	await again.until(() => again.turns.some((turn) => turn.text.includes("[Schedule call-mum] Call mum.")), "the missed one, once back");
	await sleep(300);
	assert.equal(again.turns.filter((turn) => turn.text.includes("[Schedule call-mum]")).length, 1, "once");
	assert.deepEqual(JSON.parse(await readFile(join(dataDir, "schedules.json"), "utf8")).own, {}, "done, so it's gone");
	await again.done();
});

test("MCP: a server an extension registers is connected while it's on, its tools the extension's (pi's names), started without japa's keys; off, they're gone", async () => {
	process.env.JAPA_TEST_SECRET = "s3cret";
	let api: ExtensionAPI | undefined;
	const h = await agent({
		extensions: {
			svc: (pi) => pi.registerAccount({ id: "svc", name: "Service", auth: { apiKey: envApiKeyAuth("Service key", ["JAPA_TEST_SECRET"]) } }),
			tools: (pi) => {
				api = pi;
				pi.registerMcpServer("echo-server", { command: process.execPath, args: [join(import.meta.dirname, "fixtures", "echo-mcp.ts")] });
			},
		},
		script: (turn) => {
			if (turn.text.includes("echo it")) return call("mcp__echo_server__echo", { text: "hi" });
			if (turn.text.startsWith("echo: ")) return say(turn.text);
			return say("ok");
		},
	});
	try {
		const tools = async () => (await h.thread.root.agent(context)).tools.map((tool) => tool.name);
		for (let i = 0; i < 300 && !(await tools()).includes("mcp__echo_server__echo"); i++) await sleep(20);
		assert.ok((await tools()).includes("mcp__echo_server__echo"), "its tool, named as pi names it");
		assert.deepEqual(Object.keys(api!.getMcpServers()), ["echo-server"]);
		assert.deepEqual(api!.getAllTools().find((tool) => tool.name === "mcp__echo_server__echo")?.annotations, { readOnlyHint: true, openWorldHint: false }, "with the server's annotations");
		assert.deepEqual(await h.ask("1", "[Mon 10:00] echo it"), { text: "echo: hi (secret: none)" });

		h.settings.update({ extensions: { tools: { enabled: false } } });
		await h.japa.apply(context);
		assert.ok(!(await tools()).includes("mcp__echo_server__echo"), "off: gone");
		assert.deepEqual(api!.getMcpServers(), {});
	} finally {
		delete process.env.JAPA_TEST_SECRET;
		await h.done();
	}
});

test("saved state from before the rename (jarvis.*) is japa's after a restart: a job still listed", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "japa-"));
	const home = join(dataDir, "machine");
	await mkdir(home, { recursive: true });
	const script = (turn: { text: string; job?: string }) => {
		if (turn.job === undefined && turn.text.includes("start it")) return call("delegate", { title: "Dig", brief: "Dig in." });
		return say("ok");
	};
	const h = await agent({ home, dataDir, script });
	await h.ask("1", "[Mon 10:00] start it");
	await h.until(() => h.turns.some((turn) => turn.job !== undefined), "the job's turn");
	await h.thread.settled();
	const jobs = async (on: typeof h) => {
		await on.runtime.ui.run("jobs", at);
		await pressOn(on, "Finished (1)");
		return on.cards.at(-1)!.card.text;
	};
	const before = await jobs(h);
	assert.match(before, /Dig \(t1\)/);
	await h.japa.close(context);

	// As an older version saved it.
	const db = new DatabaseSync(join(dataDir, "session.sqlite"));
	const old = "'jarvis.' || substr(json_extract(record, '$.kind'), 6)";
	for (const table of ["tasks", "documents"]) db.exec(`UPDATE ${table} SET kind = json_quote(${old}), record = json_set(record, '$.kind', ${old}) WHERE json_extract(record, '$.kind') LIKE 'japa.%'`);
	const count = (pattern: string) => ["tasks", "documents"].reduce((sum, table) => sum + Number((db.prepare(`SELECT count(*) AS n FROM ${table} WHERE json_extract(record, '$.kind') LIKE ?`).get(pattern) as { n: number }).n), 0);
	assert.ok(count("jarvis.%") > 0);
	db.close();

	const again = await agent({ home, dataDir, script });
	assert.equal(await jobs(again), before, "its job, still there");
	const after = new DatabaseSync(join(dataDir, "session.sqlite"));
	assert.equal(Number((after.prepare("SELECT count(*) AS n FROM documents WHERE json_extract(record, '$.kind') LIKE 'jarvis.%'").get() as { n: number }).n), 0, "nothing left under the old name");
	after.close();
	await again.done();
});
