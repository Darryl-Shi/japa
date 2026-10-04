// Telegram in and out: one DM with the owner, long polling (no public endpoint), each answer sent as a reply to
// the message that asked for it.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Bot } from "grammy";
import type { Arrival, MainThread, ReplyTarget } from "../pi/harness.ts";
import type { SettingsFile } from "../settings.ts";

const context = BACKGROUND_CONTEXT;
const LIMIT = 4096;

/** "Sat 4 Oct 14:05": from the message's own date, so a redelivery stamps it the same way. */
export function stamp(at: number, timeZone?: string): string {
	const parts = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
	const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return `${part("weekday")} ${part("day")} ${part("month")} ${part("hour")}:${part("minute")}`;
}

export function startTelegram(options: { token: string; thread: MainThread; settings: SettingsFile; log?: (line: string) => void }): Bot {
	const { thread, settings } = options;
	const log = options.log ?? ((line: string) => console.log(line));
	const bot = new Bot(options.token);

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

	const deliver = async (requestId: string, content: string, target: ReplyTarget, admit: boolean, arrival: Arrival = {}) => {
		const started = Date.now();
		const typing = setInterval(() => void bot.api.sendChatAction(target.chatId, "typing").catch(() => {}), 4000);
		void bot.api.sendChatAction(target.chatId, "typing").catch(() => {});
		try {
			const answer = admit ? await thread.ask(requestId, content, target, context, arrival) : await thread.answer(requestId, content, context);
			await send(target.chatId, "text" in answer ? answer.text : `Couldn't answer that: ${answer.error}`, target.messageId);
			await thread.delivered(requestId, context);
			log(`${requestId} answered in ${Date.now() - started}ms`);
		} finally {
			clearInterval(typing);
		}
	};

	bot.command("whoami", (ctx) => ctx.reply(`chat id ${ctx.chat.id}`));

	bot.on("message:text", async (ctx) => {
		const owner = settings.get().telegram.ownerChatId;
		if (owner === undefined || ctx.chat.id !== owner) {
			log(`ignored message from chat ${ctx.chat.id}`);
			return;
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
			.then(() => deliver(requestId, content, target, true, arrival))
			.catch((error: unknown) => log(`${requestId} failed: ${String(error)}`));
	});

	// Answers admitted before the last restart and never delivered.
	void thread.pending(context).then((pending) => {
		for (const { requestId, content, chatId, messageId } of pending) {
			void deliver(requestId, content, { chatId, messageId }, false).catch((error: unknown) => log(`${requestId} failed: ${String(error)}`));
		}
	});

	// Reports and other messages from background work: replies to the message that asked, silent unless they need the user.
	void thread.deliverOutbox(async (message) => {
		const chatId = message.replyTo?.chatId ?? settings.get().telegram.ownerChatId;
		if (chatId === undefined) return undefined;
		return send(chatId, message.text, message.replyTo?.messageId, message.buzz);
	}, context);

	bot.catch((error) => log(`telegram: ${String(error.error)}`));
	void bot.start({ onStart: (me) => log(`telegram: polling as @${me.username}`) });
	return bot;
}
