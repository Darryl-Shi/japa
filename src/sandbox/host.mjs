// The sandbox side of an extension installed from chat. It runs on the extension's own machine (never in the
// harness): it loads the extension with a Host whose every service is a request to the runtime, and answers the
// runtime's calls (a tool, a prompt section, a hook, the channel). Plain JavaScript on Node 24 (which runs the
// extension's TypeScript directly), and only node:* imports, so it needs nothing but itself to start.
//
// The runtime reaches it with nothing but commands on the machine (the Backend's exec):
//   node host.mjs serve <dir> [<base64 view>]    the extension's process (started detached), on <dir>/sock
//   node host.mjs call <dir> <base64 json>       one call; prints the JSON answer (@<file>: the call is in that file)
//   node host.mjs events <dir> <after> <wait> <base64 view>
//                                                what the extension wants from the runtime since <after>, as JSON lines
//
// Keys never come here. host.secrets.get gives a placeholder ("japa-secret:<name>"); a fetch that carries one goes
// out through the runtime, which puts the real value in.
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [mode, dirArg, ...rest] = process.argv.slice(2);
const dir = resolve(dirArg ?? ".");
const socket = join(dir, "sock");

/** One request over the socket: write a line, read the answer line. */
function ask(request, timeoutMs) {
	return new Promise((done, fail) => {
		const connection = createConnection(socket);
		let buffered = "";
		const timer = setTimeout(() => (connection.destroy(), fail(new Error("timed out"))), timeoutMs);
		connection.on("connect", () => connection.write(`${JSON.stringify(request)}\n`));
		connection.on("data", (chunk) => (buffered += chunk.toString("utf8")));
		connection.on("end", () => {
			clearTimeout(timer);
			try {
				done(JSON.parse(buffered));
			} catch (error) {
				fail(error);
			}
		});
		connection.on("error", (error) => (clearTimeout(timer), fail(error)));
	});
}

if (mode === "call") {
	const arg = rest[0] ?? "";
	const encoded = arg.startsWith("@") ? readFileSync(join(dir, arg.slice(1)), "utf8") : arg;
	if (arg.startsWith("@")) rmSync(join(dir, arg.slice(1)), { force: true });
	const body = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	ask({ kind: "call", body }, 15 * 60_000).then(
		(answer) => process.stdout.write(`${JSON.stringify(answer)}\n`),
		(error) => (process.stdout.write(`${JSON.stringify({ ok: false, error: `no extension process: ${error.message}`, down: true })}\n`), process.exit(3)),
	);
} else if (mode === "events") {
	const wait = Number(rest[1] ?? 25);
	const view = rest[2] === undefined ? undefined : JSON.parse(Buffer.from(rest[2], "base64").toString("utf8"));
	ask({ kind: "events", after: Number(rest[0] ?? 0), wait, view }, (wait + 10) * 1000).then(
		(messages) => {
			for (const message of messages) process.stdout.write(`${JSON.stringify(message)}\n`);
		},
		(error) => (process.stderr.write(`no extension process: ${error.message}\n`), process.exit(3)),
	);
} else if (mode === "serve") {
	serve().catch((error) => (process.stderr.write(`${error?.stack ?? error}\n`), process.exit(1)));
} else {
	process.stderr.write("usage: host.mjs serve|call|events <dir> ...\n");
	process.exit(2);
}

