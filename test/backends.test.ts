import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { boatProvider } from "../src/backends/boat.ts";
import { LocalBackend } from "../src/backends/local.ts";
import { BackendExecutionEnv } from "../src/pi/backend-env.ts";
import { MainThread } from "../src/pi/harness.ts";
import { shellExtension } from "../src/pi/shell.ts";
import { DEFAULTS } from "../src/settings.ts";

const context = BACKGROUND_CONTEXT;

test("the agent's own bash/write/read act directly on the workbench backend", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "jarvis-"));
	const machine = new LocalBackend(join(dataDir, "machine"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "notes/plan.md", content: "step one\n" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("bash", { command: "echo 'step two' >> notes/plan.md && wc -l < notes/plan.md" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("read", { path: "notes/plan.md" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Two steps written."),
	]);
	const settings = () => ({ ...DEFAULTS, model: { provider: "faux", modelId: "faux-1" } });
	const thread = await MainThread.open({ dataDir, models, settings, installed: [shellExtension()], env: () => new BackendExecutionEnv(machine) }, context);
	assert.deepEqual(await thread.ask("1", "plan it", { chatId: 1, messageId: 1 }, context), { text: "Two steps written." });
	assert.equal(await readFile(join(machine.home, "notes/plan.md"), "utf8"), "step one\nstep two\n");
	const sent = JSON.stringify((await thread.root.context(context)).messages);
	assert.match(sent, /"text":"2\\n"/, "bash output came back as the tool result");
	assert.match(sent, /step one\\nstep two/, "read returned the file");
	await thread.close(context);
	await rm(dataDir, { recursive: true, force: true });
});

/** A fake of boat's documented API, running commands on a local machine. */
function fakeBoat(machine: LocalBackend) {
	let state = "archived";
	const calls: string[] = [];
	const bodies: Array<{ call: string; body: Record<string, unknown> }> = [];
	const processes = new Map<number, { running: boolean; exitCode: number | null; log: string }>();
	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
		const path = new URL(url).pathname.replace("/api/v1", "");
		const method = init?.method ?? "GET";
		const body = init?.body === undefined ? {} : JSON.parse(String(init.body));
		calls.push(`${method} ${path}`);
		bodies.push({ call: `${method} ${path}`, body });
		if (/^\/sandboxes\/(?!bx_aaaaaaaa)/.test(path)) return json({ ok: false, code: "not_found" }, 404);
		if (method === "PATCH" && path === "/sandboxes/bx_aaaaaaaa") return json({ ok: true, sandbox: { id: "bx_aaaaaaaa", state } });
		if (method === "POST" && path === "/sandboxes") return json({ ok: true, sandbox: { id: "bx_aaaaaaaa", state: "provisioning" } }, 202);
		if (method === "GET" && path === "/sandboxes/bx_aaaaaaaa") {
			if (state === "provisioning" || state === "resuming") state = "idle";
			return json({ ok: true, sandbox: { id: "bx_aaaaaaaa", state } });
		}
		if (method === "POST" && path.endsWith("/resume")) {
			state = "resuming";
			return json({ ok: true }, 202);
		}
		if (method === "POST" && path.endsWith("/stop")) {
			state = "archived";
			return json({ ok: true });
		}
		if (method === "POST" && path.endsWith("/commands")) {
			if (state !== "idle") return json({ ok: false, code: "sandbox_not_ready", retryable: false, message: "stopped" }, 409);
			if (body.detached === true) {
				const id = processes.size + 1;
				const entry = { running: true, exitCode: null as number | null, log: "" };
				processes.set(id, entry);
				void machine.exec(body.command, { onOutput: (text) => (entry.log += text) }).then((result) => Object.assign(entry, { running: false, exitCode: result.exitCode }));
				return json({ ok: true, processId: id, pid: 999_999, logPath: `/tmp/proc-${id}.log` });
			}
			const frames: string[] = [JSON.stringify({ type: "started" })];
			const result = await machine.exec(body.command, { timeoutMs: body.timeoutSeconds * 1000, onOutput: (data) => frames.push(JSON.stringify({ type: "stdout", data })) });
			frames.push(JSON.stringify({ type: "exit", exitCode: result.exitCode, timedOut: result.timedOut === true }));
			return new Response(`${frames.join("\n")}\n`, { headers: { "Content-Type": "application/x-ndjson" } });
		}
		const status = /\/commands\/(\d+)$/.exec(path);
		if (method === "GET" && status !== null) {
			const entry = processes.get(Number(status[1]));
			if (entry !== undefined && !entry.running) await machine.exec(`printf %s ${Buffer.from(entry.log).toString("base64")} | base64 -d > /tmp/proc-${status[1]}.log`);
			return json({ ok: true, running: entry?.running ?? false, exitCode: entry?.exitCode ?? null, logPath: `/tmp/proc-${status[1]}.log` });
		}
		if (method === "POST" && path.endsWith("/desktop")) return json({ ok: true, desktopUrl: "https://desktop.example/vnc.html?_token=x" });
		return json({ ok: false, code: "not_found" }, 404);
	}) as typeof fetch;
	return { fetchImpl, calls, bodies, setState: (next: string) => (state = next) };
}

