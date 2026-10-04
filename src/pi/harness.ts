// The Pi Durable side of the main conversation. Everything Pi-specific about opening the harness, the root
// conversation and getting answers back to a channel lives here.
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Message, Models } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
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
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { OpenItems, WorkingSetFile } from "../core/state.ts";
import type { Settings } from "../settings.ts";
import { Outbox, type Origin, type OutboxMessage } from "./delegation.ts";
import { summarizeSlice, transcriptText } from "./state.ts";

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

/** What the channel knows about an incoming message that bears on where it belongs. */
export type Arrival = {
	/** The message it replies to, if any. */
	replyTo?: { messageId: number; text: string; at: number };
	/** The user asked for a fresh start (/new). */
	newTopic?: boolean;
};

/** When the current slice started; a reply to anything older anchors a new one. */
const Slice = defineDoc<{ startedAt: number }>({ kind: "jarvis.slice", version: 1, scope: "session", initial: () => ({ startedAt: 0 }) });

/** Transcript kind of a background report's note: visible to the model, never a request. */
export const REPORT = "jarvis.report";

const RECENT_MESSAGES = 6;
const RECENT_CHARS = 4000;
const MESSAGE_CHARS = 800;
/** A departing slice smaller than this is already covered by the recent messages; no summary call. */
const SUMMARIZE_ABOVE_TOKENS = 1500;

const textOf = (message: Message) =>
	typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

export class MainThread {
	readonly harness: Harness;
	readonly root: Conversation;
	private readonly models: Models;
	private readonly settings: () => Settings;
	private readonly state: { openItems: OpenItems; workingSet: WorkingSetFile } | undefined;
	private readonly log: (line: string) => void;
	private readonly background = new Set<Promise<void>>();
	private inFlight = 0;

	private constructor(options: {
		harness: Harness;
		root: Conversation;
		models: Models;
		settings: () => Settings;
		state: { openItems: OpenItems; workingSet: WorkingSetFile } | undefined;
		log: (line: string) => void;
	}) {
		this.harness = options.harness;
		this.root = options.root;
		this.models = options.models;
		this.settings = options.settings;
		this.state = options.state;
		this.log = options.log;
	}

	static async open(
		options: {
			dataDir?: string;
			storage?: Storage;
			models: Models;
			settings: () => Settings;
			extensions?: readonly Extension[];
			/** The environment the agent's tools run in (Pi's bash/read/write/edit act through it). */
			env?: () => ExecutionEnv;
			/** Open items and working set a new slice starts from. */
			state?: { openItems: OpenItems; workingSet: WorkingSetFile };
			/** Per-answer slice, cost and cache numbers, for tuning the boundaries from real use. */
			log?: (line: string) => void;
		},
		context: Context,
	): Promise<MainThread> {
		const registry = createRegistry();
		registry.install(Core);
		for (const extension of options.extensions ?? []) registry.install(extension);
		const storage = options.storage ?? (await openNodeSqliteStorage(join(options.dataDir ?? "data", "session.sqlite")));
		// Default (short) provider caching only: the context is kept small by construction instead.
		const env = options.env;
		const harness = await Harness.open(storage, { models: options.models, registry, ...(env === undefined ? {} : { env: () => env() }) }, context);
		const root = await harness.root(context, { agent: { model: options.settings().model } });
		const thread = new MainThread({ harness, root, models: options.models, settings: options.settings, state: options.state, log: options.log ?? (() => {}) });
		await thread.applySettings(options.settings(), context);
		harness.resume();
		return thread;
	}

	/** Follow the settings' main model; a change applies from the next request. */
	async applySettings(settings: Settings, context: Context): Promise<void> {
		const current = (await this.root.agent(context)).model;
		if (current?.provider !== settings.model.provider || current?.modelId !== settings.model.modelId) {
			await this.root.configure({ model: settings.model }, context);
		}
	}

	/** Submit a message from a channel and resolve with its answer. Idempotent per requestId. */
	async ask(requestId: string, content: string, reply: ReplyTarget, context: Context, arrival: Arrival = {}): Promise<Answer> {
		await this.root.commit(async (tx) => {
			(await tx.doc(PendingReplies)).byRequest[requestId] = { ...reply, content };
		}, context);
		return this.answer(requestId, content, context, arrival);
	}

