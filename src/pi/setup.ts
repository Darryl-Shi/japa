// How the agent is set up, told to the chief of staff from live state so it stays true: where it runs, its models,
// its computer, its extensions (on or off), and how it can and can't be extended. Without it the agent guesses, e.g.
// that it is a stock Pi install hot-loading ~/.pi/agent/extensions.
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import type { Backend } from "../core/backend.ts";
import type { ModelChoice, Settings } from "../settings.ts";
import type { ExtensionSet } from "./extension.ts";

const CODE_DIR = resolve(import.meta.dirname, "../..");

function origin(): string | undefined {
	try {
		return execFileSync("git", ["-C", CODE_DIR, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

const name = (model: ModelChoice) => `${model.provider}/${model.modelId}`;

export function setupExtension(options: { settings: () => Settings; extensions: () => ExtensionSet; workbench: Backend | undefined; dataDir: string }): Extension {
	const repo = origin();
	const data = resolve(options.dataDir);
	return defineExtension({
		name: "jarvis.setup",
		sections: [
			section("setup", () => {
				const settings = options.settings();
				const set = options.extensions();
				const machine = settings.machines.workbench;
				const jobModels = Object.entries(settings.jobModels).map(([key, model]) => `${key} = ${name(model)}`);
				return [
					"How you are set up. This is the truth about yourself; don't guess beyond it.",
					`- You are japa, a Node service on the server ${hostname()}, running ${CODE_DIR}/src/main.ts${repo === undefined ? "" : ` (repo ${repo})`}.`,
					`  Settings: ${data}/settings.json; model credentials: ${data}/auth.json; extension keys: ${data}/secrets.json.`,
					"  None of your tools reach the server: the user changes settings with /settings.",
					`- Models: you run on ${name(settings.model)}; jobs default to ${name(settings.delegateModel)}${jobModels.length === 0 ? "" : `; named job models: ${jobModels.join(", ")}`}.`,
					"  Models come from pi-ai's built-in providers.",
					options.workbench === undefined || machine === undefined
						? "- You have no computer of your own."
						: `- Your computer (the workbench) is a separate ${machine.provider} machine, not the server you run on: nothing you write there changes you.`,
					"- Extensions (everything beyond the core of conversation, open items, the team and triggers), as the user sees them in /settings:",
					...set.entries.map((entry) => `  ${entry.title} (${set.enabled(entry) ? "on" : "off"})${entry.about === "" ? "" : `: ${entry.about}`}`),
					"- Extending yourself: an extension is TypeScript in the repo (a JarvisExtension, src/pi/extension.ts) listed in",
					"  src/main.ts; a new model provider is a change there too. Nothing hot-loads yet: a change lands in the repo, then",
					"  the user re-runs the installer, which pulls it and restarts you. So for a new capability, delegate a job to write",
					"  it in a clone of the repo and bring the user the diff to review. Never say something is installed until it is.",
				].join("\n");
			}),
		],
	});
}
