// Approvals as an extension: a hook before every tool call. In smart mode (the default) a fast model reviews each call
// that isn't marked safe and asks the user only for what matters: sending as them, spending, deleting, deploying,
// changing accounts. The call is blocked, not held: the agent ends its turn, the user taps a button, and the decision
// comes back as a message; an approved call then goes through exactly once. Standing permissions come only from the
// user (the "Always" button) and can be removed in /settings.
import type { Models, ToolCall } from "@earendil-works/pi-ai";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { type Approvals, canonical } from "../core/approvals.ts";
import type { SettingsFile } from "../settings.ts";
import type { JarvisExtension } from "./extension.ts";

const DEFAULTS = { mode: "smart", permissions: [] as string[] };

const REVIEW_PROMPT = [
	"You review one action an AI assistant is about to take for the user, and decide whether the user must approve it first.",
	"Ask when it would: send, post or reply to other people or anywhere public, as the user or on their behalf; spend or",
	"commit money; delete or overwrite something of the user's (not the assistant's own scratch work); deploy, publish or",
	"change something live; change accounts, permissions or security settings; or anything else that matters and can't be",
	"undone. Allow reading, searching, browsing, drafting, and work on the assistant's own computer (its files, code,",
	"installs, test runs, coding agents), which holds none of the user's accounts or secrets. Allow whatever a standing",
	"permission below covers. Return JSON only:",
	'{"ask": boolean, "summary": "what it would do, in a few plain words for the user", "rule": "the general kind of action, as a standing permission would name it"}',
].join(" ");

type Verdict = { ask: boolean; summary: string; rule: string };

async function review(models: Models, model: { provider: string; modelId: string }, call: ToolCall, permissions: readonly string[]): Promise<Verdict> {
	const fallback = { ask: true, summary: `${call.name}`, rule: `Use ${call.name}` };
	const resolved = models.getModel(model.provider, model.modelId);
	if (resolved === undefined) return fallback;
	const content = [
		`<standing_permissions>\n${permissions.join("\n") || "(none)"}\n</standing_permissions>`,
		`<action tool="${call.name}">\n${JSON.stringify(call.arguments).slice(0, 4000)}\n</action>`,
	].join("\n");
	try {
		const answer = await models.completeSimple(resolved, { systemPrompt: REVIEW_PROMPT, messages: [{ role: "user", content, timestamp: Date.now() }] });
		const raw = answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Partial<Verdict>;
		return { ask: parsed.ask !== false, summary: String(parsed.summary ?? fallback.summary), rule: String(parsed.rule ?? fallback.rule) };
	} catch {
		return fallback; // when in doubt, ask
	}
}

export const APPROVAL_PREFIX = "[Approval ";

export function approvalsExtension(options: {
	approvals: Approvals;
	models: Models;
	settings: SettingsFile;
	/** Tools that never need review (each extension declares its own). */
	safeTools: () => ReadonlySet<string>;
}): JarvisExtension {
	const { approvals, settings } = options;
	const extension = defineExtension({
		name: "jarvis.approvals",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api) => {
					if (options.safeTools().has(call.name)) return undefined;
					const args = canonical(call.arguments);
					const conversationId = String(api.conversationId);
					if (approvals.consume(conversationId, call.name, args) !== undefined) return undefined;
					const { mode, permissions } = settings.options("approvals", DEFAULTS);
					const all = settings.get();
					const verdict =
						mode === "always"
							? { ask: true, summary: call.name, rule: `Use ${call.name}` }
							: await review(options.models, all.jobModels.fast ?? all.model, call, Array.isArray(permissions) ? permissions.map(String) : []);
					if (!verdict.ask) {
						approvals.audit({ conversationId, tool: call.name, args, verdict: "allowed", summary: verdict.summary });
						return undefined;
					}
					const request = approvals.request({ taskId: String(api.taskId), conversationId, tool: call.name, args, summary: verdict.summary, rule: verdict.rule });
					return {
						block: `Needs the user's approval (${request.id}: ${request.summary}). They've been asked with buttons. Don't retry or work around it: end your turn with a short note. Their decision will come to you as a message starting "${APPROVAL_PREFIX}${request.id}".`,
					};
				},
			}),
		],
	});
	return {
		name: "approvals",
		title: "Approvals",
		about: "Before anything that sends, spends, deletes, deploys or changes accounts, you're asked with buttons. Smart: a fast model decides what needs asking. Always: every action outside the safe ones.",
		settings: [
			{ key: "mode", label: "Mode", kind: "choice", options: ["smart", "always"] },
			{ key: "permissions", label: "Standing permissions", kind: "list" },
		],
		defaults: DEFAULTS,
		chief: [extension],
		jobs: [extension],
	};
}

/** What the agent is told when the user decides. */
export function decisionText(request: { id: string; tool: string; summary: string; rule: string }, decision: "approve" | "deny" | "always"): string {
	if (decision === "deny") return `${APPROVAL_PREFIX}${request.id}: denied] The user said no to: ${request.summary}. Don't do it; carry on without it or say what you'd do instead.`;
	const always = decision === "always" ? ` They also allowed this kind of action from now on: ${request.rule}.` : "";
	return `${APPROVAL_PREFIX}${request.id}: approved] Go ahead: call ${request.tool} again with exactly the same arguments.${always}`;
}
