// Live settings: data/settings.json, re-read whenever the file changes. Secrets never live here: every login's
// credentials (model providers' and accounts', a channel's token among them) are in auth.json, in the same directory.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A model slot: the model, and how hard it thinks (one of pi's thinking levels, as the model supports; default off). */
export type ModelChoice = { provider: string; modelId: string; thinking?: string };

export type Settings = {
	/**
	 * The chief of staff: judgment and synthesis, kept fast by small contexts rather than a small model. No default:
	 * it's one of the models the user has logged in to (/login), chosen with /model.
	 */
	model?: ModelChoice;
	/** A job's model when the chief of staff doesn't pick one; default: the chief of staff's. */
	delegateModel?: ModelChoice;
	/** Named models the chief of staff can assign to a job (bound to that job and its subagents). */
	jobModels: Record<string, ModelChoice>;
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
	 * The main thread is one chat, but the model works in short slices of it. A new slice starts (decided when
	 * the next message from the user arrives) after idleMinutes without one, when the next request would pass
	 * sliceTokens, on /new, or on a reply to a message from an earlier slice. A slice starts from state — open items,
	 * the working set, the last few visible messages — not from a summary of history.
	 */
	context: { idleMinutes: number; sliceTokens: number };
	/** Per extension, by name: `enabled`, and its own settings (the flags it registers, on its page in /settings). */
	extensions: Record<string, ExtensionOptions>;
};

export type ExtensionOptions = { enabled?: boolean; [option: string]: unknown };

export const DEFAULTS: Settings = {
	jobModels: {},
	allowlist: {},
	context: { idleMinutes: 10, sliceTokens: 8000 },
	extensions: {},
};

/** What the file says, over the defaults (a partial `context` keeps the other defaults). */
function read(path: string): Settings {
	const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
	return { ...DEFAULTS, ...saved, context: { ...DEFAULTS.context, ...saved.context } };
}

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
			this.cached = read(this.path);
			this.mtimeMs = mtimeMs;
		}
		return this.cached;
	}

	setOption(name: string, key: string, value: unknown): void {
		const extensions = this.get().extensions;
		this.update({ extensions: { ...extensions, [name]: { ...extensions[name], [key]: value } } });
	}

	update(change: Partial<Settings>): Settings {
		const next = { ...this.get(), ...change };
		writeFileSync(this.path, `${JSON.stringify(next, null, "\t")}\n`);
		// Writes can land within the file system's mtime resolution, so read back what was written rather than trust it.
		this.cached = read(this.path);
		this.mtimeMs = statSync(this.path).mtimeMs;
		return this.cached;
	}
}
