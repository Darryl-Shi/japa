// Addressed inputs: the one rule for where the chief of staff's words go. Every input it gets says who it's from
// (a Cause), and its answer goes back the way it came: to the user, threaded under what it answers. A message from
// the user is answered to the channel that brought it; anything else (a job's report, a trigger, a decision, a
// problem with an extension) is submitted by an Address task, which waits for the answer and puts it in the outbox.
// An empty answer says nothing, and an answer is sent once however many inputs it answered.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type ConversationId, defineDoc, defineTask, type Tx } from "@earendil-works/pi-durable";
import type { Content } from "../core/message.ts";
import type { CardRef } from "../core/ui.ts";

/** Messages waiting for the channel to deliver. Durable, so a restart doesn't lose one. */
export type OutboxMessage = { text: string; replyTo?: CardRef; buzz: boolean; itemId?: string };
export const Outbox = defineDoc<{ messages: Record<string, OutboxMessage> }>({
	kind: "jarvis.outbox",
	version: 1,
	scope: "session",
	initial: () => ({ messages: {} }),
});

/** Answers already sent: entry id and who sent it, so one answering several inputs goes out once. */
const Answered = defineDoc<{ entries: Array<[number, string]> }>({ kind: "jarvis.answered", version: 1, scope: "session", initial: () => ({ entries: [] }) });
const REMEMBERED = 500;

/**
 * Who an input is from and where its answer belongs. `quiet`: nothing to tell the user on its own (a progress
 * report); the answer is kept, not sent.
 */
export type Cause = { from: string; replyTo?: CardRef; itemId?: string; quiet?: boolean };

/** Claim an answer for sending; false if someone else sent it (the same claimant may send it again, after a restart). */
export async function claim(tx: Tx, entry: number, claimant: string): Promise<boolean> {
	const doc = await tx.doc(Answered);
	const found = doc.entries.find(([id]) => id === entry);
	if (found !== undefined) return found[1] === claimant;
	doc.entries.push([entry, claimant]);
	if (doc.entries.length > REMEMBERED) doc.entries.splice(0, doc.entries.length - REMEMBERED);
	return true;
}

const textOf = (message: AssistantMessage | undefined) => (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("").trim();

type Input = { requestId: string; content: Content; cause: Cause };
type State = { phase: "submit" } | { phase: "deliver"; answer?: number };

/** Submit an input to the chief of staff and send its answer back to whoever it's from. */
export const Address = defineTask<Input, State, null>({
	name: "jarvis.address",
	version: 1,
	initial: () => ({ phase: "submit" }),
	phases: {
		submit: async (task, runtime, context) => {
			const chief = (await runtime.conversation(task.conversationId, context))!;
			const settled = await (await chief.submit({ type: "input", content: task.input.content, requestId: task.input.requestId, whenBusy: "followUp" }, context)).wait(context);
			const answer = settled.status === "done" && settled.type === "input" ? Number(settled.answer) : undefined;
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "deliver", ...(answer === undefined ? {} : { answer }) } }), context);
		},
		deliver: async (task, runtime, context) => {
			const { answer } = task.state.checkpoint;
			const { cause } = task.input;
			const text = answer === undefined || cause.quiet === true ? "" : textOf((await runtime.context(task.conversationId, context)).entries.find((entry) => Number(entry.id) === answer)?.model?.[0] as AssistantMessage | undefined);
			await runtime.commit(async (tx) => {
				if (text !== "" && answer !== undefined && (await claim(tx, answer, `address:${task.input.requestId}`))) {
					(await tx.doc(Outbox)).messages[`answer:${answer}`] = {
						text,
						buzz: true,
						...(cause.replyTo === undefined ? {} : { replyTo: cause.replyTo }),
						...(cause.itemId === undefined ? {} : { itemId: cause.itemId }),
					};
				}
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** Address the chief of staff from any commit: the input, who it's from, and an id that makes it happen once. */
export async function address(tx: Tx, chief: ConversationId, input: Input): Promise<void> {
	await tx.createTask(Address, input, { ownership: { kind: "conversation" }, conversationId: chief, background: true });
}

export const PROBLEM_PREFIX = "[Problem with ";

/** The problems already reported, by what they're about, so each distinct one is heard once (across restarts too). */
const Problems = defineDoc<{ reported: Record<string, string> }>({ kind: "jarvis.problems", version: 1, scope: "session", initial: () => ({ reported: {} }) });

/**
 * A problem with something japa runs (an extension that won't start, a process that died), addressed to the chief
 * of staff, who can have it fixed; its answer goes to the user. Once per distinct problem; undefined: it works again.
 */
export async function problem(tx: Tx, chief: ConversationId, about: string, text: string | undefined): Promise<void> {
	const reported = (await tx.doc(Problems)).reported;
	if (text === undefined) {
		delete reported[about];
		return;
	}
	if (reported[about] === text) return;
	reported[about] = text;
	await address(tx, chief, { requestId: `problem:${about}:${Date.now()}`, content: `${PROBLEM_PREFIX}${about}] ${text}`, cause: { from: about } });
}
