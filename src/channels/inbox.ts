// The hard user whitelist. Every messaging channel, whichever extension provides it, reaches the agent
// only through an Inbox, and an Inbox refuses anyone not on the platform's list in settings.allowlist. An empty list
// lets no one in. The list lives only in data/settings.json: not in /settings, and no tool can change it, so neither
// a message nor the agent itself can widen it. Channels are extensions, and the Host gives them an Inbox, never the
// main thread.
import type { Context } from "@earendil-works/chord";
import type { CardRef } from "../core/ui.ts";
import type { Answer, Arrival, MainThread } from "../pi/harness.ts";
import type { SettingsFile } from "../settings.ts";

export class NotAllowed extends Error {}

export class Inbox {
	readonly platform: string;
	private readonly thread: () => MainThread;
	private readonly settings: SettingsFile;
	private readonly prepare: (context: Context) => Promise<void>;
	private readonly log: (line: string) => void;

	constructor(options: {
		platform: string;
		thread: () => MainThread;
		settings: SettingsFile;
		/** Before each new message: follow the settings (model, extensions turned on or off). */
		prepare?: (context: Context) => Promise<void>;
		log?: (line: string) => void;
	}) {
		this.platform = options.platform;
		this.thread = options.thread;
		this.settings = options.settings;
		this.prepare = options.prepare ?? (async () => {});
		this.log = options.log ?? ((line) => console.log(line));
	}

	/** Who may talk to the agent on this platform, as the platform's user ids. */
	allowed(): string[] {
		return (this.settings.get().allowlist[this.platform] ?? []).map(String);
	}

	/** The gate every incoming message, command and button press passes first. */
	admits(userId: string | number | undefined): boolean {
		const ok = userId !== undefined && this.allowed().includes(String(userId));
		if (!ok) this.log(`${this.platform}: refused user ${userId ?? "(unknown)"} (not on the allowlist)`);
		return ok;
	}

	/** Where the agent's own messages go on this platform: the first person on the list. */
	owner(): string | undefined {
		return this.allowed()[0];
	}

	/** A message from someone on the list; checked again here, so a channel can't skip the gate. */
	async ask(from: string | number, requestId: string, content: string, reply: CardRef, context: Context, arrival?: Arrival): Promise<Answer> {
		if (!this.allowed().includes(String(from))) throw new NotAllowed(`${this.platform} user ${from} is not on the allowlist`);
		await this.prepare(context);
		return this.thread().ask(requestId, content, reply, context, arrival);
	}

	/** Messages admitted before a restart whose answers were never delivered: this channel's, and any with no channel. */
	async pending(context: Context): ReturnType<MainThread["pending"]> {
		return (await this.thread().pending(context)).filter((pending) => (pending.channel || this.platform) === this.platform);
	}

	/** The answer to an admitted message (after a restart: no new admission, so no gate). */
	answer(requestId: string, content: string, context: Context): Promise<Answer> {
		return this.thread().answer(requestId, content, context);
	}

	delivered(requestId: string, context: Context): Promise<void> {
		return this.thread().delivered(requestId, context);
	}
}
