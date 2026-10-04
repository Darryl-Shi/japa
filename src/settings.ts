// Live settings: data/settings.json, re-read whenever the file changes. Secrets never live here;
// model credentials are in data/auth.json and channel tokens in the environment.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ModelChoice = { provider: string; modelId: string };

export type Settings = {
	/** The main thread: fast, answers directly. */
	model: ModelChoice;
	/** Delegated work: subagents. */
	delegateModel: ModelChoice;
	codingAgent: "claude-code" | "codex";
	sandbox: { kind: "endpoint"; url: string } | { kind: "boat" } | { kind: "none" };
	/** Daily model spend cap in USD. */
	spendCapUsd: number;
	telegram: { ownerChatId?: number };
	/**
	 * The main thread's model context. While messages keep coming it grows and stays cached; once the provider cache
	 * has expired it is compacted to a short handoff note, so a message after a gap is cheap. Older detail comes back
	 * through history search.
	 */
	context: { restAfterMinutes: number; maxTokens: number };
};

export const DEFAULTS: Settings = {
	model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
	delegateModel: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
	codingAgent: "claude-code",
	sandbox: { kind: "none" },
	spendCapUsd: 20,
	telegram: {},
	// Just under the 1h prompt cache ("long" retention).
	context: { restAfterMinutes: 55, maxTokens: 40_000 },
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
