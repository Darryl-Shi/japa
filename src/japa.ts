// The core, assembled: the main thread (the chief of staff), open items, the team, triggers, the record of the
// conversation, the UI with /settings, /login and /jobs, and the installer. None of these can be turned off. Everything else is an extension, made from the
// Host this builds, and hooked in only through it: what it gives each agent, its settings, its safe tools, its slice
// end, its triggers, its lifecycle, and the channels, model providers and machines it adds through the core's adapters.
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { MutableModels } from "@earendil-works/pi-ai";
import { createRegistry, type Storage } from "@earendil-works/pi-durable";
import { Inbox } from "./channels/inbox.ts";
import { attachJobs } from "./channels/jobs.ts";
import { attachLogin } from "./channels/login.ts";
import { SettingsMenu } from "./channels/settings-menu.ts";
import type { Backend } from "./core/backend.ts";
import { History } from "./core/history.ts";
import { stamp } from "./core/schedule.ts";
import { OpenItems, WorkingSetFile } from "./core/state.ts";
import { Holds, UI } from "./core/ui.ts";
import type { SecretsFile } from "./credentials.ts";
import { toInput } from "./pi/attachments.ts";
import { BackendExecutionEnv } from "./pi/backend-env.ts";
import { delegationExtensions } from "./pi/delegation.ts";
import { ExtensionSet, type Host, type JapaExtension } from "./pi/extension.ts";
import { MainThread } from "./pi/harness.ts";
import { installer } from "./pi/installer.ts";
import { address } from "./pi/inputs.ts";
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
	const { dataDir, settings, secrets, models } = options;
	const log = options.log ?? ((line: string) => console.log(line));
	const ui = new UI(log);
	const holds = new Holds();
	const history = new History(join(dataDir, "history.sqlite"));
	const state = { openItems: new OpenItems(join(dataDir, "open-items.json")), workingSet: new WorkingSetFile(join(dataDir, "working-set.json")) };
	// Resolved once the thread is open; nothing below calls these before then.
	let thread: MainThread | undefined;
	let extensions: ExtensionSet | undefined;
	const main = () => thread!;

	// The workbench, opened through the backend its settings name, from the extensions that are on; opened again when
	// its settings change. Opening starts nothing remote.
	let opened: { key: string; backend: Backend } | undefined;
	let failed: string | undefined;
	const workbench = (): Backend | undefined => {
		const config = settings.get().machines.workbench;
		if (config === undefined) return undefined;
		const key = JSON.stringify(config);
		if (opened?.key === key) return opened.backend;
		const problem = (why: string) => {
			if (failed !== why) log(`workbench: ${why}`);
			failed = why;
			return undefined;
		};
		const open = extensions?.backend(config.provider);
		if (open === undefined) return problem(`no machine provider "${config.provider}" is on`);
		try {
			opened = { key, backend: open("workbench", config) };
		} catch (error) {
			return problem(error instanceof Error ? error.message : String(error));
		}
		failed = undefined;
		log(`workbench: ${opened.backend.id} (starts on first use)`);
		return opened.backend;
	};

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
				// Files go on the workbench; images are shown to the chief of staff too when its model takes them.
				receive: (message) => {
					const choice = settings.get().model;
					const model = choice === undefined ? undefined : models.getModel(choice.provider, choice.modelId);
					return toInput(message, { workbench: workbench(), seesImages: model?.input.includes("image") === true });
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
		workbench,
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
	});
	const schedule = triggers({ triggers: () => extensions!.triggers(), timeZone: () => settings.get().timezone });
	const registry = createRegistry();
	const installs = installer({ host, dataDir, extensions: () => extensions!, registry, apply: (callContext) => japa.apply(callContext), context });
	const set = new ExtensionSet([...options.extensions(host), ...(await installs.loadInstalled())], settings, { models, ui, inbox }, log);
	extensions = set;
	const core = [stateTools, team.chief, schedule.extension, installs.extension];
	const coreTools = [...core, team.job, team.helper].flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));

	thread = await MainThread.open(
		{
			dataDir,
			...(options.storage === undefined ? {} : { storage: options.storage }),
			models,
			registry,
			settings: () => settings.get(),
			installed: [...core, team.job, team.helper, ...set.installed()],
			selected: () => [...core, ...set.forChief()],
			env: () => {
				const backend = workbench();
				return backend === undefined ? undefined : new BackendExecutionEnv(backend);
			},
			state,
			onSliceEnd: (slice) => set.sliceEnded(slice),
			log,
		},
		context,
	);

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
