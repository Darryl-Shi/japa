// Approvals as an extension: a tool_call handler before every tool call. In smart mode (the default) a fast model
// reviews each call and asks the user only for what matters: sending as them, spending, deleting, deploying, changing
// accounts. Only tools that say they stay in the agent's own world (pi's openWorldHint: false: its memory, open items,
// jobs) skip the review; files, the shell and the web are reviewed. A call that needs the user is blocked and its agent
// waits (pi's `terminate`): the user picks on a dialog, and the decision comes back to it as a message; an approved call
// then goes through exactly once. Standing permissions come only from the user ("Always") and are removed with
// /approvals. Requests are kept in a file, so one still waiting after a restart is asked again.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Models, ToolCall } from "@earendil-works/pi-ai";
import { type ApprovalRequest, type Approvals, canonical, type Decision } from "../core/approvals.ts";
import type { ModelChoice } from "../settings.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "./extension.ts";
import { reasoningOf } from "./models.ts";
import { parseJson } from "./state.ts";

type Options = { mode: "smart" | "always"; permissions: string[] };

const REVIEW_PROMPT = [
	"You review one action an AI assistant is about to take for the user, and decide whether the user must approve it first.",
	"Almost everything should go ahead: the user wants to be asked only about actions with an effect beyond the",
	"assistant's own computer that they'd want a say in. Ask when it would: send, post or reply to other people or",
	"anywhere public, as the user or on their behalf; spend or commit money; delete or change the user's own things (their",
	"email, calendar, documents, accounts, repositories elsewhere); push, deploy or publish, or change something live;",
	"change accounts, permissions or security settings. Everything else goes ahead without asking. That includes reading,",
	"searching, browsing, fetching and drafting, and anything on the assistant's own computer, where its commands and",
	"files run: creating, overwriting or deleting files at any path there (~, /home/..., /tmp, relative paths), cloning,",
	"installing, building, running tests and scripts. That computer is its own, so nothing there needs asking, except the",
	"assistant's own code and data (the paths below): changing anything in either needs asking, and so does reading its",
	"data, which holds its keys and settings; reading its code doesn't. If it's unclear whether something is the user's or the assistant's, it's the assistant's,",
	"unless the action names one of the user's accounts or services. Allow whatever a standing permission below covers.",
	"Return JSON only:",
	'{"ask": boolean, "summary": "what it would do, in a few plain words for the user", "rule": "the general kind of action, as a standing permission would name it"}',
].join(" ");

/** Where japa's own code and data are on its computer. */
export type Own = { code: readonly string[]; data: readonly string[] };

type Verdict = { ask: boolean; summary: string; rule: string };

/**
 * Ask the reviewing models in turn (each up to twice, since a provider can fail now and then) until one gives a
 * verdict. Only when none does is the user asked, saying the review failed. Exported for checking the prompt against
 * real models.
 */
export async function review(
	models: Models,
	choices: readonly (ModelChoice | undefined)[],
	call: ToolCall,
	given: { permissions: readonly string[]; own: Own },
	log: (line: string) => void = () => {},
): Promise<Verdict> {
	const { permissions } = given;
	const content = [
		`<own_code>\n${given.own.code.join("\n") || "(none)"}\n</own_code>`,
		`<own_data>\n${given.own.data.join("\n") || "(none)"}\n</own_data>`,
		`<standing_permissions>\n${permissions.join("\n") || "(none)"}\n</standing_permissions>`,
		`<action tool="${call.name}">\n${JSON.stringify(call.arguments).slice(0, 4000)}\n</action>`,
	].join("\n");
	const seen = new Set<string>();
	for (const choice of choices) {
		if (choice === undefined || seen.has(`${choice.provider}/${choice.modelId}`)) continue;
		seen.add(`${choice.provider}/${choice.modelId}`);
		const model = models.getModel(choice.provider, choice.modelId);
		if (model === undefined) {
			log(`approval review: no model ${choice.provider}/${choice.modelId}`);
			continue;
		}
		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				const answer = await models.completeSimple(model, { systemPrompt: REVIEW_PROMPT, messages: [{ role: "user", content, timestamp: Date.now() }] }, reasoningOf(models, choice));
				const text = answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
				const parsed = parseJson(text);
				if (parsed !== undefined && typeof parsed.ask === "boolean") {
					return { ask: parsed.ask, summary: String(parsed.summary ?? call.name), rule: String(parsed.rule ?? `Use ${call.name}`) };
				}
				log(`approval review of ${call.name} by ${model.id} failed: ${answer.stopReason === "error" ? answer.errorMessage : `no verdict in ${JSON.stringify(text.slice(0, 200))}`}`);
			} catch (error) {
				log(`approval review of ${call.name} by ${model.id} failed: ${String(error)}`);
			}
		}
	}
	return { ask: true, summary: `${call.name} (couldn't be reviewed automatically)`, rule: `Use ${call.name}` };
}

export const APPROVAL_PREFIX = "[Approval ";

/** The dialog that asks the user: what it would do, and the call itself. */
export function approvalTitle(request: ApprovalRequest): string {
	const args = request.args.length > 600 ? `${request.args.slice(0, 600)}…` : request.args;
	return `Approve? ${request.summary}\n\n${request.tool} ${args}`;
}

