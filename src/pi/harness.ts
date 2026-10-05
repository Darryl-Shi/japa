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
	LiveDoc,
	defineExtension,
	Harness,
	type Registry,
	section,
	type Storage,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { OpenItems, WorkingSetFile } from "../core/state.ts";
import type { Settings } from "../settings.ts";
import type { Content } from "../core/message.ts";
import type { CardRef } from "../core/ui.ts";
import { REPORT_PREFIX } from "./delegation.ts";
import { Address, claim, Outbox, type OutboxMessage } from "./inputs.ts";
import type { ExchangeEnd } from "./extension.ts";
import { modelRef, thinkingOf } from "./models.ts";
import { summarizeSlice, transcriptText } from "./state.ts";

/**
 * A message admitted and where its answer goes (none: the channel's default chat). Written before submitting, so a
 * restart can still deliver it.
 */
/** What the user sent (text, or text and images), kept until its answer is delivered. */
type PendingReply = Partial<CardRef> & { content: Content };

const PendingReplies = defineDoc<{ byRequest: Record<string, PendingReply> }>({
	kind: "jarvis.pending-replies",
	version: 1,
	scope: "session",
	initial: () => ({ byRequest: {} }),
});

/**
 * Who the agent is and who it works for (the user's name comes from settings; everything else says "the user"), and
 * the task every input not from the user comes in by, so its answer goes back the way it came.
 */
function coreExtension(settings: () => Settings): Extension {
	return defineExtension({
		name: "jarvis.core",
		tasks: [Address],
		sections: [
			section(
				"preamble",
				() =>
					[
						"You are the user's chief of staff. They talk only to you, in one continuous conversation; a team of job agents does the work.",
						...(settings().user?.name === undefined ? [] : [`The user is ${settings().user?.name}.`]),
						"Your role is to answer, decide, delegate, and synthesize what comes back. By yourself, do only the very simple:",
						"answer from what you know, or one or two quick tool calls (check email or the calendar, look something up, send a",
						"message). Delegate everything else (research, coding, writing, anything multi-step or over a minute), even when",
						"your own tools could do it: the user should never be left waiting on you.",
						"Answer directly and briefly. Lead with the answer. Plain text; no headings.",
						// The time lives in each new message, never in this prefix, so the prefix stays cacheable.
						"Each of their messages starts with the local time they sent it, in brackets.",
					].join("\n"),
				{ tag: false },
			),
		],
	});
}

/** An empty text: nothing to say (or it was already said). */
export type Answer = { text: string } | { error: string };

/** What the channel knows about an incoming message that bears on where it belongs. */
export type Arrival = {
	/** The message it replies to, if any. */
	replyTo?: { messageId: string; text: string; at: number };
	/** The user asked for a fresh start (/new). */
	newTopic?: boolean;
};

/** What a slice starts from, and the working set the end of a slice keeps current. */
export type SliceState = { openItems: OpenItems; workingSet: WorkingSetFile };

/**
 * When the current slice started (a reply to anything older anchors a new one), and what was said in the slices of
 * this exchange that were cut for size: the exchange isn't over, so it waits for the end.
 */
const Slice = defineDoc<{ startedAt: number; carried?: string }>({ kind: "jarvis.slice", version: 1, scope: "session", initial: () => ({ startedAt: 0 }) });

/** When the user last wrote. Reports from the team are inputs too, so the idle clock can't be read off the transcript. */
const Heard = defineDoc<{ at: number }>({ kind: "jarvis.heard", version: 1, scope: "session", initial: () => ({ at: 0 }) });

const RECENT_MESSAGES = 6;
const RECENT_CHARS = 4000;
const MESSAGE_CHARS = 800;

const textOf = (message: Message) =>
	typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

export class MainThread {
	readonly harness: Harness;
	readonly root: Conversation;
	/** The chief of staff's identity: job agents must not have it. */
	readonly core: Extension;
	private readonly models: Models;
	private readonly settings: () => Settings;
	private readonly selected: () => readonly Extension[];
	private readonly state: SliceState | undefined;
	private readonly onExchangeEnd: (exchange: ExchangeEnd) => Promise<void>;
	private readonly log: (line: string) => void;
	private readonly background = new Set<Promise<void>>();
	private inFlight = 0;

