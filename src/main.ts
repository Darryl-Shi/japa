// Open the main thread and start the channels. Configuration: data/settings.json (live), data/auth.json
// (model credentials, `npx @earendil-works/pi-ai login`), TELEGRAM_BOT_TOKEN in the environment, and the home
// repo (JARVIS_HOME, default ~/jarvis-home) holding memory.md.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { boatProvider } from "./backends/boat.ts";
import { localProvider } from "./backends/local.ts";
import { startTelegram } from "./channels/telegram.ts";
import { BackendProviders } from "./core/backend.ts";
import { History } from "./core/history.ts";
import { Portrait } from "./core/portrait.ts";
import { OpenItems, WorkingSetFile } from "./core/state.ts";
import { FileCredentialStore } from "./credentials.ts";
import { BackendExecutionEnv } from "./pi/backend-env.ts";
import { computerExtension } from "./pi/computer.ts";
import { delegationExtension } from "./pi/delegation.ts";
import { MainThread } from "./pi/harness.ts";
import { indexHistory, memoryExtension } from "./pi/memory.ts";
import { shellExtension } from "./pi/shell.ts";
import { stateExtension } from "./pi/state.ts";
import { SettingsFile } from "./settings.ts";

const context = BACKGROUND_CONTEXT;
const dataDir = process.env.JARVIS_DATA ?? "data";
mkdirSync(dataDir, { recursive: true });

const settings = new SettingsFile(dataDir);
const models = builtinModels({ credentials: new FileCredentialStore(join(dataDir, "auth.json")) });
const history = new History(join(dataDir, "history.sqlite"));
const portrait = new Portrait(process.env.JARVIS_HOME ?? join(homedir(), "jarvis-home"));
const memory = memoryExtension({ portrait, history, catchUp: (callContext) => indexHistory(thread.root, history, callContext) });
// Computers the agent works on. Providers are registered here; extensions can register more.
const providers = new BackendProviders();
providers.register(localProvider);
if (process.env.BOAT_API_KEY !== undefined) providers.register(boatProvider({ apiKey: process.env.BOAT_API_KEY, stateFile: join(dataDir, "boat-machines.json") }));
const workbenchConfig = settings.get().machines.workbench;
const workbench = workbenchConfig === undefined ? undefined : await providers.open("workbench", workbenchConfig);
if (workbench !== undefined) console.log(`workbench: ${workbench.id}`);

const state = { openItems: new OpenItems(join(dataDir, "open-items.json")), workingSet: new WorkingSetFile(join(dataDir, "working-set.json")) };
const stateTools = stateExtension(state);
const delegation = delegationExtension({
	openItems: state.openItems,
	delegateModel: () => settings.get().delegateModel,
	origin: (callContext) => thread.origin(callContext),
	// A subagent gets the same computer, but not the main thread's memory writes, open items, or delegation.
	withhold: () => [memory, stateTools, delegation],
});
const thread: MainThread = await MainThread.open(
	{
		dataDir,
		models,
		settings: () => settings.get(),
		extensions: [
			memory,
			stateTools,
			delegation,
			...(workbench === undefined ? [] : [shellExtension()]),
			...(workbench === undefined || workbenchConfig?.screen !== true ? [] : [computerExtension({ backend: workbench })]),
		],
		...(workbench === undefined ? {} : { env: () => new BackendExecutionEnv(workbench) }),
		state,
		log: console.log,
	},
	context,
);

const token = process.env.TELEGRAM_BOT_TOKEN;
if (token === undefined) throw new Error("Set TELEGRAM_BOT_TOKEN (from @BotFather).");
const bot = startTelegram({ token, thread, settings });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void bot.stop().finally(() => thread.close(context)).finally(() => {
			history.close();
			process.exit(0);
		});
	});
}
