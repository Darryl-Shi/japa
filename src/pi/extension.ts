// The one unit. Everything beyond the core loop is an extension: memory, the computer and screen, the web, coding
// agents, approvals, messaging channels, model providers, machine providers, and whatever the user adds. An extension
// is made from the Host (everything it may use) and says what it gives the chief of staff and job agents, what it adds
// to /settings, which of its tools are safe, what it does when a slice ends, when it wakes the chief of staff by
// itself, and what runs while it's on. The core (the main thread, open items, the team) is not an extension and can't
// be turned off.
//
// What japa is built from has one typed adapter each, and every implementation goes through it, built-in or not: a
// channel is a Channel in `channel`, a model provider is a pi-ai Provider in `providers`, a machine is an OpenBackend
// in `backends`. The core registers them while the extension is on and unregisters them when it's off.
import type { Context } from "@earendil-works/chord";
import type { Models, MutableModels, Provider } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import type { Inbox } from "../channels/inbox.ts";
import type { Backend, OpenBackend } from "../core/backend.ts";
import type { HistoryHit } from "../core/history.ts";
import type { When } from "../core/schedule.ts";
import type { Card, CardRef, Holds, UI } from "../core/ui.ts";
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

/**
 * A messaging channel: the core's adapter for one. While its extension is on, the core opens it with the Inbox for
 * its platform and shows cards through it; when it's turned off, the core stops showing cards there and closes it.
 */
export interface Channel {
	/** Its allowlist is settings.allowlist[platform], and the CardRefs it makes carry it as their channel. */
	readonly platform: string;
	/**
	 * Start receiving. Each message goes to the inbox (which refuses anyone not on the allowlist); card presses, replies
	 * to a card's question, and slash commands go to the UI (press, reply, run), whose commands it may advertise.
	 */
	open(to: { inbox: Inbox; ui: UI }): void | Promise<void>;
	/** Render a card, or replace one already shown; only while open. */
	show(card: Card, replace?: CardRef): Promise<CardRef>;
	close(): void | Promise<void>;
}

