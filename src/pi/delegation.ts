// Delegation. The user only ever talks to the chief of staff (the main thread). The chief of staff hands work to a
// job agent: one per job, with a model assigned to that job, its own small conversation, the same computer, and
// subagents of its own when the work splits. The job agent decides when to report; a report is addressed to the chief
// of staff (inputs.ts), which synthesizes, and what it replies is what the user hears (a reply to progress alone stays
// with it). A
// job is finished when its open item is closed (the one record of that, for the chief of staff and /jobs alike): by
// itself when the job reports done, or by the chief of staff or the user; more for a finished job (message_job) opens
// it again. A job agent that ends its run without reporting has its last words reported as done for it.
import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, type Message, type ModelThinkingLevel, Type } from "@earendil-works/pi-ai";
import { type Conversation, type ConversationId, configure, defineDoc, defineExtension, defineTask, defineTool, type Extension, section, type Tx } from "@earendil-works/pi-durable";
import type { OpenItems } from "../core/state.ts";
import type { CardRef } from "../core/ui.ts";
import type { ModelChoice } from "../settings.ts";
import { address } from "./inputs.ts";
import { modelRef } from "./models.ts";

type Job = {
	id: string;
	title: string;
	conversationId: ConversationId;
	/** Who it reports to: the chief of staff, or the job that started it. */
	parentConversationId: ConversationId;
	/** 1: a job; 2: a job's subagent (no subagents of its own). */
	depth: 1 | 2;
	model: ModelChoice;
	origin?: CardRef;
	/** "concluded": only on records from before a job's open item was the record of its being finished. */
	status: "working" | "reported" | "concluded" | "cancelled";
	/** Absent on jobs started before it was recorded. */
	startedAt?: number;
	lastReportAt?: number;
	/** Absent on reports made before it was recorded. */
	lastReportKind?: Kind;
};

/** A job as the user sees it (/jobs). */
export type JobSummary = Pick<Job, "id" | "title" | "depth" | "status" | "startedAt" | "lastReportAt"> & { model: string };
/** What a job is doing: its subagents, and the tail of its own conversation. */
export type JobDetail = JobSummary & { subagents: JobSummary[]; recent: string[]; lastActiveAt?: number };
/** Where the jobs live: the root conversation (their record) and the harness (their conversations). */
export type Team = { root: Conversation; harness: { conversation(id: ConversationId, context: Context): Promise<Conversation | undefined> } };

const summary = (job: Job, finished: boolean): JobSummary => ({
	id: job.id,
	title: job.title,
	depth: job.depth,
	status: finished && job.status !== "cancelled" ? "concluded" : job.status,
	model: `${job.model.provider}/${job.model.modelId}`,
	...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
	...(job.lastReportAt === undefined ? {} : { lastReportAt: job.lastReportAt }),
});

const line = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A few lines on what a conversation has been doing lately: what it was told, said, and ran. */
function recentActivity(messages: readonly Message[], count: number): string[] {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ");
			if (text.trim() !== "") lines.push(`← ${line(text, 140)}`);
		} else if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text" && part.text.trim() !== "") lines.push(line(part.text, 160));
				if (part.type === "toolCall") lines.push(`→ ${part.name} ${line(JSON.stringify(part.arguments), 90)}`);
			}
		}
	}
	return lines.slice(-count);
}
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

type Kind = "done" | "stuck" | "decision needed" | "progress";
/** Where a report is made from: a tool call or a task, each with its own commit. */
type Via = { commit(change: (tx: Tx) => Promise<void>, context: Context): Promise<unknown>; conversation(id: ConversationId, context: Context): Promise<Pick<Conversation, "submit"> | undefined> };
type Report = (job: Job, kind: Kind, text: string, requestId: string, via: Via, context: Context) => Promise<void>;

/**
 * Send a message to a job and see it through. If the job agent ends its run without reporting, its last words are its
 * report (done), unless it's waiting: on its subagents, whose reports come back as runs of their own, or on the user.
 */
