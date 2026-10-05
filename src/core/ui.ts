// What the agent shows the user outside the conversation itself: cards with buttons, questions answered by reply,
// and slash commands. Channel-neutral: an extension shows a card and handles its button presses and replies; a
// channel only renders cards (the core attaches it here as a Surface while it's on) and passes presses, replies and
// commands back here. Button data is
// "<owner>:<payload>", so each press or reply goes to the extension that made the card.

/** Where a card or message is in a channel: the channel's own ids, as strings (each channel has its own format). */
export type CardRef = { channel: string; chatId: string; messageId: string };
export type Button = { text: string; data: string };

export type Card = {
	text: string;
	buttons?: Button[][];
	/** Notify (default true); false arrives silently. */
	buzz?: boolean;
	/** Thread it under this message. */
	replyTo?: CardRef;
	/** The user answers by replying to the card; the reply goes to the card's owner, never to the agent. */
	ask?: { data: string; placeholder?: string; secret?: boolean };
};

/** A channel's side: render a card, or replace one already shown. */
export interface Surface {
	readonly channel: string;
	show(card: Card, replace?: CardRef): Promise<CardRef>;
}

export type CardHandler = {
	press?: (payload: string, ref: CardRef) => void | Promise<void>;
	reply?: (payload: string, text: string, ref: CardRef) => void | Promise<void>;
};

/** A slash command, as a channel advertises it (e.g. Telegram's command menu). */
export type Command = { name: string; description: string };

export class UI {
	private readonly surfaces = new Map<string, Surface>();
	private readonly handlers = new Map<string, CardHandler>();
	private readonly registered = new Map<string, Command & { run: (at: CardRef) => void | Promise<void> }>();
	private readonly listeners = new Set<() => void>();
	private readonly log: (line: string) => void;

	constructor(log: (line: string) => void = (line) => console.log(line)) {
		this.log = log;
	}

	attach(surface: Surface): void {
		this.surfaces.set(surface.channel, surface);
	}

	detach(channel: string): void {
		this.surfaces.delete(channel);
	}

	/** Cards whose button data starts with "<owner>:" are handled here. */
	handle(owner: string, handler: CardHandler): void {
		this.handlers.set(owner, handler);
	}

	/** A slash command a channel passes here instead of to the agent (e.g. /settings), and advertises. */
	command(name: string, description: string, run: (at: CardRef) => void | Promise<void>): void {
		this.registered.set(name, { name, description, run });
		for (const listener of this.listeners) listener();
	}

	/** Every registered command, for a channel to advertise. */
	commands(): Command[] {
		return [...this.registered.values()].map(({ name, description }) => ({ name, description }));
	}

	/** Called whenever a command is added; returns a function that stops listening. */
	onCommands(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Show a card on the channel it threads under or replaces, else the first one attached. Undefined: no channel. */
	async show(card: Card, replace?: CardRef): Promise<CardRef | undefined> {
		const channel = replace?.channel ?? card.replyTo?.channel;
		const surface = (channel === undefined ? undefined : this.surfaces.get(channel)) ?? this.surfaces.values().next().value;
		return surface?.show(card, replace);
	}

	async press(data: string, ref: CardRef): Promise<void> {
		const [owner, payload] = split(data);
		const handler = this.handlers.get(owner)?.press;
		if (handler === undefined) return this.log(`ui: no handler for ${owner}`);
		await handler(payload, ref);
	}

	async reply(data: string, text: string, ref: CardRef): Promise<void> {
		const [owner, payload] = split(data);
		await this.handlers.get(owner)?.reply?.(payload, text, ref);
	}

	/** Run a command if one is registered under that name; false means it's an ordinary message. */
	async run(name: string, at: CardRef): Promise<boolean> {
		const command = this.registered.get(name);
		if (command === undefined) return false;
		await command.run(at);
		return true;
	}
}

const split = (data: string): [string, string] => {
	const at = data.indexOf(":");
	return at === -1 ? [data, ""] : [data.slice(0, at), data.slice(at + 1)];
};

/** Conversations paused on the user (an approval, a question): a job agent that's held isn't reported as gone quiet. */
export class Holds {
	private readonly held = new Map<string, Set<string>>();

	add(conversationId: string, reason: string): void {
		const reasons = this.held.get(conversationId) ?? new Set<string>();
		reasons.add(reason);
		this.held.set(conversationId, reasons);
	}

	remove(conversationId: string, reason: string): void {
		this.held.get(conversationId)?.delete(reason);
		if (this.held.get(conversationId)?.size === 0) this.held.delete(conversationId);
	}

	has(conversationId: string): boolean {
		return this.held.has(conversationId);
	}
}
