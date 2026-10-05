// Delegation. The user only ever talks to the chief of staff (the main thread). The chief of staff hands work to a
// job agent: one per job, with a model assigned to that job, its own small conversation, the same computer, and
// subagents of its own when the work splits. The job agent decides when to report; a report wakes the chief of
// staff, which synthesizes and decides what the user hears (message_user). Jobs never vanish: only the chief of staff
// concludes one, once the user has accepted or dropped it, and a job agent that goes quiet is reported automatically.
import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import { type Conversation, type ConversationId, configure, defineDoc, defineExtension, defineTask, defineTool, type Extension, section, type Tx } from "@earendil-works/pi-durable";
import type { OpenItems } from "../core/state.ts";
import type { ModelChoice } from "../settings.ts";

/** Where a reply goes. */
export type Origin = { chatId: number; messageId: number; channel?: string };

/** Messages waiting for the channel to deliver. Durable, so a restart doesn't lose one. */
export type OutboxMessage = { text: string; replyTo?: Origin; buzz: boolean; itemId?: string };
export const Outbox = defineDoc<{ messages: Record<string, OutboxMessage> }>({
	kind: "jarvis.outbox",
	version: 1,
	scope: "session",
	initial: () => ({ messages: {} }),
});

type Job = {
	id: string;
	title: string;
	conversationId: ConversationId;
	/** Who it reports to: the chief of staff, or the job that started it. */
	parentConversationId: ConversationId;
	/** 1: a job; 2: a job's subagent (no subagents of its own). */
	depth: 1 | 2;
	model: ModelChoice;
	origin?: Origin;
	status: "working" | "reported" | "concluded" | "cancelled";
	lastReportAt?: number;
};
const Jobs = defineDoc<{ jobs: Record<string, Job> }>({ kind: "jarvis.jobs", version: 1, scope: "session", initial: () => ({ jobs: {} }) });

/** The prefix of a report as it reaches its parent, so the main thread can tell reports from the user. */
export const REPORT_PREFIX = "[Report from job ";

