// Start the agent: the core (src/japa.ts) plus the default extensions. Everything it keeps is in one data directory
// (JAPA_DATA, default ./data): settings.json (live, also edited through /settings; the allowlist only here), auth.json
// (model credentials, set with /login), secrets.json (extension keys, set from /settings or the environment), and
// memory/ (its memory of the user: yours to read and edit, a git repo when it is one).
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { boatExtension } from "./backends/boat.ts";
import { localExtension } from "./backends/local.ts";
import { telegramExtension } from "./channels/telegram.ts";
import { Approvals } from "./core/approvals.ts";
import { Portrait } from "./core/portrait.ts";
import { FileCredentialStore, SecretsFile } from "./credentials.ts";
import { startJapa } from "./japa.ts";
import { approvalsExtension } from "./pi/approvals.ts";
import { CLAUDE_CODE, CODEX, codingAgentExtension } from "./pi/coding-agents.ts";
import { memoryExtension } from "./pi/memory.ts";
import { workbenchExtensions } from "./pi/shell.ts";
import { webExtension } from "./pi/web.ts";
import { SettingsFile } from "./settings.ts";

const context = BACKGROUND_CONTEXT;
const dataDir = resolve(process.env.JAPA_DATA ?? "data");
mkdirSync(dataDir, { recursive: true });
const settings = new SettingsFile(dataDir);

const japa = await startJapa(
	{
		dataDir,
		settings,
		secrets: new SecretsFile(join(dataDir, "secrets.json")),
		models: builtinModels({ credentials: new FileCredentialStore(join(dataDir, "auth.json")) }),
		// The default extensions, each of which can be turned off in /settings.
		extensions: (host) => [
			telegramExtension(host),
			memoryExtension(host, new Portrait(join(dataDir, "memory"))),
			approvalsExtension(host, new Approvals(join(dataDir, "approvals.json"), join(dataDir, "audit.jsonl"))),
			webExtension(host),
			...workbenchExtensions(host, { screen: settings.get().machines.workbench?.screen === true }),
			codingAgentExtension(CLAUDE_CODE, host),
			codingAgentExtension(CODEX, host),
		],
	},
	context,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => void japa.close(context).finally(() => process.exit(0)));
}
