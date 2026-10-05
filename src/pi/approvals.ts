// Approvals as an extension: a hook before every tool call. In smart mode (the default) a fast model reviews each call
// that isn't marked safe and asks the user only for what matters: sending as them, spending, deleting, deploying,
// changing accounts. The call is blocked, not held: the agent ends its turn, the user taps a button, and the decision
// comes back as a message; an approved call then goes through exactly once. A job waiting on a decision is held, so
// its run ending isn't taken as its report. Standing permissions come only from the user (the "Always" button) and can be
// removed in /settings. The card is channel-neutral: whichever channel is on shows it.
import type { Models, ToolCall } from "@earendil-works/pi-ai";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { type ApprovalRequest, type Approvals, canonical, type Decision } from "../core/approvals.ts";
import type { Card } from "../core/ui.ts";
import type { Host, JapaExtension } from "./extension.ts";
import { parseJson } from "./state.ts";

const DEFAULTS = { mode: "smart", permissions: [] as string[] };

const REVIEW_PROMPT = [
	"You review one action an AI assistant is about to take for the user, and decide whether the user must approve it first.",
	"Almost everything should go ahead: the user wants to be asked only about actions with an effect beyond the",
	"assistant's own computer that they'd want a say in. Ask when it would: send, post or reply to other people or",
	"anywhere public, as the user or on their behalf; spend or commit money; delete or change the user's own things (their",
	"email, calendar, documents, accounts, repositories elsewhere); push, deploy or publish, or change something live;",
	"change accounts, permissions or security settings. Everything else goes ahead without asking. That includes reading,",
	"searching, browsing, fetching and drafting, and anything on the assistant's own computer, where its commands and",
	"files run: creating, overwriting or deleting files at any path there (~, /home/..., /tmp, relative paths), cloning,",
	"installing, building, running tests and scripts. That computer is its own, so nothing there needs asking. If it's",
	"unclear whether something is the user's or the assistant's, it's the assistant's, unless the action names one of the",
	"user's accounts or services. Allow whatever a standing permission below covers. Return JSON only:",
	'{"ask": boolean, "summary": "what it would do, in a few plain words for the user", "rule": "the general kind of action, as a standing permission would name it"}',
].join(" ");

type Verdict = { ask: boolean; summary: string; rule: string };

type ModelChoice = { provider: string; modelId: string };

/**
 * Ask the reviewing models in turn (each up to twice, since a provider can fail now and then) until one gives a
 * verdict. Only when none does is the user asked, saying the review failed. Exported for checking the prompt against
 * real models.
 */
