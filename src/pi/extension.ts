// The one unit. Everything beyond the core loop is an extension: memory, the computer and screen, the web, coding
// agents, approvals, messaging channels, and later email, calendar, skills and behaviours. An extension is made from
// the Host (everything it may use) and says what it gives the chief of staff and job agents, what it adds to
// /settings, which of its tools are safe, what it does when a slice ends, when it wakes the chief of staff by itself,
// and what runs while it's on. The only other configured abstraction is the backend (which computer): infrastructure,
// not a capability. The core (the main thread, open items, the team) is not an extension and can't be turned off.
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import type { Inbox } from "../channels/inbox.ts";
import type { Backend } from "../core/backend.ts";
import type { HistoryHit } from "../core/history.ts";
import type { When } from "../core/schedule.ts";
import type { CardRef, Holds, UI } from "../core/ui.ts";
import type { SecretsFile } from "../credentials.ts";
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

/** What a slice of the main conversation was, handed to extensions when it ends. */
export type SliceEnd = { conversation: string; openItems: string | undefined; today: string };

/**
 * A reason to wake the chief of staff by itself: on a schedule (`every`, or `at` a local time) or on an event another
 * extension emits. The prompt arrives as a message starting "[Trigger"; the chief of staff decides what, if anything,
 * the user hears.
 */
export type Trigger = { name: string; when: When; prompt: string };

/** Everything an extension may use. It never gets the main thread itself: messages come in only through an Inbox. */
export type Host = {
	settings: SettingsFile;
	secrets: SecretsFile;
	models: Models;
	/** The agent's computer, when one is configured. */
	workbench: Backend | undefined;
	ui: UI;
	/** The only way a channel reaches the agent; refuses anyone not on that platform's allowlist. */
	inbox(platform: string): Inbox;
	/**
	 * A new turn in a conversation: the chief of staff (as if from the user; its answer is shown threaded under
	 * `replyTo`) or a job agent (a new run of its job, seen through as usual). `id` makes it happen once.
	 */
	wake(conversationId: string, text: string, options: { replyTo?: CardRef; id: string }): Promise<void>;
	/** The chief of staff's conversation. */
	chiefId(): string;
	/** Full-text search over the main conversation's whole record (the core keeps it). */
	searchHistory(query: string, context: Context): Promise<HistoryHit[]>;
	/** Conversations paused on the user. */
	holds: Holds;
	/** Fire the event triggers listening for `event`. */
	emit(event: string, detail?: string): void;
	/** Tools that never need approval (every extension's safeTools, and the core's). */
	safeTools(): ReadonlySet<string>;
	log(line: string): void;
};

export type JarvisExtension = {
	/** Its key in settings.extensions. */
	name: string;
	title: string;
	about: string;
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
	/** When a slice of the main conversation ends (in the background; the user never waits for it). */
	onSliceEnd?: (slice: SliceEnd) => Promise<void>;
	triggers?: readonly Trigger[];
	/** A messaging channel for this platform (its allowlist is settings.allowlist[platform]). The last one can't be turned off. */
	channel?: string;
	/** While it's on: started when turned on (or at startup), stopped when turned off. */
	start?: () => void | Promise<void>;
	stop?: () => void | Promise<void>;
};

/** The installed extensions, which of them are on, and their lifecycles. */
export class ExtensionSet {
	readonly entries: readonly JarvisExtension[];
	private readonly settings: SettingsFile;
	private readonly running = new Set<string>();
	private readonly log: (line: string) => void;

	constructor(entries: readonly JarvisExtension[], settings: SettingsFile, log: (line: string) => void = (line) => console.log(line)) {
		this.entries = entries;
		this.settings = settings;
		this.log = log;
	}

	enabled(entry: JarvisExtension): boolean {
		return this.settings.get().extensions[entry.name]?.enabled ?? entry.enabledByDefault ?? true;
	}

	on(): JarvisExtension[] {
		return this.entries.filter((entry) => this.enabled(entry));
	}

	get(name: string): JarvisExtension | undefined {
		return this.entries.find((entry) => entry.name === name);
	}

	/** Why it can't be turned off, if it can't. */
	cannotTurnOff(entry: JarvisExtension): string | undefined {
		if (entry.channel === undefined || !this.enabled(entry)) return undefined;
		return this.on().some((other) => other !== entry && other.channel !== undefined) ? undefined : "It's the only channel you can reach me on.";
	}

	/** Every Pi extension, once each, for the registry. */
	installed(): Extension[] {
		return unique(this.entries.flatMap((entry) => [...(entry.chief ?? []), ...(entry.jobs ?? [])]));
	}

	forChief(): Extension[] {
		return unique(this.on().flatMap((entry) => entry.chief ?? []));
	}

	/** What a new job agent must not have: whatever isn't on for jobs right now. */
	withheldFromJobs(): Extension[] {
		const jobs = new Set(this.on().flatMap((entry) => entry.jobs ?? []));
		return this.installed().filter((extension) => !jobs.has(extension));
	}

	safeTools(): string[] {
		return this.entries.flatMap((entry) => entry.safeTools ?? []);
	}

	/** Triggers of the extensions that are on, keyed "<extension>/<trigger>". */
	triggers(): Map<string, Trigger> {
		return new Map(this.on().flatMap((entry) => (entry.triggers ?? []).map((trigger) => [`${entry.name}/${trigger.name}`, trigger] as const)));
	}

	async sliceEnded(slice: SliceEnd): Promise<void> {
		await Promise.all(this.on().map((entry) => entry.onSliceEnd?.(slice).catch((error: unknown) => this.log(`${entry.name}: slice end: ${String(error)}`))));
	}

	/** Start what was turned on and stop what was turned off. */
	async sync(): Promise<void> {
		for (const entry of this.entries) {
			const on = this.enabled(entry);
			if (on && !this.running.has(entry.name)) {
				this.running.add(entry.name);
				await Promise.resolve()
					.then(() => entry.start?.())
					.catch((error: unknown) => this.log(`${entry.name}: start: ${String(error)}`));
			} else if (!on && this.running.has(entry.name)) {
				this.running.delete(entry.name);
				await Promise.resolve()
					.then(() => entry.stop?.())
					.catch((error: unknown) => this.log(`${entry.name}: stop: ${String(error)}`));
			}
		}
	}

	async stopAll(): Promise<void> {
		for (const entry of this.entries) {
			if (!this.running.delete(entry.name)) continue;
			await Promise.resolve()
				.then(() => entry.stop?.())
				.catch(() => {});
		}
	}
}

const unique = (extensions: readonly Extension[]) => [...new Set(extensions)];