	private constructor(options: {
		harness: Harness;
		root: Conversation;
		core: Extension;
		models: Models;
		settings: () => Settings;
		selected: () => readonly Extension[];
		state: SliceState | undefined;
		onExchangeEnd: (exchange: ExchangeEnd) => Promise<void>;
		log: (line: string) => void;
	}) {
		this.harness = options.harness;
		this.root = options.root;
		this.core = options.core;
		this.models = options.models;
		this.settings = options.settings;
		this.selected = options.selected;
		this.state = options.state;
		this.onExchangeEnd = options.onExchangeEnd;
		this.log = options.log;
	}

	static async open(
		options: {
			dataDir?: string;
			storage?: Storage;
			models: Models;
			settings: () => Settings;
			/** Every Pi extension any agent may use (the chief of staff's, job agents'). */
			installed?: readonly Extension[];
			/** Where they're installed; pass one to install more while running. */
			registry?: Registry;
			/** The ones the chief of staff has right now; re-read with the settings, so a toggle applies on the next message. */
			selected?: () => readonly Extension[];
			/** The environment the agent's tools run in (Pi's bash/read/write/edit act through it). */
			env?: () => ExecutionEnv | undefined;
			/** Open items and working set a new slice starts from. */
			state?: SliceState;
			/** Extensions' work when an exchange with the user ends (e.g. memory reflection), in the background. */
			onExchangeEnd?: (exchange: ExchangeEnd) => Promise<void>;
			/** Per-answer slice, cost and cache numbers, for tuning the boundaries from real use. */
			log?: (line: string) => void;
		},
		context: Context,
	): Promise<MainThread> {
		const registry = options.registry ?? createRegistry();
		const core = coreExtension(options.settings);
		registry.install(core);
		for (const extension of options.installed ?? []) registry.install(extension);
		const storage = options.storage ?? (await openNodeSqliteStorage(join(options.dataDir ?? "data", "session.sqlite")));
		// Default (short) provider caching only: the context is kept small by construction instead.
		const env = options.env;
		const harness = await Harness.open(
			storage,
			{
				models: options.models,
				registry,
				...(env === undefined ? {} : { env: () => env() }),
				// Reports that queue up while the chief of staff is busy are taken in one turn, not one wake each.
				settings: { followUpMode: "all" },
			},
			context,
		);
		const model = options.settings().model;
		const root = await harness.root(context, { agent: model === undefined ? {} : { model: modelRef(model), thinkingLevel: thinkingOf(options.models, model) } });
		const selected = options.selected ?? (() => options.installed ?? []);
		const thread = new MainThread({
			harness,
			root,
			core,
			models: options.models,
			settings: options.settings,
			selected: () => [core, ...selected()],
			state: options.state,
			onExchangeEnd: options.onExchangeEnd ?? (async () => {}),
			log: options.log ?? (() => {}),
		});
		await thread.applySettings(options.settings(), context);
		harness.resume();
		return thread;
	}

	/** Follow the settings' main model and the extensions that are on; a change applies from the next request. */
	async applySettings(settings: Settings, context: Context): Promise<void> {
		const agent = await this.root.agent(context);
		const current = agent.model;
		if (settings.model !== undefined) {
			const thinkingLevel = thinkingOf(this.models, settings.model);
			if (current?.provider !== settings.model.provider || current?.modelId !== settings.model.modelId || agent.thinkingLevel !== thinkingLevel) {
				await this.root.configure({ model: modelRef(settings.model), thinkingLevel }, context);
			}
		}
		const wanted = this.selected();
		const names = (list: readonly Extension[]) => list.map((extension) => extension.name).join(",");
		if (names(agent.extensions) !== names(wanted)) await this.root.configure({ extensions: wanted }, context);
	}