type RunInput = { jobId: string; message: string; startedAt: number };
/** A checkpoint saved before reports had a kind has only its text. */
type RunState = { phase: "run" } | { phase: "report"; kind?: Kind; text?: string };
const makeRun = (waitingOnUser: (conversationId: ConversationId) => boolean, finished: (job: Job) => boolean, report: Report) => defineTask<RunInput, RunState, null>({
	name: "jarvis.job-run",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, context) => {
			const job = (await runtime.snapshot(Jobs, context))?.jobs[task.input.jobId];
			if (job === undefined) return void (await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context));
			const conversation = (await runtime.conversation(job.conversationId, context))!;
			const settled = await (await conversation.submit({ type: "input", content: task.input.message, requestId: `job-run:${task.id}`, whenBusy: "followUp" }, context)).wait(context);
			const jobs = (await runtime.snapshot(Jobs, context))?.jobs ?? {};
			const current = jobs[job.id];
			const working = Object.values(jobs).some((sub) => sub.parentConversationId === job.conversationId && sub.status === "working" && !finished(sub));
			let next: { kind: Kind; text: string } | undefined;
			if (current === undefined || finished(current)) next = undefined;
			else if ((current.lastReportAt ?? 0) >= task.input.startedAt && current.lastReportKind !== "progress") next = undefined; // it reported itself
			else if (waitingOnUser(job.conversationId)) next = undefined; // paused on the user's approval, which resumes it
			else if (working) next = undefined; // its subagents' reports will run it again
			else if (settled.status === "unanswered") next = settled.reason === "aborted" ? undefined : { kind: "stuck", text: `Failed: ${settled.reason}` };
			else if (settled.type === "input") {
				const answer = (await runtime.context(job.conversationId, context)).entries.find((entry) => entry.id === settled.answer);
				next = { kind: "done", text: textOf(answer?.model?.[0] as AssistantMessage | undefined) || "(ended without a word)" };
			}
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", ...next } }), context);
		},
		report: async (task, runtime, context) => {
			const { kind, text } = task.state.checkpoint;
			const job = (await runtime.snapshot(Jobs, context))?.jobs[task.input.jobId];
			if (text !== undefined && job !== undefined) {
				const via: Via = {
					commit: (change, callContext) => runtime.commit(async (tx) => void (await change(tx)), callContext),
					conversation: (id, callContext) => runtime.conversation(id, callContext),
				};
				await report(job, kind ?? (text.startsWith("Failed") ? "stuck" : "done"), text, `auto-report:${task.id}`, via, context);
			}
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

const CHIEF_GUIDE = [
	"You run a team. delegate hands a self-contained job to a job agent (its own conversation and model; pick a model",
	"name only when the job needs it). Job agents can have tools you don't: hand them the work that needs those.",
	"Job agents report back to you as messages starting with \"[Report from job\": your team, not the user. On a",
	"report: check it, ask the job agent more or redirect it (message_job) if it's thin or wrong, and connect it with",
	"other jobs and what you know of the user. Then reply with what the user should hear. Whatever you're answering (the",
	"user, a report, a trigger), your reply goes to the user, threaded under what it answers; a reply to progress",
	"reports alone stays with you, and an empty reply sends nothing. A job closes when its agent reports done; more",
	"for work a job already did goes to that job with message_job, even once it's closed: it opens again and keeps what",
	"it learned. cancel_job one that's no longer wanted. delegate tracks the job itself: don't track it as well.",
	"Messages starting \"[Trigger\" are your own schedule or an event, not the user: do what they ask.",
].join(" ");

const JOB_GUIDE = [
	"You are a job agent working for the user's chief of staff on one job. You decide when to report: call report when",
	"the job is done, when you're stuck, when you need a decision, or at milestones of long work. A report should",
	"stand alone: the result itself, how sure you are, and where the details are (files on your computer, sources).",
	"For work that splits into independent parts, use subagent; their results come back to you as reports.",
].join(" ");

export type Delegation = {
	/** The chief of staff's tools: delegate, message_job, check_job, cancel_job (and the tasks). */
	chief: Extension;
	/** A job agent's tools: report, subagent. */
	job: Extension;
	/** Report only: for a job's subagents (and selected alongside `job` for job agents). */
	helper: Extension;
	/** Send a message to a job (e.g. the user's decision on its approval); it's seen through like any other run. */
	resume: (root: Conversation, conversationId: string, message: string, context: Context) => Promise<boolean>;
	/** Every job and subagent, newest first, for the user to look over. */
	list: (team: Team, context: Context) => Promise<JobSummary[]>;
	/** One job in detail, or undefined if there's none by that id. */
	detail: (team: Team, id: string, context: Context) => Promise<JobDetail | undefined>;
	/** Stop a job and its subagents, as cancel_job does. False if it isn't open. */
	cancel: (team: Team, id: string, reason: string, context: Context) => Promise<boolean>;
	/** Close a job that's done with (its open item). False if it isn't open. */
	close: (team: Team, id: string, outcome: string, context: Context) => Promise<boolean>;
};

export function delegationExtensions(options: {
	openItems: OpenItems;
	settings: () => { model?: ModelChoice; delegateModel?: ModelChoice; jobModels: Record<string, ModelChoice> };
	/** The chat message the chief of staff is answering right now. */
	origin: (context: Context) => Promise<CardRef | undefined>;
	/** What a new job agent must not have (the chief of staff's own extensions, anything turned off). */
	withhold: () => readonly Extension[];
	/** A job paused on something only the user can give (an approval) isn't reported for. */
	waitingOnUser?: (conversationId: ConversationId) => boolean;
	/** The thinking level a job's model slot runs at (default: off). */
	thinking?: (choice: ModelChoice) => ModelThinkingLevel;
}): Delegation {
	const { openItems } = options;
	/** Finished: cancelled, or its open item (a subagent's: its job's) closed, which is the one record of that. */
	const finished = (job: Job) =>
		job.status === "cancelled" || job.status === "concluded" || openItems.all().find((item) => item.id === job.id.split(".")[0])?.closedAt !== undefined;
	/**
	 * A report: recorded on its job (done closes a job's open item, which finishes it), then sent to whoever gave the
	 * job. To a job, as a run of it, so it's seen through; to the chief of staff, addressed: its answer goes to the user
	 * under the request the job came from (a reply to progress alone is kept).
	 */
	const report: Report = async (job, kind, text, requestId, via, context) => {
		let parentJob: Job | undefined;
		await via.commit(async (tx) => {
			const jobs = (await tx.doc(Jobs)).jobs;
			const stored = jobs[job.id];
			if (stored !== undefined && stored.status === "working") stored.status = "reported";
			if (stored !== undefined) Object.assign(stored, { lastReportAt: Date.now(), lastReportKind: kind });
			parentJob = Object.values(jobs).find((candidate) => candidate.conversationId === job.parentConversationId);
			if (parentJob !== undefined) {
				if (!finished(parentJob)) await tx.createTask(Run, { jobId: parentJob.id, message: reportText(job, kind, text), startedAt: Date.now() }, background);
				return;
			}
			const cause = { from: `job ${job.id}`, itemId: job.id, ...(job.origin === undefined ? {} : { replyTo: job.origin }), ...(kind === "progress" ? { quiet: true } : {}) };
			await address(tx, job.parentConversationId, { requestId, content: reportText(job, kind, text), cause });
		}, context);
		if (kind === "done" && job.depth === 1) openItems.close(job.id, `done: ${line(text, 200)}`);
	};
	const Run = makeRun(options.waitingOnUser ?? (() => false), finished, report);

	/** Create a job's conversation and send it its brief, in one commit. */
	const startJob = async (tx: Tx, job: Omit<Job, "conversationId" | "status">, brief: string, withhold: readonly Extension[]) => {
		const anchor = await tx.createTask(Anchor, null, background);
		const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
		await configure(tx, conversation.id, { model: modelRef(job.model), thinkingLevel: options.thinking?.(job.model) ?? "off", extensions: { remove: [...withhold] }, instructions: `Your job (${job.id}): "${job.title}".` });
		(await tx.doc(Jobs)).jobs[job.id] = { ...job, conversationId: conversation.id, status: "working", startedAt: Date.now() };
		await tx.createTask(Run, { jobId: job.id, message: brief, startedAt: Date.now() }, background);
	};

	const helper = defineExtension({
		name: "jarvis.job-report",
		sections: [section("job_guide", () => JOB_GUIDE, { tag: false })],
		tools: [
			defineTool({
				name: "report",
				description: "Report to whoever gave you this job: done (that closes the job), stuck, a decision needed, or a milestone.",
				parameters: Type.Object({
					kind: Type.Union([Type.Literal("done"), Type.Literal("stuck"), Type.Literal("decision needed"), Type.Literal("progress")]),
					text: Type.String(),
				}),
				execute: async (args, api, context) => {
					const job = Object.values((await api.snapshot(Jobs, context))?.jobs ?? {}).find((candidate) => candidate.conversationId === api.conversationId);
					if (job === undefined) return reply("You're not on a job.");
					await report(job, args.kind, args.text, `report:${api.taskId}`, api, context);
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
					return reply(`Started subagent ${id}. Its report comes back to you as a message: end your turn to wait for it, or carry on with other work meanwhile.`);
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
				description: "Start a job: self-contained work (research, multi-step tasks, anything over a minute or two) for a job agent, in a conversation of its own on your computer. Returns at once. The brief must stand alone: the agent sees nothing of this conversation.",
				parameters: Type.Object({
					title: Type.String({ description: "A few words" }),
					brief: Type.String({ description: "Goal, context, constraints, what to report back" }),
					model: Type.Optional(Type.String({ description: "A model name for this job, if it needs a specific one" })),
				}),
				replay: "unsafe",
				execute: async (args, api, context) => {
					const settings = options.settings();
					const model = args.model === undefined ? (settings.delegateModel ?? settings.model) : settings.jobModels[args.model];
					if (model === undefined) {
						return reply(args.model === undefined ? "No model is chosen for jobs yet: the user picks one in /settings." : `No model named ${args.model}; choose from: ${Object.keys(settings.jobModels).join(", ") || "(none set)"}.`);
					}
					const origin = await options.origin(context);
					const item = openItems.add("task", args.title, origin?.messageId);
					const job1 = { id: item.id, title: args.title, parentConversationId: api.conversationId, depth: 1 as const, model, ...(origin === undefined ? {} : { origin }) };
					await api.commit((tx) => startJob(tx, job1, args.brief, options.withhold()), context);
					return reply(`Started job ${item.id}.`);
				},
			}),
			defineTool({
				name: "message_job",
				description: "Tell a job's agent something: a question, a correction, new direction, more to do, or information from the user. It answers with a report. A finished job is opened again. Never seen by the user.",
				parameters: Type.Object({ id: Type.String(), text: Type.String() }),
				execute: async (args, api, context) => {
					const found = (await api.snapshot(Jobs, context))?.jobs[args.id];
					if (found === undefined) return reply(`No job ${args.id}.`);
					if (found.status === "cancelled") return reply(`${found.id} was cancelled; start a new job instead.`);
					if (finished(found) && !openItems.reopen(found.id.split(".")[0]!)) return reply(`${found.id} is long finished; start a new job instead.`);
					await api.commit(async (tx) => {
						const stored = (await tx.doc(Jobs)).jobs[found.id];
						if (stored !== undefined) stored.status = "working";
					}, context);
					await api.commit((tx) => tx.createTask(Run, { jobId: found.id, message: `From the chief of staff: ${args.text}`, startedAt: Date.now() }, background), context);
					return reply(`Sent to ${found.id}; its answer will come as a report.`);
				},
			}),
			defineTool({
				name: "check_job",
				description: "A job's status and its subagents'.",
				parameters: Type.Object({ id: Type.String() }),
				execute: async (args, api, context) => {
					const jobs = (await api.snapshot(Jobs, context))?.jobs ?? {};
					const found = jobs[args.id];
					if (found === undefined) return reply(`No job ${args.id}.`);
					const lines = [`${found.id} "${found.title}": ${summary(found, finished(found)).status}${found.lastReportAt === undefined ? "" : `, last report ${new Date(found.lastReportAt).toISOString().slice(0, 16)}`}, model ${found.model.modelId}`];
					for (const sub of Object.values(jobs).filter((candidate) => candidate.parentConversationId === found.conversationId)) lines.push(`  ${sub.id} "${sub.title}": ${summary(sub, finished(sub)).status}`);
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
					await stop(found, jobs, (change) => api.commit(change, context), (id) => api.conversation(id, context), args.reason, context);
					return reply(`Cancelled ${found.id}.`);
				},
			}),
		],
	});

	/** Cancel a job and its subagents: marked cancelled, their conversations aborted, its open item closed. */
	async function stop(
		found: Job,
		jobs: Record<string, Job>,
		commit: (change: (tx: Tx) => Promise<void>) => Promise<void>,
		conversation: (id: ConversationId) => Promise<Pick<Conversation, "abort"> | undefined>,
		reason: string | undefined,
		context: Context,
	): Promise<void> {
		const family = Object.values(jobs).filter((each) => each.id === found.id || each.id.startsWith(`${found.id}.`));
		await commit(async (tx) => {
			const all = (await tx.doc(Jobs)).jobs;
			for (const each of family) if (all[each.id] !== undefined) all[each.id]!.status = "cancelled";
		});
		for (const each of family) await (await conversation(each.conversationId))?.abort(context);
		openItems.close(found.id, `cancelled${reason === undefined ? "" : `: ${reason}`}`);
	}

	/** The jobs as recorded, read through the root conversation (a read-only commit). */
	const read = (root: Conversation, context: Context) => root.commit(async (tx) => JSON.parse(JSON.stringify((await tx.doc(Jobs)).jobs)) as Record<string, Job>, context);

	const list = async (team: Team, context: Context) =>
		Object.values(await read(team.root, context))
			.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
			.map((job) => summary(job, finished(job)));

	const detail = async (team: Team, id: string, context: Context): Promise<JobDetail | undefined> => {
		const jobs = await read(team.root, context);
		const found = jobs[id];
		if (found === undefined) return undefined;
		const messages = (await (await team.harness.conversation(found.conversationId, context))?.context(context))?.messages ?? [];
		const lastActiveAt = messages.at(-1)?.timestamp;
		return {
			...summary(found, finished(found)),
			subagents: Object.values(jobs)
				.filter((each) => each.parentConversationId === found.conversationId)
				.map((each) => summary(each, finished(each))),
			recent: recentActivity(messages, 8),
			...(lastActiveAt === undefined ? {} : { lastActiveAt }),
		};
	};

	const cancel = async (team: Team, id: string, reason: string, context: Context) => {
		const jobs = await read(team.root, context);
		const found = jobs[id];
		if (found === undefined || finished(found)) return false;
		await stop(found, jobs, (change) => team.root.commit(change, context), (conversationId) => team.harness.conversation(conversationId, context), reason, context);
		return true;
	};

	const close = async (team: Team, id: string, outcome: string, context: Context) => {
		const found = (await read(team.root, context))[id];
		if (found === undefined || finished(found) || found.depth !== 1) return false;
		openItems.close(found.id, outcome);
		return true;
	};

	const resume = async (root: Conversation, conversationId: string, message: string, context: Context) =>
		root.commit(async (tx) => {
			const found = Object.values((await tx.doc(Jobs)).jobs).find((candidate) => String(candidate.conversationId) === conversationId);
			if (found === undefined || finished(found)) return false;
			await tx.createTask(Run, { jobId: found.id, message, startedAt: Date.now() }, background);
			return true;
		}, context);

	return { chief, job, helper, resume, list, detail, cancel, close };
}
