// Start the agent: the core (src/japa.ts) plus the default extensions. Everything it keeps is in one data directory
// (JAPA_DATA, default ./data): settings.json (live, also edited through /settings; the allowlist only here), auth.json
// (every login's credentials, model providers' and accounts', set with /login), and memory/ (its memory of the user:
// yours to read and edit, a git repo when it is one). Its computer, by default, is the machine it runs on: its tools
// run here, from the home directory of the user it runs as.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { telegramExtension } from "./channels/telegram.ts";
import { Approvals } from "./core/approvals.ts";
import { MemoryFile } from "./core/memory.ts";
import { FileCredentialStore, KeyEnvironment } from "./credentials.ts";
import { startJapa } from "./japa.ts";
import { approvalsExtension } from "./pi/approvals.ts";
import { localComputer } from "./pi/computer.ts";
import { memoryExtension } from "./pi/memory.ts";
import { screenExtension } from "./pi/screen.ts";
import { webExtension } from "./pi/web.ts";
import { SettingsFile } from "./settings.ts";

const context = BACKGROUND_CONTEXT;
const dataDir = resolve(process.env.JAPA_DATA ?? "data");
mkdirSync(dataDir, { recursive: true });
const settings = new SettingsFile(dataDir);
const log = (line: string) => console.log(line);
// The X display its screen is on: the one it's given, else the first one's, if the machine has a desktop.
const display = process.env.DISPLAY ?? ":0";
const credentials = new FileCredentialStore(join(dataDir, "auth.json"));
const keys = new KeyEnvironment();

const japa = await startJapa(
	{
		dataDir,
		settings,
		models: builtinModels({ credentials, authContext: keys }),
		credentials,
		keys,
		// The default extensions, by name, each of which can be turned off in /settings.
		extensions: {
			local: localComputer(homedir()),
			telegram: telegramExtension(log),
			memory: memoryExtension(new MemoryFile(join(dataDir, "memory")), log),
			// Its own code and data, on the machine it runs on.
			approvals: approvalsExtension(new Approvals(join(dataDir, "approvals.json"), join(dataDir, "audit.jsonl")), { code: [resolve(import.meta.dirname, "..")], data: [dataDir] }, log),
			web: webExtension(),
			screen: screenExtension({ display, hasDisplay: existsSync(`/tmp/.X11-unix/X${display.replace(/^.*:(\d+).*$/, "$1")}`) }),
		},
		log,
	},
	context,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => void japa.close(context).finally(() => process.exit(0)));
}
