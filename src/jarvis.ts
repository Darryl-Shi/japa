// The core, assembled: the main thread (the chief of staff), open items, the team, triggers, the record of the
// conversation, the UI and /settings. None of these can be turned off. Everything else is an extension, made from the
// Host this builds, and hooked in only through it: what it gives each agent, its settings, its safe tools, its slice
// end, its triggers, its lifecycle. Channels are extensions too, and reach the agent only through an Inbox.
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { MutableModels } from "@earendil-works/pi-ai";
import { createRegistry, type Storage } from "@earendil-works/pi-durable";
import { Inbox } from "./channels/inbox.ts";
import { SettingsMenu } from "./channels/settings-menu.ts";
import type { Backend } from "./core/backend.ts";
import { History } from "./core/history.ts";
import { stamp } from "./core/schedule.ts";
import { OpenItems, WorkingSetFile } from "./core/state.ts";
import { Holds, UI } from "./core/ui.ts";
import type { SecretsFile } from "./credentials.ts";
import { BackendExecutionEnv } from "./pi/backend-env.ts";
import { type Delegation, delegationExtensions } from "./pi/delegation.ts";
import { ExtensionSet, type Host, type JarvisExtension } from "./pi/extension.ts";
import { MainThread } from "./pi/harness.ts";
import { installer } from "./pi/installer.ts";
import { indexHistory } from "./pi/memory.ts";
import { setupExtension } from "./pi/setup.ts";
import { stateExtension } from "./pi/state.ts";
import { triggers } from "./pi/triggers.ts";
import type { SettingsFile } from "./settings.ts";

/** Tools of the core that never need approval. */
const CORE_SAFE = ["track", "resolve", "list_open_items", "delegate", "check_job", "cancel_job", "conclude_job", "message_user", "report", "subagent", "install_extension", "remove_extension"];

export type Jarvis = {
	thread: MainThread;
	host: Host;
	extensions: ExtensionSet;
	team: Delegation;
	/** Apply settings changes: the model, extensions started or stopped, schedules for new triggers. */
	apply(context: Context): Promise<void>;
	close(context: Context): Promise<void>;
};

export async function startJarvis(
	options: {
		dataDir: string;
		settings: SettingsFile;
		secrets: SecretsFile;
		models: MutableModels;
		workbench?: Backend;
		/** Default: SQLite in dataDir. */
		storage?: Storage;
		extensions: (host: Host) => JarvisExtension[];
		log?: (line: string) => void;
	},
	context: Context,
): Promise<Jarvis> {
	const { dataDir, settings, secrets, models, workbench } = options;
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
	const host: Host = {
		settings,
		secrets,
		models,
		workbench,
		ui,
		holds,
		log,
		inbox: (platform) => {
			let inbox = inboxes.get(platform);
			if (inbox === undefined) {
				inbox = new Inbox({ platform, thread: main, settings, log, prepare: (callContext) => jarvis.apply(callContext) });
				inboxes.set(platform, inbox);
			}
			return inbox;
		},
		searchHistory: async (query, callContext) => {
			await indexHistory(main().root, history, callContext);
			return history.search(query);
		},
		wake: async (conversationId, text, { replyTo, id }) => {
			if (conversationId !== String(main().root.id)) {
				await team.resume(main().root, conversationId, text, context);
				return;
			}
			// The chief of staff: as if from the user, answered where the card that prompted it is.
			const target = { chatId: replyTo?.chatId ?? 0, messageId: replyTo?.messageId ?? 0, ...(replyTo === undefined ? {} : { channel: replyTo.channel }) };
			const answer = await main().ask(id, `[${stamp(Date.now(), settings.get().timezone)}] ${text}`, target, context);
			await ui.show({ text: "text" in answer ? answer.text : `Couldn't answer that: ${answer.error}`, ...(replyTo === undefined ? {} : { replyTo }) });
			await main().delivered(id, context);
		},
		emit: (event, detail) => void schedule.emit(main().root, event, detail, context).catch((error: unknown) => log(`trigger ${event}: ${String(error)}`)),
		safeTools: () => new Set([...CORE_SAFE, ...(extensions?.safeTools() ?? [])]),
		chiefId: () => String(main().root.id),
	};

	const stateTools = stateExtension(state);
	const setup = setupExtension({ settings: () => settings.get(), extensions: () => extensions!, workbench, dataDir });
	const team = delegationExtensions({
		openItems: state.openItems,
		settings: () => settings.get(),
		origin: (callContext) => main().origin(callContext),
		withhold: () => [main().core, setup, stateTools, team.chief, schedule.extension, installs.extension, ...extensions!.withheldFromJobs()],
		waitingOnUser: (conversationId) => holds.has(String(conversationId)),
	});
	const schedule = triggers({ triggers: () => extensions!.triggers(), timeZone: () => settings.get().timezone });
	const registry = createRegistry();
	const installs = installer({ host, dataDir, extensions: () => extensions!, registry, apply: (callContext) => jarvis.apply(callContext), context });
	const set = new ExtensionSet([...options.extensions(host), ...(await installs.loadInstalled())], settings, log);
	extensions = set;
	const core = [setup, stateTools, team.chief, schedule.extension, installs.extension];

	thread = await MainThread.open(
		{
			dataDir,
			...(options.storage === undefined ? {} : { storage: options.storage }),
			models,
			registry,
			settings: () => settings.get(),
			installed: [...core, team.job, team.helper, ...set.installed()],
			selected: () => [...core, ...set.forChief()],
			...(workbench === undefined ? {} : { env: () => new BackendExecutionEnv(workbench) }),
			state,
			onSliceEnd: (slice) => set.sliceEnded(slice),
			log,
		},
		context,
	);

	const jarvis: Jarvis = {
		thread,
		host,
		extensions: set,
		team,
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
		changed: () => jarvis.apply(context),
	}).attach(ui);
	// What the chief of staff sends on its own (results, questions, news) goes out as cards on whichever channel is on.
	await thread.deliverOutbox(async (message) => {
		const replyTo = message.replyTo === undefined ? undefined : { channel: message.replyTo.channel ?? "telegram", chatId: message.replyTo.chatId, messageId: message.replyTo.messageId };
		return (await ui.show({ text: message.text, buzz: message.buzz, ...(replyTo === undefined ? {} : { replyTo }) }))?.messageId;
	}, context);
	await jarvis.apply(context);
	return jarvis;
}
