// The core, assembled: the main thread (the chief of staff), open items, the team, triggers, the record of the
// conversation, the UI with its commands (japa's /settings and /jobs, and pi's /login, /logout, /model and /thinking),
// and the installer. None of these can be turned off. Everything
// else is an extension, made from the Host this builds, and hooked in only through it: which agents get it, its
// settings, its safe tools, its exchange end, its triggers, its lifecycle, and the channel it adds through the core's
// adapter. The agent's computer is the machine this runs on: its tools run here, in `home`.
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { getSupportedThinkingLevels, type MutableModels } from "@earendil-works/pi-ai";
import { createRegistry, type Storage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Inbox } from "./channels/inbox.ts";
import { attachJobs } from "./commands/jobs.ts";
import { attachLogin } from "./commands/login.ts";
import { SettingsMenu } from "./commands/settings.ts";
import { History } from "./core/history.ts";
import { stamp } from "./core/schedule.ts";
import { OpenItems, WorkingSetFile } from "./core/state.ts";
import { Holds, UI } from "./core/ui.ts";
import type { SecretsFile } from "./credentials.ts";
import { toInput } from "./pi/attachments.ts";
import { delegationExtensions } from "./pi/delegation.ts";
import { ExtensionSet, type Host, type JapaExtension } from "./pi/extension.ts";
import { MainThread } from "./pi/harness.ts";
import { thinkingOf } from "./pi/models.ts";
import { installer } from "./pi/installer.ts";
import { address, problem } from "./pi/inputs.ts";
import { indexHistory } from "./pi/memory.ts";
import { stateExtension } from "./pi/state.ts";
import { triggers } from "./pi/triggers.ts";
import type { SettingsFile } from "./settings.ts";

export type Japa = {
	thread: MainThread;
	host: Host;
	extensions: ExtensionSet;
	/** Apply settings changes: the model, extensions started or stopped, schedules for new triggers. */
	apply(context: Context): Promise<void>;
	close(context: Context): Promise<void>;
};

