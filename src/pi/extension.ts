// An extension is what it is in pi: a module whose default export is a factory given `pi` (pi's ExtensionAPI), on
// which it registers what it adds (tools, commands, model providers) and handles pi's events. The names, shapes and
// meanings are pi's (packages/coding-agent/src/core/extensions/types.ts), so pi's own docs apply; japa implements them
// on Pi Durable:
//
//   before_agent_start   a prompt section, rendered before each request (systemPromptOptions.sections)
//   tool_call            the tool task's beforeTool hook (block, terminate, or input mutated in place)
//   tool_result          the tool task's afterTool hook (replace the result)
//   tool_execution_*     around the tool task (start: once the call isn't blocked here; end: with its result)
//   context              the generation task's beforeRequest hook (replace the messages of one request)
//   turn_start, turn_end before a request, and after a round's tools
//   message_end          each assistant message the provider returns (to observe)
//   agent_end            the final answer of a run
//   appendEntry          a durable document of the session, read back through ctx.sessionManager
//   sendMessage          a message written into the conversation (or, with triggerTurn, one that starts a turn)
//   setActiveTools       the tools the conversation offers the model
//
// What only a terminal can show (shortcuts, flags, renderers, widgets, the status line) is accepted and not drawn, as
// in pi without a terminal. Anything else of pi's API that japa doesn't have fails at once, saying so: an unknown event
// when the factory subscribes to it, an unknown method when it's used.
//
// Where japa is built from something pi isn't, it's in the same API: a messaging channel (registerChannel), the end
// of an exchange with the user (the exchange_end event), more than one agent (ctx.agent, and `to` on sendUserMessage
// and sendMessage), and keys that aren't model credentials (secrets). Everything else beyond the core is an extension;
// the core (the main thread, open items, the team, the computer) is not, and can't be turned off.
import type { Context } from "@earendil-works/chord";
import type { Api, ImageContent, Message, Model, Models, ModelThinkingLevel, MutableModels, Provider, Static, TextContent, TSchema, Usage } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, GenerationTask, hook, type JsonObject, section, ToolTask, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Inbox } from "../channels/inbox.ts";
import type { Content } from "../core/message.ts";
import type { Card, CardRef, Command, Dialogs, UI } from "../core/ui.ts";
import type { SecretsFile } from "../credentials.ts";
import type { Settings, SettingsFile } from "../settings.ts";

/** pi's tool annotations (MCP's hints): what a tool does, for whoever decides which calls need a look first. */
export type ToolAnnotations = { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };

type JsonValue = JsonObject[string];
type Parts = (TextContent | ImageContent)[];

/** pi's AgentToolResult. `terminate`: when every result of the round says so, the run ends without another request. */
export type ToolResult<TDetails = unknown> = { content: Parts; details?: TDetails; isError?: boolean; usage?: Usage; terminate?: boolean };

/** pi's ToolDefinition, as far as japa uses it (renderers are accepted and not drawn). Throwing makes an error result. */
export type ToolDefinition<P extends TSchema = TSchema, TDetails = unknown> = {
	name: string;
	label?: string;
	description: string;
	/** Bullets for the prompt while the tool is active. */
	promptGuidelines?: string[];
	promptSnippet?: string;
	parameters: P;
	prepareArguments?: (args: unknown) => Static<P>;
	annotations?: ToolAnnotations;
	/** Default true; false: offered only once setActiveTools names it. */
	defaultActive?: boolean;
	executionMode?: "sequential" | "parallel";
	execute(toolCallId: string, params: Static<P>, signal: AbortSignal | undefined, onUpdate: ((partial: ToolResult<TDetails>) => void) | undefined, ctx: ExtensionContext): Promise<ToolResult<TDetails>>;
	renderCall?: unknown;
	renderResult?: unknown;
	renderShell?: unknown;
};

/** pi's ExecOptions and ExecResult. */
export type ExecOptions = { signal?: AbortSignal; timeout?: number; cwd?: string };
export type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };

