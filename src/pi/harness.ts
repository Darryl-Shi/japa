// The Pi Durable side of the main conversation. Everything Pi-specific about opening the harness, the root
// conversation and getting answers back to a channel lives here.
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Conversation,
	createRegistry,
	type Extension,
	defineDoc,
	defineExtension,
	Harness,
	section,
	type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Settings } from "../settings.ts";

/** Where an answer goes once it exists. Written before submitting, so a restart can still deliver it. */
export type ReplyTarget = { chatId: number; messageId: number };
type PendingReply = ReplyTarget & { content: string };

const PendingReplies = defineDoc<{ byRequest: Record<string, PendingReply> }>({
	kind: "jarvis.pending-replies",
	version: 1,
	scope: "session",
	initial: () => ({ byRequest: {} }),
});

const Core = defineExtension({
	name: "jarvis.core",
	sections: [
		section(
			"preamble",
			() =>
				[
					"You are Darryl's chief of staff, talking with him over Telegram in one continuous conversation.",
					"Answer directly and briefly. Lead with the answer. Plain text; no headings.",
					// The time lives in each new message, never in this prefix, so the prefix stays cacheable.
					"Each of his messages starts with the local time he sent it, in brackets.",
				].join("\n"),
			{ tag: false },
		),
	],
});

export type Answer = { text: string } | { error: string };

/** What a compaction keeps verbatim: roughly the last exchange. */
const KEEP_RECENT_TOKENS = 4000;

const REST_NOTE = [
	"The conversation is going quiet. Write the summary as a short handoff note for picking it up later:",
	"open threads, commitments made, questions waiting on an answer, and anything the next message will likely need.",
	"Under 150 words. Drop anything finished. No timestamps.",
].join(" ");

export class MainThread {
	readonly harness: Harness;
	readonly root: Conversation;
	private readonly settings: () => Settings;
	private readonly log: (line: string) => void;
	private restTimer: NodeJS.Timeout | undefined;

	private constructor(harness: Harness, root: Conversation, settings: () => Settings, log: (line: string) => void) {
		this.harness = harness;
		this.root = root;
		this.settings = settings;
		this.log = log;
	}

	static async open(
		options: {
			dataDir?: string;
			storage?: Storage;
			models: Models;
			settings: () => Settings;
			extensions?: readonly Extension[];
			/** Per-answer cost and cache numbers, for tuning the context policy from real use. */
			log?: (line: string) => void;
		},
		context: Context,
	): Promise<MainThread> {
		const registry = createRegistry();
		registry.install(Core);
		for (const extension of options.extensions ?? []) registry.install(extension);
		const storage = options.storage ?? (await openNodeSqliteStorage(join(options.dataDir ?? "data", "session.sqlite")));
		const harness = await Harness.open(
			storage,
			{
				models: options.models,
				registry,
				// Default (short) provider caching only: the context is kept small by construction instead.
				settings: { compaction: { keepRecentTokens: KEEP_RECENT_TOKENS } },
			},
			context,
		);
		const root = await harness.root(context, { agent: { model: options.settings().model } });
		const thread = new MainThread(harness, root, options.settings, options.log ?? (() => {}));
		await thread.applySettings(options.settings(), context);
		harness.resume();
		await thread.scheduleRest(context);
		return thread;
	}

	/** When the last message was, and how big the last request's prompt was. */
	async activity(context: Context): Promise<{ lastAt: number | undefined; promptTokens: number }> {
		const { messages } = await this.root.context(context);
		const last = messages.at(-1);
		const answer = messages.findLast((message) => message.role === "assistant");
		const usage = answer?.role === "assistant" ? answer.usage : undefined;
		return {
			lastAt: last?.role === "system" ? undefined : last?.timestamp,
			promptTokens: usage === undefined ? 0 : usage.input + usage.cacheRead + usage.cacheWrite,
		};
	}

	/** Compact to a handoff note. A no-op when the context is already small. */
	async rest(context: Context): Promise<void> {
		await this.harness.waitForTask(await this.root.compact(REST_NOTE, context), context);
	}