	/** Answers the last process admitted but never delivered. */
	async pending(context: Context): Promise<Array<{ requestId: string } & PendingReply>> {
		const doc = await this.harness.snapshot(PendingReplies, context);
		return Object.entries(doc?.byRequest ?? {}).map(([requestId, pending]) => ({ requestId, ...pending }));
	}

	async answer(requestId: string, content: string, context: Context, arrival: Arrival = {}): Promise<Answer> {
		const existing = await this.root.commit((tx) => tx.submissionByRequest(this.root.id, requestId), context);
		const boundary = existing === undefined ? await this.boundary(content, arrival, context) : undefined;
		if (boundary !== undefined) await this.startSlice(arrival, context);
		this.inFlight++;
		let settled;
		try {
			settled = await (await this.root.submit({ type: "input", content, requestId }, context)).wait(context);
		} finally {
			this.inFlight--;
		}
		if (settled.status !== "done" || settled.type !== "input") {
			return { error: settled.status === "unanswered" ? settled.reason : settled.status };
		}
		const entry = await this.root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		const message = entry?.model?.[0];
		if (message?.role !== "assistant") return { error: "no answer" };
		const { usage } = message;
		this.log(
			`${requestId} slice=${boundary ?? "continued"} input=${usage.input} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} output=${usage.output} cost=$${usage.cost.total.toFixed(5)} (last request)`,
		);
		return message.stopReason === "error" ? { error: message.errorMessage ?? "model error" } : { text: textOf(message) };
	}

	/**
	 * Whether this message starts a new slice, decided now that it has arrived. Never while an answer is running: a
	 * reset placed mid-run would end it.
	 */
	async boundary(content: string, arrival: Arrival, context: Context): Promise<string | undefined> {
		if (this.inFlight > 0) return undefined;
		const { messages } = await this.root.context(context);
		const conversation = messages.filter((message) => message.role !== "system");
		if (conversation.length === 0) return undefined;
		if (arrival.newTopic === true) return "new-topic";
		const startedAt = (await this.harness.snapshot(Slice, context))?.startedAt ?? 0;
		if (arrival.replyTo !== undefined && arrival.replyTo.at < startedAt) return "reply-to-earlier";
		const limits = this.settings().context;
		// Only Darryl's own messages count: reports and notes written in the background never reset the idle clock.
		const lastFromHim = (await this.root.context(context)).entries.findLast((entry) => entry.kind === "pi.user")?.model?.[0];
		const anchoredHere = arrival.replyTo !== undefined;
		if (!anchoredHere && lastFromHim !== undefined && Date.now() - lastFromHim.timestamp >= limits.idleMinutes * 60_000) return "idle";
		const projected = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + Math.ceil(content.length / 4);
		if (projected > limits.sliceTokens) return "size";
		return undefined;
	}

	/**
	 * Start a new slice from state: the open items and working set (system sections), plus the last few visible
	 * messages and, for a reply, the message replied to. The departing slice's working set is written in the
	 * background, so the user's message never waits for a summary.
	 */
	private async startSlice(arrival: Arrival, context: Context): Promise<void> {
		const { messages } = await this.root.context(context);
		const departing = transcriptText(messages);
		const version = (await this.harness.snapshot(Slice, context))?.startedAt ?? 0;
		await this.root.reset(await this.handoff(arrival, context), context);
		await this.root.commit(async (tx) => {
			(await tx.doc(Slice)).startedAt = Date.now();
		}, context);
		if (this.state !== undefined && Math.ceil(departing.length / 4) > SUMMARIZE_ABOVE_TOKENS) this.inBackground(this.writeWorkingSet(version, departing));
	}

