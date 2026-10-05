// Extensions installed from chat run sandboxed: on their own machine (machines.extensions, else the workbench's
// provider under the role "extensions"), never inside the harness. That looks like a paradox, since what an
// extension extends (the agent loop, durable state, the keys, the user's consent) must stay here. It's resolved by
// splitting each one in two:
//
//   there: its code, loaded by a small host process (src/sandbox/host.mjs) with a Host whose every service is a
//          request back to the runtime; keys are placeholders;
//   here:  a stand-in JapaExtension made from what the code declared (its manifest, cached so japa starts without the
//          machine), every part of which forwards there: tools, prompt sections, hooks, the channel, the lifecycle.
//
// The two talk over nothing but the machine's exec (the Backend contract): a short command per call, and a long poll
// for what the extension wants (a card shown, a message let in, a request to the web). Keys are put into such a
// request here, and only the extension's own. Hooks may rewrite only its own tools' calls; for any other tool they
// may only block. A model provider becomes a provider here, on pi-ai's built-in API for each model, with its key from
// /login. Durable tasks and machine providers stay with built-in extensions.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { createProvider, envApiKeyAuth, type Models, type AnyModel, type Provider, type ProviderStreams, type TSchema } from "@earendil-works/pi-ai";
import { lazyApi } from "@earendil-works/pi-ai/api/lazy";
import { CompactionTask, defineExtension, type Extension, GenerationTask, hook, type HookRegistration, section, type ToolExecutionResult, type ToolRegistration, ToolTask } from "@earendil-works/pi-durable";
import type { Inbox } from "../channels/inbox.ts";
import { type Backend, shellQuote as q } from "../core/backend.ts";
import type { Card } from "../core/ui.ts";
import type { Field, Host, JapaExtension, Trigger } from "./extension.ts";

const HOST = resolve(import.meta.dirname, "../sandbox/host.mjs");
const CODE_DIR = resolve(import.meta.dirname, "../..");
/** Under the machine's home: the Node it runs on, and each extension's versions and data. */
const ROOT = ".japa";
/** Base64 per command, to keep each command a modest size. */
const CHUNK = 512 * 1024;
const POLL_S = 25;
/** Tries for one that won't start, before waiting for a change. */
const RETRIES = 3;

export type ToolSpec = { name: string; description: string; parameters: unknown; replay?: "safe" | "unsafe"; executionMode?: "parallel" | "sequential" };
export type PiSpec = { name: string; tools: ToolSpec[]; sections: Array<{ key: string; tag?: boolean }>; hooks: Array<{ task: string; names: string[] }> };
export type ProviderSpec = { id: string; name: string; baseUrl?: string; headers?: Record<string, string>; models: AnyModel[]; dynamic: boolean };

/** What an extension's code declared, as its host process reported it. */
export type Manifest = {
	name: string;
	title: string;
	about: string;
	enabledByDefault?: boolean;
	settings: Field[];
	defaults: Record<string, unknown>;
	safeTools: string[];
	triggers: Trigger[];
	chief: string[];
	jobs: string[];
	extensions: PiSpec[];
	providers: ProviderSpec[];
	channel?: { platform: string };
	lifecycle: { start: boolean; stop: boolean; sliceEnd: boolean };
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// --- The extension's files, kept in the data directory: code/, config.json, manifest.json ---------------------------

/** Every file under a directory, relative to it, in a stable order. */
function files(dir: string, under = dir): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) => (entry.isDirectory() ? (entry.name === "node_modules" ? [] : files(join(dir, entry.name), under)) : [relative(under, join(dir, entry.name))]))
		.sort();
}

const packageOf = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

/** Packages its code imports (values, not types), by name. */
function imports(code: string): string[] {
	const found = new Set<string>();
	for (const file of files(code).filter((name) => /\.(m?[jt]s|cjs)$/.test(name))) {
		const source = readFileSync(join(code, file), "utf8");
		for (const match of source.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm)) {
			const specifier = match[1]!;
			if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:") || builtinModules.includes(packageOf(specifier))) continue;
			found.add(packageOf(specifier));
		}
	}
	return [...found].sort();
}

/**
 * Make an extension's files ready to deploy: its package.json gets every package its code imports (at the version
 * japa itself uses, when japa uses it, so it runs against what it was written for), and config.json says where it
 * starts. Returns the packages it needs.
 */