	/** Rest after a quiet gap: the cache is cold by then anyway, so compacting throws nothing warm away. */
	private async scheduleRest(context: Context): Promise<void> {
		clearTimeout(this.restTimer);
		const { lastAt } = await this.activity(context);
		if (lastAt === undefined) return;
		const due = lastAt + this.settings().context.restAfterMinutes * 60_000 - Date.now();
		this.restTimer = setTimeout(() => void this.restIfQuiet(context).catch(() => {}), Math.max(0, due));
		this.restTimer.unref();
	}

	private async restIfQuiet(context: Context): Promise<void> {
		const { lastAt } = await this.activity(context);
		const quietFor = Date.now() - (lastAt ?? Date.now());
		if (quietFor >= this.settings().context.restAfterMinutes * 60_000) await this.rest(context);
		else await this.scheduleRest(context);
	}

	/** Follow the settings' main model; a change applies from the next request. */
	async applySettings(settings: Settings, context: Context): Promise<void> {
		const current = (await this.root.agent(context)).model;
		if (current?.provider !== settings.model.provider || current?.modelId !== settings.model.modelId) {
			await this.root.configure({ model: settings.model }, context);
		}
	}

	/** Submit a message from a channel and resolve with its answer. Idempotent per requestId. */
	async ask(requestId: string, content: string, reply: ReplyTarget, context: Context): Promise<Answer> {
		await this.root.commit(async (tx) => {
			(await tx.doc(PendingReplies)).byRequest[requestId] = { ...reply, content };
		}, context);
		return this.answer(requestId, content, context);
	}

	/** Answers the last process admitted but never delivered. */
	async pending(context: Context): Promise<Array<{ requestId: string } & PendingReply>> {
		const doc = await this.harness.snapshot(PendingReplies, context);
		return Object.entries(doc?.byRequest ?? {}).map(([requestId, pending]) => ({ requestId, ...pending }));
	}

	async answer(requestId: string, content: string, context: Context): Promise<Answer> {
		const existing = await this.root.commit((tx) => tx.submissionByRequest(this.root.id, requestId), context);
		const { lastAt } = await this.activity(context);
		const gapMs = lastAt === undefined ? undefined : Date.now() - lastAt;
		// After a gap (e.g. the process was down when the timer was due): resend the short note, not the whole burst.
		if (existing === undefined && gapMs !== undefined && gapMs >= this.settings().context.restAfterMinutes * 60_000) await this.rest(context);
		const submission = await this.root.submit({ type: "input", content, requestId }, context);
		const settled = await submission.wait(context);
		void this.afterAnswer(context).catch(() => {});
		if (settled.status !== "done" || settled.type !== "input") {
			return { error: settled.status === "unanswered" ? settled.reason : settled.status };
		}
		const entry = await this.root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		const message = entry?.model?.[0];
		if (message?.role !== "assistant") return { error: "no answer" };
		const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		const { usage } = message;
		this.log(
			`${requestId} gap=${gapMs === undefined ? "-" : `${Math.round(gapMs / 60_000)}m`} input=${usage.input} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} output=${usage.output} cost=$${usage.cost.total.toFixed(5)} (last request)`,
		);
		return message.stopReason === "error" ? { error: message.errorMessage ?? "model error" } : { text };
	}

	private async afterAnswer(context: Context): Promise<void> {
		// A long burst still gets bounded; this one runs in the background and keeps the conversation working.
		if ((await this.activity(context)).promptTokens > this.settings().context.maxTokens) await this.root.compact(undefined, context);
		await this.scheduleRest(context);
	}

	async delivered(requestId: string, context: Context): Promise<void> {
		await this.root.commit(async (tx) => {
			delete (await tx.doc(PendingReplies)).byRequest[requestId];
		}, context);
	}

	close(context: Context): Promise<void> {
		clearTimeout(this.restTimer);
		return this.harness.close(context);
	}
}