/** A tool any agent may have, as `getAllTools` lists it. */
export type ToolInfo = { name: string; description: string; parameters?: TSchema; promptGuidelines?: string[]; annotations?: ToolAnnotations };

/** pi's CustomEntry: what appendEntry kept. */
export type CustomEntry = { type: "custom"; id: string; parentId: string | null; timestamp: string; customType: string; data?: unknown };

/** pi's dialog options: dismissed (undefined, false) on abort or after `timeout` ms. */
export type DialogOptions = { signal?: AbortSignal; timeout?: number };

/** pi's ExtensionUIContext: dialogs, drawn as cards on whichever channel is on; what only a terminal shows is a no-op. */
export type ExtensionUI = {
	select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;
	confirm(title: string, message: string, opts?: DialogOptions): Promise<boolean>;
	input(title: string, placeholder?: string, opts?: DialogOptions & { secret?: boolean }): Promise<string | undefined>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	custom(...args: unknown[]): Promise<undefined>;
	setStatus(key: string, text: string | undefined): void;
	setWorkingMessage(message?: string): void;
	setWorkingVisible(visible: boolean): void;
	setWorkingIndicator(options?: unknown): void;
	setHiddenThinkingLabel(label?: string): void;
	setWidget(key: string, content: unknown, options?: unknown): void;
	setFooter(factory: unknown): void;
	setHeader(factory: unknown): void;
	setTitle(title: string): void;
};

/** pi's ExtensionContext, as far as japa has it. */
export type ExtensionContext = {
	/** The agent's home: where its commands start. */
	cwd: string;
	ui: ExtensionUI;
	/** No terminal; dialogs go to the user through the channel, as pi's RPC mode sends them to its client. */
	mode: "rpc";
	hasUI: true;
	/** The models pi can use: the providers logged in to with /login. */
	modelRegistry: Models;
	/** The model of the agent whose turn this is (the chief of staff's otherwise). */
	model: Model<Api> | undefined;
	signal: AbortSignal | undefined;
	/** The session's entries that extensions appended (appendEntry), oldest first. */
	sessionManager: { getEntries(): CustomEntry[]; getBranch(): CustomEntry[] };
	/** japa: in an agent's turn, which agent: the chief of staff, or a job agent (or its subagent). */
	agent?: "chief" | "job";
	/** japa: that agent's conversation, for `to`. */
	conversationId?: string;
};

/**
 * An exchange with the user that just ended (they went quiet, started a new topic, or went back to an earlier one):
 * what was said, across however many slices it took.
 */
export type ExchangeEnd = { conversation: string; openItems: string | undefined; today: string };

/** pi's ToolCallEventResult. `terminate`: the agent ends its turn, and waits for a message (sendUserMessage `to` it). */
export type ToolCallEventResult = { block?: boolean; reason?: string; terminate?: boolean };

/** pi's ToolResultEventResult: omitted fields stay as they are. */
export type ToolResultEventResult = { content?: Parts; details?: unknown; isError?: boolean; usage?: Usage };

