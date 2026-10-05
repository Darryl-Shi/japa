// The core, assembled: the main thread (the chief of staff), open items, the team, the agent's computer, skills, the
// record of the conversation, the UI with its commands (japa's /settings and /jobs, and pi's /login, /logout, /model,
// /thinking and /session), and the installer. None of these can be turned off. Everything else is an extension: a pi
// extension factory, given pi's ExtensionAPI (src/pi/extension.ts), built-in or installed from chat alike. The agent's
// computer is the machine this runs on: its tools run here, in `home`.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { getSupportedThinkingLevels, type MutableModels } from "@earendil-works/pi-ai";
import { createRegistry, type Extension, type Storage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Inbox } from "./channels/inbox.ts";
import { attachJobs } from "./commands/jobs.ts";
import { attachLogin } from "./commands/login.ts";
import { attachSession } from "./commands/session.ts";
import { SettingsMenu } from "./commands/settings.ts";
import { History } from "./core/history.ts";
import { stamp } from "./core/schedule.ts";
import { OpenItems, WorkingSetFile } from "./core/state.ts";
import { type CardRef, Holds, UI } from "./core/ui.ts";
import type { SecretsFile } from "./credentials.ts";
import { toInput } from "./pi/attachments.ts";
import { computerExtension } from "./pi/computer.ts";
import { delegationExtensions } from "./pi/delegation.ts";
import { EventBus, type ExecResult, type ExtensionFactory, ExtensionSet, type Loaded, loadExtension, type Runtime, type ToolInfo } from "./pi/extension.ts";
import { MainThread } from "./pi/harness.ts";
import { historyExtension, indexHistory } from "./pi/history.ts";
import { address, problem } from "./pi/inputs.ts";
import { installer } from "./pi/installer.ts";
import { thinkingOf } from "./pi/models.ts";
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
		/** The agent's home on this machine: where its tools start and its files go. */
		home: string;
		settings: SettingsFile;
		secrets: SecretsFile;
		models: MutableModels;
		/** Default: SQLite in dataDir. */
		storage?: Storage;
		/** The built-in extensions, by name: each one's factory, as an installed one's default export is. */
		extensions: Readonly<Record<string, ExtensionFactory>>;
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

	/**
	 * A new turn in a conversation, once per `id`: the chief of staff (addressed from `from`; its answer goes to the user
	 * threaded under `replyTo`) or a job agent (a new run of its job, seen through as usual), which is no longer held.
	 */
	const wake = async (conversationId: string, text: string, { id, from, replyTo }: { id: string; from: string; replyTo?: CardRef }) => {
		holds.release(conversationId);
		const root = main().root;
		if (conversationId !== String(root.id)) {
			await team.resume(root, conversationId, text, context);
			return;
		}
		const content = `[${stamp(Date.now(), settings.get().timezone)}] ${text}`;
		await root.commit((tx) => address(tx, root.id, { requestId: id, content, cause: { from, ...(replyTo === undefined ? {} : { replyTo }) } }), context);
	};

	// Its commands run here, in its home, without japa's own keys in their environment: a key a command needs is passed
	// to that command. An extension's keys are taken out as it reads them.
	const shellEnv: Record<string, string | undefined> = { HOME: home };
	const computerEnv = new NodeExecutionEnv({ cwd: home, shellEnv });
	const exec = (command: string, args: string[], given: { signal?: AbortSignal; timeout?: number; cwd?: string } = {}) =>
		new Promise<ExecResult>((done) => {
			const env = Object.fromEntries(Object.entries({ ...process.env, ...shellEnv }).filter(([, value]) => value !== undefined));
			const child = spawn(command, args, { cwd: given.cwd ?? home, env, ...(given.signal === undefined ? {} : { signal: given.signal }), ...(given.timeout === undefined ? {} : { timeout: given.timeout }) });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => void (stdout += chunk.toString()));
			child.stderr.on("data", (chunk: Buffer) => void (stderr += chunk.toString()));
			child.on("error", (error) => done({ stdout, stderr: stderr || error.message, code: 1, killed: child.killed }));
			child.on("close", (code, signal) => done({ stdout, stderr, code: code ?? 1, killed: signal !== null }));
		});

	const runtime: Runtime = {
		ui,
		models,
		settings,
		secrets,
		dataDir,
		home,
		events: new EventBus(),
		chiefId: () => String(main().root.id),
		send: (text, { to, from }) => void wake(to ?? String(main().root.id), text, { id: `${from}:${randomUUID()}`, from }).catch((error: unknown) => log(`${from}: ${String(error)}`)),
		hold: (conversationId, reason) => holds.add(conversationId, reason),
		exec,
		tools: () => [...coreTools, ...(extensions?.tools() ?? [])],
		keyEnv: (name) => void (shellEnv[name] = undefined),
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
	const registry = createRegistry();
	const installs = installer({
		ui,
		tell: (text, id, replyTo) => wake(String(main().root.id), text, { id, from: "installer", ...(replyTo === undefined ? {} : { replyTo }) }),
		load: (name, factory) => loadExtension(name, factory, runtime),
		log,
		dataDir,
		home,
		extensions: () => extensions!,
		registry,
		apply: (callContext) => japa.apply(callContext),
		problem: (about, text) => report(about, text),
		context,
	});
	/** A problem with something japa runs: the chief of staff hears it once, and can have it fixed. Kept until it's open. */
	const early: Array<[string, string | undefined]> = [];
	const report = (about: string, text: string | undefined) => {
		if (thread === undefined) return void early.push([about, text]);
		const root = thread.root;
		void root.commit((tx) => problem(tx, root.id, about, text), context).catch((error: unknown) => log(`problem with ${about}: ${String(error)}`));
	};

	const builtIn: Loaded[] = [];
	for (const [name, factory] of Object.entries(options.extensions)) {
		try {
			builtIn.push(await loadExtension(name, factory, runtime));
		} catch (error) {
			report(`extension ${name}`, `it didn't load: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const set = new ExtensionSet([...builtIn, ...(await installs.loadInstalled())], settings, { ui, inbox, problem: (entry, text) => report(`extension ${entry.name}`, text) }, log);
	extensions = set;

	const record = historyExtension(async (query, callContext) => {
		await indexHistory(main().root, history, callContext);
		return history.search(query);
	});
	/** The chief of staff's own: job agents don't get them. */
	const chiefOnly: Extension[] = [stateTools, team.chief, installs.extension, record];
	// Every job agent gets these from the chief of staff: its computer, and its skills and standing instructions.
	const shared = [skillsExtension({ home, builtIn: join(CODE_DIR, "skills"), discovered: () => set.skillPaths() }), computerExtension({ code: CODE_DIR, data: dataDir })];
	const core = [...chiefOnly, ...shared];
	// The core's tools that stay in the agent's own world (its open items, its team, its record, installing, which asks
	// the user by itself) say so, as pi's tools do; its computer's don't.
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
			env: () => computerEnv,
			state,
			onExchangeEnd: (exchange) => set.exchangeEnded(exchange),
			log,
		},
		context,
	);

	for (const [about, text] of early.splice(0)) report(about, text);

	const japa: Japa = {
		thread,
		runtime,
		extensions: set,
		apply: async (callContext) => {
			await main().applySettings(settings.get(), callContext);
			await set.sync();
		},
		close: async (callContext) => {
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
	attachSession(ui, () => team.spend(main(), context));
	// What the chief of staff sends on its own (results, questions, news) goes out as cards on whichever channel is on.
	await thread.deliverOutbox(async (message) => {
		return (await ui.show({ text: message.text, buzz: message.buzz, ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }) }))?.messageId;
	}, context);
	await japa.apply(context);
	log("japa: ready");
	return japa;
}