export async function review(models: Models, choices: readonly (ModelChoice | undefined)[], call: ToolCall, permissions: readonly string[], log: (line: string) => void = () => {}): Promise<Verdict> {
	const content = [
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
				const answer = await models.completeSimple(model, { systemPrompt: REVIEW_PROMPT, messages: [{ role: "user", content, timestamp: Date.now() }] });
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

/** The card that asks the user: what it would do, and the call itself. */
export function approvalCard(request: ApprovalRequest, decision?: Decision): Card {
	const args = request.args.length > 600 ? `${request.args.slice(0, 600)}…` : request.args;
	const head = decision === undefined ? "Approve?" : decision === "deny" ? "Denied." : decision === "always" ? "Approved (and always from now on)." : "Approved.";
	return {
		text: `${head} ${request.summary}\n\n${request.tool} ${args}`,
		...(decision === undefined
			? { buttons: [[{ text: "Approve", data: `approvals:${request.id}:y` }, { text: "Deny", data: `approvals:${request.id}:n` }], [{ text: `Always: ${request.rule}`.slice(0, 60), data: `approvals:${request.id}:a` }]] }
			: {}),
	};
}

export function approvalsExtension(host: Host, approvals: Approvals): JapaExtension {
	const { settings } = host;

	const show = async (request: ApprovalRequest) => {
		const card = await host.ui.show(approvalCard(request));
		if (card !== undefined) approvals.update(request.id, { card });
	};

	/** Tell whoever asked, once: the chief of staff as a message from the user, a job agent as a new run of its job. */
	const tell = async (request: ApprovalRequest, decision: Decision) => {
		await host.wake(request.conversationId, decisionText(request, decision), { id: `approval:${request.id}`, from: "approvals", ...(request.card === undefined ? {} : { replyTo: request.card }) });
		approvals.update(request.id, { told: true });
		host.holds.remove(request.conversationId, request.id);
	};

	host.ui.handle("approvals", {
		press: async (payload, ref) => {
			const [id = "", choice] = payload.split(":");
			const decision: Decision = choice === "y" ? "approve" : choice === "a" ? "always" : "deny";
			const request = approvals.decide(id, decision);
			if (request === undefined) return;
			await host.ui.show(approvalCard(request, decision), ref);
			if (decision === "always") {
				const { permissions } = settings.options("approvals", DEFAULTS);
				settings.setOption("approvals", "permissions", [...(Array.isArray(permissions) ? permissions : []), request.rule]);
			}
			await tell(request, decision);
		},
	});

	const extension = defineExtension({
		name: "approvals",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api) => {
					if (host.safeTools().has(call.name)) return undefined;
					const args = canonical(call.arguments);
					const conversationId = String(api.conversationId);
					if (approvals.consume(conversationId, call.name, args) !== undefined) return undefined;
					const { mode, permissions } = settings.options("approvals", DEFAULTS);
					const all = settings.get();
					const verdict =
						mode === "always"
							? { ask: true, summary: call.name, rule: `Use ${call.name}` }
							: await review(host.models, [all.jobModels.fast, all.model], call, Array.isArray(permissions) ? permissions.map(String) : [], host.log);
					if (!verdict.ask) {
						approvals.audit({ conversationId, tool: call.name, args, verdict: "allowed", summary: verdict.summary });
						return undefined;
					}
					const request = approvals.request({ taskId: String(api.taskId), conversationId, tool: call.name, args, summary: verdict.summary, rule: verdict.rule });
					host.holds.add(conversationId, request.id);
					if (request.card === undefined) void show(request).catch((error: unknown) => host.log(`approval ${request.id}: ${String(error)}`));
					return {
						block: `Needs the user's approval (${request.id}: ${request.summary}). They've been asked with buttons. Don't retry or work around it: end your turn with a short note. Their decision will come to you as a message starting "${APPROVAL_PREFIX}${request.id}".`,
					};
				},
			}),
		],
	});

	return {
		...extension,
		title: "Approvals",
		about: "Before anything that sends, spends, deletes, deploys or changes accounts, you're asked with buttons. Smart: a fast model decides what needs asking. Always: every action outside the safe ones.",
		settings: [
			{ key: "mode", label: "Mode", kind: "choice", options: ["smart", "always"] },
			{ key: "permissions", label: "Standing permissions", kind: "list" },
		],
		defaults: DEFAULTS,
		// After a restart: still waiting on the user (hold the job; show the card if it never went out), or decided but
		// never told.
		start: async () => {
			for (const request of approvals.all()) {
				if (request.status === "pending") {
					host.holds.add(request.conversationId, request.id);
					if (request.card === undefined) await show(request);
				} else if (request.told !== true) await tell(request, request.status === "denied" ? "deny" : "approve");
			}
		},
	};
}

/** What the agent is told when the user decides. */
export function decisionText(request: { id: string; tool: string; summary: string; rule: string }, decision: Decision): string {
	if (decision === "deny") return `${APPROVAL_PREFIX}${request.id}: denied] The user said no to: ${request.summary}. Don't do it; carry on without it or say what you'd do instead.`;
	const always = decision === "always" ? ` They also allowed this kind of action from now on: ${request.rule}.` : "";
	return `${APPROVAL_PREFIX}${request.id}: approved] Go ahead: call ${request.tool} again with exactly the same arguments.${always}`;
}
