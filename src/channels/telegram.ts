// Telegram in and out: one private chat with the user (only people on the allowlist get past the first middleware), long polling (no public endpoint), each answer sent as a reply to
// the message that asked for it.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Bot } from "grammy";
import type { ApprovalRequest, Approvals, Decision } from "../core/approvals.ts";
import type { Arrival, ReplyTarget } from "../pi/harness.ts";
import type { SettingsFile } from "../settings.ts";
import type { Inbox } from "./inbox.ts";
import type { Button, Prompt, SettingsMenu, View } from "./settings-menu.ts";

const context = BACKGROUND_CONTEXT;
const LIMIT = 4096;

/** "Sat 4 Oct 14:05": from the message's own date, so a redelivery stamps it the same way. */
export function stamp(at: number, timeZone?: string): string {
	const parts = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
	const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return `${part("weekday")} ${part("day")} ${part("month")} ${part("hour")}:${part("minute")}`;
}

export type Telegram = {
	/** Put a message to the chief of staff as if from the user (e.g. their tap on an approval), and deliver its answer. */
	tell: (requestId: string, text: string, target: ReplyTarget) => Promise<void>;
	stop: () => Promise<void>;
};

const keyboard = (buttons: Button[][]) => ({ inline_keyboard: buttons.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data }))) });