/** The events, each with what its handlers return. */
export type ExtensionEvents = {
	/** It's on: at startup, or when turned on. Start long-lived things here, not in the factory. */
	session_start: [{ type: "session_start"; reason: "startup" }, void];
	/** It's off: turned off, or japa is stopping. */
	session_shutdown: [{ type: "session_shutdown"; reason: "quit" }, void];
	/** Before each model request: add to `systemPromptOptions.sections` (key: text, wrapped in its tag). */
	before_agent_start: [{ type: "before_agent_start"; systemPromptOptions: { sections: Record<string, string> } }, void];
	/** Before a tool runs: block it, or let it through. `input` is mutable: change it in place to patch the arguments. */
	tool_call: [{ type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown> }, ToolCallEventResult | void];
	/** After a tool ran: change its result. */
	tool_result: [{ type: "tool_result"; toolCallId: string; toolName: string; input: Record<string, unknown>; content: Parts; details: unknown; isError: boolean; usage?: Usage }, ToolResultEventResult | void];
	tool_execution_start: [{ type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }, void];
	tool_execution_end: [{ type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResult; isError: boolean }, void];
	/** Before each model request: the messages it sends (system prompt aside); return `messages` to replace them. */
	context: [{ type: "context"; messages: Message[] }, { messages?: Message[] } | void];
	turn_start: [{ type: "turn_start"; turnIndex: number; timestamp: number }, void];
	/** A round is done: the assistant's message and its tools' results. */
	turn_end: [{ type: "turn_end"; turnIndex: number; message: Message | undefined; toolResults: Message[] }, void];
	/** Each assistant message the provider returns. */
	message_end: [{ type: "message_end"; message: Message }, void];
	/** A run ended with this answer. */
	agent_end: [{ type: "agent_end"; messages: Message[] }, void];
	/** Where its skills are (directories with a SKILL.md, pi's format). */
	resources_discover: [{ type: "resources_discover"; cwd: string; reason: "startup" }, { skillPaths?: string[] } | void];
	/** japa: an exchange with the user ended (in the background; the user never waits for it). */
	exchange_end: [{ type: "exchange_end" } & ExchangeEnd, void];
};

type Handler<E extends keyof ExtensionEvents> = (event: ExtensionEvents[E][0], ctx: ExtensionContext) => ExtensionEvents[E][1] | Promise<ExtensionEvents[E][1]>;

const EVENTS: ReadonlySet<string> = new Set<keyof ExtensionEvents>([
	"session_start",
	"session_shutdown",
	"before_agent_start",
	"tool_call",
	"tool_result",
	"tool_execution_start",
	"tool_execution_end",
	"context",
	"turn_start",
	"turn_end",
	"message_end",
	"agent_end",
	"resources_discover",
	"exchange_end",
]);

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

/** pi's CustomMessage, as sendMessage takes it. */
export type CustomMessage = { customType: string; content: string | Parts; display?: boolean; details?: unknown };

/** pi's ExtensionAPI, as japa has it. */
export interface ExtensionAPI {
	on<E extends keyof ExtensionEvents>(event: E, handler: Handler<E>): () => void;
	registerTool<P extends TSchema, TDetails = unknown>(tool: ToolDefinition<P, TDetails>): void;
	registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: ExtensionContext) => void | Promise<void> }): void;
	/** A pi-ai Provider: on the core's Models while the extension is on; its credential through /login. */
	registerProvider(provider: Provider): void;
	unregisterProvider(name: string): void;
	/** A message to the chief of staff (or, with `to`, to that agent's conversation), as if the user had sent it. */
	sendUserMessage(content: string | Parts, options?: { deliverAs?: "steer" | "followUp"; to?: string }): void;
	/** A message into the conversation; it starts a turn only with `triggerTurn`. */
	sendMessage(message: CustomMessage, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn"; to?: string }): void;
	/** Keep state in the session (never sent to the model); read back with ctx.sessionManager.getEntries(). */
	appendEntry(customType: string, data?: unknown): void;
	/** Run a command on the agent's computer (from its home, without japa's keys in its environment). */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
	/** japa's settings (settings.json), live; an extension's own options are under `extensions[<its name>]`. */
	getSettings(): Settings;
	getAllTools(): ToolInfo[];
	getActiveTools(): string[];
	setActiveTools(toolNames: string[]): void;
	getCommands(): Command[];
	/** The chief of staff's model, as the user's settings choose it. False: its provider has no credential. */
	setModel(model: Model<Api>): Promise<boolean>;
	getThinkingLevel(): ModelThinkingLevel;
	setThinkingLevel(level: ModelThinkingLevel): void;
	/** Terminal-only: accepted, and not drawn (japa has no terminal). */
	registerShortcut(shortcut: string, options: { description?: string; handler: (ctx: ExtensionContext) => void | Promise<void> }): void;
	registerMessageRenderer(customType: string, renderer: unknown): void;
	registerEntryRenderer(customType: string, renderer: unknown): void;
	registerMarkdownTransformer(transformer: unknown): void;
	registerToolRenderer(resolver: unknown): void;
	/** A CLI flag: there's no command line, so it's always its default. */
	registerFlag(name: string, options: { description?: string; type: "boolean" | "string"; default?: boolean | string }): void;
	getFlag(name: string): boolean | string | undefined;
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

export type ExtensionFactory = (pi: ExtensionAPI) => unknown;

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
	/** A message to a conversation (default: the chief of staff), once: a turn of its own, or (`write`) kept for the next one. */
	send(content: Content, options: { to?: string; from: string; write?: boolean }): void;
	/** A conversation waiting on the user until a message is sent to it. */
	hold(conversationId: string, reason: string): void;
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
	tools(): ToolInfo[];
	/** The tools no conversation offers the model now (setActiveTools, or defaultActive false). */
	inactive(): ReadonlySet<string>;
	setActiveTools(names: string[]): void;
	/** The model a conversation runs on. */
	model(conversationId: string | undefined): Promise<Model<Api> | undefined>;
	/** Entries' messages, for turn_end. */
	messages(conversationId: string, entryIds: readonly unknown[]): Promise<Message[]>;
	/** The session's custom entries (appendEntry), oldest first. */
	entries(): CustomEntry[];
	appendEntry(entry: CustomEntry): void;
	/** Apply a change to what agents run with (the model, the active tools). */
	apply(): void;
	/** An environment variable holding a key, to keep out of commands' environment. */
	keyEnv(name: string): void;
	log(line: string): void;
};