	private async handoff(arrival: Arrival, context: Context): Promise<string> {
		const recent: string[] = [];
		let used = 0;
		let cursor: Parameters<Conversation["entries"]>[2];
		scan: do {
			const page = await this.root.entries({}, 50, cursor, context);
			for (const entry of page.items) {
				if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant" && entry.kind !== REPORT) continue;
				const message = entry.model?.[0];
				if (message === undefined) continue;
				const who = entry.kind === REPORT ? "Report" : message.role === "user" ? "Darryl" : "You";
				const line = `${who}: ${textOf(message).slice(0, MESSAGE_CHARS)}`;
				if (recent.length >= RECENT_MESSAGES || used + line.length > RECENT_CHARS) break scan;
				recent.unshift(line);
				used += line.length;
			}
			cursor = page.next;
		} while (cursor !== undefined);
		const parts = ["Earlier turns of this conversation are not in your context. The last few messages:", ...recent];
		if (arrival.replyTo !== undefined) {
			parts.push("", `His next message replies to this earlier message: «${arrival.replyTo.text.slice(0, 2000)}»`);
			const item = this.state?.openItems.forMessage(arrival.replyTo.messageId);
			if (item !== undefined) parts.push(`It belongs to open item ${item.id} [${item.kind}]: ${item.text}${item.closedAt === undefined ? "" : ` (closed: ${item.outcome ?? "done"})`}`);
		}
		return parts.join("\n");
	}

	private async writeWorkingSet(version: number, departing: string): Promise<void> {
		const workingSet = this.state?.workingSet;
		if (workingSet === undefined) return;
		const text = await summarizeSlice(this.models, this.settings().model, workingSet.read()?.text, departing);
		if (text !== undefined && workingSet.write({ version, text })) this.log(`working set updated from slice ${version}`);
	}

	private inBackground(work: Promise<void>): void {
		const tracked = work.catch((error: unknown) => this.log(`background: ${String(error)}`)).finally(() => this.background.delete(tracked));
		this.background.add(tracked);
	}

	/** Resolve once background work (working-set summaries) has finished. */
	async settled(): Promise<void> {
		while (this.background.size > 0) await Promise.all(this.background);
	}

	/** The Telegram message the main thread is answering right now (the placed input). */
	async origin(context: Context): Promise<Origin | undefined> {
		const placed = (await this.harness.inspect(context)).submissions.findLast(
			(submission) => submission.conversationId === this.root.id && submission.type === "input" && submission.status === "placed",
		);
		if (placed?.requestId === undefined) return undefined;
		const target = (await this.harness.snapshot(PendingReplies, context))?.byRequest[placed.requestId];
		return target === undefined ? undefined : { chatId: target.chatId, messageId: target.messageId };
	}

	/**
	 * Deliver the outbox through a channel, now and whenever something is added. Each message: its note goes into the
	 * transcript as a passive write (no model run), the channel sends it, the open item learns the sent message's id.
	 */
	async deliverOutbox(send: (message: OutboxMessage) => Promise<number | undefined>, context: Context): Promise<void> {
		await this.root.commit(async (tx) => void (await tx.doc(Outbox)), context);
		let draining = Promise.resolve();
		const drain = () => {
			draining = draining.then(async () => {
				const pending = (await this.harness.snapshot(Outbox, context))?.messages ?? {};
				for (const [id, message] of Object.entries(pending)) {
					if (message.note !== undefined) {
						const entry = { kind: REPORT, model: [{ role: "user" as const, content: message.note, timestamp: Date.now() }] };
						await this.root.submit({ type: "write", requestId: id, entry }, context);
					}
					const sent = await send(message);
					if (sent !== undefined && message.itemId !== undefined) this.state?.openItems.link(message.itemId, sent);
					await this.root.commit(async (tx) => {
						delete (await tx.doc(Outbox)).messages[id];
					}, context);
				}
			}).catch((error: unknown) => this.log(`outbox: ${String(error)}`));
			this.inBackground(draining);
		};
		const state = await this.harness.documentState(Outbox, context);
		state?.subscribe(() => drain());
		drain();
	}

	async delivered(requestId: string, context: Context): Promise<void> {
		await this.root.commit(async (tx) => {
			delete (await tx.doc(PendingReplies)).byRequest[requestId];
		}, context);
	}

	async close(context: Context): Promise<void> {
		await this.settled();
		await this.harness.close(context);
	}
}
