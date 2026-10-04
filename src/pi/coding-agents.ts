// Coding agents as default extensions: Claude Code and Codex, run headless on the workbench by a job agent. Each is
// installed on first use. A token or key set in /settings is passed to that one command and never written to the
// workbench; without one, the agent uses whatever login the workbench has.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { type Backend, shellQuote as q } from "../core/backend.ts";
import type { SecretsFile } from "../credentials.ts";
import type { SettingsFile } from "../settings.ts";
import type { JarvisExtension } from "./extension.ts";

const DEFAULTS = { model: "", timeoutMinutes: 60 };

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

type Engine = {
	name: "claude-code" | "codex";
	title: string;
	tool: string;
	install: string;
	/** The command for a task, optionally continuing a session. */
	command: (task: string, model: string, session: string | undefined) => string;
	secrets: ReadonlyArray<{ key: string; label: string; env: string }>;
	/** The answer and the session id from the command's output. */
	parse: (output: string) => { answer: string; session?: string; error?: string };
};

const lines = (output: string) =>
	output
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Record<string, unknown>];
			} catch {
				return [];
			}
		});

export const CLAUDE_CODE: Engine = {
	name: "claude-code",
	title: "Claude Code",
	tool: "claude_code",
	install: "command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1",
	command: (task, model, session) =>
		`IS_SANDBOX=1 claude -p ${q(task)} --output-format json --dangerously-skip-permissions${model === "" ? "" : ` --model ${q(model)}`}${session === undefined ? "" : ` --resume ${q(session)}`} </dev/null`,
	secrets: [
		{ key: "oauthToken", label: "Subscription token (claude setup-token)", env: "CLAUDE_CODE_OAUTH_TOKEN" },
		{ key: "apiKey", label: "Anthropic API key", env: "ANTHROPIC_API_KEY" },
	],
	parse: (output) => {
		const result = lines(output).findLast((line) => line.type === "result");
		if (result === undefined) return { answer: "", error: output.trim().slice(-2000) || "no output" };
		const answer = typeof result.result === "string" ? result.result : "";
		const session = typeof result.session_id === "string" ? result.session_id : undefined;
		return { answer, ...(session === undefined ? {} : { session }), ...(result.is_error === true ? { error: answer || String(result.subtype) } : {}) };
	},
};

export const CODEX: Engine = {
	name: "codex",
	title: "Codex",
	tool: "codex",
	install: "command -v codex >/dev/null || npm install -g @openai/codex >/dev/null 2>&1",
	command: (task, model, session) =>
		`codex exec${session === undefined ? "" : ` resume ${q(session)}`} --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check${model === "" ? "" : ` -m ${q(model)}`} ${q(task)} </dev/null`,
	secrets: [{ key: "apiKey", label: "OpenAI API key", env: "CODEX_API_KEY" }],
	parse: (output) => {
		const events = lines(output);
		const thread = events.find((event) => event.type === "thread.started")?.thread_id;
		const messages = events.flatMap((event) => {
			const item = event.item as Record<string, unknown> | undefined;
			return event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string" ? [item.text] : [];
		});
		const failed = events.findLast((event) => event.type === "turn.failed" || event.type === "error");
		const error = failed === undefined ? undefined : String((failed.error as { message?: string } | undefined)?.message ?? failed.message ?? "failed");
		return {
			answer: messages.at(-1) ?? "",
			...(typeof thread === "string" ? { session: thread } : {}),
			...(error === undefined ? (messages.length === 0 ? { error: output.trim().slice(-2000) || "no output" } : {}) : { error }),
		};
	},
};

export function codingAgentExtension(engine: Engine, options: { workbench: Backend | undefined; settings: SettingsFile; secrets: SecretsFile }): JarvisExtension {
	const extension = defineExtension({
		name: `jarvis.${engine.name}`,
		sections: [
			section(
				`${engine.tool}_guide`,
				() =>
					`${engine.title} (the ${engine.tool} tool) is a coding agent on your computer: give it a whole coding task and a directory; it works there and answers when done. Use it for code; check its answer against the files. Pass the session it returns to follow up on the same work.`,
				{ tag: false },
			),
		],
		tools: [
			defineTool({
				name: engine.tool,
				description: `Run ${engine.title} on a coding task in a directory on your computer; returns its answer and a session id to continue.`,
				parameters: Type.Object({
					task: Type.String({ description: "The whole task: goal, constraints, how to check it's done" }),
					dir: Type.Optional(Type.String({ description: "Working directory (created if missing); default ~/work" })),
					session: Type.Optional(Type.String({ description: "A session id from an earlier run, to continue it" })),
				}),
				execute: async (args, _api, context) => {
					const workbench = options.workbench;
					if (workbench === undefined) return text("No computer is configured, so there's nowhere to run it.");
					const { model, timeoutMinutes } = options.settings.options(engine.name, DEFAULTS);
					const env: Record<string, string> = {};
					for (const secret of engine.secrets) {
						const value = options.secrets.get(`${engine.name}.${secret.key}`, secret.env);
						if (value !== undefined) env[secret.env] = value;
					}
					const dir = args.dir ?? "work";
					const command = `export PATH="$HOME/.local/bin:$PATH"; ${engine.install}; mkdir -p ${q(dir)} && cd ${q(dir)} && ${engine.command(args.task, String(model), args.session)}`;
					let output = "";
					const { exitCode, timedOut } = await workbench.exec(command, {
						env,
						timeoutMs: Number(timeoutMinutes) * 60_000,
						onOutput: (chunk) => (output += chunk),
						signal: context.abortSignal,
					});
					const parsed = engine.parse(output);
					const session = parsed.session === undefined ? "" : `\n\n(session ${parsed.session})`;
					if (timedOut === true) return text(`${engine.title} ran out of time after ${timeoutMinutes} minutes.${session}`);
					if (parsed.error !== undefined) return text(`${engine.title} failed (exit ${exitCode}): ${parsed.error}${session}`);
					return text(`${parsed.answer}${session}`);
				},
			}),
		],
	});
	return {
		name: engine.name,
		title: engine.title,
		about: `${engine.title} as a coding agent for job agents, on the workbench. A key set here is passed per run, never stored there.`,
		settings: [
			{ key: "model", label: "Model (blank: its default)", kind: "text" },
			{ key: "timeoutMinutes", label: "Time limit (minutes)", kind: "number" },
			...engine.secrets.map((secret) => ({ ...secret, kind: "secret" as const })),
		],
		defaults: DEFAULTS,
		jobs: [extension],
	};
}
