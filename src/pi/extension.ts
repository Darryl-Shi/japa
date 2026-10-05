// An extension is what it is in pi: a module whose default export is a factory given `pi` (pi's ExtensionAPI), on
// which it registers what it adds (tools, commands, model providers) and handles events (pi's session_start,
// session_shutdown, before_agent_start, tool_call, resources_discover). The names and meanings are pi's, so pi's own
// docs apply; japa implements them on Pi Durable, and anything pi's API can express needs nothing new here.
//
// Where japa is built from something pi isn't, it's in the same API: a messaging channel (registerChannel), the end
// of an exchange with the user (the exchange_end event), more than one agent (ctx.agent, and sendUserMessage's `to`),
// and keys that aren't model credentials (secrets). Everything else beyond the core is an extension; the core (the
// main thread, open items, the team, the computer) is not, and can't be turned off.
import type { Context } from "@earendil-works/chord";
import type { ImageContent, Models, MutableModels, Provider, Static, TextContent, TSchema, Usage } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, hook, section, ToolTask } from "@earendil-works/pi-durable";
import type { Inbox } from "../channels/inbox.ts";
import type { Card, CardRef, Dialogs, UI } from "../core/ui.ts";
import type { SecretsFile } from "../credentials.ts";
import type { Settings, SettingsFile } from "../settings.ts";

/** pi's tool annotations (MCP's hints): what a tool does, for whoever decides which calls need a look first. */
export type ToolAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };

export type ToolResult = { content: (TextContent | ImageContent)[]; isError?: boolean; usage?: Usage };

/** pi's ToolDefinition: what the model sees, and execute. Throwing makes an error result. */
export type ToolDefinition<P extends TSchema = TSchema> = {
	name: string;
	label?: string;
	description: string;
	parameters: P;
	annotations?: ToolAnnotations;
	execute(toolCallId: string, params: Static<P>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<ToolResult>;
};

/** pi's ExecOptions and ExecResult. */
export type ExecOptions = { signal?: AbortSignal; timeout?: number; cwd?: string };
export type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };

/** A tool any agent may have, as `getAllTools` lists it. */
export type ToolInfo = { name: string; description: string; annotations?: ToolAnnotations };

/** pi's ExtensionContext, as far as japa has it. */
export type ExtensionContext = {
	/** The agent's home: where its commands start. */
	cwd: string;
	/** Dialogs with the user, on whichever channel is on (threaded under a command's message). */
	ui: Dialogs;
	/** The models pi can use: the providers logged in to with /login. */
	modelRegistry: Models;
	signal: AbortSignal | undefined;
	/** japa: in an agent's turn, which agent: the chief of staff, or a job agent (or its subagent). */
	agent?: "chief" | "job";
	/** japa: that agent's conversation, for sendUserMessage's `to`. */
	conversationId?: string;
};

/**
 * An exchange with the user that just ended (they went quiet, started a new topic, or went back to an earlier one):
 * what was said, across however many slices it took.
 */
export type ExchangeEnd = { conversation: string; openItems: string | undefined; today: string };

/** pi's ToolCallEventResult. `terminate`: the agent ends its turn, and waits for a message (sendUserMessage `to` it). */
export type ToolCallEventResult = { block?: boolean; reason?: string; terminate?: boolean };

/** The events, each with what its handlers return. */
export type ExtensionEvents = {
	/** It's on: at startup, or when turned on. Start long-lived things here, not in the factory. */
	session_start: [{ type: "session_start" }, void];
	/** It's off: turned off, or japa is stopping. */
	session_shutdown: [{ type: "session_shutdown" }, void];
	/** Before each model request: add to `systemPromptOptions.sections` (key: text). */
	before_agent_start: [{ type: "before_agent_start"; systemPromptOptions: { sections: Record<string, string> } }, void];
	/** Before a tool runs: block it, or let it through. */
	tool_call: [{ type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown> }, ToolCallEventResult | void];
	/** Where its skills are (directories with a SKILL.md, pi's format). */
	resources_discover: [{ type: "resources_discover" }, { skillPaths?: string[] } | void];
	/** japa: an exchange with the user ended (in the background; the user never waits for it). */
	exchange_end: [{ type: "exchange_end" } & ExchangeEnd, void];
};

