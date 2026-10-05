// Telegram as a channel extension: one private chat with the user, long polling (no public endpoint). It reaches the
// agent only through its Inbox (anyone not on allowlist.telegram is refused by the first middleware, and again at the
// Inbox), answers each message as a reply to it, and renders the UI's cards: buttons, questions answered by reply,
// and slash commands such as /settings. It knows nothing about which extension a card belongs to.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Bot } from "grammy";
import { stamp } from "../core/schedule.ts";
import type { Button, Card, CardRef, Command } from "../core/ui.ts";
import type { Host, JarvisExtension } from "../pi/extension.ts";
import type { Arrival, ReplyTarget } from "../pi/harness.ts";

const context = BACKGROUND_CONTEXT;
const LIMIT = 4096;
const PLATFORM = "telegram";

/** Commands Telegram handles itself, advertised alongside everyone else's. */
const OWN: Command[] = [
	{ name: "new", description: "Start a fresh topic (optionally followed by your message)" },
	{ name: "whoami", description: "Your Telegram user id" },
];

const keyboard = (buttons: Button[][]) => ({ inline_keyboard: buttons.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data }))) });

export function telegramExtension(host: Host): JarvisExtension {
	let bot: Bot | undefined;
	let stopAdvertising: (() => void) | undefined;

	const start = async () => {
		const token = host.secrets.get("telegram.token", "TELEGRAM_BOT_TOKEN");
		if (token === undefined) return host.log("telegram: no bot token (TELEGRAM_BOT_TOKEN, or /settings → Telegram)");
		const inbox = host.inbox(PLATFORM);
		const live = new Bot(token);
		bot = live;
		const ref = (chatId: number, messageId: number): CardRef => ({ channel: PLATFORM, chatId, messageId });
		/** Messages that asked for a reply: the reply goes to the card's owner, not the agent. */
		const asks = new Map<number, NonNullable<Card["ask"]>>();

		/** Send, split to Telegram's limit; resolves with the last message's id. Silent unless `buzz`. */
		const send = async (chatId: number, text: string, replyTo?: number, buzz = true): Promise<number> => {
			let last = 0;
			for (let at = 0; at < text.length || at === 0; at += LIMIT) {
				const sent = await live.api.sendMessage(chatId, text.slice(at, at + LIMIT) || "(empty)", {
					...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
					disable_notification: !buzz,
				});
				last = sent.message_id;
			}
			return last;
		};

		const deliver = async (requestId: string, content: string, target: ReplyTarget, from: number | undefined, arrival: Arrival = {}) => {
			const started = Date.now();
			const typing = setInterval(() => void live.api.sendChatAction(target.chatId, "typing").catch(() => {}), 4000);
			void live.api.sendChatAction(target.chatId, "typing").catch(() => {});
			try {
				const answer = from !== undefined ? await inbox.ask(from, requestId, content, target, context, arrival) : await inbox.answer(requestId, content, context);
				await send(target.chatId, "text" in answer ? answer.text : `Couldn't answer that: ${answer.error}`, target.messageId);
				await inbox.delivered(requestId, context);
				host.log(`${requestId} answered in ${Date.now() - started}ms`);
			} finally {
				clearInterval(typing);
			}
		};

		// The hard allowlist, first: updates from anyone else, or from any chat but a private one, stop here. With no one
		// on the list yet, /whoami tells a person their own id, and nothing else.
		live.use(async (ctx, next) => {
			if (ctx.chat?.type === "private" && inbox.admits(ctx.from?.id)) return next();
			if (inbox.allowed().length === 0 && ctx.chat?.type === "private" && ctx.message?.text?.startsWith("/whoami") === true) {
				await ctx.reply(`Your Telegram user id is ${ctx.from?.id}. Put it in "allowlist": { "telegram": [...] } in data/settings.json.`);
			}
		});

		live.command("whoami", (ctx) => ctx.reply(`Your Telegram user id is ${ctx.from?.id}; you're on the allowlist.`));

		live.on("callback_query:data", async (ctx) => {
			await ctx.answerCallbackQuery();
			const message = ctx.callbackQuery.message;
			if (message !== undefined) await host.ui.press(ctx.callbackQuery.data, ref(message.chat.id, message.message_id));
		});

		live.on("message:text", async (ctx) => {
			const here = ref(ctx.chat.id, ctx.message.message_id);
			const replied = ctx.message.reply_to_message;
			const ask = replied === undefined ? undefined : asks.get(replied.message_id);
			if (ask !== undefined) {
				if (ask.secret === true) await ctx.deleteMessage().catch(() => {});
				asks.delete(replied!.message_id);
				return void (await host.ui.reply(ask.data, ctx.message.text, here));
			}
			const command = /^\/(\w+)(?:@\w+)?\s*$/.exec(ctx.message.text)?.[1];
			if (command !== undefined && command !== "new" && (await host.ui.run(command, here))) return;

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
			if (replied !== undefined && (replied.text ?? replied.caption) !== undefined) {
				arrival.replyTo = { messageId: replied.message_id, text: replied.text ?? replied.caption ?? "", at: replied.date * 1000 };
			}
			const target = { chatId: ctx.chat.id, messageId: ctx.message.message_id, channel: PLATFORM };
			const requestId = `tg:${target.chatId}:${target.messageId}`;
			const content = `[${stamp(ctx.message.date * 1000, host.settings.get().timezone)}] ${text}`;
			void deliver(requestId, content, target, ctx.from.id, arrival).catch((error: unknown) => host.log(`${requestId} failed: ${String(error)}`));
		});

		// Cards from any extension (and the agent's own messages): to the user's private chat, whose id is their user id.
		host.ui.attach({
			channel: PLATFORM,
			show: async (card, replace) => {
				const markup = card.buttons === undefined ? {} : { reply_markup: keyboard(card.buttons) };
				if (replace !== undefined) {
					await live.api.editMessageText(replace.chatId, replace.messageId, card.text, markup).catch(() => {});
					return replace;
				}
				const owner = inbox.owner();
				const chatId = card.replyTo?.channel === PLATFORM ? card.replyTo.chatId : owner === undefined ? undefined : Number(owner);
				if (chatId === undefined) throw new Error("telegram: no one on the allowlist to show it to");
				const replyTo = card.replyTo?.channel === PLATFORM ? card.replyTo.messageId : undefined;
				if (card.buttons === undefined && card.ask === undefined) return ref(chatId, await send(chatId, card.text, replyTo, card.buzz ?? true));
				const sent = await live.api.sendMessage(chatId, card.text, {
					...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
					disable_notification: card.buzz === false,
					...(card.ask === undefined ? markup : { reply_markup: { force_reply: true, input_field_placeholder: card.ask.placeholder ?? "" } }),
				});
				if (card.ask !== undefined) asks.set(sent.message_id, card.ask);
				return ref(chatId, sent.message_id);
			},
		});

		// The command menu: every command registered with the UI (by any extension) plus Telegram's own, kept current as
		// extensions add theirs. Telegram allows lowercase names of up to 32 characters.
		let advertising = Promise.resolve();
		const advertise = () => {
			const commands = [...host.ui.commands(), ...OWN]
				.filter((command) => /^[a-z0-9_]{1,32}$/.test(command.name))
				.map((command) => ({ command: command.name, description: command.description.slice(0, 256) || command.name }));
			advertising = advertising
				.then(() => live.api.setMyCommands(commands, { scope: { type: "all_private_chats" } }))
				.then(() => void 0)
				.catch((error: unknown) => host.log(`telegram: couldn't set the command menu: ${String(error)}`));
		};
		stopAdvertising = host.ui.onCommands(advertise);
		advertise();

		// Answers admitted before the last restart and never delivered.
		for (const { requestId, content, chatId, messageId } of await inbox.pending(context)) {
			void deliver(requestId, content, { chatId, messageId, channel: PLATFORM }, undefined).catch((error: unknown) => host.log(`${requestId} failed: ${String(error)}`));
		}

		live.catch((error) => host.log(`telegram: ${String(error.error)}`));
		void live.start({ onStart: (me) => host.log(`telegram: polling as @${me.username}`) }).catch((error: unknown) => host.log(`telegram: ${String(error)}`));
	};

	return {
		name: "telegram",
		title: "Telegram",
		about: "Talk to it in a private chat. Only people on allowlist.telegram in data/settings.json get through.",
		channel: PLATFORM,
		settings: [{ key: "token", label: "Bot token (from @BotFather)", kind: "secret", env: "TELEGRAM_BOT_TOKEN" }],
		start,
		stop: async () => {
			stopAdvertising?.();
			host.ui.detach(PLATFORM);
			await bot?.stop();
			bot = undefined;
		},
	};
}
