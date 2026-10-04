// Open the main thread and start the channels. Configuration: data/settings.json (live, also edited through
// /settings), data/auth.json (model credentials, `npx @earendil-works/pi-ai login`), data/secrets.json (extension
// keys, set from /settings), TELEGRAM_BOT_TOKEN in the environment, and the home repo (JARVIS_HOME, default
// ~/jarvis-home) holding memory.md.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { boatProvider } from "./backends/boat.ts";
import { localProvider } from "./backends/local.ts";
import { SettingsMenu } from "./channels/settings-menu.ts";
import { startTelegram } from "./channels/telegram.ts";
import { Approvals } from "./core/approvals.ts";
import { BackendProviders } from "./core/backend.ts";
import { History } from "./core/history.ts";
import { Portrait } from "./core/portrait.ts";
import { OpenItems, WorkingSetFile } from "./core/state.ts";
import { FileCredentialStore, SecretsFile } from "./credentials.ts";
import { approvalsExtension, decisionText } from "./pi/approvals.ts";
import { BackendExecutionEnv } from "./pi/backend-env.ts";
import { CLAUDE_CODE, CODEX, codingAgentExtension } from "./pi/coding-agents.ts";
import { computerExtension } from "./pi/computer.ts";
import { delegationExtensions } from "./pi/delegation.ts";
import { ExtensionSet, type JarvisExtension } from "./pi/extension.ts";
import { MainThread } from "./pi/harness.ts";
import { indexHistory, memoryExtension } from "./pi/memory.ts";
import { shellExtension } from "./pi/shell.ts";
import { stateExtension } from "./pi/state.ts";
import { webExtension } from "./pi/web.ts";
import { SettingsFile } from "./settings.ts";

const context = BACKGROUND_CONTEXT;
const dataDir = process.env.JARVIS_DATA ?? "data";
mkdirSync(dataDir, { recursive: true });

const settings = new SettingsFile(dataDir);
const secrets = new SecretsFile(join(dataDir, "secrets.json"));
const models = builtinModels({ credentials: new FileCredentialStore(join(dataDir, "auth.json")) });
const history = new History(join(dataDir, "history.sqlite"));
const portrait = new Portrait(process.env.JARVIS_HOME ?? join(homedir(), "jarvis-home"));
const approvals = new Approvals(join(dataDir, "approvals.json"), join(dataDir, "audit.jsonl"));

// The one configured abstraction besides extensions: the computers the agent works on. Extensions can register providers.
const providers = new BackendProviders();
providers.register(localProvider);
if (process.env.BOAT_API_KEY !== undefined) providers.register(boatProvider({ apiKey: process.env.BOAT_API_KEY, stateFile: join(dataDir, "boat-machines.json") }));
const workbenchConfig = settings.get().machines.workbench;
const workbench = workbenchConfig === undefined ? undefined : await providers.open("workbench", workbenchConfig);
if (workbench !== undefined) console.log(`workbench: ${workbench.id}`);

// Everything else is an extension entry: what it gives the chief of staff, what it gives job agents, its settings.
const state = { openItems: new OpenItems(join(dataDir, "open-items.json")), workingSet: new WorkingSetFile(join(dataDir, "working-set.json")), memory: portrait };
const stateTools = stateExtension(state);
const memory = memoryExtension({ portrait, history, catchUp: (callContext) => indexHistory(thread.root, history, callContext) });
const team = delegationExtensions({
	openItems: state.openItems,
	settings: () => settings.get(),
	origin: (callContext) => thread.origin(callContext),
	withhold: () => [thread.core, ...extensions.withheldFromJobs()],
	waitingOnUser: (conversationId) => approvals.waiting(String(conversationId)),
});
const shell = workbench === undefined ? undefined : shellExtension();
const screen = workbench === undefined ? undefined : computerExtension({ backend: workbench });
const entries: JarvisExtension[] = [
	{
		name: "team",
		title: "Team",
		about: "Job agents the chief of staff delegates to, each on a model of its own, reporting back to it.",
		required: true,
		safeTools: ["delegate", "check_job", "cancel_job", "conclude_job", "message_user", "report", "subagent"],
		chief: [team.chief],
		jobs: [team.job, team.helper],
	},
	{
		name: "open-items",
		title: "Open items",
		about: "What's in flight, waiting on you, or promised; kept in every prompt.",
		required: true,
		safeTools: ["track", "resolve", "list_open_items"],
		chief: [stateTools],
	},
	{
		name: "memory",
		title: "Memory",
		about: `Its memory of you (${portrait.path}, yours to edit) and search over everything said before.`,
		safeTools: ["remember", "search_history"],
		chief: [memory],
	},
	approvalsExtension({ approvals, models, settings, safeTools: () => extensions.safeTools() }),
	webExtension({ settings, secrets }),
	...(workbench === undefined || shell === undefined || screen === undefined
		? []
		: [
				{
					name: "computer",
					title: "Computer",
					about: `Shell and files on its own machine (${workbench.id}), which holds none of your secrets.`,
					safeTools: ["read"],
					chief: [shell],
					jobs: [shell],
				},
				{
					name: "screen",
					title: "Screen",
					about: "Seeing and using the machine's desktop.",
					enabledByDefault: workbenchConfig?.screen === true,
					chief: [screen],
					jobs: [screen],
				},
			]),
	codingAgentExtension(CLAUDE_CODE, { workbench, settings, secrets }),
	codingAgentExtension(CODEX, { workbench, settings, secrets }),
];
const extensions = new ExtensionSet(entries, settings);

const thread: MainThread = await MainThread.open(
	{
		dataDir,
		models,
		settings: () => settings.get(),
		installed: extensions.installed(),
		selected: () => extensions.forChief(),
		...(workbench === undefined ? {} : { env: () => new BackendExecutionEnv(workbench) }),
		state,
		log: console.log,
	},
	context,
);

const token = process.env.TELEGRAM_BOT_TOKEN;
if (token === undefined) throw new Error("Set TELEGRAM_BOT_TOKEN (from @BotFather).");
const menu = new SettingsMenu({ settings, secrets, extensions, modelExists: (choice) => models.getModel(choice.provider, choice.modelId) !== undefined });
const telegram = startTelegram({ token, thread, settings, menu, approvals });

// The user's tap on an approval goes back to whoever asked: the chief of staff as a message from them, a job agent
// as a new run of its job.
const tell = async (request: ReturnType<Approvals["all"]>[number], decision: "approve" | "deny" | "always") => {
	const text = decisionText(request, decision);
	if (request.conversationId === String(thread.root.id)) {
		const chatId = settings.get().telegram.ownerChatId;
		if (chatId !== undefined) void telegram.tell(`approval:${request.id}`, text, { chatId, messageId: request.messageId ?? 0 });
	} else await team.resume(thread.root, request.conversationId, text, context);
	approvals.update(request.id, { told: true });
};
approvals.onDecision((request, decision) => {
	if (decision === "always") {
		const { permissions } = settings.options("approvals", { permissions: [] as string[] });
		settings.setOption("approvals", "permissions", [...permissions, request.rule]);
	}
	void tell(request, decision).catch((error: unknown) => console.log(`approval ${request.id}: ${String(error)}`));
});
// Decisions made just before a restart that never reached the agent.
for (const request of approvals.all()) {
	if (request.status !== "pending" && request.told !== true) void tell(request, request.status === "denied" ? "deny" : "approve").catch(() => {});
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void telegram.stop().finally(() => thread.close(context)).finally(() => {
			history.close();
			process.exit(0);
		});
	});
}
