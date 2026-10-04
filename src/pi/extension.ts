// The one unit. Everything the agent can do or know beyond its core loop (memory, its team, its computer, the web,
// coding agents, approvals, and later email, calendar, skills and behaviours) is an extension entry: what it gives
// the chief of staff, what it gives job agents, and the settings it adds to /settings. The only other configured
// abstraction is the backend (which computer), because a machine is infrastructure, not a capability.
import type { Extension } from "@earendil-works/pi-durable";
import type { SettingsFile } from "../settings.ts";

/** One setting an extension shows in /settings. Values live in settings.json, secrets in data/secrets.json. */
export type Field =
	| { key: string; label: string; kind: "toggle" }
	| { key: string; label: string; kind: "choice"; options: readonly string[] }
	| { key: string; label: string; kind: "text" | "number" }
	/** A model as "provider/modelId". */
	| { key: string; label: string; kind: "model" }
	/** A list the user can remove items from (e.g. standing permissions). */
	| { key: string; label: string; kind: "list" }
	/** Stored in data/secrets.json as "<extension>.<key>"; `env` is the fallback. */
	| { key: string; label: string; kind: "secret"; env?: string };

export type JarvisExtension = {
	/** Its key in settings.extensions. */
	name: string;
	title: string;
	about: string;
	/** The agent doesn't work without it, so /settings shows no off switch. */
	required?: boolean;
	/** On unless settings say otherwise (default true). */
	enabledByDefault?: boolean;
	settings?: readonly Field[];
	/** Values of its settings when settings.json says nothing. */
	defaults?: Readonly<Record<string, unknown>>;
	/** Tools that only read or only touch the agent's own state; approvals never stop them. */
	safeTools?: readonly string[];
	/** What the chief of staff gets. */
	chief?: readonly Extension[];
	/** What a job agent (and its subagents) gets. */
	jobs?: readonly Extension[];
};

/** The installed extensions, and which of them are on right now. */
export class ExtensionSet {
	readonly entries: readonly JarvisExtension[];
	private readonly settings: SettingsFile;

	constructor(entries: readonly JarvisExtension[], settings: SettingsFile) {
		this.entries = entries;
		this.settings = settings;
	}

	enabled(entry: JarvisExtension): boolean {
		return entry.required === true || (this.settings.get().extensions[entry.name]?.enabled ?? entry.enabledByDefault ?? true);
	}

	get(name: string): JarvisExtension | undefined {
		return this.entries.find((entry) => entry.name === name);
	}

	/** Every Pi extension, once each, for the registry. */
	installed(): Extension[] {
		return unique(this.entries.flatMap((entry) => [...(entry.chief ?? []), ...(entry.jobs ?? [])]));
	}

	forChief(): Extension[] {
		return unique(this.entries.filter((entry) => this.enabled(entry)).flatMap((entry) => entry.chief ?? []));
	}

	/** What a new job agent must not have: whatever isn't on for jobs right now. */
	withheldFromJobs(): Extension[] {
		const jobs = new Set(this.entries.filter((entry) => this.enabled(entry)).flatMap((entry) => entry.jobs ?? []));
		return this.installed().filter((extension) => !jobs.has(extension));
	}

	safeTools(): Set<string> {
		return new Set(this.entries.flatMap((entry) => entry.safeTools ?? []));
	}
}

const unique = (extensions: readonly Extension[]) => [...new Set(extensions)];
