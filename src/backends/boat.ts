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
			throw Object.assign(new Error(`boat ${method} ${path}: ${response.status} ${detail.code ?? ""} ${detail.message ?? ""}`.trim()), {
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

export class BoatBackend implements Backend {
	readonly id: string;
	readonly home = HOME;
	readonly sandboxId: string;
	private readonly api: BoatApi;

	constructor(api: BoatApi, sandboxId: string) {
		this.api = api;
		this.sandboxId = sandboxId;
		this.id = `boat:${sandboxId}`;
	}

	private state(): Promise<string> {
		return this.api.json<{ sandbox: { state: string } }>("GET", `/sandboxes/${this.sandboxId}`).then((body) => body.sandbox.state);
	}

	/** Bring a stopped machine back, and wait until it accepts commands. */
	async ensureRunning(signal?: AbortSignal): Promise<void> {
		let state = await this.state();
		if (state === "archived" || state === "error") {
			await this.api.json("POST", `/sandboxes/${this.sandboxId}/resume`, { ttlSeconds: null }, signal);
		}
		for (const started = Date.now(); !READY.has(state); state = await this.state()) {
			if (Date.now() - started > 180_000) throw new Error(`boat machine ${this.sandboxId} not ready (${state})`);
			await new Promise((resolve) => setTimeout(resolve, 1000));
			signal?.throwIfAborted();
		}
	}

	async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		const cwd = options.cwd === undefined ? HOME : posix.isAbsolute(options.cwd) ? options.cwd : posix.join(HOME, options.cwd);
		const exports = Object.entries(options.env ?? {})
			.map(([key, value]) => `export ${key}=${q(value)}; `)
			.join("");
		const full = `cd ${q(cwd)} && ${exports}${command}`;
		const seconds = options.timeoutMs === undefined ? SYNC_LIMIT_S : Math.ceil(options.timeoutMs / 1000);
		try {
			return seconds > SYNC_LIMIT_S ? await this.execDetached(full, seconds, options) : await this.execStreamed(full, seconds, options);
		} catch (error) {
			// A stopped machine: resume it once and run again. A command that may already be running is never retried.
			if ((error as BoatError).code !== "sandbox_not_ready") throw error;
			await this.ensureRunning(options.signal);
			return seconds > SYNC_LIMIT_S ? this.execDetached(full, seconds, options) : this.execStreamed(full, seconds, options);
		}
	}

	private async execStreamed(command: string, timeoutSeconds: number, options: ExecOptions): Promise<ExecResult> {
		const response = await this.api.request("POST", `/sandboxes/${this.sandboxId}/commands`, { command, timeoutSeconds, stream: true }, options.signal);
		if (response.body === null) throw new Error("boat: empty command stream");
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
				else if (frame.type === "error") throw new Error(`boat: ${frame.message ?? "command failed"}`);
			}
		}
		if (result === undefined) throw new Error("boat: command stream ended without an exit");
		return result;
	}

	/** Past boat's synchronous limit: start detached, poll, then read the logs. */
	private async execDetached(command: string, timeoutSeconds: number, options: ExecOptions): Promise<ExecResult> {
		const started = await this.api.json<{ processId: number; pid: number; logPath?: string; errLogPath?: string }>(
			"POST",
			`/sandboxes/${this.sandboxId}/commands`,
			{ command, detached: true },
			options.signal,
		);
		const deadline = Date.now() + timeoutSeconds * 1000;
		let status: { running: boolean; exitCode: number | null; logPath?: string; errLogPath?: string };
		for (let wait = 250; ; wait = Math.min(wait * 2, 5000)) {
			status = await this.api.json("GET", `/sandboxes/${this.sandboxId}/commands/${started.processId}`);
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
		for (let attempt = 0; attempt < 30; attempt++) {
			const body = await this.api.json<{ desktopUrl?: string; provisioning?: boolean }>("POST", `/sandboxes/${this.sandboxId}/desktop?vnc=1`, {});
			if (body.desktopUrl !== undefined) return body.desktopUrl;
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
		throw new Error("boat: desktop not available");
	}

	async suspend(): Promise<void> {
		await this.api.json("POST", `/sandboxes/${this.sandboxId}/stop`, {});
	}
}

/**
 * Config per role: `sandboxId` to use an existing machine, else one is created (`type`, default "small"; `ttlSeconds`,
 * default none) and its
 * id remembered in `stateFile`, so the same machine — and everything on it — comes back next time.
 */
export function boatProvider(options: { apiKey: string; stateFile: string; fetch?: typeof fetch }): BackendProvider {
	const api = new BoatApi(options.apiKey, options.fetch);
	const remembered = (): Record<string, string> => (existsSync(options.stateFile) ? (JSON.parse(readFileSync(options.stateFile, "utf8")) as Record<string, string>) : {});
	return {
		name: "boat",
		async open(role, config) {
			let sandboxId = typeof config.sandboxId === "string" ? config.sandboxId : remembered()[role];
			if (sandboxId === undefined) {
				const created = await api.json<{ sandbox: { id: string } }>("POST", "/sandboxes", {
					type: typeof config.type === "string" ? config.type : "small",
					// Auto-stop (archive) after this long; it resumes on the next command. Free trials require ≤ 7200.
					ttlSeconds: typeof config.ttlSeconds === "number" ? config.ttlSeconds : null,
					noEnv: true,
				});
				sandboxId = created.sandbox.id;
				writeFileSync(options.stateFile, `${JSON.stringify({ ...remembered(), [role]: sandboxId }, null, "\t")}\n`);
			}
			const backend = new BoatBackend(api, sandboxId);
			await backend.ensureRunning();
			return backend;
		},
	};
}
