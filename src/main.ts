// Open the main thread and start the channels. Configuration: data/settings.json (live), data/auth.json
// (model credentials, `npx @earendil-works/pi-ai login`), TELEGRAM_BOT_TOKEN in the environment.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { startTelegram } from "./channels/telegram.ts";
import { FileCredentialStore } from "./credentials.ts";
import { MainThread } from "./pi/harness.ts";
import { SettingsFile } from "./settings.ts";

const context = BACKGROUND_CONTEXT;
const dataDir = process.env.JARVIS_DATA ?? "data";
mkdirSync(dataDir, { recursive: true });

const settings = new SettingsFile(dataDir);
const models = builtinModels({ credentials: new FileCredentialStore(join(dataDir, "auth.json")) });
const thread = await MainThread.open({ dataDir, models, settings: () => settings.get() }, context);

const token = process.env.TELEGRAM_BOT_TOKEN;
if (token === undefined) throw new Error("Set TELEGRAM_BOT_TOKEN (from @BotFather).");
const bot = startTelegram({ token, thread, settings });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void bot.stop().finally(() => thread.close(context)).finally(() => process.exit(0));
	});
}