test("boat provider: creates a no-env machine once, streams commands, resumes a stopped machine, runs long commands detached", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "jarvis-"));
	const machine = new LocalBackend(join(dataDir, "machine"));
	const boat = fakeBoat(machine);
	const provider = boatProvider({ apiKey: "test", stateFile: join(dataDir, "boat.json"), fetch: boat.fetchImpl });
	const backend = await provider.open("workbench", { provider: "boat" });
	assert.equal(backend.id, "boat:workbench");
	assert.equal(boat.calls.length, 0, "opening starts nothing");

	// The first command creates the machine, waits for it, and runs.
	const env = new BackendExecutionEnv(backend, machine.home);
	let output = "";
	const run = await env.exec("echo hello; exit 4", { onOutput: (text) => (output += text) }, context);
	assert.ok(run.ok && run.value.exitCode === 4);
	assert.equal(output, "hello\n");
	assert.deepEqual(JSON.parse(await readFile(join(dataDir, "boat.json"), "utf8")), { workbench: "bx_aaaaaaaa" });

	// Stopped between uses: the next command resumes it and runs, invisibly to the agent.
	await backend.suspend?.();
	assert.ok((await env.writeFile("kept.txt", "still here", context)).ok);
	assert.deepEqual(await env.readTextFile("kept.txt", context), { ok: true, value: "still here" });
	assert.ok(boat.calls.includes("POST /sandboxes/bx_aaaaaaaa/resume"));

	// Past boat's 600s synchronous limit: detached and polled.
	let long = "";
	const detached = await env.exec("echo long-running", { timeout: 3600, onOutput: (text) => (long += text) }, context);
	assert.ok(detached.ok && detached.value.exitCode === 0);
	assert.equal(long, "long-running\n");

	// Opening the same role again reuses the machine instead of creating another.
	await (await provider.open("workbench", { provider: "boat" })).exec("true");
	assert.equal(boat.calls.filter((call) => call === "POST /sandboxes").length, 1);
	assert.equal(await backend.viewUrl?.(), "https://desktop.example/vnc.html?_token=x");
	await rm(dataDir, { recursive: true, force: true });
});

test("boat provider: with idleSeconds the machine sleeps only after that long unused (each use pushes the deadline back)", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "jarvis-"));
	const boat = fakeBoat(new LocalBackend(join(dataDir, "machine")));
	const backend = await boatProvider({ apiKey: "test", stateFile: join(dataDir, "boat.json"), fetch: boat.fetchImpl, touchEveryMs: 300 }).open("workbench", { provider: "boat", idleSeconds: 7200 });
	const touches = () => boat.bodies.filter((request) => request.call === "PATCH /sandboxes/bx_aaaaaaaa").map((request) => request.body);
	await backend.exec("true");
	assert.deepEqual(boat.bodies.find((request) => request.call === "POST /sandboxes")?.body, { type: "small", ttlSeconds: 7200, noEnv: true });
	assert.deepEqual(touches(), [], "just woken: the deadline is already fresh");
	await new Promise((resolve) => setTimeout(resolve, 350));
	await backend.exec("true");
	await backend.exec("true");
	assert.deepEqual(touches(), [{ ttlSeconds: 7200 }], "pushed back on use, at most once per interval");
	await backend.exec("sleep 1.5", { cwd: "/tmp" });
	assert.ok(touches().length >= 3, `and while a long command runs (${touches().length})`);
	await backend.suspend?.();
	await backend.exec("true");
	assert.deepEqual(boat.bodies.find((request) => request.call.endsWith("/resume"))?.body, { ttlSeconds: 7200 }, "a resumed machine keeps sleeping when idle");
	await rm(dataDir, { recursive: true, force: true });
});

test("boat provider: a remembered machine that's gone is replaced on the next command", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "jarvis-"));
	const boat = fakeBoat(new LocalBackend(join(dataDir, "machine")));
	await writeFile(join(dataDir, "boat.json"), JSON.stringify({ workbench: "bx_gone" }));
	const backend = await boatProvider({ apiKey: "test", stateFile: join(dataDir, "boat.json"), fetch: boat.fetchImpl }).open("workbench", { provider: "boat" });
	let output = "";
	const result = await backend.exec("echo hi", { cwd: "/tmp", onOutput: (text) => (output += text) });
	assert.equal(result.exitCode, 0);
	assert.equal(output, "hi\n");
	assert.deepEqual(JSON.parse(await readFile(join(dataDir, "boat.json"), "utf8")), { workbench: "bx_aaaaaaaa" });
	await rm(dataDir, { recursive: true, force: true });
});
