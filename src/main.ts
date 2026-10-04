// Start the agent: the core (src/jarvis.ts) plus the default extensions. Configuration: data/settings.json (live, also
// edited through /settings; the allowlist only here), data/auth.json (model credentials, `npx @earendil-works/pi-ai
// login`), data/secrets.json (extension keys and the bot token, set from /settings or the environment), and the home
// repo (JARVIS_HOME, default ~/jarvis-home) holding memory.md.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { boatProvider } from "./backends/boat.ts";
import { localProvider } from "./backends/local.ts";
import { telegramExtension } from "./channels/telegram.ts";
import { Approvals } from "./core/approvals.ts";
import { BackendProviders } from "./core/backend.ts";
import { Portrait } from "./core/portrait.ts";
import { FileCredentialStore, SecretsFile } from "./credentials.ts";
import { startJarvis } from "./jarvis.ts";
import { approvalsExtension } from "./pi/approvals.ts";
import { CLAUDE_CODE, CODEX, codingAgentExtension } from "./pi/coding-agents.ts";
import { memoryExtension } from "./pi/memory.ts";
import { workbenchExtensions } from "./pi/shell.ts";
import { webExtension } from "./pi/web.ts";
import { SettingsFile } from "./settings.ts";

const context = BACKGROUND_CONTEXT;
const dataDir = process.env.JARVIS_DATA ?? "data";
mkdirSync(dataDir, { recursive: true });
const settings = new SettingsFile(dataDir);

// The one configured abstraction besides extensions: the computer the agent works on.
const providers = new BackendProviders();
providers.register(localProvider);
if (process.env.BOAT_API_KEY !== undefined) providers.register(boatProvider({ apiKey: process.env.BOAT_API_KEY, stateFile: join(dataDir, "boat-machines.json") }));
const workbenchConfig = settings.get().machines.workbench;
const workbench = workbenchConfig === undefined ? undefined : await providers.open("workbench", workbenchConfig);
if (workbench !== undefined) console.log(`workbench: ${workbench.id}`);

const jarvis = await startJarvis(
	{
		dataDir,
		settings,
		secrets: new SecretsFile(join(dataDir, "secrets.json")),
		models: builtinModels({ credentials: new FileCredentialStore(join(dataDir, "auth.json")) }),
		...(workbench === undefined ? {} : { workbench }),
		// The default extensions, each of which can be turned off in /settings.
		extensions: (host) => [
			telegramExtension(host),
			memoryExtension(host, new Portrait(process.env.JARVIS_HOME ?? join(homedir(), "jarvis-home"))),
			approvalsExtension(host, new Approvals(join(dataDir, "approvals.json"), join(dataDir, "audit.jsonl"))),
			webExtension(host),
			...workbenchExtensions(host, { screen: workbenchConfig?.screen === true }),
			codingAgentExtension(CLAUDE_CODE, host),
			codingAgentExtension(CODEX, host),
		],
	},
	context,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => void jarvis.close(context).finally(() => process.exit(0)));
}
