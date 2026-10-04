// Delegation: the main thread hands self-contained work to a background subagent and answers Darryl at once. The
// subagent has its own conversation (its own small context, the delegate model, the same computer). When it
// finishes, its report is recorded and delivered without waking the main model: the open item is updated, the
// report goes into the outbox (the channel delivers it as a reply to the message that asked), and a passive note
// lands in the main transcript. Only a report that needs Darryl's decision buzzes.
import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import { type ConversationId, configure, defineDoc, defineExtension, defineTask, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { OpenItems } from "../core/state.ts";
import type { ModelChoice } from "../settings.ts";

/** Where a reply goes. */
export type Origin = { chatId: number; messageId: number };

/** Messages waiting for the channel to deliver. Durable, so a restart doesn't lose a report. */
export type OutboxMessage = { text: string; replyTo?: Origin; buzz: boolean; itemId?: string; note?: string };
export const Outbox = defineDoc<{ messages: Record<string, OutboxMessage> }>({
	kind: "jarvis.outbox",
	version: 1,
	scope: "session",
	initial: () => ({ messages: {} }),
});

/** Prefix a subagent uses when it can't finish without Darryl. */
const DECISION = "DECISION NEEDED:";
const NOTE_CHARS = 1200;

const textOf = (message: AssistantMessage | undefined) => (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/** Owns a subagent's conversation; a background task, so the main thread's aborts and idle waits stop at it. */
const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "jarvis.delegation-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: { done: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context) },
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

type RunInput = { itemId: string; title: string; brief: string; conversationId: ConversationId; origin?: Origin };
type RunState = { phase: "run" } | { phase: "report"; report: string; decision: boolean };

export function delegationExtension(options: {
	openItems: OpenItems;
	delegateModel: () => ModelChoice;
	/** The Telegram message the main thread is answering right now. */
	origin: (context: Context) => Promise<Origin | undefined>;
	/** Extensions a subagent must not have (delegation itself, the main thread's state tools). */
	withhold: () => readonly Extension[];
}): Extension {
	const { openItems } = options;

	const Run = defineTask<RunInput, RunState, null>({
		name: "jarvis.delegation",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, context) => {
				const subagent = (await runtime.conversation(task.input.conversationId, context))!;
				const settled = await (await subagent.submit({ type: "input", content: task.input.brief, requestId: `delegation:${task.id}` }, context)).wait(context);
				let report: string;
				if (settled.status === "unanswered") report = settled.reason === "aborted" ? "Stopped." : `Failed: ${settled.reason}`;
				else if (settled.type !== "input") report = "Finished.";
				else {
					// The answer lives in the subagent's conversation, not this task's (the main thread's).
					const answer = (await runtime.context(task.input.conversationId, context)).entries.find((entry) => entry.id === settled.answer);
					report = textOf(answer?.model?.[0] as AssistantMessage | undefined) || "Finished.";
				}
				const decision = report.trimStart().startsWith(DECISION);
				if (decision) report = report.trimStart().slice(DECISION.length).trim();
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", report, decision } }), context);
			},
			report: async (task, runtime, context) => {
				const { itemId, title, origin } = task.input;
				const { report, decision } = task.state.checkpoint;
				// Idempotent, so a crash between here and the commit below only repeats harmless writes.
				if (decision) openItems.needsUser(itemId, `${title}: ${report.slice(0, 300)}`);
				else openItems.close(itemId, report.slice(0, 300));
				await runtime.commit(async (tx) => {
					(await tx.doc(Outbox)).messages[`report:${task.id}`] = {
						text: decision ? `${title}: needs you.\n\n${report}` : report,
						...(origin === undefined ? {} : { replyTo: origin }),
						buzz: decision,
						itemId,
						note: `[${decision ? "Needs Darryl" : "Done"}: ${itemId} ${title}] ${report.length > NOTE_CHARS ? `${report.slice(0, NOTE_CHARS)}…` : report}`,
					};
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

	/** Delegations started from the main thread, by open item: the subagent conversation and its run task. */
	const Delegations = defineDoc<{ byItem: Record<string, { conversationId: ConversationId }> }>({
		kind: "jarvis.delegations",
		version: 1,
		scope: "session",
		initial: () => ({ byItem: {} }),
	});

	return defineExtension({
		name: "jarvis.delegation",
		tasks: [Anchor, Run],
		tools: [
			defineTool({
				name: "delegate",
				description:
					"Hand self-contained work (research, multi-step tasks, anything that takes more than a minute or two) to a background subagent with its own computer. Returns at once; its report reaches Darryl as a reply to his message, and you'll see a note. The brief must stand alone: the subagent sees nothing of this conversation.",
				parameters: Type.Object({
					title: Type.String({ description: "A few words, shown to Darryl" }),
					brief: Type.String({ description: "Everything the subagent needs: goal, context, constraints, what to report back" }),
				}),
				// A rerun after a crash would start a second subagent; the model sees the interruption instead.
				replay: "unsafe",
				execute: async (args, api, context) => {
					const origin = await options.origin(context);
					const item = openItems.add("task", args.title, origin?.messageId);
					await api.commit(async (tx) => {
						const background = { ownership: { kind: "conversation" }, background: true } as const;
						const anchor = await tx.createTask(Anchor, null, background);
						const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
						await configure(tx, child.id, {
							model: options.delegateModel(),
							extensions: { remove: [...options.withhold()] },
							instructions: [
								`You are working on a delegated task for Darryl's chief of staff: "${args.title}".`,
								"Do the work, then answer with the result itself — what Darryl needs, concise and complete. No preamble.",
								`If you can't finish without a decision or information only Darryl has, end by starting your answer with "${DECISION}" followed by the question and the options.`,
							].join(" "),
						});
						(await tx.doc(Delegations)).byItem[item.id] = { conversationId: child.id };
						await tx.createTask(Run, { itemId: item.id, title: args.title, brief: args.brief, conversationId: child.id, ...(origin === undefined ? {} : { origin }) }, background);
					}, context);
					return { content: [{ type: "text", text: `Started as ${item.id}. Tell Darryl briefly; the report will come to him directly.` }] };
				},
			}),
			defineTool({
				name: "cancel_task",
				description: "Stop a delegated task by its open item id.",
				parameters: Type.Object({ id: Type.String() }),
				execute: async (args, api, context) => {
					const found = (await api.snapshot(Delegations, context))?.byItem[args.id];
					if (found === undefined) return { content: [{ type: "text", text: `No delegated task ${args.id}.` }] };
					await (await api.conversation(found.conversationId, context))?.abort(context);
					return { content: [{ type: "text", text: `Stopping ${args.id}.` }] };
				},
			}),
		],
	});
}