type Handler<E extends keyof ExtensionEvents> = (event: ExtensionEvents[E][0], ctx: ExtensionContext) => ExtensionEvents[E][1] | Promise<ExtensionEvents[E][1]>;

/** pi's event bus between extensions (`pi.events`). */
export class EventBus {
	private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

	on(name: string, handler: (data: unknown) => void): () => void {
		const set = this.handlers.get(name) ?? new Set();
		set.add(handler);
		this.handlers.set(name, set);
		return () => set.delete(handler);
	}

	emit(name: string, data?: unknown): void {
		for (const handler of this.handlers.get(name) ?? []) handler(data);
	}
}

/**
 * A messaging channel. While its extension is on, the core opens it with the Inbox for its platform and shows cards
 * through it; when it's turned off, the core stops showing cards there and closes it.
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

/** pi's ExtensionAPI, as japa has it. */
export interface ExtensionAPI {
	on<E extends keyof ExtensionEvents>(event: E, handler: Handler<E>): void;
	registerTool<P extends TSchema>(tool: ToolDefinition<P>): void;
	registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: ExtensionContext) => void | Promise<void> }): void;
	/** A pi-ai Provider: on the core's Models while the extension is on; its credential through /login. */
	registerProvider(provider: Provider): void;
	unregisterProvider(name: string): void;
	/** A message to the chief of staff (or, with `to`, to that agent's conversation), as if the user had sent it. */
	sendUserMessage(content: string, options?: { to?: string }): void;
	/** Run a command on the agent's computer (from its home, without japa's keys in its environment). */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
	/** japa's settings (settings.json), live; an extension's own options are under `extensions[<its name>]`. */
	getSettings(): Settings;
	getAllTools(): ToolInfo[];
	events: EventBus;
	/** japa: a messaging channel. */
	registerChannel(channel: Channel): void;
	/** japa: where its own files go (the data directory; name them after the extension). */
	readonly dataDir: string;
	/**
	 * japa: its keys, in secrets.json as "<its name>.<key>", never in settings.json or a command's environment. `env`
	 * is the environment variable to fall back on (taken out of the environment japa's commands run in).
	 */
	readonly secrets: { get(key: string, env?: string): string | undefined; set(key: string, value: string | undefined): void };
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

/** What the core gives every extension, and does for it. */
export type Runtime = {
	ui: UI;
	models: MutableModels;
	settings: SettingsFile;
	secrets: SecretsFile;
	dataDir: string;
	home: string;
	events: EventBus;
	chiefId(): string;
	/** A message to a conversation (default: the chief of staff), once. */
	send(text: string, options: { to?: string; from: string }): void;
	/** A conversation waiting on the user until a message is sent to it. */
	hold(conversationId: string, reason: string): void;
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
	tools(): ToolInfo[];
	/** An environment variable holding a key, to keep out of commands' environment. */
	keyEnv(name: string): void;
	log(line: string): void;
};

const text = (value: string) => [{ type: "text" as const, text: value }];
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** An extension, loaded: what its factory registered, and the Pi Durable extension that's selected for agents. */
export class Loaded {
	readonly name: string;
	readonly tools: ToolDefinition[] = [];
	readonly commands = new Map<string, { description?: string; handler: (args: string, ctx: ExtensionContext) => void | Promise<void> }>();
	readonly providers = new Map<string, Provider>();
	channel: Channel | undefined;
	durable!: Extension;
	running = false;
	private readonly handlers = new Map<keyof ExtensionEvents, Handler<never>[]>();
	private readonly runtime: Runtime;

	constructor(name: string, runtime: Runtime) {
		this.name = name;
		this.runtime = runtime;
	}