export function startTelegram(options: {
	token: string;
	/** The only way in: the allowlist is checked before anything else runs. */
	inbox: Inbox;
	settings: SettingsFile;
	menu?: SettingsMenu;
	approvals?: Approvals;
	log?: (line: string) => void;
}): Telegram {
	const { inbox, settings, menu, approvals } = options;
	const thread = inbox.main;
	const log = options.log ?? ((line: string) => console.log(line));
	const bot = new Bot(options.token);
	/** The user's private chat (in Telegram its id is their user id). */
	const ownerChat = () => (inbox.owner() === undefined ? undefined : Number(inbox.owner()));

	// The hard allowlist, first: updates from anyone else, or from any chat but a private one, stop here. With no one on
	// the list yet, /whoami tells a person their own id, and nothing else.
	bot.use(async (ctx, next) => {
		if (ctx.chat?.type === "private" && inbox.admits(ctx.from?.id)) return next();
		if (inbox.allowed().length === 0 && ctx.chat?.type === "private" && ctx.message?.text?.startsWith("/whoami") === true) {
			await ctx.reply(`Your Telegram user id is ${ctx.from?.id}. Put it in "allowlist": { "telegram": [...] } in data/settings.json.`);
		}
	});

	/** Send, split to Telegram's limit; resolves with the last message's id. Silent unless `buzz`. */
	const send = async (chatId: number, text: string, replyTo?: number, buzz = true): Promise<number> => {
		let last = 0;
		for (let start = 0; start < text.length || start === 0; start += LIMIT) {
			const sent = await bot.api.sendMessage(chatId, text.slice(start, start + LIMIT) || "(empty)", {
				...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
				disable_notification: !buzz,
			});
			last = sent.message_id;
		}
		return last;
	};

	/** `from`: the sender, for a new message; undefined to redeliver one admitted before a restart. */
	const deliver = async (requestId: string, content: string, target: ReplyTarget, from: number | string | undefined, arrival: Arrival = {}) => {
		const started = Date.now();
		const typing = setInterval(() => void bot.api.sendChatAction(target.chatId, "typing").catch(() => {}), 4000);
		void bot.api.sendChatAction(target.chatId, "typing").catch(() => {});
		try {
			const answer = from !== undefined ? await inbox.ask(from, requestId, content, target, context, arrival) : await thread.answer(requestId, content, context);
			await send(target.chatId, "text" in answer ? answer.text : `Couldn't answer that: ${answer.error}`, target.messageId);
			await thread.delivered(requestId, context);
			log(`${requestId} answered in ${Date.now() - started}ms`);
		} finally {
			clearInterval(typing);
		}
	};

	bot.command("whoami", (ctx) => ctx.reply(`Your Telegram user id is ${ctx.from?.id}; you're on the allowlist.`));

	// /settings: a menu of buttons. A field that needs a value asks for it; the reply to that question sets it.
	const prompts = new Map<number, Prompt>();
	const showView = async (chatId: number, view: View, editing?: number) => {
		if (editing !== undefined) await bot.api.editMessageText(chatId, editing, view.text, { reply_markup: keyboard(view.buttons) }).catch(() => {});
		else await bot.api.sendMessage(chatId, view.text, { reply_markup: keyboard(view.buttons) });
	};
	bot.command("settings", async (ctx) => {
		if (menu !== undefined) await showView(ctx.chat.id, menu.main());
	});

	bot.on("callback_query:data", async (ctx) => {
		const chatId = ctx.chat?.id;
		const messageId = ctx.callbackQuery.message?.message_id;
		if (chatId === undefined || messageId === undefined) return void (await ctx.answerCallbackQuery());
		const data = ctx.callbackQuery.data;
		if (data.startsWith("st:") && menu !== undefined) {
			const next = menu.press(data);
			await ctx.answerCallbackQuery();
			if ("buttons" in next) return void (await showView(chatId, next, messageId));
			const asked = await bot.api.sendMessage(chatId, `Send the new value for "${next.label}" as a reply to this message ("-" to clear).${next.secret ? " I'll delete your message once it's saved." : ""}`, {
				reply_markup: { force_reply: true, input_field_placeholder: next.label },
			});
			prompts.set(asked.message_id, next);
			return;
		}
		if (data.startsWith("ap:") && approvals !== undefined) {
			const [, id = "", choice] = data.split(":");
			const decision: Decision = choice === "y" ? "approve" : choice === "a" ? "always" : "deny";
			const decided = approvals.decide(id, decision);
			await ctx.answerCallbackQuery(decided === undefined ? { text: "Already decided." } : {});
			const request = approvals.get(id);
			if (request !== undefined) await bot.api.editMessageText(chatId, messageId, approvalText(request, decision)).catch(() => {});
			return;
		}
		await ctx.answerCallbackQuery();
	});

	bot.on("message:text", async (ctx) => {
		const prompt = ctx.message.reply_to_message === undefined ? undefined : prompts.get(ctx.message.reply_to_message.message_id);
		if (prompt !== undefined && menu !== undefined) {
			const result = menu.answer(prompt, ctx.message.text);
			if (prompt.secret) await ctx.deleteMessage().catch(() => {});
			if ("error" in result) return void (await ctx.reply(result.error));
			prompts.delete(ctx.message.reply_to_message!.message_id);
			return void (await showView(ctx.chat.id, result));
		}
		let text = ctx.message.text;
		const arrival: Arrival = {};
		// "/new" (optionally followed by the message) starts the model on a fresh slice.
		const fresh = /^\/new(?:@\w+)?(?:\s+|$)/.exec(text);
		if (fresh !== null) {
			arrival.newTopic = true;
			text = text.slice(fresh[0].length);
			if (text.trim() === "") {
				await ctx.reply("Fresh start.", { reply_parameters: { message_id: ctx.message.message_id } });
				text = "(New topic.)";
			}
		}
		const replied = ctx.message.reply_to_message;
		if (replied !== undefined && (replied.text ?? replied.caption) !== undefined) {
			arrival.replyTo = { messageId: replied.message_id, text: replied.text ?? replied.caption ?? "", at: replied.date * 1000 };
		}
		const target = { chatId: ctx.chat.id, messageId: ctx.message.message_id };
		const requestId = `tg:${target.chatId}:${target.messageId}`;
		const content = `[${stamp(ctx.message.date * 1000, settings.get().timezone)}] ${text}`;
		void thread
			.applySettings(settings.get(), context)
			.then(() => deliver(requestId, content, target, ctx.from.id, arrival))
			.catch((error: unknown) => log(`${requestId} failed: ${String(error)}`));
	});

	// Answers admitted before the last restart and never delivered.
	void thread.pending(context).then((pending) => {
		for (const { requestId, content, chatId, messageId } of pending) {
			void deliver(requestId, content, { chatId, messageId }, undefined).catch((error: unknown) => log(`${requestId} failed: ${String(error)}`));
		}
	});

	// Reports and other messages from background work: replies to the message that asked, silent unless they need the user.
	void thread.deliverOutbox(async (message) => {
		const chatId = message.replyTo?.chatId ?? ownerChat();
		if (chatId === undefined) return undefined;
		return send(chatId, message.text, message.replyTo?.messageId, message.buzz);
	}, context);

	// Approval requests: a message with buttons, sent once (again after a restart if it never went out).
	const ask = async (request: ApprovalRequest) => {
		const chatId = ownerChat();
		if (chatId === undefined || approvals === undefined || request.messageId !== undefined || request.status !== "pending") return;
		const sent = await bot.api.sendMessage(chatId, approvalText(request), {
			reply_markup: keyboard([[{ text: "Approve", data: `ap:${request.id}:y` }, { text: "Deny", data: `ap:${request.id}:n` }], [{ text: `Always: ${request.rule}`.slice(0, 60), data: `ap:${request.id}:a` }]]),
		});
		approvals.update(request.id, { messageId: sent.message_id });
	};
	if (approvals !== undefined) {
		approvals.onRequest((request) => void ask(request).catch((error: unknown) => log(`approval ${request.id}: ${String(error)}`)));
		for (const request of approvals.all()) void ask(request).catch((error: unknown) => log(`approval ${request.id}: ${String(error)}`));
	}

	bot.catch((error) => log(`telegram: ${String(error.error)}`));
	void bot.start({ onStart: (me) => log(`telegram: polling as @${me.username}`) });
	return {
		tell: async (requestId, text, target) => {
			const owner = inbox.owner();
			if (owner !== undefined) await deliver(requestId, `[${stamp(Date.now(), settings.get().timezone)}] ${text}`, { ...target, chatId: target.chatId || Number(owner) }, owner);
		},
		stop: () => bot.stop(),
	};
}

function approvalText(request: ApprovalRequest, decision?: Decision): string {
	const args = request.args.length > 600 ? `${request.args.slice(0, 600)}…` : request.args;
	const head = decision === undefined ? "Approve?" : decision === "deny" ? "Denied." : decision === "always" ? "Approved (and always from now on)." : "Approved.";
	return `${head} ${request.summary}\n\n${request.tool} ${args}`;
}