export async function startJapa(
	options: {
		dataDir: string;
		/** The agent's home on this machine: where its tools start and its files go. */
		home: string;
		settings: SettingsFile;
		secrets: SecretsFile;
		models: MutableModels;
		/** Default: SQLite in dataDir. */
		storage?: Storage;
		extensions: (host: Host) => JapaExtension[];
		log?: (line: string) => void;
	},
	context: Context,
): Promise<Japa> {
	const { dataDir, home, settings, secrets, models } = options;
	const log = options.log ?? ((line: string) => console.log(line));
	const ui = new UI(log);
	const holds = new Holds();
	const history = new History(join(dataDir, "history.sqlite"));
	const state = { openItems: new OpenItems(join(dataDir, "open-items.json")), workingSet: new WorkingSetFile(join(dataDir, "working-set.json")) };
	// Resolved once the thread is open; nothing below calls these before then.
	let thread: MainThread | undefined;
	let extensions: ExtensionSet | undefined;
	const main = () => thread!;

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
				prepare: (callContext) => japa.apply(callContext),
				// Files go on its computer; images are shown to the chief of staff too when its model takes them.
				receive: (message) => {
					const choice = settings.get().model;
					const model = choice === undefined ? undefined : models.getModel(choice.provider, choice.modelId);
					return toInput(message, { home, seesImages: model?.input.includes("image") === true });
				},
			});
			inboxes.set(platform, found);
		}
		return found;
	};
	const host: Host = {
		settings,
		secrets,
		dataDir,
		models,
		ui,
		holds,
		log,
		searchHistory: async (query, callContext) => {
			await indexHistory(main().root, history, callContext);
			return history.search(query);
		},
		wake: async (conversationId, text, { replyTo, id, from }) => {
			const root = main().root;
			if (conversationId !== String(root.id)) {
				await team.resume(root, conversationId, text, context);
				return;
			}
			// The chief of staff: addressed, so its answer goes to the user under the card that prompted it.
			const content = `[${stamp(Date.now(), settings.get().timezone)}] ${text}`;
			await root.commit((tx) => address(tx, root.id, { requestId: id, content, cause: { from, ...(replyTo === undefined ? {} : { replyTo }) } }), context);
		},
		emit: (event, detail) => void schedule.emit(main().root, event, detail, context).catch((error: unknown) => log(`trigger ${event}: ${String(error)}`)),
		// The core's own tools only touch the agent's own state (installing an extension asks the user by itself).
		safeTools: () => new Set([...coreTools, ...(extensions?.safeTools() ?? [])]),
		chiefId: () => String(main().root.id),
	};

	const stateTools = stateExtension(state);
	const team = delegationExtensions({
		openItems: state.openItems,
		settings: () => settings.get(),
		origin: (callContext) => main().origin(callContext),
		withhold: () => [main().core, stateTools, team.chief, schedule.extension, installs.extension, ...extensions!.withheldFromJobs()],
		waitingOnUser: (conversationId) => holds.has(String(conversationId)),
		thinking: (choice) => thinkingOf(models, choice),
	});
	const schedule = triggers({ triggers: () => extensions!.triggers(), timeZone: () => settings.get().timezone });
	const registry = createRegistry();
	const installs = installer({ host, dataDir, home, extensions: () => extensions!, registry, apply: (callContext) => japa.apply(callContext), problem: (about, text) => report(about, text), context });
	/** A problem with something japa runs: the chief of staff hears it once, and can have it fixed. Kept until it's open. */
	const early: Array<[string, string | undefined]> = [];
	const report = (about: string, text: string | undefined) => {
		if (thread === undefined) return void early.push([about, text]);
		const root = thread.root;
		void root.commit((tx) => problem(tx, root.id, about, text), context).catch((error: unknown) => log(`problem with ${about}: ${String(error)}`));
	};
	const set = new ExtensionSet(
		[...options.extensions(host), ...(await installs.loadInstalled())],
		settings,
		{ ui, inbox, problem: (entry, text) => report(`extension ${entry.name}`, text) },
		log,
	);
	extensions = set;
	// Its commands run here, in its home, without japa's own keys in their environment: a key a command needs is passed
	// to that command.
	const keys = set.entries.flatMap((entry) => (entry.settings ?? []).flatMap((field) => (field.kind === "secret" && field.env !== undefined ? [field.env] : [])));
	const computer = new NodeExecutionEnv({ cwd: home, shellEnv: { ...Object.fromEntries(keys.map((key) => [key, undefined])), HOME: home } });
	const core = [stateTools, team.chief, schedule.extension, installs.extension];
	const coreTools = [...core, team.job, team.helper].flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));

	thread = await MainThread.open(
		{
			dataDir,
			...(options.storage === undefined ? {} : { storage: options.storage }),
			models,
			registry,
			settings: () => settings.get(),
			installed: [...core, team.job, team.helper, ...set.entries],
			selected: () => [...core, ...set.forChief()],
			env: () => computer,
			state,
			onExchangeEnd: (exchange) => set.exchangeEnded(exchange),
			log,
		},
		context,
	);

	for (const [about, text] of early.splice(0)) report(about, text);

	const japa: Japa = {
		thread,
		host,
		extensions: set,
		apply: async (callContext) => {
			await main().applySettings(settings.get(), callContext);
			await set.sync();
			await schedule.sync(main().root, callContext);
		},
		close: async (callContext) => {
			await set.stopAll();
			await main().close(callContext);
			history.close();
		},
	};

	new SettingsMenu({
		settings,
		secrets,
		extensions: set,
		modelExists: (choice) => models.getModel(choice.provider, choice.modelId) !== undefined,
		available: async () =>
			(await models.getAvailable()).map((model) => ({ provider: model.provider, id: model.id, name: model.name, vision: model.input.includes("image") })),
		changed: () => japa.apply(context),
		thinkingLevels: (choice) => {
			const model = models.getModel(choice.provider, choice.modelId);
			return model === undefined ? ["off"] : getSupportedThinkingLevels(model);
		},
	}).attach(ui);
	attachLogin(ui, models);
	attachJobs(ui, {
		list: () => team.list(main(), context),
		detail: (id) => team.detail(main(), id, context),
		cancel: (id) => team.cancel(main(), id, "by the user, from /jobs", context),
		close: (id) => team.close(main(), id, "closed by the user, from /jobs", context),
	});
	// What the chief of staff sends on its own (results, questions, news) goes out as cards on whichever channel is on.
	await thread.deliverOutbox(async (message) => {
		return (await ui.show({ text: message.text, buzz: message.buzz, ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }) }))?.messageId;
	}, context);
	await japa.apply(context);
	log("japa: ready");
	return japa;
}
