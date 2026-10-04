// Telegram in and out: one DM with the owner, long polling (no public endpoint), each answer sent as a reply to
// the message that asked for it.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Bot } from "grammy";
import type { MainThread, ReplyTarget } from "../pi/harness.ts";
import type { SettingsFile } from "../settings.ts";

const context = BACKGROUND_CONTEXT;
const LIMIT = 4096;

export function startTelegram(options: { token: string; thread: MainThread; settings: SettingsFile; log?: (line: string) => void }): Bot {
	const { thread, settings } = options;
	const log = options.log ?? ((line: string) => console.log(line));
	const bot = new Bot(options.token);

	const send = async (target: ReplyTarget, text: string) => {
		for (let start = 0; start < text.length || start === 0; start += LIMIT) {
			await bot.api.sendMessage(target.chatId, text.slice(start, start + LIMIT) || "(empty answer)", {
				reply_parameters: { message_id: target.messageId, allow_sending_without_reply: true },
			});
		}
	};

	const deliver = async (requestId: string, content: string, target: ReplyTarget, admit: boolean) => {
		const started = Date.now();
		const typing = setInterval(() => void bot.api.sendChatAction(target.chatId, "typing").catch(() => {}), 4000);
		void bot.api.sendChatAction(target.chatId, "typing").catch(() => {});
		try {
			const answer = admit ? await thread.ask(requestId, content, target, context) : await thread.answer(requestId, content, context);
			await send(target, "text" in answer ? answer.text : `Couldn't answer that: ${answer.error}`);
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
		const target = { chatId: ctx.chat.id, messageId: ctx.message.message_id };
		const requestId = `tg:${target.chatId}:${target.messageId}`;
		void thread.applySettings(settings.get(), context).then(() => deliver(requestId, ctx.message.text, target, true)).catch((error: unknown) => log(`${requestId} failed: ${String(error)}`));
	});

	// Answers admitted before the last restart and never delivered.
	void thread.pending(context).then((pending) => {
		for (const { requestId, content, chatId, messageId } of pending) {
			void deliver(requestId, content, { chatId, messageId }, false).catch((error: unknown) => log(`${requestId} failed: ${String(error)}`));
		}
	});

	bot.catch((error) => log(`telegram: ${String(error.error)}`));
	void bot.start({ onStart: (me) => log(`telegram: polling as @${me.username}`) });
	return bot;
}
