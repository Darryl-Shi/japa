// Live settings: data/settings.json, re-read whenever the file changes. Secrets never live here: model credentials
// are in data/auth.json, extension secrets in data/secrets.json, the bot token in the environment.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ModelChoice = { provider: string; modelId: string };
/** `screen: true` gives the agent the computer tool on that machine's display. Other options go to the provider. */
export type MachineConfig = { provider: string; screen?: boolean; [option: string]: unknown };

export type Settings = {
	/** The chief of staff: judgment and synthesis, kept fast by small contexts rather than a small model. */
	model: ModelChoice;
	/** A job's model when the chief of staff doesn't pick one. */
	delegateModel: ModelChoice;
	/** Named models the chief of staff can assign to a job (bound to that job and its subagents). */
	jobModels: Record<string, ModelChoice>;
	/**
	 * The computers the agent works on, by role, each backed by a provider (built in: "boat", "local"; extensions can
	 * add more). workbench: its own machine for shell, files, scripts and coding agents — no secrets. desk (later):
	 * a machine with a screen and the user's logged-in browser. A role with no entry is not available.
	 */
	machines: { workbench?: MachineConfig; desk?: MachineConfig };
	/** Who the agent works for. Optional; the agent also learns about them in memory. */
	user?: { name?: string };
	/**
	 * The hard user whitelist: per messaging platform, the user ids that may talk to the agent. Everyone else is
	 * refused before anything runs; an empty list lets no one in. The first id is where the agent's own messages go.
	 * Edited only here (not in /settings, and no tool can change it).
	 */
	allowlist: Record<string, Array<string | number>>;
	/** IANA zone for the time stamped on each message; default: the machine's. */
	timezone?: string;
	/**
	 * The main thread is one Telegram DM, but the model works in short slices of it. A new slice starts (decided when
	 * the next message from the user arrives) after idleMinutes without one, when the next request would pass
	 * sliceTokens, on /new, or on a reply to a message from an earlier slice. A slice starts from state — open items,
	 * the working set, the last few visible messages — not from a summary of history.
	 */
	context: { idleMinutes: number; sliceTokens: number };
	/** Per extension, by name: `enabled` and the extension's own options (see each extension's settings fields). */
	extensions: Record<string, ExtensionOptions>;
};

export type ExtensionOptions = { enabled?: boolean; [option: string]: unknown };

export const DEFAULTS: Settings = {
	model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
	delegateModel: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
	jobModels: {
		fast: { provider: "anthropic", modelId: "claude-haiku-4-5" },
		strong: { provider: "anthropic", modelId: "claude-opus-5-5" },
	},
	machines: {},
	allowlist: {},
	context: { idleMinutes: 10, sliceTokens: 8000 },
	extensions: {},
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

	/** An extension's options: its defaults, overridden by what settings say. */
	options<T extends Record<string, unknown>>(name: string, defaults: T): T & ExtensionOptions {
		return { ...defaults, ...this.get().extensions[name] };
	}

	setOption(name: string, key: string, value: unknown): void {
		const extensions = this.get().extensions;
		this.update({ extensions: { ...extensions, [name]: { ...extensions[name], [key]: value } } });
	}

	update(change: Partial<Settings>): Settings {
		const next = { ...this.get(), ...change };
		writeFileSync(this.path, `${JSON.stringify(next, null, "\t")}\n`);
		// Writes can land within the file system's mtime resolution, so read back what was written rather than trust it.
		this.cached = { ...DEFAULTS, ...(JSON.parse(readFileSync(this.path, "utf8")) as Partial<Settings>) };
		this.mtimeMs = statSync(this.path).mtimeMs;
		return this.cached;
	}
}
