// Start the agent: the core (src/japa.ts) plus the default extensions, on this machine, which is its computer: its
// tools run here, from the home directory of the user it runs as. Everything it keeps is in one data directory
// (JAPA_DATA, default ./data): settings.json (live, also edited through /settings; the allowlist only here), auth.json
// (model credentials, set with /login), secrets.json (extension keys, set from /settings or the environment), and
// memory/ (its memory of the user: yours to read and edit, a git repo when it is one).
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { telegramExtension } from "./channels/telegram.ts";
import { Approvals } from "./core/approvals.ts";
import { MemoryFile } from "./core/memory.ts";
import { FileCredentialStore, SecretsFile } from "./credentials.ts";
import { startJapa } from "./japa.ts";
import { approvalsExtension } from "./pi/approvals.ts";
import { memoryExtension } from "./pi/memory.ts";
import { screenExtension } from "./pi/screen.ts";
import { computerExtension } from "./pi/computer.ts";
import { webExtension } from "./pi/web.ts";
import { SettingsFile } from "./settings.ts";

const context = BACKGROUND_CONTEXT;
const dataDir = resolve(process.env.JAPA_DATA ?? "data");
mkdirSync(dataDir, { recursive: true });
const settings = new SettingsFile(dataDir);
// The X display its screen is on: the one it's given, else the first one's, if the machine has a desktop.
const display = process.env.DISPLAY ?? ":0";

const japa = await startJapa(
	{
		dataDir,
		home: homedir(),
		settings,
		secrets: new SecretsFile(join(dataDir, "secrets.json")),
		models: builtinModels({ credentials: new FileCredentialStore(join(dataDir, "auth.json")) }),
		// The default extensions, each of which can be turned off in /settings.
		extensions: (host) => [
			telegramExtension(host),
			memoryExtension(host, new MemoryFile(join(dataDir, "memory"))),
			approvalsExtension(host, new Approvals(join(dataDir, "approvals.json"), join(dataDir, "audit.jsonl"))),
			webExtension(host),
			computerExtension([resolve(import.meta.dirname, ".."), dataDir]),
			screenExtension({ display, hasDisplay: existsSync(`/tmp/.X11-unix/X${display.replace(/^.*:(\d+).*$/, "$1")}`) }),
		],
	},
	context,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => void japa.close(context).finally(() => process.exit(0)));
}