export function prepareBundle(dir: string, name: string): { entry: string; packages: string[] } {
	const code = join(dir, "code");
	const path = join(code, "package.json");
	const manifest = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { main?: string; type?: string; dependencies?: Record<string, string> }) : { type: "module" };
	const own = (JSON.parse(readFileSync(join(CODE_DIR, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
	const dependencies = { ...manifest.dependencies };
	for (const used of imports(code)) dependencies[used] ??= own[used] ?? "*";
	writeFileSync(path, `${JSON.stringify({ ...manifest, dependencies }, null, "\t")}\n`);
	const top = files(code).filter((file) => !file.includes("/") && /\.(m?[jt]s)$/.test(file));
	const entry = typeof manifest.main === "string" && existsSync(join(code, manifest.main)) ? manifest.main : (["index.ts", "index.js", "index.mjs"].find((file) => top.includes(file)) ?? (top.length === 1 ? top[0] : undefined));
	if (entry === undefined) throw new Error('can\'t tell where it starts: give it one top-level .ts file, an index.ts, or "main" in package.json');
	writeFileSync(join(dir, "config.json"), `${JSON.stringify({ name, entry, data: "../data" })}\n`);
	return { entry, packages: Object.keys(dependencies).sort() };
}

/** A version id for exactly these files and this host: a new one deploys anew. */
function versionOf(dir: string): string {
	const hash = createHash("sha256").update(readFileSync(HOST)).update(readFileSync(join(dir, "config.json")));
	for (const file of files(join(dir, "code"))) hash.update(file).update(readFileSync(join(dir, "code", file)));
	return hash.digest("hex").slice(0, 12);
}

export const readManifest = (dir: string): Manifest | undefined => (existsSync(join(dir, "manifest.json")) ? (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest) : undefined);

// --- One extension's process on its machine ---------------------------------------------------------------------------

export type SandboxOptions = {
	name: string;
	/** Its files here: code/, config.json, and manifest.json once known. */
	dir: string;
	/** The machine extensions run on, if there is one. */
	machine: () => Backend | undefined;
	host: Host;
	/** Where its provider's /login key comes from, for requests that carry it. */
	models: Models;
	/** A channel's messages come in through its platform's inbox, as every channel's do. */
	inbox: (platform: string) => Inbox;
	/** A problem the chief of staff should hear (undefined: it works again). */
	problem: (text: string | undefined) => void;
	context: Context;
};

/** Its process is gone (its machine slept, or it died). */
class Down extends Error {}

type Sent = { seq: number; op: string; id?: number; args?: Record<string, unknown>; line?: string };

export class Sandbox {
	readonly name: string;
	private readonly options: SandboxOptions;
	private manifest: Manifest | undefined;
	/** Where it's deployed on the machine (relative to its home) and the Node there; known once it's been up. */
	private where: { dir: string; node: string } | undefined;
	private starting: Promise<void> | undefined;
	/** Bumped whenever it's taken down, so a poll or restart from before stops. */
	private generation = 0;
	private wanted = false;
	private failures = 0;
	/** The last of its process's messages read; calls in flight; whether a poll is running. */
	private after = 0;
	private inflight = 0;
	private polling = false;

	constructor(options: SandboxOptions) {
		this.name = options.name;
		this.options = options;
		this.manifest = readManifest(options.dir);
	}

	private machine(): Backend {
		const machine = this.options.machine();
		if (machine === undefined) throw new Error("there's no machine for extensions to run on (machines.extensions, or a workbench)");
		return machine;
	}

	/** A command on the machine: its exit code and everything it printed. */
	private async exec(command: string, options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ exitCode: number; output: string }> {
		let output = "";
		const { exitCode, timedOut } = await this.machine().exec(command, { ...options, onOutput: (chunk) => (output += chunk) });
		return { exitCode: timedOut ? 124 : exitCode, output };
	}

	private async run(command: string, options: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
		const { exitCode, output } = await this.exec(command, options);
		if (exitCode !== 0) throw new Error(output.trim().slice(-2000) || `exit ${exitCode}`);
		return output;
	}

	/** Put base64 text in a file there, in chunks. */
	private async upload(path: string, data: string): Promise<void> {
		await this.run(`: > ${q(path)}`);
		for (let at = 0; at < data.length; at += CHUNK) await this.run(`printf %s ${q(data.slice(at, at + CHUNK))} >> ${q(path)}`);
	}

	/** Node new enough to run it (japa's own requirement): the machine's, or a private copy under ~/.japa/node. */
	private async node(): Promise<string> {
		const engines = (JSON.parse(readFileSync(join(CODE_DIR, "package.json"), "utf8")) as { engines?: { node?: string } }).engines?.node ?? "";
		const major = /\d+/.exec(engines)?.[0] ?? "24";
		const script = `
major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
own="$PWD/${ROOT}/node/bin/node"
if [ -x "$own" ] && [ "$(major "$own")" -ge ${major} ]; then echo "$own"; exit 0; fi
if command -v node >/dev/null 2>&1 && [ "$(major node)" -ge ${major} ]; then command -v node; exit 0; fi
case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "unsupported OS: $(uname -s)"; exit 1 ;; esac
case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) echo "unsupported CPU: $(uname -m)"; exit 1 ;; esac
base="https://nodejs.org/dist/latest-v${major}.x"
file="$(curl -fsSL "$base/SHASUMS256.txt" | awk -v want="-$os-$arch.tar.gz" 'substr($2, length($2) - length(want) + 1) == want { print $2; exit }')"
[ -n "$file" ] || { echo "no Node ${major} build for $os-$arch"; exit 1; }
rm -rf ${ROOT}/node && mkdir -p ${ROOT}/node && curl -fsSL "$base/$file" | tar -xz -C ${ROOT}/node --strip-components=1 && echo "$own"`;
		return (await this.run(script, { timeoutMs: 10 * 60_000 })).trim().split("\n").at(-1)!;
	}

	/** Its files on the machine, with their packages, once per version. Returns where. */
	private async deploy(): Promise<{ dir: string; node: string }> {
		const version = versionOf(this.options.dir);
		const dir = `${ROOT}/extensions/${this.name}/${version}`;
		const node = await this.node();
		if ((await this.exec(`test -f ${q(`${dir}/ready`)}`)).exitCode === 0) return { dir, node };
		const bundle = execFileSync("tar", ["-czf", "-", "-C", resolve(HOST, ".."), "host.mjs", "-C", this.options.dir, "config.json", "code"], { maxBuffer: 1 << 30 });
		await this.run(`rm -rf ${q(dir)} && mkdir -p ${q(dir)} ${q(`${ROOT}/extensions/${this.name}/data`)}`);
		await this.upload(`${dir}/bundle.b64`, bundle.toString("base64"));
		await this.run(`base64 -d < bundle.b64 | tar -xzf - && rm bundle.b64`, { cwd: dir });
		// Its packages, unless they're already there to be found (a machine may come with them).
		const found = `import { existsSync, readFileSync } from "node:fs"; import { dirname, join, resolve } from "node:path";
const wanted = Object.keys(JSON.parse(readFileSync("package.json", "utf8")).dependencies ?? {});
const found = (name) => { for (let at = resolve("."); ; at = dirname(at)) { if (existsSync(join(at, "node_modules", name, "package.json"))) return true; if (dirname(at) === at) return false; } };
process.exit(wanted.every(found) ? 0 : 1);`;
		if ((await this.exec(`${q(node)} --input-type=module -e ${q(found)}`, { cwd: `${dir}/code` })).exitCode !== 0) {
			await this.run(`PATH="$(dirname ${q(node)}):$PATH" npm install --omit=dev --no-audit --no-fund --loglevel=error`, { cwd: `${dir}/code`, timeoutMs: 15 * 60_000 });
		}
		await this.run(`touch ready`, { cwd: dir });
		return { dir, node };
	}

	/** Start its process there (a fresh one), and wait for it to answer. `others`: stop and remove its other versions. */
	private async launch(where: { dir: string; node: string }, others: boolean): Promise<void> {
		const base = `${ROOT}/extensions/${this.name}`;
		const version = where.dir.split("/").at(-1)!;
		const stop = (dir: string) => `[ -f ${dir}/pid ] && kill "$(cat ${dir}/pid)" 2>/dev/null; rm -f ${dir}/pid ${dir}/sock`;
		await this.run(
			others
				? `cd ${q(base)} && for d in */; do d="\${d%/}"; [ "$d" = data ] && continue; ${stop('"$d"')}; [ "$d" = ${q(version)} ] || rm -rf "$d"; done; true`
				: `cd ${q(where.dir)} && ${stop(".")}; true`,
		);
		// Its own session, so it outlives the command that started it; ready once its socket is there, failed if it exits.
		const view = Buffer.from(JSON.stringify(this.view())).toString("base64");
		const serve = `${q(where.node)} host.mjs serve . ${q(view)} > log 2>&1 < /dev/null &`;
		const started = await this.exec(
			`if command -v setsid >/dev/null 2>&1; then setsid ${serve} else nohup ${serve} fi; pid=$!; for i in $(seq 1 240); do [ -S sock ] && exit 0; kill -0 $pid 2>/dev/null || exit 1; sleep 0.25; done; exit 1`,
			{ cwd: where.dir },
		);
		if (started.exitCode !== 0) throw new Error(`it didn't start: ${await this.tail(where)}`);
	}

	/** The end of its process's own log: why it stopped, usually. */
	private async tail(where = this.where): Promise<string> {
		if (where === undefined) return "(no log)";
		const { output } = await this.exec(`tail -c 2000 log 2>/dev/null`, { cwd: where.dir }).catch(() => ({ output: "" }));
		return output.trim() || "(its log is empty)";
	}

	/** What japa sends with each call: its own options, the settings it may read, and which of its keys are set. */
	private view() {
		const { host, name } = this.options;
		const { allowlist, ...settings } = host.settings.get();
		const manifest = this.manifest;
		return {
			options: host.settings.options(name, manifest?.defaults ?? {}),
			settings,
			allowlist: manifest?.channel === undefined ? [] : (allowlist[manifest.channel.platform] ?? []).map(String),
			secrets: (manifest?.settings ?? []).flatMap((field) => (field.kind === "secret" && host.secrets.get(`${name}.${field.key}`, field.env) !== undefined ? [`${name}.${field.key}`] : [])),
			chiefId: host.chiefId(),
			safeTools: [...host.safeTools()],
			commands: host.ui.commands(),
		};
	}

	/** One call to its process, which must be up. */
	private async send<T>(op: string, body: Record<string, unknown> = {}, where = this.where): Promise<T> {
		if (where === undefined) throw new Error("it isn't running");
		const encoded = Buffer.from(JSON.stringify({ ...body, op, view: this.view() })).toString("base64");
		let arg = encoded;
		if (encoded.length > 64 * 1024) {
			arg = `in-${randomUUID()}`;
			await this.upload(`${where.dir}/${arg}`, encoded);
			arg = `@${arg}`;
		}
		// What it asks for while the call runs (a request to the web, say) is read meanwhile.
		this.inflight++;
		if (where === this.where) void this.poll(this.generation);
		let output: string;
		try {
			output = (await this.exec(`${q(where.node)} host.mjs call . ${q(arg)}`, { cwd: where.dir })).output;
		} finally {
			this.inflight--;
		}
		const line = output.trim().split("\n").at(-1) ?? "";
		let answer: { ok: boolean; result?: unknown; error?: string; down?: boolean };
		try {
			answer = JSON.parse(line) as typeof answer;
		} catch {
			throw new Error(output.trim().slice(-500) || "no answer");
		}
		if (answer.down === true) throw new Down(answer.error ?? "its process is gone");
		if (!answer.ok) throw new Error(answer.error ?? "failed");
		return answer.result as T;
	}

	/** Something it keeps here (beside its files), such as the last model list its provider fetched. */
	remember(key: string, value: unknown): void {
		writeFileSync(join(this.options.dir, `${key}.json`), JSON.stringify(value));
	}

	recall<T>(key: string): T | undefined {
		const path = join(this.options.dir, `${key}.json`);
		return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
	}

	/**
	 * Whether it has a life of its own (a channel, or something it starts), so its process must keep running and be
	 * listened to. One that only answers calls (tools, a provider's model list) is listened to during a call, and if its
	 * machine slept and its process is gone, the next call just starts it again.
	 */
	private live(): boolean {
		return this.manifest?.channel !== undefined || this.manifest?.lifecycle.start === true;
	}

	/** Load it there and say what it declares, without starting it: what's checked, and shown, before the user is asked. */
	async inspect(): Promise<Manifest> {
		const where = await this.deploy();
		await this.launch(where, false);
		try {
			const manifest = await this.send<Manifest>("manifest", {}, where);
			if (manifest.name !== this.name) throw new Error(`it calls itself "${manifest.name}", not "${this.name}"`);
			this.manifest = manifest;
			return manifest;
		} catch (error) {
			throw new Error(`${message(error)}\n${await this.tail(where)}`);
		} finally {
			await this.send("shutdown", {}, where).catch(() => {});
		}
	}

	/** Up and running: deployed, its process started, polled, its channel open and its own start run. Once, shared. */
	up(): Promise<void> {
		if (this.starting === undefined) {
			const generation = this.generation;
			this.starting = (async () => {
				const where = await this.deploy();
				await this.launch(where, true);
				if (generation !== this.generation) throw new Error("it was turned off");
				this.where = where;
				this.after = 0;
				this.manifest = await this.send<Manifest>("manifest");
				void this.poll(generation);
				if (this.manifest.channel !== undefined) await this.send("channel.open");
				if (this.manifest.lifecycle.start) await this.send("start");
				this.failures = 0;
				this.options.problem(undefined);
			})();
			// A start that failed half way leaves nothing behind: no poll, no process.
			this.starting.catch(() => {
				this.starting = undefined;
				const where = this.where;
				this.where = undefined;
				if (where !== undefined) void this.send("shutdown", {}, where).catch(() => {});
			});
		}
		return this.starting;
	}

	/** A call to it, bringing it up first if it isn't (again, if its process is gone). */
	async call<T>(op: string, body: Record<string, unknown> = {}): Promise<T> {
		await this.up();
		try {
			return await this.send<T>(op, body);
		} catch (error) {
			if (!(error instanceof Down)) throw error;
			this.starting = undefined;
			this.where = undefined;
			await this.up();
			return this.send<T>(op, body);
		}
	}

	/**
	 * Turned on. A live one comes up in the background (japa doesn't wait on a machine to start), and a failure is the
	 * chief of staff's news; one that only answers calls comes up on its first.
	 */
	start(): void {
		this.wanted = true;
		if (this.live()) void this.up().catch((error: unknown) => this.failed(`it didn't start: ${message(error)}`, true));
	}

	/** Turned off: its channel closed, its own stop run, its process ended. */
	async stop(): Promise<void> {
		this.wanted = false;
		this.generation++;
		const starting = this.starting;
		this.starting = undefined;
		if (starting === undefined || !(await starting.then(() => true, () => false))) return;
		if (this.manifest?.channel !== undefined) await this.send("channel.close").catch((error: unknown) => this.log(`close: ${message(error)}`));
		if (this.manifest?.lifecycle.stop) await this.send("stop").catch((error: unknown) => this.log(`stop: ${message(error)}`));
		await this.send("shutdown").catch(() => {});
		this.where = undefined;
	}

	/**
	 * Report it, and while it's wanted, try again later (sooner at first). One that won't start is tried a few times,
	 * then left until it's turned off and on, reinstalled, or japa restarts: its code won't change by itself.
	 */
	private failed(text: string, starting = false): void {
		this.log(text);
		this.options.problem(text);
		if (!this.wanted) return;
		if (starting && this.failures >= RETRIES) return this.log(`not trying again (${RETRIES} tries) until it's turned off and on, or reinstalled`);
		const generation = this.generation;
		const delay = Math.min(10 * 60_000, 15_000 * 2 ** this.failures++);
		setTimeout(() => {
			if (generation === this.generation && this.wanted) this.start();
		}, delay).unref();
	}

	private log(line: string): void {
		this.options.host.log(`${this.name}: ${line}`);
	}

	/**
	 * What the extension wants from japa, as it comes: all along if it's live, else while a call is in flight; until
	 * it's taken down or its process dies.
	 */
	private async poll(generation: number): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		let misses = 0;
		try {
			while (generation === this.generation && this.where !== undefined && (this.live() || this.inflight > 0)) {
				const where = this.where;
				const view = Buffer.from(JSON.stringify(this.view())).toString("base64");
				const result = await this.exec(`${q(where.node)} host.mjs events . ${this.after} ${POLL_S} ${q(view)}`, { cwd: where.dir, timeoutMs: (POLL_S + 30) * 1000 }).catch((error: unknown) => ({ exitCode: -1, output: message(error) }));
				if (generation !== this.generation || where !== this.where) return;
				if (result.exitCode !== 0) {
					// A hiccup reaching the machine is tried again; a live one's process that's gone is a problem.
					if (result.exitCode !== 3 && ++misses < 3) continue;
					this.starting = undefined;
					this.where = undefined;
					if (this.live()) this.failed(`it stopped running: ${await this.tail(where)}`);
					return;
				}
				misses = 0;
				for (const line of result.output.split("\n")) {
					if (!line.startsWith("{")) continue;
					const sent = JSON.parse(line) as Sent;
					if (sent.seq <= this.after) continue;
					this.after = sent.seq;
					void this.handle(sent).catch((error: unknown) => this.log(`${sent.op}: ${message(error)}`));
				}
			}
		} finally {
			this.polling = false;
		}
		// A call that began just as it stopped listening.
		if (generation === this.generation && this.where !== undefined && this.inflight > 0) void this.poll(generation);
	}

	/** One thing it wants: a notice, or a request answered back to it. */
	private async handle(sent: Sent): Promise<void> {
		const { host } = this.options;
		const args = sent.args ?? {};
		if (sent.op === "log") return this.log(String(sent.line));
		if (sent.op === "ui.handle") {
			const owner = String(args.owner);
			if (owner !== this.name) return this.log(`refused: it may only handle its own cards ("${this.name}:"), not "${owner}:"`);
			host.ui.handle(owner, {
				press: (payload, ref) => this.call("press", { owner, payload, ref }),
				reply: (payload, text, ref) => this.call("cardReply", { owner, payload, text, ref }),
			});
			return;
		}
		if (sent.op === "ui.command") {
			const name = String(args.name);
			if (host.ui.commands().some((command) => command.name === name) && !this.commands.has(name)) return this.log(`refused: /${name} is taken`);
			this.commands.add(name);
			host.ui.command(name, String(args.description), (at) => this.call("command", { name, at }));
			return;
		}
		if (sent.op === "setOption") return host.settings.setOption(this.name, String(args.key), args.value);
		if (sent.op === "holds.add") return host.holds.add(String(args.id), `${this.name}:${String(args.reason)}`);
		if (sent.op === "holds.remove") return host.holds.remove(String(args.id), `${this.name}:${String(args.reason)}`);
		if (sent.op === "emit") return host.emit(String(args.event), args.detail === undefined ? undefined : String(args.detail));
		if (sent.id === undefined) return this.log(`unknown notice ${sent.op}`);
		try {
			await this.send("reply", { id: sent.id, result: (await this.request(sent.op, args)) ?? null });
		} catch (error) {
			await this.send("reply", { id: sent.id, error: message(error) });
		}
	}

	private readonly commands = new Set<string>();

	/** A request from its code, answered within what it was granted. */
	private async request(op: string, args: Record<string, unknown>): Promise<unknown> {
		const { host, context } = this.options;
		const channel = this.manifest?.channel;
		const needsChannel = () => {
			if (channel === undefined) throw new Error(`${op} is for a channel, and it declares none`);
			return channel;
		};
		switch (op) {
			case "ui.show": {
				const card = args.card as Card;
				const own = (data: string) => data.startsWith(`${this.name}:`);
				if (!(card.buttons ?? []).flat().every((button) => own(button.data)) || (card.ask !== undefined && !own(card.ask.data))) {
					throw new Error(`a card's buttons and questions must be its own: data starting "${this.name}:"`);
				}
				return host.ui.show(card, args.replace as never);
			}
			case "ui.press":
				needsChannel();
				return host.ui.press(String(args.data), args.ref as never);
			case "ui.reply":
				needsChannel();
				return host.ui.reply(String(args.data), String(args.text), args.ref as never);
			case "ui.run":
				needsChannel();
				return host.ui.run(String(args.name), args.at as never);
			case "wake": {
				const options = (args.options ?? {}) as { id?: string; replyTo?: never };
				return host.wake(String(args.conversationId), String(args.text), { id: `${this.name}:${options.id ?? randomUUID()}`, from: `extension ${this.name}`, ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }) });
			}
			case "searchHistory":
				return host.searchHistory(String(args.query), context);
			case "inbox.ask": {
				const inbox = this.options.inbox(needsChannel().platform);
				const sent = args.message as { text: string; attachments?: Array<{ name: string; mimeType: string; data: string }> };
				const incoming = { text: sent.text, ...(sent.attachments === undefined ? {} : { attachments: sent.attachments.map((file) => ({ ...file, data: new Uint8Array(Buffer.from(file.data, "base64")) })) }) };
				return inbox.ask(args.from as string, String(args.requestId), incoming, args.reply as never, context, (args.arrival ?? undefined) as never);
			}
			case "inbox.answer":
				return this.options.inbox(needsChannel().platform).answer(String(args.requestId), args.content as never, context);
			case "inbox.pending":
				return this.options.inbox(needsChannel().platform).pending(context);
			case "inbox.delivered":
				return this.options.inbox(needsChannel().platform).delivered(String(args.requestId), context);
			case "fetch":
				return this.egress(args as { url: string; method: string; headers: Record<string, string>; body?: string });
			default:
				throw new Error(`unknown request ${op}`);
		}
	}

	/**
	 * A request to the web that carries a key placeholder: the real values go in here, only its own (a secret settings
	 * field of its, or its provider's /login key), and come out of the answer again.
	 */
	private async egress(request: { url: string; method: string; headers: Record<string, string>; body?: string }): Promise<unknown> {
		const { host, models } = this.options;
		const manifest = this.manifest;
		const values = new Map<string, string>();
		const text = [request.url, ...Object.values(request.headers), request.body === undefined ? "" : Buffer.from(request.body, "base64").toString("utf8")].join("\n");
		for (const [, key] of text.matchAll(/japa-secret:([\w.:-]+)/g)) {
			if (key === undefined || values.has(key)) continue;
			let value: string | undefined;
			if (key.startsWith("auth:")) {
				const id = key.slice("auth:".length);
				if (!(manifest?.providers ?? []).some((provider) => provider.id === id)) throw new Error(`"${id}" isn't its provider`);
				value = (await models.getAuth(id))?.auth.apiKey;
			} else {
				const field = (manifest?.settings ?? []).find((each) => each.kind === "secret" && `${this.name}.${each.key}` === key);
				if (field === undefined || field.kind !== "secret") throw new Error(`"${key}" isn't one of its keys`);
				value = host.secrets.get(key, field.env);
			}
			if (value === undefined) throw new Error(`${key} isn't set`);
			values.set(key, value);
		}
		const fill = (value: string) => value.replace(/japa-secret:([\w.:-]+)/g, (whole, key: string) => values.get(key) ?? whole);
		const body = request.body === undefined ? undefined : Buffer.from(request.body, "base64");
		const filled = body !== undefined && body.toString("utf8").includes("japa-secret:") ? Buffer.from(fill(body.toString("utf8"))) : body;
		const response = await fetch(fill(request.url), { method: request.method, headers: Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, fill(value)])), ...(filled === undefined ? {} : { body: filled }) });
		let answer = Buffer.from(await response.arrayBuffer());
		const shown = answer.toString("utf8");
		if ([...values.values()].some((value) => shown.includes(value))) answer = Buffer.from([...values].reduce((all, [key, value]) => all.replaceAll(value, `japa-secret:${key}`), shown));
		return { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), body: answer.toString("base64") };
	}
}