	/** A context for a handler: in an agent's turn (`conversationId`), or a command's (`at`). */
	context(options: { conversationId?: string; signal?: AbortSignal; at?: CardRef } = {}): ExtensionContext {
		const { runtime } = this;
		return {
			cwd: runtime.home,
			ui: runtime.ui.dialogs(options.at),
			modelRegistry: runtime.models,
			signal: options.signal,
			...(options.conversationId === undefined ? {} : { conversationId: options.conversationId, agent: options.conversationId === runtime.chiefId() ? ("chief" as const) : ("job" as const) }),
		};
	}

	has(event: keyof ExtensionEvents): boolean {
		return (this.handlers.get(event)?.length ?? 0) > 0;
	}

	/**
	 * Run its handlers for `event`, in order; what each returned. A handler's failure is logged and skipped, except where
	 * it means something: a tool_call handler's blocks the call (as in pi), a session_start handler's is a problem the
	 * chief of staff hears.
	 */
	async emit<E extends keyof ExtensionEvents>(event: E, payload: ExtensionEvents[E][0], ctx: ExtensionContext): Promise<ExtensionEvents[E][1][]> {
		const results: ExtensionEvents[E][1][] = [];
		for (const handler of (this.handlers.get(event) ?? []) as unknown as Handler<E>[]) {
			try {
				results.push(await handler(payload, ctx));
			} catch (error) {
				if (event === "tool_call" || event === "session_start") throw error;
				this.runtime.log(`${this.name}: ${event}: ${message(error)}`);
			}
		}
		return results;
	}

	api(): ExtensionAPI {
		const { runtime } = this;
		return {
			on: (event, handler) => {
				const list = this.handlers.get(event) ?? [];
				list.push(handler as unknown as Handler<never>);
				this.handlers.set(event, list);
			},
			registerTool: (tool) => void this.tools.push(tool as unknown as ToolDefinition),
			registerCommand: (name, options) => {
				this.commands.set(name, options);
				if (this.running) this.offer(name);
			},
			registerProvider: (provider) => {
				this.providers.set(provider.id, provider);
				if (this.running) runtime.models.setProvider(provider);
			},
			unregisterProvider: (name) => {
				if (this.providers.delete(name) && this.running) runtime.models.deleteProvider(name);
			},
			sendUserMessage: (content, options) => runtime.send(content, { ...(options?.to === undefined ? {} : { to: options.to }), from: this.name }),
			exec: (command, args, options) => runtime.exec(command, args, options),
			getSettings: () => runtime.settings.get(),
			getAllTools: () => runtime.tools(),
			events: runtime.events,
			registerChannel: (channel) => void (this.channel = channel),
			dataDir: runtime.dataDir,
			secrets: {
				get: (key, env) => {
					if (env !== undefined) runtime.keyEnv(env);
					return runtime.secrets.get(`${this.name}.${key}`, env);
				},
				set: (key, value) => runtime.secrets.set(`${this.name}.${key}`, value),
			},
		};
	}