	/** Submit a message from a channel and resolve with its answer. Idempotent per requestId. */
	async ask(requestId: string, content: Content, reply: CardRef | undefined, context: Context, arrival: Arrival = {}): Promise<Answer> {
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

	async answer(requestId: string, content: Content, context: Context, arrival: Arrival = {}): Promise<Answer> {
		if (this.settings().model === undefined) return { error: "no model chosen yet: log in to a provider with /login, then pick a model with /model" };
		const existing = await this.root.commit((tx) => tx.submissionByRequest(this.root.id, requestId), context);
		const boundary = existing === undefined ? await this.boundary(typeof content === "string" ? content : textOf({ role: "user", content, timestamp: 0 }), arrival, context) : undefined;
		if (boundary !== undefined) await this.startSlice(boundary, arrival, context);
		// Recorded after the boundary decision, which measures the gap since the previous message.
		if (existing === undefined) {
			await this.root.commit(async (tx) => {
				(await tx.doc(Heard)).at = Date.now();
			}, context);
		}
		this.inFlight++;
		let settled;
		try {
			// The user comes first: if the chief of staff is busy with a report, their message joins that run at its next
			// step instead of waiting behind it. Behind their own earlier message, it queues as usual.
			const whenBusy = this.inFlight > 1 ? "followUp" : "steer";
			settled = await (await this.root.submit({ type: "input", content, requestId, whenBusy }, context)).wait(context);
		} finally {
			this.inFlight--;
		}
		if (settled.status !== "done" || settled.type !== "input") {
			return { error: settled.status === "unanswered" ? settled.reason : settled.status };
		}
		// An answer is sent once: if it also answered a report (the user joined that run), it may have gone already.
		const [entry, first] = await this.root.commit(async (tx) => [await tx.entry(AssistantEntry, settled.answer), await claim(tx, Number(settled.answer), requestId)] as const, context);
		const message = entry?.model?.[0];
		if (message?.role !== "assistant") return { error: "no answer" };
		if (!first) return { text: "" };
		const { usage } = message;
		this.log(
			`${requestId} slice=${boundary ?? "continued"} input=${usage.input} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} output=${usage.output} cost=$${usage.cost.total.toFixed(5)} (last request)`,
		);
		return message.stopReason === "error" ? { error: message.errorMessage ?? "model error" } : { text: textOf(message) };
	}

	/**
	 * Whether this message starts a new slice, decided now that it has arrived. Never while a run is going (an answer,
	 * or a report being handled): a reset placed mid-run would end it.
	 */
	async boundary(content: string, arrival: Arrival, context: Context): Promise<string | undefined> {
		if (this.inFlight > 0 || (await this.harness.snapshot(LiveDoc, this.root.id, context))?.run !== undefined) return undefined;
		const { messages } = await this.root.context(context);
		const conversation = messages.filter((message) => message.role !== "system");
		if (conversation.length === 0) return undefined;
		if (arrival.newTopic === true) return "new-topic";
		const startedAt = (await this.harness.snapshot(Slice, context))?.startedAt ?? 0;
		if (arrival.replyTo !== undefined && arrival.replyTo.at < startedAt) return "reply-to-earlier";
		const limits = this.settings().context;
		// Only the user's own messages count: reports from the team never reset the idle clock.
		const heardAt = (await this.harness.snapshot(Heard, context))?.at ?? 0;
		const anchoredHere = arrival.replyTo !== undefined;
		if (!anchoredHere && heardAt > 0 && Date.now() - heardAt >= limits.idleMinutes * 60_000) return "idle";
		// The conversation's own size: the system sections (open items, working set, guides) are there in every slice.
		const projected = conversation.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + Math.ceil(content.length / 4);
		if (projected > limits.sliceTokens) return "size";
		return undefined;
	}

	/**
	 * Start a new slice from state: the open items and working set (system sections), plus the last few visible
	 * messages and, for a reply, the message replied to. The departing slice's working set is written in the
	 * background, so the user's message never waits for a summary.
	 */
	private async startSlice(reason: string, arrival: Arrival, context: Context): Promise<void> {
		const { messages } = await this.root.context(context);
		const departing = transcriptText(messages);
		const slice = await this.harness.snapshot(Slice, context);
		const version = slice?.startedAt ?? 0;
		const said = [slice?.carried, departing].filter((text) => text !== undefined && text !== "").join("\n\n");
		// Cut for size, the exchange goes on: what it said waits for the exchange to end.
		const ended = reason !== "size";
		await this.root.reset(await this.handoff(arrival, context), context);
		await this.root.commit(async (tx) => {
			const doc = await tx.doc(Slice);
			doc.startedAt = Date.now();
			if (ended) delete doc.carried;
			else doc.carried = said;
		}, context);
		if (messages.some((message) => message.role === "user")) this.inBackground(this.endSlice(version, departing, ended ? said : undefined));
	}

	private async handoff(arrival: Arrival, context: Context): Promise<string> {
		const recent: string[] = [];
		let used = 0;
		let cursor: Parameters<Conversation["entries"]>[2];
		scan: do {
			const page = await this.root.entries({}, 50, cursor, context);
			for (const entry of page.items) {
				if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") continue;
				const message = entry.model?.[0];
				if (message === undefined) continue;
				const said = textOf(message);
				// A turn that only called tools says nothing worth recalling.
				if (said.trim() === "") continue;
				const who = message.role === "assistant" ? "You" : said.startsWith(REPORT_PREFIX) ? "Team" : "User";
				const line = `${who}: ${said.slice(0, MESSAGE_CHARS)}`;
				if (recent.length >= RECENT_MESSAGES || used + line.length > RECENT_CHARS) break scan;
				recent.unshift(line);
				used += line.length;
			}
			cursor = page.next;
		} while (cursor !== undefined);
		const parts = ["Earlier turns of this conversation are not in your context. The last few messages:", ...recent];
		if (arrival.replyTo !== undefined) {
			parts.push("", `Their next message replies to this earlier message: «${arrival.replyTo.text.slice(0, 2000)}»`);
			const item = this.state?.openItems.forMessage(arrival.replyTo.messageId);
			if (item !== undefined) parts.push(`It belongs to open item ${item.id} [${item.kind}]: ${item.text}${item.closedAt === undefined ? "" : ` (closed: ${item.outcome ?? "done"})`}`);
		}
		return parts.join("\n");
	}

	/**
	 * The end of a slice: a new working set (versioned), then, if the exchange ended with it, the extensions' own work
	 * (e.g. memory reflection) over everything the exchange said.
	 */
	private async endSlice(version: number, departing: string, exchange: string | undefined): Promise<void> {
		const state = this.state;
		const openItems = state?.openItems.projection();
		const today = new Date().toISOString().slice(0, 10);
		if (state !== undefined) {
			const workingSet = await summarizeSlice(this.models, this.settings().model, { workingSet: state.workingSet.read()?.text, conversation: departing, openItems, today });
			if (workingSet !== undefined && state.workingSet.write({ version, text: workingSet })) this.log(`working set updated from slice ${version}`);
		}
		if (exchange !== undefined) await this.onExchangeEnd({ conversation: exchange, openItems, today });
	}

	private inBackground(work: Promise<void>): void {
		const tracked = work.catch((error: unknown) => this.log(`background: ${String(error)}`)).finally(() => this.background.delete(tracked));
		this.background.add(tracked);
	}

	/** Resolve once background work (working-set summaries) has finished. */
	async settled(): Promise<void> {
		while (this.background.size > 0) await Promise.all(this.background);
	}

	/** The chat message the main thread is answering right now (the placed input). */
	async origin(context: Context): Promise<CardRef | undefined> {
		const placed = (await this.harness.inspect(context)).submissions.findLast(
			(submission) => submission.conversationId === this.root.id && submission.type === "input" && submission.status === "placed",
		);
		if (placed?.requestId === undefined) return undefined;
		const target = (await this.harness.snapshot(PendingReplies, context))?.byRequest[placed.requestId];
		if (target?.chatId === undefined || target.messageId === undefined) return undefined;
		// String() and "": answers admitted before ids were strings and channels were recorded.
		return { channel: target.channel ?? "", chatId: String(target.chatId), messageId: String(target.messageId) };
	}

	/**
	 * Deliver the outbox (messages the chief of staff sends on its own: results, questions, news) through a channel, now
	 * and whenever something is added. The open item learns the sent message's id, so a reply to it finds the job.
	 */
	async deliverOutbox(send: (message: OutboxMessage) => Promise<string | undefined>, context: Context): Promise<void> {
		await this.root.commit(async (tx) => void (await tx.doc(Outbox)), context);
		let draining = Promise.resolve();
		const drain = () => {
			draining = draining.then(async () => {
				const pending = (await this.harness.snapshot(Outbox, context))?.messages ?? {};
				for (const [id, message] of Object.entries(pending)) {
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