// --- Its stand-in here ------------------------------------------------------------------------------------------------

const TASKS = new Map([ToolTask, GenerationTask, CompactionTask].map((task) => [task.definition.name, task]));

/** pi-ai's built-in implementation of each API, loaded when a model on it is first used. */
const apis = new Map<string, ProviderStreams>();
const builtin = (api: string) => {
	let found = apis.get(api);
	if (found === undefined) {
		found = lazyApi(() => import(`@earendil-works/pi-ai/api/${api}`) as Promise<ProviderStreams>);
		apis.set(api, found);
	}
	return found;
};
const byApi: ProviderStreams = {
	stream: (model, context, options) => builtin(model.api).stream(model, context, options),
	streamSimple: (model, context, options) => builtin(model.api).streamSimple(model, context, options),
};

/** Its provider, here: its models on pi-ai's built-in APIs, its key from /login, its model list fetched there. */
function providerStandIn(spec: ProviderSpec, sandbox: Sandbox): Provider {
	return createProvider({
		id: spec.id,
		name: spec.name,
		...(spec.baseUrl === undefined ? {} : { baseUrl: spec.baseUrl }),
		...(spec.headers === undefined ? {} : { headers: spec.headers }),
		auth: { apiKey: envApiKeyAuth(spec.name, []) },
		// The list it fetched last time, so its models are there before its machine is.
		models: spec.models.length > 0 ? spec.models : (sandbox.recall<AnyModel[]>(`models-${spec.id}`) ?? []),
		api: byApi,
		...(spec.dynamic
			? {
					fetchModels: async (context) => {
						if (context.credential === undefined) return [];
						const fetched = await sandbox.call<AnyModel[]>("models", { provider: spec.id });
						sandbox.remember(`models-${spec.id}`, fetched);
						return fetched;
					},
				}
			: {}),
	});
}

