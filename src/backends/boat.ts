// boat.dev as a backend provider: a persistent Linux VM per role. The agent never sees any of this — to it, the
// machine is just its computer. The API key stays in the harness; the machine is created no-env so none of the
// account's secrets reach it. Files and installed packages persist across stop/resume.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { type Backend, type BackendProvider, type ExecOptions, type ExecResult, shellQuote as q } from "../core/backend.ts";

const API = "https://boat.dev/api/v1";
const HOME = "/home/user";
/** boat's synchronous command limit. */
const SYNC_LIMIT_S = 600;
const READY = new Set(["ready", "idle", "running"]);
/** How often the sleep deadline is pushed back while the machine is in use. */
const TOUCH_EVERY_MS = 5 * 60_000;

type BoatError = { status: number; code?: string; retryable?: boolean; message?: string };

export class BoatApi {
	private readonly apiKey: string;
	private readonly fetch: typeof fetch;

	constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
		this.apiKey = apiKey;
		this.fetch = fetchImpl;
	}

	async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
		const response = await this.fetch(`${API}${path}`, {
			method,
			headers: { Authorization: `Bearer ${this.apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			...(signal === undefined ? {} : { signal }),
		});
		if (!response.ok) {
			const detail = (await response.json().catch(() => ({}))) as { code?: string; retryable?: boolean; message?: string };
			// Worded for the agent, which only knows it has a computer.
			throw Object.assign(new Error(`the computer is unavailable right now (${response.status} ${detail.code ?? ""} ${detail.message ?? ""})`.replace(/ +\)/, ")")), {
				status: response.status,
				...detail,
			} satisfies BoatError);
		}
		return response;
	}

	async json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
		return (await (await this.request(method, path, body, signal)).json()) as T;
	}
}

/**
 * One role's machine. Nothing happens until it's used: the first command creates the machine (or finds the one
 * remembered for this role), wakes it if it's asleep, and runs. Whoever uses it only ever sees a computer.
 */
export class BoatBackend implements Backend {
	readonly id: string;
	readonly home = HOME;
	private readonly api: BoatApi;
	/** The machine's id: the remembered one, or a new machine (`fresh`: the remembered one is gone). */
	private readonly find: (fresh: boolean) => Promise<string>;
	private machine: Promise<string> | undefined;
	/** Sleep (archive) after this long unused; undefined: never. */
	private readonly idleSeconds: number | undefined;
	private readonly touchEveryMs: number;
	private touchedAt = 0;

	constructor(api: BoatApi, role: string, find: (fresh: boolean) => Promise<string>, idleSeconds?: number, touchEveryMs = TOUCH_EVERY_MS) {
		this.api = api;
		this.id = `boat:${role}`;
		this.find = find;
		this.idleSeconds = idleSeconds;
		this.touchEveryMs = touchEveryMs;
	}

	/** The machine's id, creating the machine on first use. */
	sandboxId(fresh = false): Promise<string> {
		if (this.machine === undefined || fresh) {
			const found = this.find(fresh);
			this.machine = found;
			found.catch(() => {
				if (this.machine === found) this.machine = undefined; // try again next time
			});
		}
		return this.machine;
	}

	/**
	 * boat only has a fixed auto-stop deadline, but setting the TTL again restarts it from now. So the deadline is
	 * pushed back whenever the machine is used (and every few minutes while a command runs): it sleeps after
	 * `idleSeconds` without use, never in the middle of work.
	 */
	private touch(): void {
		// Not used yet since start: the first command either finds it awake or wakes it with a fresh deadline.
		if (this.machine === undefined || this.idleSeconds === undefined || Date.now() - this.touchedAt < this.touchEveryMs) return;
		this.touchedAt = Date.now();
		void this.sandboxId().then((id) => this.api.json("PATCH", `/sandboxes/${id}`, { ttlSeconds: this.idleSeconds })).catch(() => {
			this.touchedAt = 0; // try again next time
		});
	}

	private async state(): Promise<string> {
		return (await this.api.json<{ sandbox: { state: string } }>("GET", `/sandboxes/${await this.sandboxId()}`)).sandbox.state;
	}

	/** Bring a stopped machine back (or a new one, if it's gone), and wait until it accepts commands. */
	async ensureRunning(signal?: AbortSignal): Promise<void> {
		let state = await this.state().catch(async (error: unknown) => {
			if ((error as BoatError).status !== 404) throw error;
			await this.sandboxId(true);
			return this.state();
		});
		if (state === "archived" || state === "error") {
			await this.api.json("POST", `/sandboxes/${await this.sandboxId()}/resume`, { ttlSeconds: this.idleSeconds ?? null }, signal);
			this.touchedAt = Number.POSITIVE_INFINITY; // the resume set a fresh deadline
		}
		for (const started = Date.now(); !READY.has(state); state = await this.state()) {
			if (Date.now() - started > 180_000) throw new Error(`the computer didn't start (${state})`);
			await new Promise((resolve) => setTimeout(resolve, 1000));
			signal?.throwIfAborted();
		}
		if (this.touchedAt === Number.POSITIVE_INFINITY) this.touchedAt = Date.now();
	}

	async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		const cwd = options.cwd === undefined ? HOME : posix.isAbsolute(options.cwd) ? options.cwd : posix.join(HOME, options.cwd);
		const exports = Object.entries(options.env ?? {})
			.map(([key, value]) => `export ${key}=${q(value)}; `)
			.join("");
		const full = `cd ${q(cwd)} && ${exports}${command}`;
		const seconds = options.timeoutMs === undefined ? SYNC_LIMIT_S : Math.ceil(options.timeoutMs / 1000);
		this.touch();
		const keepAwake = setInterval(() => this.touch(), this.touchEveryMs);
		try {
			return seconds > SYNC_LIMIT_S ? await this.execDetached(full, seconds, options) : await this.execStreamed(full, seconds, options);
		} catch (error) {
			// Asleep (or gone): wake it, or replace it, once and run again. A command that may already be running is
			// never retried.
			const { code, status } = error as BoatError;
			if (code !== "sandbox_not_ready" && status !== 404) throw error;
			await this.ensureRunning(options.signal);
			return seconds > SYNC_LIMIT_S ? await this.execDetached(full, seconds, options) : await this.execStreamed(full, seconds, options);
		} finally {
			clearInterval(keepAwake);
		}
	}

	private async execStreamed(command: string, timeoutSeconds: number, options: ExecOptions): Promise<ExecResult> {
		const response = await this.api.request("POST", `/sandboxes/${await this.sandboxId()}/commands`, { command, timeoutSeconds, stream: true }, options.signal);
		if (response.body === null) throw new Error("the computer returned no output stream");
		const decoder = new TextDecoder();
		let buffered = "";
		let result: ExecResult | undefined;
		for await (const chunk of response.body) {
			buffered += decoder.decode(chunk as Uint8Array, { stream: true });
			let newline = buffered.indexOf("\n");
			for (; newline !== -1; newline = buffered.indexOf("\n")) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (line === "") continue;
				const frame = JSON.parse(line) as { type: string; data?: string; exitCode?: number | null; timedOut?: boolean; message?: string };
				if (frame.type === "stdout" || frame.type === "stderr") options.onOutput?.(frame.data ?? "");
				else if (frame.type === "exit") result = { exitCode: frame.exitCode ?? 137, ...(frame.timedOut === true ? { timedOut: true } : {}) };
				else if (frame.type === "error") throw new Error(frame.message ?? "the command failed");
			}
		}
		if (result === undefined) throw new Error("the command ended without an exit code");
		return result;
	}

	/** Past boat's synchronous limit: start detached, poll, then read the logs. */
	private async execDetached(command: string, timeoutSeconds: number, options: ExecOptions): Promise<ExecResult> {
		const id = await this.sandboxId();
		const started = await this.api.json<{ processId: number; pid: number; logPath?: string; errLogPath?: string }>(
			"POST",
			`/sandboxes/${id}/commands`,
			{ command, detached: true },
			options.signal,
		);
		const deadline = Date.now() + timeoutSeconds * 1000;
		let status: { running: boolean; exitCode: number | null; logPath?: string; errLogPath?: string };
		for (let wait = 250; ; wait = Math.min(wait * 2, 5000)) {
			status = await this.api.json("GET", `/sandboxes/${id}/commands/${started.processId}`);
			if (!status.running) break;
			if (Date.now() > deadline || options.signal?.aborted === true) {
				await this.execStreamed(`kill -TERM -- -${started.pid} 2>/dev/null || kill -TERM ${started.pid}`, 30, {});
				return { exitCode: 143, timedOut: Date.now() > deadline };
			}
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
		const logs = [status.logPath ?? started.logPath, status.errLogPath ?? started.errLogPath].filter((path): path is string => path !== undefined);
		if (logs.length > 0 && options.onOutput !== undefined) await this.execStreamed(`cat -- ${logs.map(q).join(" ")} 2>/dev/null`, 120, { onOutput: options.onOutput });
		return { exitCode: status.exitCode ?? 137 };
	}

	async viewUrl(): Promise<string> {
		await this.ensureRunning();
		for (let attempt = 0; attempt < 30; attempt++) {
			const body = await this.api.json<{ desktopUrl?: string; provisioning?: boolean }>("POST", `/sandboxes/${await this.sandboxId()}/desktop?vnc=1`, {});
			if (body.desktopUrl !== undefined) return body.desktopUrl;
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
		throw new Error("the screen link isn't available");
	}

	async suspend(): Promise<void> {
		if (this.machine === undefined) return;
		await this.api.json("POST", `/sandboxes/${await this.sandboxId()}/stop`, {});
	}
}

/**
 * Config per role: `sandboxId` to use an existing machine, else one is created on first use (`type`, default "small")
 * and its id remembered in `stateFile`, so the same machine — and everything on it — comes back next time; if it's
 * gone, the next command gets a new one. `idleSeconds`: sleep after that long unused (free trials require ≤ 7200); it
 * wakes, same disk, on the next command. Opening costs nothing: no machine starts until something runs on it.
 */
export function boatProvider(options: { apiKey: string; stateFile: string; fetch?: typeof fetch; touchEveryMs?: number }): BackendProvider {
	const api = new BoatApi(options.apiKey, options.fetch);
	const remembered = (): Record<string, string> => (existsSync(options.stateFile) ? (JSON.parse(readFileSync(options.stateFile, "utf8")) as Record<string, string>) : {});
	return {
		name: "boat",
		async open(role, config) {
			const idleSeconds = typeof config.idleSeconds === "number" ? config.idleSeconds : undefined;
			const configured = typeof config.sandboxId === "string" ? config.sandboxId : undefined;
			const find = async (fresh: boolean) => {
				const known = fresh ? undefined : (configured ?? remembered()[role]);
				if (known !== undefined) return known;
				const created = await api.json<{ sandbox: { id: string } }>("POST", "/sandboxes", {
					type: typeof config.type === "string" ? config.type : "small",
					ttlSeconds: idleSeconds ?? null,
					noEnv: true,
				});
				writeFileSync(options.stateFile, `${JSON.stringify({ ...remembered(), [role]: created.sandbox.id }, null, "\t")}\n`);
				return created.sandbox.id;
			};
			return new BoatBackend(api, role, find, idleSeconds, options.touchEveryMs);
		},
	};
}
