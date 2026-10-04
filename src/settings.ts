// Live settings: data/settings.json, re-read whenever the file changes. Secrets never live here;
// model credentials are in data/auth.json and channel tokens in the environment.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ModelChoice = { provider: string; modelId: string };
export type MachineConfig = { provider: string; [option: string]: unknown };

export type Settings = {
	/** The main thread: fast, answers directly. */
	model: ModelChoice;
	/** Delegated work: subagents. */
	delegateModel: ModelChoice;
	codingAgent: "claude-code" | "codex";
	/**
	 * The computers the agent works on, by role, each backed by a provider (built in: "boat", "local"; extensions can
	 * add more). workbench: its own machine for shell, files, scripts and coding agents — no secrets. desk (later):
	 * a machine with a screen and the user's logged-in browser. A role with no entry is not available.
	 */
	machines: { workbench?: MachineConfig; desk?: MachineConfig };
	/** Daily model spend cap in USD. */
	spendCapUsd: number;
	telegram: { ownerChatId?: number };
	/** IANA zone for the time stamped on each message; default: the machine's. */
	timezone?: string;
	/**
	 * The main thread is one Telegram DM, but the model works in short slices of it. A new slice starts (decided when
	 * the next message from the user arrives) after idleMinutes without one, when the next request would pass
	 * sliceTokens, on /new, or on a reply to a message from an earlier slice. A slice starts from state — open items,
	 * the working set, the last few visible messages — not from a summary of history.
	 */
	context: { idleMinutes: number; sliceTokens: number };
};

export const DEFAULTS: Settings = {
	model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
	delegateModel: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
	codingAgent: "claude-code",
	machines: {},
	spendCapUsd: 20,
	telegram: {},
	context: { idleMinutes: 10, sliceTokens: 8000 },
};

export class SettingsFile {
	readonly path: string;
	private cached: Settings = DEFAULTS;
	private mtimeMs = -1;

	constructor(dataDir: string) {
		this.path = join(dataDir, "settings.json");
	}

	get(): Settings {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(this.path).mtimeMs;
		} catch {
			return this.cached;
		}
		if (mtimeMs !== this.mtimeMs) {
			this.cached = { ...DEFAULTS, ...(JSON.parse(readFileSync(this.path, "utf8")) as Partial<Settings>) };
			this.mtimeMs = mtimeMs;
		}
		return this.cached;
	}

	update(change: Partial<Settings>): Settings {
		const next = { ...this.get(), ...change };
		writeFileSync(this.path, `${JSON.stringify(next, null, "\t")}\n`);
		return this.get();
	}
}