/** The JapaExtension japa registers for it: what its code declared, every part forwarding to its process. */
export function standIn(manifest: Manifest, sandbox: Sandbox, log: (line: string) => void): JapaExtension {
	const own = new Set(manifest.extensions.flatMap((spec) => spec.tools.map((tool) => tool.name)));
	const ids = (api: { taskId: unknown; conversationId: unknown; callId?: string }) => ({ taskId: String(api.taskId), conversationId: String(api.conversationId), ...(api.callId === undefined ? {} : { callId: api.callId }) });

	const tool = (ext: string, spec: ToolSpec): ToolRegistration => ({
		name: spec.name,
		description: spec.description,
		parameters: spec.parameters as TSchema,
		...(spec.replay === undefined ? {} : { replay: spec.replay }),
		...(spec.executionMode === undefined ? {} : { executionMode: spec.executionMode }),
		execute: async (args, api, context) => {
			const abort = () => void sandbox.call("abort", { callId: api.callId }).catch(() => {});
			context.abortSignal?.addEventListener("abort", abort, { once: true });
			try {
				return await sandbox.call<ToolExecutionResult>("tool", { ext, tool: spec.name, args, callId: api.callId, ids: ids(api) });
			} catch (error) {
				return { content: [{ type: "text", text: `${spec.name} failed: ${message(error)}` }], isError: true };
			} finally {
				context.abortSignal?.removeEventListener("abort", abort);
			}
		},
	});

	/** A hook, forwarded; for another extension's tool it may only block, and if it can't be reached it stays out of the way. */
	const forward = (ext: string, task: string, name: string) =>
		async (...all: unknown[]) => {
			const args = all.slice(0, -2);
			const api = all.at(-2) as { taskId: unknown; conversationId: unknown };
			const call = task === ToolTask.definition.name ? (args[0] as { name: string }) : undefined;
			const mine = call !== undefined && own.has(call.name);
			let result: Record<string, unknown> | null;
			try {
				result = await sandbox.call<Record<string, unknown> | null>("hook", { ext, task, name, args, ids: ids(api) });
			} catch (error) {
				if (mine) throw error;
				log(`${manifest.name}: hook ${name}: ${message(error)}`);
				return undefined;
			}
			if (result === null) return undefined;
			if (call === undefined || mine) return result;
			return name === "beforeTool" && typeof result.block === "string" ? { block: result.block } : undefined;
		};

	const pis = new Map<string, Extension>(
		manifest.extensions.map((spec) => [
			spec.name,
			defineExtension({
				name: spec.name,
				tools: spec.tools.map((each) => tool(spec.name, each)),
				sections: spec.sections.map((each) =>
					section(
						each.key,
						async (input) => (await sandbox.call<string | null>("section", { ext: spec.name, key: each.key, input: { conversationId: String(input.conversationId), shown: input.shown } }).catch((error: unknown) => (log(`${manifest.name}: section ${each.key}: ${message(error)}`), null))) ?? undefined,
						each.tag === undefined ? undefined : { tag: each.tag },
					),
				),
				hooks: spec.hooks.flatMap((each): HookRegistration[] => {
					const task = TASKS.get(each.task);
					return task === undefined ? [] : [hook(task, Object.fromEntries(each.names.map((name) => [name, forward(spec.name, each.task, name)])) as never)];
				}),
			}),
		]),
	);

	return {
		name: manifest.name,
		title: manifest.title,
		about: manifest.about,
		...(manifest.enabledByDefault === undefined ? {} : { enabledByDefault: manifest.enabledByDefault }),
		settings: manifest.settings,
		defaults: manifest.defaults,
		// It vouches only for its own tools.
		safeTools: manifest.safeTools.filter((name) => own.has(name)),
		chief: manifest.chief.flatMap((name) => pis.get(name) ?? []),
		jobs: manifest.jobs.flatMap((name) => pis.get(name) ?? []),
		triggers: manifest.triggers,
		providers: manifest.providers.map((spec) => providerStandIn(spec, sandbox)),
		...(manifest.lifecycle.sliceEnd ? { onSliceEnd: async (slice) => void (await sandbox.call("sliceEnd", { slice })) } : {}),
		// Its channel opens and closes with its process (start and stop); cards go through it there.
		...(manifest.channel === undefined
			? {}
			: { channel: { platform: manifest.channel.platform, open: () => {}, show: (card, replace) => sandbox.call("channel.show", { card, replace }), close: () => {} } }),
		start: () => sandbox.start(),
		stop: () => sandbox.stop(),
	};
}

