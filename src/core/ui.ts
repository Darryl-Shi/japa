// What the agent shows the user outside the conversation itself: cards with buttons, questions answered by reply,
// and slash commands. Channel-neutral: the core's commands show cards and handle their presses and replies, and an
// extension uses pi's dialogs (`dialogs()`: select, confirm, input, notify), drawn here as cards. A channel only
// renders cards (the core attaches it here as a Surface while it's on) and passes presses, replies and commands back
// here. Button data is "<owner>:<payload>", so each press or reply goes to whoever made the card.

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
	/** `ref`: the user's reply; `asked`: the card it answers. */
	reply?: (payload: string, text: string, ref: CardRef, asked: CardRef) => void | Promise<void>;
};

/** A slash command, as a channel advertises it (e.g. Telegram's command menu). */
export type Command = { name: string; description: string };

/**
 * pi's dialogs (its ExtensionUIContext), on whichever channel is on. One dialog is one card, updated in place from
 * one call to the next; `notify` ends it, and an `input` is its own question, answered by reply.
 */
export type Dialogs = {
	/** One of `options`, or undefined if it's no longer waiting. */
	select(title: string, options: readonly string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	/** A typed answer; `secret`: the user's message is deleted once read. */
	input(title: string, placeholder?: string, options?: { secret?: boolean }): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
};

export class UI {
	private readonly surfaces = new Map<string, Surface>();
	private readonly handlers = new Map<string, CardHandler>();
	private readonly registered = new Map<string, Command & { run: (at: CardRef, args: string) => void | Promise<void> }>();
	/** Dialogs waiting on the user, by id. */
	private readonly waiting = new Map<string, { options?: readonly string[]; title: string; resolve: (value: string | undefined) => void }>();
	private next = 0;
	private readonly listeners = new Set<() => void>();
	private readonly log: (line: string) => void;

	constructor(log: (line: string) => void = (line) => console.log(line)) {
		this.log = log;
		this.handle("dialog", {
			press: async (payload, ref) => {
				const [id = "", index] = payload.split(":");
				const dialog = this.waiting.get(id);
				const choice = dialog?.options?.[Number(index)];
				if (dialog === undefined || choice === undefined) return void (await this.show({ text: "That's no longer waiting." }, ref));
				this.waiting.delete(id);
				await this.show({ text: `${dialog.title}\n✓ ${choice}` }, ref);
				dialog.resolve(choice);
			},
			reply: async (payload, text, ref) => {
				const dialog = this.waiting.get(payload);
				if (dialog === undefined) return void (await this.show({ text: "That's no longer waiting.", replyTo: ref }));
				this.waiting.delete(payload);
				dialog.resolve(text);
			},
		});
	}

	/** pi's dialogs, threaded under `at` (a command's message) when given. */
	dialogs(at?: CardRef): Dialogs {
		let card: CardRef | undefined;
		const ask = (title: string, options: readonly string[]) =>
			new Promise<string | undefined>((resolve) => {
				const id = String(this.next++);
				this.waiting.set(id, { title, options, resolve });
				void this.show({ text: title, buttons: options.map((option, index) => [{ text: option, data: `dialog:${id}:${index}` }]), ...(at === undefined ? {} : { replyTo: at }) }, card)
					.then((ref) => void (card = ref))
					.catch((error: unknown) => this.log(`ui: ${String(error)}`));
			});
		return {
			select: (title, options) => ask(title, options),
			confirm: async (title, message) => (await ask(`${title}\n\n${message}`, ["Yes", "No"])) === "Yes",
			input: (title, placeholder, options) =>
				new Promise<string | undefined>((resolve) => {
					const id = String(this.next++);
					this.waiting.set(id, { title, resolve });
					card = undefined;
					void this.show({ text: title, ask: { data: `dialog:${id}`, ...(placeholder === undefined ? {} : { placeholder }), secret: options?.secret === true }, ...(at === undefined ? {} : { replyTo: at }) }).catch((error: unknown) =>
						this.log(`ui: ${String(error)}`),
					);
				}),
			notify: (message) => {
				const replace = card;
				card = undefined;
				void this.show({ text: message, ...(replace !== undefined || at === undefined ? {} : { replyTo: at }) }, replace).catch((error: unknown) => this.log(`ui: ${String(error)}`));
			},
		};
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

	/** A slash command a channel passes here instead of to the agent (e.g. /settings), with what follows it, and advertises. */
	command(name: string, description: string, run: (at: CardRef, args: string) => void | Promise<void>): void {
		this.registered.set(name, { name, description, run });
		for (const listener of this.listeners) listener();
	}

	/** Stop offering a command (its extension was turned off). */
	removeCommand(name: string): void {
		if (this.registered.delete(name)) for (const listener of this.listeners) listener();
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

	async reply(data: string, text: string, ref: CardRef, asked: CardRef): Promise<void> {
		const [owner, payload] = split(data);
		await this.handlers.get(owner)?.reply?.(payload, text, ref, asked);
	}

	/** Run a command if one is registered under that name; false means it's an ordinary message. */
	async run(name: string, at: CardRef, args = ""): Promise<boolean> {
		const command = this.registered.get(name);
		if (command === undefined) return false;
		await command.run(at, args.trim());
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

	/** A message came for it: it's no longer waiting. */
	release(conversationId: string): void {
		this.held.delete(conversationId);
	}

	has(conversationId: string): boolean {
		return this.held.has(conversationId);
	}
}