/** Its mode and standing permissions: its own file (what settings.json said, before there was one). */
function optionsFile(pi: ExtensionAPI) {
	const path = join(pi.dataDir, "approvals-options.json");
	const read = (): Options => {
		const saved = (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : pi.getSettings().extensions.approvals) as Partial<Options> | undefined;
		return { mode: saved?.mode === "always" ? "always" : "smart", permissions: Array.isArray(saved?.permissions) ? saved.permissions.map(String) : [] };
	};
	return {
		read,
		write: (change: Partial<Options>) => {
			writeFileSync(`${path}.tmp`, `${JSON.stringify({ ...read(), ...change }, null, "\t")}\n`);
			renameSync(`${path}.tmp`, path);
		},
	};
}

/** `own`: where japa's own code and data are on its computer, which no action touches without asking. */
export const approvalsExtension =
	(approvals: Approvals, own: Own = { code: [], data: [] }, log: (line: string) => void = () => {}): ExtensionFactory =>
	(pi) => {
		const options = optionsFile(pi);

		/** Tell whoever asked, once: their conversation gets the decision as a message. */
		const tell = (request: ApprovalRequest, decision: Decision) => {
			pi.sendUserMessage(decisionText(request, decision), { to: request.conversationId });
			approvals.update(request.id, { told: true });
		};

		const ask = async (request: ApprovalRequest, ctx: ExtensionContext) => {
			const offered = ["Approve", "Deny", `Always: ${request.rule}`.slice(0, 60)];
			const choice = await ctx.ui.select(approvalTitle(request), offered);
			if (choice === undefined) return;
			const decision: Decision = choice === offered[0] ? "approve" : choice === offered[2] ? "always" : "deny";
			const decided = approvals.decide(request.id, decision);
			if (decided === undefined) return;
			if (decision === "always") options.write({ permissions: [...options.read().permissions, decided.rule] });
			tell(decided, decision);
		};

		pi.on("tool_call", async (event, ctx) => {
			const conversationId = ctx.conversationId;
			if (conversationId === undefined) return;
			if (pi.getAllTools().find((tool) => tool.name === event.toolName)?.annotations?.openWorldHint === false) return;
			const args = canonical(event.input);
			if (approvals.consume(conversationId, event.toolName, args) !== undefined) return;
			const { mode, permissions } = options.read();
			const settings = pi.getSettings();
			const call: ToolCall = { type: "toolCall", id: event.toolCallId, name: event.toolName, arguments: event.input as ToolCall["arguments"] };
			const verdict =
				mode === "always" ? { ask: true, summary: event.toolName, rule: `Use ${event.toolName}` } : await review(ctx.modelRegistry, [settings.jobModels.fast, settings.model], call, { permissions, own }, log);
			if (!verdict.ask) {
				approvals.audit({ conversationId, tool: event.toolName, args, verdict: "allowed", summary: verdict.summary });
				return;
			}
			// Once per call: the same call again (its task retried) finds the same request, already asked.
			const asked = approvals.all().some((request) => request.taskId === event.toolCallId);
			const request = approvals.request({ taskId: event.toolCallId, conversationId, tool: event.toolName, args, summary: verdict.summary, rule: verdict.rule });
			if (!asked) void ask(request, ctx).catch((error: unknown) => log(`approval ${request.id}: ${String(error)}`));
			return {
				block: true,
				terminate: true,
				reason: `Needs the user's approval (${request.id}: ${request.summary}). They've been asked. Don't retry or work around it: end your turn with a short note. Their decision will come to you as a message starting "${APPROVAL_PREFIX}${request.id}".`,
			};
		});

		pi.registerCommand("approvals", {
			description: "How actions are approved, and standing permissions",
			handler: async (_args, ctx) => {
				for (;;) {
					const { mode, permissions } = options.read();
					const modeOption = mode === "smart" ? "Mode: smart (a fast model decides what to ask)" : "Mode: always (every action is asked)";
					const choice = await ctx.ui.select("Approvals: before anything that sends, spends, deletes, deploys or changes accounts, you're asked. Tap the mode to change it, a permission to remove it.", [
						modeOption,
						...permissions.map((permission) => `✕ ${permission}`),
						"Done",
					]);
					if (choice === undefined || choice === "Done") return ctx.ui.notify("Approvals saved.");
					if (choice === modeOption) options.write({ mode: mode === "smart" ? "always" : "smart" });
					else options.write({ permissions: permissions.filter((permission) => `✕ ${permission}` !== choice) });
				}
			},
		});

		// After a restart: still waiting on the user (asked again), or decided but never told.
		pi.on("session_start", (_event, ctx) => {
			for (const request of approvals.all()) {
				if (request.status === "pending") void ask(request, ctx).catch((error: unknown) => log(`approval ${request.id}: ${String(error)}`));
				else if (request.told !== true) tell(request, request.status === "denied" ? "deny" : "approve");
			}
		});
	};

/** What the agent is told when the user decides. */
export function decisionText(request: { id: string; tool: string; summary: string; rule: string }, decision: Decision): string {
	if (decision === "deny") return `${APPROVAL_PREFIX}${request.id}: denied] The user said no to: ${request.summary}. Don't do it; carry on without it or say what you'd do instead.`;
	const always = decision === "always" ? ` They also allowed this kind of action from now on: ${request.rule}.` : "";
	return `${APPROVAL_PREFIX}${request.id}: approved] Go ahead: call ${request.tool} again with exactly the same arguments.${always}`;
}
