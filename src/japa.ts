// The core, assembled: the main thread (the chief of staff), open items, the team, the agent's computer, skills,
// schedules, the record of the conversation, the UI with its commands (japa's /settings and /jobs, and pi's /login,
// /logout, /model, /thinking and /session), and the installer. None of these can be turned off. Everything else is an
// extension: a pi extension factory, given pi's ExtensionAPI (src/pi/extension.ts), built-in or installed from chat
// alike, and what it registers is put in use by the core's owner of each kind (src/pi/owners.ts and the modules beside
// it): its commands, model providers, accounts, environments (the agent's computer), channels, schedules and MCP servers.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { getSupportedThinkingLevels, type CredentialStore, type MutableModels } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type Extension, type Storage } from "@earendil-works/pi-durable";
import { Inbox } from "./channels/inbox.ts";
import { attachJobs } from "./commands/jobs.ts";
import { attachLogin } from "./commands/login.ts";
import { attachSession } from "./commands/session.ts";
import { SettingsMenu } from "./commands/settings.ts";
import { History } from "./core/history.ts";
import type { Content } from "./core/message.ts";
import { stamp } from "./core/schedule.ts";
import { OpenItems, WorkingSetFile } from "./core/state.ts";
import { type CardRef, Holds, UI } from "./core/ui.ts";
import type { KeyEnvironment } from "./credentials.ts";
import { Accounts } from "./pi/accounts.ts";
import { toInput } from "./pi/attachments.ts";
import { computerExtension, execOn } from "./pi/computer.ts";
import { delegationExtensions } from "./pi/delegation.ts";
import { type CustomEntry, EventBus, type ExtensionFactory, ExtensionSet, type Loaded, loadExtension, type Owners, type Runtime, type ToolInfo } from "./pi/extension.ts";
import { MainThread } from "./pi/harness.ts";
import { historyExtension, indexHistory } from "./pi/history.ts";
import { address, problem } from "./pi/inputs.ts";
import { installer } from "./pi/installer.ts";
import { McpServers } from "./pi/mcp.ts";
import { thinkingOf } from "./pi/models.ts";
import { channelOwner, commandOwner, Computers, providerOwner } from "./pi/owners.ts";
import { SCHEDULE_PREFIX, Schedules, schedulesExtension } from "./pi/schedules.ts";
import { skillsExtension } from "./pi/skills.ts";
import { stateExtension } from "./pi/state.ts";
import type { SettingsFile } from "./settings.ts";

/** japa's own code: where it runs from. */
const CODE_DIR = resolve(import.meta.dirname, "..");

export type Japa = {
	thread: MainThread;
	runtime: Runtime;
	extensions: ExtensionSet;
	/** Apply settings changes: the model, extensions started or stopped. */
	apply(context: Context): Promise<void>;
	close(context: Context): Promise<void>;
};

