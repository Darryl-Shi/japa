// Open the main thread and start the channels. Configuration: data/settings.json (live), data/auth.json
// (model credentials, `npx @earendil-works/pi-ai login`), TELEGRAM_BOT_TOKEN in the environment, and the home
// repo (JARVIS_HOME, default ~/jarvis-home) holding memory.md.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { startTelegram } from "./channels/telegram.ts";
import { History } from "./core/history.ts";
import { Portrait } from "./core/portrait.ts";
import { FileCredentialStore } from "./credentials.ts";
import { MainThread } from "./pi/harness.ts";
import { indexHistory, memoryExtension } from "./pi/memory.ts";
import { SettingsFile } from "./settings.ts";

const context = BACKGROUND_CONTEXT;
const dataDir = process.env.JARVIS_DATA ?? "data";
mkdirSync(dataDir, { recursive: true });

const settings = new SettingsFile(dataDir);
const models = builtinModels({ credentials: new FileCredentialStore(join(dataDir, "auth.json")) });
const history = new History(join(dataDir, "history.sqlite"));
const portrait = new Portrait(process.env.JARVIS_HOME ?? join(homedir(), "jarvis-home"));
const memory = memoryExtension({ portrait, history, catchUp: (callContext) => indexHistory(thread.root, history, callContext) });
const thread: MainThread = await MainThread.open({ dataDir, models, settings: () => settings.get(), extensions: [memory], log: console.log }, context);

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