const textOf = (message: AssistantMessage | undefined) => (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
const background = { ownership: { kind: "conversation" }, background: true } as const;

/** Owns a job's conversation; a background task, so the chief of staff's aborts and idle waits stop at it. */
const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "jarvis.job-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: { done: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context) },
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

function reportText(job: Job, kind: string, text: string): string {
	return `${REPORT_PREFIX}${job.id} "${job.title}" — ${kind}] ${text}`;
}

/** Send a message to a job and see it through; if the job agent ends its run without reporting, report for it. */
type RunInput = { jobId: string; message: string; startedAt: number };
type RunState = { phase: "run" } | { phase: "report"; text?: string };
const makeRun = (waitingOnUser: (conversationId: ConversationId) => boolean) => defineTask<RunInput, RunState, null>({
	name: "jarvis.job-run",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, context) => {
			const job = (await runtime.snapshot(Jobs, context))?.jobs[task.input.jobId];
			if (job === undefined) return void (await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context));
			const conversation = (await runtime.conversation(job.conversationId, context))!;
			const settled = await (await conversation.submit({ type: "input", content: task.input.message, requestId: `job-run:${task.id}`, whenBusy: "followUp" }, context)).wait(context);
			const current = (await runtime.snapshot(Jobs, context))?.jobs[job.id];
			let text: string | undefined;
			if (current?.status === "cancelled" || current?.status === "concluded") text = undefined;
			else if ((current?.lastReportAt ?? 0) >= task.input.startedAt) text = undefined; // it reported itself
			else if (waitingOnUser(job.conversationId)) text = undefined; // paused on the user's approval, which resumes it
			else if (settled.status === "unanswered") text = settled.reason === "aborted" ? undefined : `Failed: ${settled.reason}`;
			else if (settled.type === "input") {
				const answer = (await runtime.context(job.conversationId, context)).entries.find((entry) => entry.id === settled.answer);
				text = `Went quiet without reporting. Its last words: ${textOf(answer?.model?.[0] as AssistantMessage | undefined) || "(nothing)"}`;
			}
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", ...(text === undefined ? {} : { text }) } }), context);
		},
		report: async (task, runtime, context) => {
			const text = task.state.checkpoint.text;
			const job = (await runtime.snapshot(Jobs, context))?.jobs[task.input.jobId];
			if (text !== undefined && job !== undefined) {
				const parent = await runtime.conversation(job.parentConversationId, context);
				await parent?.submit({ type: "input", content: reportText(job, "automatic", text), requestId: `auto-report:${task.id}`, whenBusy: "followUp" }, context);
			}
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

const CHIEF_GUIDE = [
	"You run a team. delegate hands a self-contained job to a job agent (its own computer and model; pick a model",
	"name only when the job needs it). Job agents can have tools you don't, such as coding agents: hand them coding work.",
	"Job agents report back to you as messages starting with \"[Report from job\" —",
	"those are your team, not the user, and your reply to them goes nowhere. On a report: check it, ask the job agent",
	"more (check_job with a question) or redirect it if it's thin or wrong, and connect it with other jobs and what",
	"you know of the user. Then decide what they hear: message_user (now, or silent when it can wait), or nothing yet.",
	"Don't break into an unrelated conversation with non-urgent news; mention it at a natural opening. A job stays",
	"open until the user has accepted the result or dropped it; only then conclude_job. Messages starting \"[Trigger\" are",
	"your own schedule or an event, not the user: do what they ask and, as with reports, decide what the user hears.",
].join(" ");

const JOB_GUIDE = [
	"You are a job agent working for the user's chief of staff on one job. You decide when to report: call report when",
	"the job is done, when you're stuck, when you need a decision, or at milestones of long work. A report should",
	"stand alone: the result itself, how sure you are, and where the details are (files on your computer, sources).",
	"For work that splits into independent parts, use subagent; their results come back to you as reports.",
].join(" ");

export type Delegation = {
	/** The chief of staff's tools: delegate, check_job, cancel_job, conclude_job, message_user (and the tasks). */
	chief: Extension;
	/** A job agent's tools: report, subagent. */
	job: Extension;
	/** Report only: for a job's subagents (and selected alongside `job` for job agents). */
	helper: Extension;
	/** Send a message to a job (e.g. the user's decision on its approval); it's seen through like any other run. */
	resume: (root: Conversation, conversationId: string, message: string, context: Context) => Promise<boolean>;
};

export function delegationExtensions(options: {
	openItems: OpenItems;
	settings: () => { delegateModel: ModelChoice; jobModels: Record<string, ModelChoice> };
	/** The chat message the chief of staff is answering right now. */
	origin: (context: Context) => Promise<Origin | undefined>;
	/** What a new job agent must not have (the chief of staff's own extensions, anything turned off). */
	withhold: () => readonly Extension[];
	/** A job paused on something only the user can give (an approval) isn't reported as gone quiet. */
	waitingOnUser?: (conversationId: ConversationId) => boolean;
}): Delegation {
	const { openItems } = options;
	const Run = makeRun(options.waitingOnUser ?? (() => false));

	/** Create a job's conversation and send it its brief, in one commit. */
	const startJob = async (tx: Tx, job: Omit<Job, "conversationId" | "status">, brief: string, withhold: readonly Extension[]) => {
		const anchor = await tx.createTask(Anchor, null, background);
		const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
		await configure(tx, conversation.id, { model: job.model, extensions: { remove: [...withhold] }, instructions: `Your job (${job.id}): "${job.title}".` });
		(await tx.doc(Jobs)).jobs[job.id] = { ...job, conversationId: conversation.id, status: "working" };
		await tx.createTask(Run, { jobId: job.id, message: brief, startedAt: Date.now() }, background);
	};

	const helper = defineExtension({
		name: "jarvis.job-report",
		sections: [section("job_guide", () => JOB_GUIDE, { tag: false })],
		tools: [
			defineTool({
				name: "report",
				description: "Report to whoever gave you this job: done, stuck, a decision needed, or a milestone. The job stays yours until they conclude it.",
				parameters: Type.Object({
					kind: Type.Union([Type.Literal("done"), Type.Literal("stuck"), Type.Literal("decision needed"), Type.Literal("progress")]),
					text: Type.String(),
				}),
				execute: async (args, api, context) => {
					const job = Object.values((await api.snapshot(Jobs, context))?.jobs ?? {}).find((candidate) => candidate.conversationId === api.conversationId);
					if (job === undefined) return reply("You're not on a job.");
					await api.commit(async (tx) => {
						const stored = (await tx.doc(Jobs)).jobs[job.id];
						if (stored !== undefined && stored.status === "working") stored.status = "reported";
						if (stored !== undefined) stored.lastReportAt = Date.now();
					}, context);
					const parent = await api.conversation(job.parentConversationId, context);
					await parent?.submit({ type: "input", content: reportText(job, args.kind, args.text), requestId: `report:${api.taskId}`, whenBusy: "followUp" }, context);
					return reply("Reported.");
				},
			}),
		],
	});

	const job: Extension = defineExtension({
		name: "jarvis.job",
		tools: [
			defineTool({
				name: "subagent",
				description: "Hand an independent part of your job to a subagent (same model and computer). Its result comes back to you as a report.",
				parameters: Type.Object({ title: Type.String(), brief: Type.String({ description: "Everything it needs; it sees nothing else" }) }),
				replay: "unsafe",
				execute: async (args, api, context) => {
					const jobs = (await api.snapshot(Jobs, context))?.jobs ?? {};
					const parent = Object.values(jobs).find((candidate) => candidate.conversationId === api.conversationId);
					if (parent === undefined) return reply("You're not on a job.");
					const id = `${parent.id}.${Object.values(jobs).filter((candidate) => candidate.parentConversationId === api.conversationId).length + 1}`;
					await api.commit((tx) => startJob(tx, { id, title: args.title, parentConversationId: api.conversationId, depth: 2, model: parent.model }, args.brief, [...options.withhold(), job]), context);
					return reply(`Started subagent ${id}.`);
				},
			}),
		],
	});

	const chief: Extension = defineExtension({
		name: "jarvis.delegation",
		tasks: [Anchor, Run],
		sections: [section("team", () => CHIEF_GUIDE, { tag: false })],
		tools: [
			defineTool({
				name: "delegate",
				description: "Start a job: self-contained work (research, multi-step tasks, anything over a minute or two) for a job agent with its own computer. Returns at once. The brief must stand alone: the agent sees nothing of this conversation.",
				parameters: Type.Object({
					title: Type.String({ description: "A few words" }),
					brief: Type.String({ description: "Goal, context, constraints, what to report back" }),
					model: Type.Optional(Type.String({ description: "A model name for this job, if it needs a specific one" })),
				}),
				replay: "unsafe",
				execute: async (args, api, context) => {
					const settings = options.settings();
					const model = args.model === undefined ? settings.delegateModel : settings.jobModels[args.model];
					if (model === undefined) return reply(`No model named ${args.model}; choose from: ${Object.keys(settings.jobModels).join(", ")}.`);
					const origin = await options.origin(context);
					const item = openItems.add("task", args.title, origin?.messageId);
					const job1 = { id: item.id, title: args.title, parentConversationId: api.conversationId, depth: 1 as const, model, ...(origin === undefined ? {} : { origin }) };
					await api.commit((tx) => startJob(tx, job1, args.brief, options.withhold()), context);
					return reply(`Started job ${item.id}.`);
				},
			}),
			defineTool({
				name: "check_job",
				description: "A job's status. With a question, the job agent is asked and answers with a report.",
				parameters: Type.Object({ id: Type.String(), question: Type.Optional(Type.String()) }),
				execute: async (args, api, context) => {
					const jobs = (await api.snapshot(Jobs, context))?.jobs ?? {};
					const found = jobs[args.id];
					if (found === undefined) return reply(`No job ${args.id}.`);
					if (args.question !== undefined) {
						await api.commit((tx) => tx.createTask(Run, { jobId: found.id, message: `From the chief of staff: ${args.question}`, startedAt: Date.now() }, background), context);
						return reply(`Asked ${found.id}; the answer will come as a report.`);
					}
					const lines = [`${found.id} "${found.title}": ${found.status}${found.lastReportAt === undefined ? "" : `, last report ${new Date(found.lastReportAt).toISOString().slice(0, 16)}`}, model ${found.model.modelId}`];
					for (const sub of Object.values(jobs).filter((candidate) => candidate.parentConversationId === found.conversationId)) lines.push(`  ${sub.id} "${sub.title}": ${sub.status}`);
					return reply(lines.join("\n"));
				},
			}),
			defineTool({
				name: "cancel_job",
				description: "Stop a job and its subagents; it is concluded as cancelled.",
				parameters: Type.Object({ id: Type.String(), reason: Type.Optional(Type.String()) }),
				execute: async (args, api, context) => {
					const jobs = (await api.snapshot(Jobs, context))?.jobs ?? {};
					const found = jobs[args.id];
					if (found === undefined) return reply(`No job ${args.id}.`);
					const family = Object.values(jobs).filter((each) => each.id === found.id || each.id.startsWith(`${found.id}.`));
					await api.commit(async (tx) => {
						const all = (await tx.doc(Jobs)).jobs;
						for (const each of family) if (all[each.id] !== undefined) all[each.id]!.status = "cancelled";
					}, context);
					for (const each of family) await (await api.conversation(each.conversationId, context))?.abort(context);
					openItems.close(found.id, `cancelled${args.reason === undefined ? "" : `: ${args.reason}`}`);
					return reply(`Cancelled ${found.id}.`);
				},
			}),
			defineTool({
				name: "conclude_job",
				description: "Close a job once the user has accepted the result or dropped it. Never before.",
				parameters: Type.Object({ id: Type.String(), outcome: Type.String() }),
				execute: async (args, api, context) => {
					if ((await api.snapshot(Jobs, context))?.jobs[args.id] === undefined) return reply(`No job ${args.id}.`);
					await api.commit(async (tx) => {
						const stored = (await tx.doc(Jobs)).jobs[args.id];
						if (stored !== undefined) stored.status = "concluded";
					}, context);
					openItems.close(args.id, args.outcome);
					return reply(`Concluded ${args.id}.`);
				},
			}),
			defineTool({
				name: "message_user",
				description: "Send the user a message when you're not replying to them: a result, a question, news. urgency now buzzes; silent arrives without a notification. With a job id it threads under their original request.",
				parameters: Type.Object({ text: Type.String(), urgency: Type.Union([Type.Literal("now"), Type.Literal("silent")]), job: Type.Optional(Type.String()) }),
				execute: async (args, api, context) => {
					const found = args.job === undefined ? undefined : (await api.snapshot(Jobs, context))?.jobs[args.job];
					await api.commit(async (tx) => {
						(await tx.doc(Outbox)).messages[`message:${api.taskId}`] = {
							text: args.text,
							buzz: args.urgency === "now",
							...(found?.origin === undefined ? {} : { replyTo: found.origin }),
							...(found === undefined ? {} : { itemId: found.id }),
						};
					}, context);
					return reply("Sent.");
				},
			}),
		],
	});

	const resume = async (root: Conversation, conversationId: string, message: string, context: Context) =>
		root.commit(async (tx) => {
			const found = Object.values((await tx.doc(Jobs)).jobs).find((candidate) => String(candidate.conversationId) === conversationId);
			if (found === undefined || found.status === "cancelled" || found.status === "concluded") return false;
			await tx.createTask(Run, { jobId: found.id, message, startedAt: Date.now() }, background);
			return true;
		}, context);

	return { chief, job, helper, resume };
}