async function serve() {
	const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
	/** What the runtime last told it: its own options, settings it may read, its platform's allowlist, its secrets' names. */
	let view = { options: {}, settings: {}, allowlist: [], secrets: [], chiefId: "", safeTools: [], commands: [] };
	if (rest[0] !== undefined) view = JSON.parse(Buffer.from(rest[0], "base64").toString("utf8"));

	// What the extension wants from the runtime, in order; dropped once the runtime has read past them.
	const outbox = [];
	let seq = 0;
	let wake = () => {};
	const send = (message) => {
		outbox.push({ seq: ++seq, ...message });
		wake();
	};
	const waiting = new Map();
	let requests = 0;
	/** A request to the runtime; resolves with its answer. */
	const request = (op, args) =>
		new Promise((done, fail) => {
			const id = ++requests;
			waiting.set(id, { done, fail });
			send({ id, op, args });
		});
	// To the runtime's log, and to this process's own (what the runtime shows when the process dies).
	const log = (line) => (process.stderr.write(`${line}\n`), send({ op: "log", line: String(line) }));
	process.on("uncaughtException", (error) => log(`uncaught: ${error?.stack ?? error}`));
	process.on("unhandledRejection", (error) => log(`unhandled: ${error?.stack ?? error}`));

	// Requests carrying a placeholder go out through the runtime, which knows the real values; the rest go direct.
	const direct = globalThis.fetch;
	globalThis.fetch = async (input, init = {}) => {
		const request0 = input instanceof Request ? input : new Request(input, init);
		const headers = Object.fromEntries(request0.headers.entries());
		const body = request0.body === null ? undefined : Buffer.from(await request0.arrayBuffer());
		const carries = (text) => typeof text === "string" && text.includes("japa-secret:");
		if (!carries(request0.url) && !Object.values(headers).some(carries) && !(body !== undefined && carries(body.toString("utf8")))) {
			return direct(request0.url, { method: request0.method, headers, ...(body === undefined ? {} : { body }), signal: init.signal });
		}
		const answer = await request("fetch", { url: request0.url, method: request0.method, headers, ...(body === undefined ? {} : { body: body.toString("base64") }) });
		return new Response(answer.body === undefined ? null : Buffer.from(answer.body, "base64"), { status: answer.status, statusText: answer.statusText, headers: answer.headers });
	};

	const handlers = new Map();
	const commands = new Map();
	const encode = (message) => ({
		...message,
		...(message.attachments === undefined ? {} : { attachments: message.attachments.map((file) => ({ ...file, data: Buffer.from(file.data).toString("base64") })) }),
	});
	const ui = {
		show: (card, replace) => request("ui.show", { card, replace }),
		handle: (owner, handler) => {
			handlers.set(owner, handler);
			send({ op: "ui.handle", args: { owner } });
		},
		command: (name, description, run) => {
			commands.set(name, run);
			send({ op: "ui.command", args: { name, description } });
		},
		commands: () => view.commands,
		onCommands: () => () => {},
		press: (data, ref) => request("ui.press", { data, ref }),
		reply: (data, text, ref) => request("ui.reply", { data, text, ref }),
		run: (name, at) => request("ui.run", { name, at }),
		attach: () => {},
		detach: () => {},
	};
	const unavailable = (what) => () => {
		throw new Error(`${what} isn't available to an extension installed from chat (it runs on its own machine)`);
	};
	const host = {
		settings: {
			path: "(japa's settings)",
			get: () => view.settings,
			options: (name, defaults = {}) => (name === config.name ? { ...defaults, ...view.options } : { ...defaults }),
			setOption: (name, key, value) => {
				if (name === config.name) send({ op: "setOption", args: { key, value } });
			},
		},
		secrets: { get: (name) => (view.secrets.includes(name) ? `japa-secret:${name}` : undefined), set: unavailable("Setting secrets") },
		dataDir: resolve(dir, config.data ?? "data"),
		get models() {
			return unavailable("host.models")();
		},
		workbench: () => undefined,
		ui,
		wake: (conversationId, text, options = {}) => request("wake", { conversationId, text, options }),
		chiefId: () => view.chiefId,
		searchHistory: (query) => request("searchHistory", { query }),
		holds: { add: (id, reason) => send({ op: "holds.add", args: { id, reason } }), remove: (id, reason) => send({ op: "holds.remove", args: { id, reason } }), has: () => false },
		emit: (event, detail) => send({ op: "emit", args: { event, detail } }),
		safeTools: () => new Set(view.safeTools),
		log,
	};

	const module = await import(pathToFileURL(resolve(dir, "code", config.entry)).href);
	if (typeof module.default !== "function") throw new Error("its default export must be a function: (host) => extension");
	const entry = await module.default(host);
	if (typeof entry !== "object" || entry === null || typeof entry.name !== "string") throw new Error("the extension needs a name, title and about");

	// Pi extensions by name; one may be both the chief of staff's and job agents'.
	const pis = new Map();
	for (const pi of [...(entry.chief ?? []), ...(entry.jobs ?? [])]) pis.set(pi.name, pi);
	const toolOf = (ext, name) => pis.get(ext)?.tools?.find((tool) => tool.name === name);
	const providers = new Map((entry.providers ?? []).map((provider) => [provider.id, provider]));
	const aborts = new Map();
	/** What a hook or tool gets in place of the durable API, which stays in the runtime. */
	const api = (ids) => ({ ...ids, env: undefined, commit: unavailable("Durable state"), snapshot: unavailable("Durable state"), conversation: unavailable("Other conversations"), memo: unavailable("Memos"), createTask: unavailable("Tasks") });

	const manifest = () => {
		const unsupported = [];
		for (const pi of pis.values()) {
			if ((pi.tasks ?? []).length > 0) unsupported.push(`${pi.name}: durable tasks`);
			if ((pi.wraps ?? []).length > 0) unsupported.push(`${pi.name}: wraps`);
		}
		if (entry.backends !== undefined && Object.keys(entry.backends).length > 0) unsupported.push("machine providers");
		if (unsupported.length > 0) throw new Error(`not supported in an extension installed from chat: ${unsupported.join(", ")}`);
		return {
			name: entry.name,
			title: entry.title,
			about: entry.about,
			...(entry.enabledByDefault === undefined ? {} : { enabledByDefault: entry.enabledByDefault }),
			settings: entry.settings ?? [],
			defaults: entry.defaults ?? {},
			safeTools: entry.safeTools ?? [],
			triggers: entry.triggers ?? [],
			chief: (entry.chief ?? []).map((pi) => pi.name),
			jobs: (entry.jobs ?? []).map((pi) => pi.name),
			extensions: [...pis.values()].map((pi) => ({
				name: pi.name,
				tools: (pi.tools ?? []).map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: JSON.parse(JSON.stringify(tool.parameters)),
					...(tool.replay === undefined ? {} : { replay: tool.replay }),
					...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
				})),
				sections: (pi.sections ?? []).map((section) => ({ key: section.key, ...(section.tag === undefined ? {} : { tag: section.tag }) })),
				hooks: (pi.hooks ?? []).map((registration) => ({ task: registration.task, names: Object.keys(registration.handlers).filter((key) => typeof registration.handlers[key] === "function") })),
			})),
			providers: [...providers.values()].map((provider) => ({
				id: provider.id,
				name: provider.name,
				...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
				...(provider.headers === undefined ? {} : { headers: provider.headers }),
				models: JSON.parse(JSON.stringify(provider.getAllModels?.() ?? provider.getModels())),
				dynamic: typeof provider.refreshModels === "function",
			})),
			...(entry.channel === undefined ? {} : { channel: { platform: entry.channel.platform } }),
			lifecycle: { start: typeof entry.start === "function", stop: typeof entry.stop === "function", sliceEnd: typeof entry.onSliceEnd === "function" },
		};
	};

	const inbox = () => ({
		platform: entry.channel.platform,
		allowed: () => view.allowlist,
		admits: (id) => id !== undefined && view.allowlist.includes(String(id)),
		owner: () => view.allowlist[0],
		ask: (from, requestId, message, reply, _context, arrival) => request("inbox.ask", { from, requestId, message: encode(typeof message === "string" ? { text: message } : message), reply, arrival }),
		answer: (requestId, content) => request("inbox.answer", { requestId, content }),
		pending: () => request("inbox.pending", {}),
		delivered: (requestId) => request("inbox.delivered", { requestId }),
	});

	/** The runtime's calls. */
	const call = async (body) => {
		if (body.view !== undefined) view = body.view;
		switch (body.op) {
			case "ping":
				return "pong";
			case "manifest":
				return manifest();
			case "reply": {
				const found = waiting.get(body.id);
				waiting.delete(body.id);
				if (found !== undefined) body.error === undefined ? found.done(body.result) : found.fail(new Error(body.error));
				return null;
			}
			case "abort":
				aborts.get(body.callId)?.abort();
				return null;
			case "tool": {
				const tool = toolOf(body.ext, body.tool);
				if (tool === undefined) throw new Error(`no tool ${body.tool}`);
				const controller = new AbortController();
				aborts.set(body.callId, controller);
				// Running output, remarks and details, as the runtime's tool API keeps them.
				const output = [];
				const diagnostics = [];
				let details;
				const toolApi = { ...api(body.ids), output: (chunk) => output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")), diagnostic: (each) => diagnostics.push(each), details: async (value) => void (details = value) };
				try {
					const result = (await tool.execute(body.args, toolApi, { abortSignal: controller.signal })) ?? {};
					return {
						...result,
						...(result.content === undefined && output.length > 0 ? { content: [{ type: "text", text: output.join("") }] } : {}),
						...(result.details === undefined && details !== undefined ? { details } : {}),
						...(diagnostics.length > 0 ? { diagnostics: [...diagnostics, ...(result.diagnostics ?? [])] } : {}),
					};
				} finally {
					aborts.delete(body.callId);
				}
			}
			case "section": {
				const section = pis.get(body.ext)?.sections?.find((candidate) => candidate.key === body.key);
				return (await section?.render(body.input, {})) ?? null;
			}
			case "hook": {
				const registration = (pis.get(body.ext)?.hooks ?? []).find((candidate) => candidate.task === body.task && typeof candidate.handlers[body.name] === "function");
				if (registration === undefined) return null;
				return (await registration.handlers[body.name](...body.args, api(body.ids), {})) ?? null;
			}
			case "start":
				await entry.start?.();
				return null;
			case "stop":
				await entry.stop?.();
				return null;
			case "sliceEnd":
				await entry.onSliceEnd?.(body.slice);
				return null;
			case "channel.open":
				await entry.channel.open({ inbox: inbox(), ui });
				return null;
			case "channel.show":
				return await entry.channel.show(body.card, body.replace);
			case "channel.close":
				await entry.channel.close();
				return null;
			case "press":
				await handlers.get(body.owner)?.press?.(body.payload, body.ref);
				return null;
			case "cardReply":
				await handlers.get(body.owner)?.reply?.(body.payload, body.text, body.ref);
				return null;
			case "command":
				await commands.get(body.name)?.(body.at);
				return null;
			case "models": {
				const provider = providers.get(body.provider);
				if (provider === undefined) return [];
				await provider.refreshModels?.({
					credential: { type: "api_key", key: `japa-secret:auth:${body.provider}` },
					allowNetwork: true,
					force: true,
					signal: new AbortController().signal,
					publish: async (publication) => (publication.update?.(), true),
				});
				return JSON.parse(JSON.stringify(provider.getAllModels?.() ?? provider.getModels()));
			}
			case "shutdown":
				setTimeout(() => process.exit(0), 50);
				return null;
			default:
				throw new Error(`unknown call ${body.op}`);
		}
	};

	if (existsSync(socket)) unlinkSync(socket);
	createServer((connection) => {
		let buffered = "";
		connection.on("data", async (chunk) => {
			buffered += chunk.toString("utf8");
			const newline = buffered.indexOf("\n");
			if (newline === -1) return;
			const line = buffered.slice(0, newline);
			buffered = "";
			const message = JSON.parse(line);
			if (message.kind === "events") {
				if (message.view !== undefined) view = message.view;
				while (outbox.length > 0 && outbox[0].seq <= message.after) outbox.shift();
				if (outbox.length === 0) await new Promise((done) => ((wake = done), setTimeout(done, message.wait * 1000)));
				wake = () => {};
				return connection.end(`${JSON.stringify(outbox.filter((each) => each.seq > message.after))}\n`);
			}
			try {
				connection.end(`${JSON.stringify({ ok: true, result: (await call(message.body)) ?? null })}\n`);
			} catch (error) {
				connection.end(`${JSON.stringify({ ok: false, error: error?.message ?? String(error) })}\n`);
			}
		});
	}).listen(socket);
	writeFileSync(join(dir, "pid"), String(process.pid));
	log("ready");
}