	/** What agents get of it, on Pi Durable: its tools, its sections (before_agent_start), its tool_call handlers. */
	build(): void {
		const tools = this.tools.map((tool) =>
			defineTool({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				replay: tool.annotations?.readOnlyHint === true ? "safe" : "unsafe",
				execute: async (args, api, context: Context) => {
					try {
						const result = await tool.execute(api.callId, args, context.abortSignal, undefined, this.context({ conversationId: String(api.conversationId), signal: context.abortSignal }));
						return { content: result.content, ...(result.isError === true ? { isError: true } : {}), ...(result.usage === undefined ? {} : { usage: result.usage }) };
					} catch (error) {
						return { content: text(message(error)), isError: true };
					}
				},
			}),
		);
		const sections = this.has("before_agent_start")
			? [
					section(
						this.name,
						async (input) => {
							const options = { sections: {} as Record<string, string> };
							await this.emit("before_agent_start", { type: "before_agent_start", systemPromptOptions: options }, this.context({ conversationId: String(input.conversationId) }));
							const shown = Object.entries(options.sections).filter(([, value]) => value.trim() !== "");
							return shown.length === 0 ? undefined : shown.map(([key, value]) => `<${key}>\n${value}\n</${key}>`).join("\n\n");
						},
						{ tag: false },
					),
				]
			: [];
		const hooks = this.has("tool_call")
			? [
					hook(ToolTask, {
						beforeTool: async (call, api) => {
							const conversationId = String(api.conversationId);
							const results = await this.emit("tool_call", { type: "tool_call", toolCallId: call.id, toolName: call.name, input: call.arguments }, this.context({ conversationId }));
							const blocked = results.find((result) => result?.block === true);
							if (blocked === undefined || blocked === null) return undefined;
							if (blocked.terminate === true) this.runtime.hold(conversationId, call.id);
							return { block: blocked.reason ?? `${call.name} was blocked` };
						},
					}),
				]
			: [];
		this.durable = defineExtension({ name: this.name, tools, sections, hooks });
	}

	/** Offer one of its commands on the UI. */
	private offer(name: string): void {
		const command = this.commands.get(name);
		if (command === undefined) return;
		this.runtime.ui.command(name, command.description ?? name, (at, args) => command.handler(args, this.context({ at })));
	}

	/** It's on: its providers on Models, its commands offered, then session_start. */
	async start(): Promise<void> {
		this.running = true;
		for (const provider of this.providers.values()) this.runtime.models.setProvider(provider);
		for (const name of this.commands.keys()) this.offer(name);
		await this.emit("session_start", { type: "session_start" }, this.context());
	}

	async stop(): Promise<void> {
		this.running = false;
		await this.emit("session_shutdown", { type: "session_shutdown" }, this.context());
		for (const name of this.commands.keys()) this.runtime.ui.removeCommand(name);
		for (const name of this.providers.keys()) this.runtime.models.deleteProvider(name);
	}
}

/** Run an extension's factory and make what agents get of it. */
export async function loadExtension(name: string, factory: ExtensionFactory, runtime: Runtime): Promise<Loaded> {
	const loaded = new Loaded(name, runtime);
	const returned = (await factory(loaded.api())) as unknown;
	if (returned !== undefined) throw new Error("it's written in an older shape (a factory returning an extension); its default export is now (pi) => { pi.registerTool(...) ... }, pi's extension shape");
	loaded.build();
	return loaded;
}

/** The loaded extensions, which of them are on, and their lifecycles. */
export class ExtensionSet {
	private list: Loaded[];
	private readonly settings: SettingsFile;
	private readonly adapters: Adapters;
	/** Why each one that's on isn't working, if it isn't (its last failure to start). */
	private readonly failures = new Map<string, string>();
	/** Channels that opened, so only those are shown on and closed. */
	private readonly open = new Set<Channel>();
	private readonly log: (line: string) => void;

	constructor(entries: readonly Loaded[], settings: SettingsFile, adapters: Adapters, log: (line: string) => void = (line) => console.log(line)) {
		this.list = [...entries];
		this.settings = settings;
		this.adapters = adapters;
		this.log = log;
	}

	get entries(): readonly Loaded[] {
		return this.list;
	}

	/** Add an extension, or replace the one with its name (stopped first; sync starts the new one). */
	async put(entry: Loaded): Promise<void> {
		if (this.get(entry.name) !== undefined) await this.remove(entry.name);
		this.list = [...this.list, entry];
	}

	/** Stop it if it's running and forget it. */
	async remove(name: string): Promise<void> {
		const entry = this.get(name);
		if (entry === undefined) return;
		if (entry.running) await this.stop(entry);
		this.list = this.list.filter((other) => other !== entry);
	}

	enabled(entry: Loaded): boolean {
		return this.settings.get().extensions[entry.name]?.enabled ?? true;
	}

