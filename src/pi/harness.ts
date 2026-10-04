// The Pi Durable side of the main conversation. Everything Pi-specific about opening the harness, the root
// conversation and getting answers back to a channel lives here.
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Conversation,
	createRegistry,
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
				].join("\n"),
			{ tag: false },
		),
		// By the day, not the minute, so the prompt cache stays warm.
		section("today", () => new Date().toISOString().slice(0, 10)),
	],
});

export type Answer = { text: string } | { error: string };

export class MainThread {
	readonly harness: Harness;
	readonly root: Conversation;

	private constructor(harness: Harness, root: Conversation) {
		this.harness = harness;
		this.root = root;
	}

	static async open(options: { dataDir?: string; storage?: Storage; models: Models; settings: () => Settings }, context: Context): Promise<MainThread> {
		const registry = createRegistry();
		registry.install(Core);
		const storage = options.storage ?? (await openNodeSqliteStorage(join(options.dataDir ?? "data", "session.sqlite")));
		const harness = await Harness.open(storage, { models: options.models, registry }, context);
		const root = await harness.root(context, { agent: { model: options.settings().model } });
		const thread = new MainThread(harness, root);
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
		const submission = await this.root.submit({ type: "input", content, requestId }, context);
		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input") {
			return { error: settled.status === "unanswered" ? settled.reason : settled.status };
		}
		const entry = await this.root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		const message = entry?.model?.[0];
		if (message?.role !== "assistant") return { error: "no answer" };
		const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		return message.stopReason === "error" ? { error: message.errorMessage ?? "model error" } : { text };
	}

	async delivered(requestId: string, context: Context): Promise<void> {
		await this.root.commit(async (tx) => {
			delete (await tx.doc(PendingReplies)).byRequest[requestId];
		}, context);
	}

	close(context: Context): Promise<void> {
		return this.harness.close(context);
	}
}