/** What it would be given, for the card the user decides on. */
export function grants(manifest: Manifest, packages: readonly string[]): string[] {
	const tools = (names: string[]) => manifest.extensions.filter((spec) => names.includes(spec.name)).flatMap((spec) => spec.tools.map((each) => each.name));
	const hooks = [...new Set(manifest.extensions.flatMap((spec) => spec.hooks.flatMap((each) => each.names)))];
	const secrets = manifest.settings.filter((field) => field.kind === "secret").map((field) => field.label);
	return [
		...(tools(manifest.chief).length === 0 ? [] : [`Tools for you: ${tools(manifest.chief).join(", ")}`]),
		...(tools(manifest.jobs).length === 0 ? [] : [`Tools for job agents: ${tools(manifest.jobs).join(", ")}`]),
		...(hooks.length === 0 ? [] : [`Hooks into the agent: ${hooks.join(", ")} (it can only block other extensions' tools, not change them)`]),
		...(manifest.providers.length === 0 ? [] : [`Model providers: ${manifest.providers.map((provider) => provider.name).join(", ")} (key from /login)`]),
		...(manifest.channel === undefined ? [] : [`A channel: ${manifest.channel.platform} (only people on its allowlist get in)`]),
		...(manifest.triggers.length === 0 ? [] : [`Wakes you: ${manifest.triggers.map((trigger) => trigger.name).join(", ")}`]),
		...(secrets.length === 0 ? [] : [`Keys it can use in web requests (it never sees them): ${secrets.join(", ")}`]),
		...(packages.length === 0 ? [] : [`npm packages: ${packages.join(", ")}`]),
	];
}