	on(): Loaded[] {
		return this.entries.filter((entry) => this.enabled(entry));
	}

	get(name: string): Loaded | undefined {
		return this.entries.find((entry) => entry.name === name);
	}

	/** Why it's on but not working, if it isn't. */
	failure(name: string): string | undefined {
		return this.failures.get(name);
	}

	/** Why it can't be turned off, if it can't: it's the only channel that's actually open. */
	cannotTurnOff(entry: Loaded): string | undefined {
		if (entry.channel === undefined || !this.open.has(entry.channel)) return undefined;
		return [...this.open].some((channel) => channel !== entry.channel) ? undefined : "It's the only channel you can reach me on.";
	}

	/** What agents get of the ones that are on. */
	selected(): Extension[] {
		return this.on().map((entry) => entry.durable);
	}

	/** What a new job agent must not have: whatever isn't on right now. */
	withheld(): Extension[] {
		return this.entries.filter((entry) => !this.enabled(entry)).map((entry) => entry.durable);
	}

	tools(): ToolInfo[] {
		return this.on().flatMap((entry) => entry.tools.map((tool) => ({ name: tool.name, description: tool.description, ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }) })));
	}

	/** The ones that are on: where their skills are (resources_discover). */
	async skillPaths(): Promise<string[]> {
		const found: string[] = [];
		for (const entry of this.on()) for (const result of await entry.emit("resources_discover", { type: "resources_discover" }, entry.context())) found.push(...(result?.skillPaths ?? []));
		return found;
	}

	async exchangeEnded(exchange: ExchangeEnd): Promise<void> {
		await Promise.all(this.on().map((entry) => entry.emit("exchange_end", { type: "exchange_end", ...exchange }, entry.context())));
	}

	/** Start what was turned on and stop what was turned off. */
	async sync(): Promise<void> {
		for (const entry of this.entries) {
			const on = this.enabled(entry);
			if (on && !entry.running) await this.start(entry);
			else if (!on && entry.running) await this.stop(entry);
		}
	}

	async stopAll(): Promise<void> {
		for (const entry of this.entries) if (entry.running) await this.stop(entry);
	}

	/**
	 * Start it; a failure is a problem for whoever can fix it (the adapters' `problem`: the chief of staff hears it),
	 * not just a line in the log.
	 */
	private async start(entry: Loaded): Promise<void> {
		const { ui, inbox } = this.adapters;
		const problems: string[] = [];
		const channel = entry.channel;
		if (channel !== undefined) {
			try {
				await channel.open({ inbox: inbox(channel.platform), ui });
				this.open.add(channel);
				ui.attach({ channel: channel.platform, show: (card, replace) => channel.show(card, replace) });
			} catch (error) {
				problems.push(`its channel didn't open: ${message(error)}`);
			}
		}
		await entry.start().catch((error: unknown) => problems.push(`it didn't start: ${message(error)}`));
		if (problems.length === 0) {
			this.failures.delete(entry.name);
			this.adapters.problem(entry, undefined);
			return;
		}
		const text = problems.join("; ");
		this.log(`${entry.name}: ${text}`);
		this.failures.set(entry.name, text);
		this.adapters.problem(entry, text);
	}

	private async stop(entry: Loaded): Promise<void> {
		await entry.stop().catch((error: unknown) => this.log(`${entry.name}: stop: ${String(error)}`));
		const channel = entry.channel;
		if (channel !== undefined && this.open.delete(channel)) {
			this.adapters.ui.detach(channel.platform);
			await Promise.resolve()
				.then(() => channel.close())
				.catch((error: unknown) => this.log(`${entry.name}: close: ${String(error)}`));
		}
		this.failures.delete(entry.name);
	}
}

/** The core's side of the adapters: where channels are shown, messages let in, and problems reported (undefined: it works now). */
export type Adapters = { ui: UI; inbox(platform: string): Inbox; problem(entry: Loaded, text: string | undefined): void };