export async function startJapa(
	options: {
		dataDir: string;
		settings: SettingsFile;
		/** pi's models: the model providers, with `credentials` and `keys` as their store and auth context. */
		models: MutableModels;
		/** Every login's credentials (auth.json): model providers' and accounts'. */
		credentials: CredentialStore;
		/** How logins read the environment; what they find there are keys, kept out of commands' environment. */
		keys: KeyEnvironment;
		/** Default: SQLite in dataDir. */
		storage?: Storage;
		/** The built-in extensions, by name: each one's factory, as an installed one's default export is. */
		extensions: Readonly<Record<string, ExtensionFactory>>;
		log?: (line: string) => void;
	},
	context: Context,
): Promise<Japa> {
	const { dataDir, settings, models, keys } = options;
	const log = options.log ?? ((line: string) => console.log(line));
	const ui = new UI(log);
	const holds = new Holds();
	const history = new History(join(dataDir, "history.sqlite"));
	const state = { openItems: new OpenItems(join(dataDir, "open-items.json")), workingSet: new WorkingSetFile(join(dataDir, "working-set.json")) };
	const registry = createRegistry();
	// Resolved once the thread is open; nothing below calls these before then.
	let thread: MainThread | undefined;
	let extensions: ExtensionSet | undefined;
	let japa: Japa | undefined;
	const main = () => thread!;
	const apply = (callContext: Context) => japa?.apply(callContext) ?? Promise.resolve();

	const computers = new Computers(() => keys.names());
	const inboxes = new Map<string, Inbox>();
	/** The gate a channel's messages come in through: one per platform, refusing anyone not on its allowlist. */
	const inbox = (platform: string): Inbox => {
		let found = inboxes.get(platform);
		if (found === undefined) {
			found = new Inbox({
				platform,
				thread: main,
				settings,
				log,
				prepare: apply,
				// Files go on its computer; images are shown to the chief of staff too when its model takes them.
				receive: (message) => {
					const choice = settings.get().model;
					const model = choice === undefined ? undefined : models.getModel(choice.provider, choice.modelId);
					return toInput(message, { env: computers.current(), seesImages: model?.input.includes("image") === true, context });
				},
			});
			inboxes.set(platform, found);
		}
		return found;
	};

	/**
	 * A new turn in a conversation, once per `id`: the chief of staff (addressed from `from`; its answer goes to the user
	 * threaded under `replyTo`) or a job agent (a new run of its job, seen through as usual), which is no longer held.
	 * `write`: no turn, the message is kept for the conversation's next one.
	 */
	const wake = async (conversationId: string, content: Content, { id, from, replyTo, write }: { id: string; from: string; replyTo?: CardRef; write?: boolean }) => {
		const root = main().root;
		if (write === true) {
			const conversation = conversationId === String(root.id) ? root : await main().harness.conversation(Number(conversationId) as ConversationId, context);
			if (conversation === undefined) throw new Error(`no conversation ${conversationId}`);
			await conversation.submit({ type: "write", requestId: id, entry: { kind: "pi.user", model: [{ role: "user", content, timestamp: Date.now() }] } }, context);
			return;
		}
		holds.release(conversationId);
		if (conversationId !== String(root.id)) {
			await team.resume(root, conversationId, typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"), context);
			return;
		}
		const at = `[${stamp(Date.now(), settings.get().timezone)}]`;
		const stamped: Content = typeof content === "string" ? `${at} ${content}` : [{ type: "text", text: at }, ...content];
		await root.commit((tx) => address(tx, root.id, { requestId: id, content: stamped, cause: { from, ...(replyTo === undefined ? {} : { replyTo }) } }), context);
	};

	/** What extensions appended to the session (pi's custom entries), kept in the data directory. */
	const entriesFile = join(dataDir, "extension-entries.jsonl");
	const entries: CustomEntry[] = existsSync(entriesFile)
		? readFileSync(entriesFile, "utf8")
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => JSON.parse(line) as CustomEntry)
		: [];
	/** The tools setActiveTools chose, while one has; otherwise every tool but those not active by default. */
	let activeTools: ReadonlySet<string> | undefined;

	/** A problem with something japa runs: the chief of staff hears it once, and can have it fixed. Kept until it's open. */
	const early: Array<[string, string | undefined]> = [];
	const report = (about: string, text: string | undefined) => {
		if (thread === undefined) return void early.push([about, text]);
		const root = thread.root;
		void root.commit((tx) => problem(tx, root.id, about, text), context).catch((error: unknown) => log(`problem with ${about}: ${String(error)}`));
	};

	// A login may be what something that's on was missing (a channel's token): what didn't start, starts again.
	const accounts = new Accounts({ models, credentials: options.credentials, authContext: keys, ui, loggedIn: () => void extensions?.retry().catch((error: unknown) => log(`retry: ${String(error)}`)) });
	const accountOwner = accounts.owner();
	const credentials = { get: (id: string, given?: { signal?: AbortSignal }) => accounts.get(id, given) };
	const schedules = new Schedules({
		path: join(dataDir, "schedules.json"),
		timezone: () => settings.get().timezone,
		fire: (name, message) => runtime.send(`${SCHEDULE_PREFIX}${name}] ${message}`, { from: `schedule:${name}` }),
	});
	const mcp = new McpServers({ accounts: accountOwner, credentials, cwd: () => computers.current()?.cwd, log });
	const owners: Owners = {
		commands: commandOwner(ui),
		// Its keys read now, as an account's are.
		providers: providerOwner(models, (id) => void accounts.probe(id)),
		accounts: accountOwner,
		environments: computers.owner(),
		channels: channelOwner(ui, inbox),
		schedules: schedules.owner(),
		mcpServers: mcp.owner(),
	};

	const runtime: Runtime = {
		ui,
		models,
		settings,
		dataDir,
		events: new EventBus(),
		owners,
		accounts: credentials,
		computer: () => computers.current(),
		chiefId: () => String(main().root.id),
		send: (content, { to, from, write }) =>
			void wake(to ?? String(main().root.id), content, { id: `${from}:${randomUUID()}`, from, ...(write === true ? { write } : {}) }).catch((error: unknown) => log(`${from}: ${String(error)}`)),
		hold: (conversationId, reason) => holds.add(conversationId, reason),
		exec: (command, args, given = {}) => execOn(computers.current(), command, args, given, context),
		tools: () => [...coreTools, ...(extensions?.tools() ?? [])],
		inactive: () => {
			const all = runtime.tools();
			if (activeTools !== undefined) return new Set(all.map((tool) => tool.name).filter((name) => !activeTools!.has(name)));
			return new Set((extensions?.on() ?? []).flatMap((entry) => entry.allTools().filter((tool) => tool.defaultActive === false).map((tool) => tool.name)));
		},
		setActiveTools: (names) => {
			activeTools = new Set(names);
			void apply(context).catch((error: unknown) => log(`setActiveTools: ${String(error)}`));
		},
		model: async (conversationId) => {
			const conversation = conversationId === undefined || conversationId === String(main().root.id) ? main().root : await main().harness.conversation(Number(conversationId) as ConversationId, context);
			const ref = conversation === undefined ? undefined : (await conversation.agent(context)).model;
			return ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId);
		},
		messages: async (conversationId, entryIds) => {
			const conversation = await main().harness.conversation(Number(conversationId) as ConversationId, context);
			const found = (await conversation?.context(context))?.entries ?? [];
			return entryIds.flatMap((id) => found.find((entry) => entry.id === id)?.model ?? []);
		},
		entries: () => [...entries],
		appendEntry: (entry) => {
			entries.push(entry);
			appendFileSync(entriesFile, `${JSON.stringify(entry)}\n`);
		},
		apply: () => void apply(context).catch((error: unknown) => log(`apply: ${String(error)}`)),
		rebuilt: (entry) => {
			registry.install(entry.durable);
			if (thread !== undefined) void thread.applySettings(settings.get(), context).catch((error: unknown) => log(`${entry.name}: ${String(error)}`));
		},
		mcpServers: () => mcp.configs(),
		problem: report,
		log,
	};

	const stateTools = stateExtension(state);
	const team = delegationExtensions({
		openItems: state.openItems,
		settings: () => settings.get(),
		origin: (callContext) => main().origin(callContext),
		withhold: () => [main().core, ...chiefOnly, ...extensions!.withheld()],
		waitingOnUser: (conversationId) => holds.has(String(conversationId)),
		thinking: (choice) => thinkingOf(models, choice),
	});
	const installs = installer({
		ui,
		tell: (text, id, replyTo) => wake(String(main().root.id), text, { id, from: "installer", ...(replyTo === undefined ? {} : { replyTo }) }),
		load: (name, factory) => loadExtension(name, factory, runtime),
		log,
		dataDir,
		computer: () => computers.current(),
		extensions: () => extensions!,
		registry,
		apply,
		problem: (about, text) => report(about, text),
		context,
	});
	const builtIn: Loaded[] = [];
	for (const [name, factory] of Object.entries(options.extensions)) {
		try {
			builtIn.push(await loadExtension(name, factory, runtime));
		} catch (error) {
			report(`extension ${name}`, `it didn't load: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const set = new ExtensionSet([...builtIn, ...(await installs.loadInstalled())], settings, (entry, text) => report(`extension ${entry.name}`, text), log);
	extensions = set;

	const record = historyExtension(async (query, callContext) => {
		await indexHistory(main().root, history, callContext);
		return history.search(query);
	});
	/** The chief of staff's own: job agents don't get them. */
	const chiefOnly: Extension[] = [stateTools, team.chief, installs.extension, record, schedulesExtension(schedules, () => settings.get().timezone)];
	// Every job agent gets these from the chief of staff: its computer, and its skills and standing instructions.
	const shared = [skillsExtension({ builtIn: join(CODE_DIR, "skills"), discovered: () => set.skillPaths() }), computerExtension({ code: CODE_DIR, data: dataDir })];
	const core = [...chiefOnly, ...shared];
	// The core's tools that stay in the agent's own world (its open items, its team, its record, its schedules,
	// installing, which asks the user by itself) say so, as pi's tools do; its computer's don't.
	const coreTools: ToolInfo[] = [
		...[...chiefOnly, team.job, team.helper].flatMap((extension) => (extension.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, annotations: { openWorldHint: false } }))),
		...shared.flatMap((extension) => (extension.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description }))),
	];

	thread = await MainThread.open(
		{
			dataDir,
			...(options.storage === undefined ? {} : { storage: options.storage }),
			models,
			registry,
			settings: () => settings.get(),
			installed: [...core, team.job, team.helper, ...set.entries.map((entry) => entry.durable)],
			selected: () => [...core, ...set.selected()],
			inactiveTools: () => runtime.inactive(),
			env: () => computers.current(),
			state,
			onExchangeEnd: (exchange) => set.exchangeEnded(exchange),
			log,
		},
		context,
	);

	for (const [about, text] of early.splice(0)) report(about, text);
	// Every login's environment read once now (the built-in model providers' too), so a key there is kept out of
	// commands from the start.
	await accounts.probe();
	schedules.resume();

	japa = {
		thread,
		runtime,
		extensions: set,
		apply: async (callContext) => {
			await main().applySettings(settings.get(), callContext);
			await set.sync();
		},
		close: async (callContext) => {
			schedules.stopAll();
			await set.stopAll();
			await main().close(callContext);
			history.close();
		},
	};

	new SettingsMenu({
		settings,
		extensions: set,
		modelExists: (choice) => models.getModel(choice.provider, choice.modelId) !== undefined,
		available: async () =>
			(await models.getAvailable()).map((model) => ({ provider: model.provider, id: model.id, name: model.name, vision: model.input.includes("image") })),
		changed: () => apply(context),
		thinkingLevels: (choice) => {
			const model = models.getModel(choice.provider, choice.modelId);
			return model === undefined ? ["off"] : getSupportedThinkingLevels(model);
		},
	}).attach(ui);
	attachLogin(ui, accounts);
	attachJobs(ui, {
		list: () => team.list(main(), context),
		schedules: () => schedules.list(),
		timezone: () => settings.get().timezone,
		detail: (id) => team.detail(main(), id, context),
		cancel: (id) => team.cancel(main(), id, "by the user, from /jobs", context),
		close: (id) => team.close(main(), id, "closed by the user, from /jobs", context),
	});
	attachSession(ui, () => team.spend(main(), context));
	// What the chief of staff sends on its own (results, questions, news) goes out as cards on whichever channel is on.
	await thread.deliverOutbox(async (message) => {
		return (await ui.show({ text: message.text, buzz: message.buzz, ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }) }))?.messageId;
	}, context);
	await japa.apply(context);
	log("japa: ready");
	return japa;
}
