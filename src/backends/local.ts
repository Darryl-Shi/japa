// The local backend: commands run on this machine under `home`. For development and tests, and the smallest
// example of a provider — implementing `exec` is all it takes to attach a computer.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Backend, BackendProvider, ExecOptions, ExecResult } from "../core/backend.ts";

export class LocalBackend implements Backend {
	readonly id: string;
	readonly home: string;

	constructor(home: string) {
		this.home = resolve(home);
		this.id = `local:${hostname()}`;
		mkdirSync(this.home, { recursive: true });
	}

	exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		const cwd = options.cwd === undefined ? this.home : isAbsolute(options.cwd) ? options.cwd : join(this.home, options.cwd);
		return new Promise((done, fail) => {
			const child = spawn("bash", ["-c", command], { cwd, env: { ...process.env, HOME: this.home, ...options.env }, detached: true });
			let timedOut = false;
			const kill = () => {
				try {
					process.kill(-(child.pid ?? 0), "SIGKILL");
				} catch {}
			};
			const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => ((timedOut = true), kill()), options.timeoutMs);
			options.signal?.addEventListener("abort", kill, { once: true });
			const forward = (chunk: Buffer) => options.onOutput?.(chunk.toString("utf8"));
			child.stdout.on("data", forward);
			child.stderr.on("data", forward);
			child.on("error", (error) => {
				clearTimeout(timer);
				fail(error);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", kill);
				done({ exitCode: code ?? 137, ...(timedOut ? { timedOut } : {}) });
			});
		});
	}
}

export const localProvider: BackendProvider = {
	name: "local",
	async open(role, config) {
		return new LocalBackend(typeof config.home === "string" ? config.home : join("data", "machines", role));
	},
};