const text = (value: string) => [{ type: "text" as const, text: value }];
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const textOf = (parts: Parts) => parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/**
 * The object, with a member it doesn't have failing at once with a clear reason, rather than undefined somewhere later
 * (pi's API is larger than what japa implements).
 */
function strict<T extends object>(target: T, what: string): T {
	return new Proxy(target, {
		get(object, key, receiver) {
			if (typeof key === "symbol" || key in object || key === "then" || key === "toJSON") return Reflect.get(object, key, receiver);
			throw new Error(`${what}.${key} isn't available in japa`);
		},
	});
}

/** A dialog that gives up (with `none`) when its signal aborts or its time runs out, as pi's do. */
function dismissable<T>(asked: Promise<T>, none: T, options: DialogOptions | undefined): Promise<T> {
	if (options?.signal === undefined && options?.timeout === undefined) return asked;
	return new Promise<T>((resolve) => {
		const timer = options.timeout === undefined ? undefined : setTimeout(() => resolve(none), options.timeout);
		options.signal?.addEventListener("abort", () => resolve(none), { once: true });
		void asked.then((value) => {
			clearTimeout(timer);
			resolve(value);
		});
	});
}

function extensionUI(dialogs: Dialogs): ExtensionUI {
	const nothing = () => {};
	return strict(
		{
			select: (title, options, opts) => dismissable(dialogs.select(title, options), undefined, opts),
			confirm: (title, body, opts) => dismissable(dialogs.confirm(title, body), false, opts),
			input: (title, placeholder, opts) => dismissable(dialogs.input(title, placeholder, opts?.secret === true ? { secret: true } : {}), undefined, opts),
			editor: (title, prefill) => dialogs.input(title, prefill),
			notify: (body) => dialogs.notify(body),
			custom: async () => undefined,
			setStatus: nothing,
			setWorkingMessage: nothing,
			setWorkingVisible: nothing,
			setWorkingIndicator: nothing,
			setHiddenThinkingLabel: nothing,
			setWidget: nothing,
			setFooter: nothing,
			setHeader: nothing,
			setTitle: nothing,
		} satisfies ExtensionUI,
		"ctx.ui",
	);
}

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
	private readonly flags = new Map<string, boolean | string | undefined>();
	/** Rounds per conversation, for turn_start and turn_end. */
	private readonly turns = new Map<string, number>();
	private readonly runtime: Runtime;

	constructor(name: string, runtime: Runtime) {
		this.name = name;
		this.runtime = runtime;
	}

	/** A context for a handler: in an agent's turn (`conversationId`), or a command's (`at`). */
	async context(options: { conversationId?: string; signal?: AbortSignal; at?: CardRef } = {}): Promise<ExtensionContext> {
		const { runtime } = this;
		const entries = () => runtime.entries();
		return strict<ExtensionContext>(
			{
				cwd: runtime.home,
				ui: extensionUI(runtime.ui.dialogs(options.at)),
				mode: "rpc",
				hasUI: true,
				modelRegistry: runtime.models,
				model: await runtime.model(options.conversationId),
				signal: options.signal,
				sessionManager: strict({ getEntries: entries, getBranch: entries }, "ctx.sessionManager"),
				...(options.conversationId === undefined ? {} : { conversationId: options.conversationId, agent: options.conversationId === runtime.chiefId() ? ("chief" as const) : ("job" as const) }),
			},
			"ctx",
		);
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

	/** Emit in an agent's turn, if it has handlers for it. */
	private async emitIn<E extends keyof ExtensionEvents>(event: E, payload: ExtensionEvents[E][0], conversationId: unknown): Promise<ExtensionEvents[E][1][]> {
		if (!this.has(event)) return [];
		return this.emit(event, payload, await this.context({ conversationId: String(conversationId) }));
	}

	api(): ExtensionAPI {
		const { runtime } = this;
		const nothing = () => {};
		const to = (options: { to?: string } | undefined) => (options?.to === undefined ? {} : { to: options.to });
		return strict<ExtensionAPI>(
			{
				on: (event, handler) => {
					if (!EVENTS.has(event)) throw new Error(`japa has no "${event}" event (it has ${[...EVENTS].join(", ")})`);
					const list = this.handlers.get(event) ?? [];
					list.push(handler as unknown as Handler<never>);
					this.handlers.set(event, list);
					return () => void list.splice(list.indexOf(handler as unknown as Handler<never>), 1);
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
				sendUserMessage: (content, options) => runtime.send(content, { ...to(options), from: this.name }),
				sendMessage: (custom, options) =>
					runtime.send(custom.content, { ...to(options), from: this.name, ...(options?.triggerTurn === true && options.deliverAs !== "nextTurn" ? {} : { write: true }) }),
				appendEntry: (customType, data) =>
					runtime.appendEntry({ type: "custom", id: `${this.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, parentId: null, timestamp: new Date().toISOString(), customType, ...(data === undefined ? {} : { data }) }),
				exec: (command, args, options) => runtime.exec(command, args, options),
				getSettings: () => runtime.settings.get(),
				getAllTools: () => runtime.tools(),
				getActiveTools: () => runtime.tools().map((tool) => tool.name).filter((name) => !runtime.inactive().has(name)),
				setActiveTools: (names) => runtime.setActiveTools(names),
				getCommands: () => runtime.ui.commands(),
				setModel: async (model) => {
					if ((await runtime.models.checkAuth(model.provider)) === undefined) return false;
					const current = runtime.settings.get().model;
					runtime.settings.update({ model: { provider: model.provider, modelId: model.id, ...(current?.thinking === undefined ? {} : { thinking: current.thinking }) } });
					runtime.apply();
					return true;
				},
				getThinkingLevel: () => (runtime.settings.get().model?.thinking ?? "off") as ModelThinkingLevel,
				setThinkingLevel: (level) => {
					const current = runtime.settings.get().model;
					if (current === undefined) return;
					runtime.settings.update({ model: level === "off" ? { provider: current.provider, modelId: current.modelId } : { ...current, thinking: level } });
					runtime.apply();
				},
				registerShortcut: nothing,
				registerMessageRenderer: nothing,
				registerEntryRenderer: nothing,
				registerMarkdownTransformer: nothing,
				registerToolRenderer: nothing,
				registerFlag: (name, options) => void this.flags.set(name, options.default),
				getFlag: (name) => this.flags.get(name),
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
			},
			"pi",
		);
	}

	/** A tool as Pi Durable runs it. */
	private durableTool(tool: ToolDefinition): ToolRegistration {
		return defineTool({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			replay: tool.annotations?.readOnlyHint === true ? "safe" : "unsafe",
			...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
			...(tool.prepareArguments === undefined ? {} : { prepareArguments: tool.prepareArguments }),
			execute: async (args, api, context: Context) => {
				// pi's onUpdate: a partial result; its new text streams as the call's output, its details as the call's.
				let shown = "";
				const onUpdate = (partial: ToolResult) => {
					const now = textOf(partial.content ?? []);
					if (now.startsWith(shown) && now.length > shown.length) api.output(now.slice(shown.length));
					shown = now;
					if (partial.details !== undefined) void api.details(partial.details as JsonValue, context).catch(() => {});
				};
				try {
					const result = await tool.execute(api.callId, args, context.abortSignal, onUpdate, await this.context({ conversationId: String(api.conversationId), signal: context.abortSignal }));
					return {
						content: result.content,
						...(result.isError === true ? { isError: true } : {}),
						...(result.details === undefined ? {} : { details: result.details as JsonValue }),
						...(result.usage === undefined ? {} : { usage: result.usage }),
						...(result.terminate === true ? { control: { terminate: true as const } } : {}),
					};
				} catch (error) {
					return { content: text(message(error)), isError: true };
				}
			},
		});
	}

	/**
	 * What agents get of it, on Pi Durable: its tools, a prompt section (before_agent_start, and its tools' guidelines),
	 * and hooks on the tool and generation tasks for the events it handles.
	 */
	build(): void {
		const tools = this.tools.map((tool) => this.durableTool(tool));
		const guidelines = this.tools.flatMap((tool) => (tool.promptGuidelines ?? []).map((line) => [tool.name, line] as const));
		const sections =
			this.has("before_agent_start") || guidelines.length > 0
				? [
						section(
							this.name,
							async (input) => {
								const options = { sections: {} as Record<string, string> };
								await this.emitIn("before_agent_start", { type: "before_agent_start", systemPromptOptions: options }, input.conversationId);
								const active = guidelines.filter(([name]) => !this.runtime.inactive().has(name)).map(([, line]) => `- ${line}`);
								const shown = [...Object.entries(options.sections).filter(([, value]) => value.trim() !== "").map(([key, value]) => `<${key}>\n${value}\n</${key}>`), ...(active.length === 0 ? [] : [active.join("\n")])];
								return shown.length === 0 ? undefined : shown.join("\n\n");
							},
							{ tag: false },
						),
					]
				: [];
		const hooks = [];
		if (this.has("tool_call") || this.has("tool_execution_start") || this.has("tool_result") || this.has("tool_execution_end")) {
			hooks.push(
				hook(ToolTask, {
					beforeTool: async (call, api) => {
						const conversationId = String(api.conversationId);
						const input = structuredClone(call.arguments) as Record<string, unknown>;
						const results = await this.emitIn("tool_call", { type: "tool_call", toolCallId: call.id, toolName: call.name, input }, conversationId);
						const blocked = results.find((result) => result?.block === true);
						if (blocked !== undefined && blocked !== null) {
							if (blocked.terminate === true) this.runtime.hold(conversationId, call.id);
							return { block: blocked.reason ?? `${call.name} was blocked` };
						}
						await this.emitIn("tool_execution_start", { type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: input }, conversationId);
						return JSON.stringify(input) === JSON.stringify(call.arguments) ? undefined : { arguments: input as JsonObject };
					},
					afterTool: async (call, result, api) => {
						let changed = { content: (result.content ?? []) as Parts, details: result.details as unknown, isError: result.isError === true, ...(result.usage === undefined ? {} : { usage: result.usage }) };
						let replaced = false;
						for (const change of await this.emitIn("tool_result", { type: "tool_result", toolCallId: call.id, toolName: call.name, input: call.arguments, ...changed }, api.conversationId)) {
							if (change === undefined || change === null) continue;
							changed = { ...changed, ...change } as typeof changed;
							replaced = true;
						}
						await this.emitIn("tool_execution_end", { type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: changed, isError: changed.isError }, api.conversationId);
						if (!replaced) return undefined;
						return { ...result, content: changed.content, isError: changed.isError, ...(changed.details === undefined ? {} : { details: changed.details as JsonValue }), ...(changed.usage === undefined ? {} : { usage: changed.usage }) };
					},
				}),
			);
		}
		if (this.has("context") || this.has("turn_start") || this.has("turn_end") || this.has("message_end") || this.has("agent_end")) {
			hooks.push(
				hook(GenerationTask, {
					beforeRequest: async (request, api) => {
						const conversationId = String(api.conversationId);
						await this.emitIn("turn_start", { type: "turn_start", turnIndex: this.turns.get(conversationId) ?? 0, timestamp: Date.now() }, conversationId);
						let messages = [...request.messages];
						for (const change of await this.emitIn("context", { type: "context", messages }, conversationId)) if (change?.messages !== undefined) messages = change.messages;
						return messages.length === request.messages.length && messages.every((each, index) => each === request.messages[index]) ? undefined : { messages };
					},
					afterResponse: async (response, api) => void (await this.emitIn("message_end", { type: "message_end", message: response }, api.conversationId)),
					afterTools: async (assistant, results, api) => {
						const conversationId = String(api.conversationId);
						const turnIndex = this.turns.get(conversationId) ?? 0;
						this.turns.set(conversationId, turnIndex + 1);
						if (!this.has("turn_end")) return;
						const [message, ...toolResults] = await this.runtime.messages(conversationId, [assistant, ...results]);
						await this.emitIn("turn_end", { type: "turn_end", turnIndex, message, toolResults }, conversationId);
					},
					onYield: async (answer, api) => {
						this.turns.delete(String(api.conversationId));
						await this.emitIn("agent_end", { type: "agent_end", messages: [answer] }, api.conversationId);
						return undefined;
					},
				}),
			);
		}
		this.durable = defineExtension({ name: this.name, tools, sections, hooks });
	}

	/** Offer one of its commands on the UI. */
	private offer(name: string): void {
		const command = this.commands.get(name);
		if (command === undefined) return;
		this.runtime.ui.command(name, command.description ?? name, async (at, args) => command.handler(args, await this.context({ at })));
	}

	/** It's on: its providers on Models, its commands offered, then session_start. */
	async start(): Promise<void> {
		this.running = true;
		for (const provider of this.providers.values()) this.runtime.models.setProvider(provider);
		for (const name of this.commands.keys()) this.offer(name);
		await this.emit("session_start", { type: "session_start", reason: "startup" }, await this.context());
	}

	async stop(): Promise<void> {
		this.running = false;
		await this.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, await this.context());
		for (const name of this.commands.keys()) this.runtime.ui.removeCommand(name);
		for (const name of this.providers.keys()) this.runtime.models.deleteProvider(name);
	}
}

/** Run an extension's factory and make what agents get of it. */
export async function loadExtension(name: string, factory: ExtensionFactory, runtime: Runtime): Promise<Loaded> {
	const loaded = new Loaded(name, runtime);
	const returned = (await factory(loaded.api())) as unknown;
	// The shape from before an extension was a pi extension: a factory returning the extension itself.
	if (returned !== null && typeof returned === "object" && "name" in returned) {
		throw new Error("it's written in an older shape (a factory returning an extension); its default export is now (pi) => { pi.registerTool(...) ... }, pi's extension shape");
	}
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
		for (const entry of this.on()) {
			const ctx = await entry.context();
			for (const result of await entry.emit("resources_discover", { type: "resources_discover", cwd: ctx.cwd, reason: "startup" }, ctx)) found.push(...(result?.skillPaths ?? []));
		}
		return found;
	}

	async exchangeEnded(exchange: ExchangeEnd): Promise<void> {
		await Promise.all(this.on().map(async (entry) => entry.emit("exchange_end", { type: "exchange_end", ...exchange }, await entry.context())));
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