/** Everything an extension may use. It never gets the main thread itself: messages come in only through a Channel. */
export type Host = {
	settings: SettingsFile;
	secrets: SecretsFile;
	/** Where an extension keeps its own files (the data directory; name them after the extension). */
	dataDir: string;
	/** The models pi can use. To add a provider, declare it in `providers`. */
	models: Models;
	/** The agent's computer: machines.workbench opened through its provider's backend. None when unset or unavailable. */
	workbench(): Backend | undefined;
	ui: UI;
	/**
	 * A new turn in a conversation: the chief of staff (addressed from `from`, e.g. the extension's name; its answer goes
	 * to the user threaded under `replyTo`) or a job agent (a new run of its job, seen through as usual). `id` makes it
	 * happen once.
	 */
	wake(conversationId: string, text: string, options: { replyTo?: CardRef; id: string; from: string }): Promise<void>;
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

export type JapaExtension = {
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
	/** Model providers it adds: registered while it's on, their models loaded with the credential from /login. */
	providers?: readonly Provider[];
	/** Machine providers it adds, by the name settings use (machines.workbench.provider). */
	backends?: Readonly<Record<string, OpenBackend>>;
	/** A messaging channel. The last one on can't be turned off. */
	channel?: Channel;
	/** While it's on: started when turned on (or at startup), stopped when turned off. */
	start?: () => void | Promise<void>;
	stop?: () => void | Promise<void>;
};

/** The installed extensions, which of them are on, and their lifecycles. */
export class ExtensionSet {
	private list: JapaExtension[];
	private readonly settings: SettingsFile;
	private readonly adapters: Adapters;
	private readonly running = new Set<string>();
	/** Channels that opened, so only those are shown on and closed. */
	private readonly open = new Set<Channel>();
	private readonly log: (line: string) => void;

	constructor(entries: readonly JapaExtension[], settings: SettingsFile, adapters: Adapters, log: (line: string) => void = (line) => console.log(line)) {
		this.list = [...entries];
		this.settings = settings;
		this.adapters = adapters;
		this.log = log;
	}

	get entries(): readonly JapaExtension[] {
		return this.list;
	}

	/** Add an extension, or replace the one with its name (stopped first; sync starts the new one). Returns the old one. */
	async put(entry: JapaExtension): Promise<JapaExtension | undefined> {
		const old = this.get(entry.name);
		if (old !== undefined) await this.remove(old.name);
		this.list = [...this.list, entry];
		return old;
	}

	/** Stop it if it's running and forget it. */
	async remove(name: string): Promise<void> {
		const entry = this.get(name);
		if (entry === undefined) return;
		if (this.running.delete(name)) await this.stop(entry);
		this.list = this.list.filter((other) => other !== entry);
	}

	enabled(entry: JapaExtension): boolean {
		return this.settings.get().extensions[entry.name]?.enabled ?? entry.enabledByDefault ?? true;
	}

	on(): JapaExtension[] {
		return this.entries.filter((entry) => this.enabled(entry));
	}

	get(name: string): JapaExtension | undefined {
		return this.entries.find((entry) => entry.name === name);
	}

	/** Why it can't be turned off, if it can't. */
	cannotTurnOff(entry: JapaExtension): string | undefined {
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

	/** The machine provider of that name, from the extensions that are on. */
	backend(name: string): OpenBackend | undefined {
		return this.on().find((entry) => entry.backends?.[name] !== undefined)?.backends?.[name];
	}

	/** Start what was turned on and stop what was turned off. */
	async sync(): Promise<void> {
		for (const entry of this.entries) {
			const on = this.enabled(entry);
			if (on && !this.running.has(entry.name)) {
				this.running.add(entry.name);
				await this.start(entry);
			} else if (!on && this.running.has(entry.name)) {
				this.running.delete(entry.name);
				await this.stop(entry);
			}
		}
	}

	async stopAll(): Promise<void> {
		for (const entry of this.entries) if (this.running.delete(entry.name)) await this.stop(entry);
	}

	private async start(entry: JapaExtension): Promise<void> {
		const { models, ui, inbox } = this.adapters;
		for (const provider of entry.providers ?? []) {
			models.setProvider(provider);
			// A provider that fetches its model list gets it now (with the credential from /login), not on first use.
			void models.refresh({ providers: [provider.id] }).then(
				(result) => result.errors.forEach((error, id) => this.log(`${entry.name}: models of ${id}: ${error.message}`)),
				(error: unknown) => this.log(`${entry.name}: models: ${String(error)}`),
			);
		}
		const channel = entry.channel;
		if (channel !== undefined) {
			try {
				await channel.open({ inbox: inbox(channel.platform), ui });
				this.open.add(channel);
				ui.attach({ channel: channel.platform, show: (card, replace) => channel.show(card, replace) });
			} catch (error) {
				this.log(`${entry.name}: open: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		await Promise.resolve()
			.then(() => entry.start?.())
			.catch((error: unknown) => this.log(`${entry.name}: start: ${String(error)}`));
	}

	private async stop(entry: JapaExtension): Promise<void> {
		await Promise.resolve()
			.then(() => entry.stop?.())
			.catch((error: unknown) => this.log(`${entry.name}: stop: ${String(error)}`));
		const channel = entry.channel;
		if (channel !== undefined && this.open.delete(channel)) {
			this.adapters.ui.detach(channel.platform);
			await Promise.resolve()
				.then(() => channel.close())
				.catch((error: unknown) => this.log(`${entry.name}: close: ${String(error)}`));
		}
		for (const provider of entry.providers ?? []) this.adapters.models.deleteProvider(provider.id);
	}
}

/** The core's side of the adapters: where providers are registered, channels shown, and messages let in. */
export type Adapters = { models: MutableModels; ui: UI; inbox(platform: string): Inbox };

const unique = (extensions: readonly Extension[]) => [...new Set(extensions)];
