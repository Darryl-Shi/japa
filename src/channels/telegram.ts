// Telegram as a channel, on the core's Channel adapter: one private chat with the user, long polling (no public
// endpoint). It reaches the agent only through the Inbox the core opens it with (anyone not on allowlist.telegram is
// refused by the first middleware, and again at the Inbox), answers each message as a reply to it, and renders the
// UI's cards: buttons, questions answered by reply, and slash commands such as /settings. It knows nothing about which
// extension a card belongs to.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Bot } from "grammy";
import type { Message } from "grammy/types";
import { stamp } from "../core/schedule.ts";
import type { Attachment } from "../core/message.ts";
import type { Button, Card, CardRef, Command } from "../core/ui.ts";
import type { Channel, Host, JapaExtension } from "../pi/extension.ts";
import type { Answer, Arrival } from "../pi/harness.ts";

const context = BACKGROUND_CONTEXT;
const LIMIT = 4096;
const PLATFORM = "telegram";

/** Commands Telegram handles itself, advertised alongside everyone else's. */
const OWN: Command[] = [
	{ name: "new", description: "Start a fresh topic (optionally followed by your message)" },
	{ name: "whoami", description: "Your Telegram user id" },
];

const keyboard = (buttons: Button[][]) => ({ inline_keyboard: buttons.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data }))) });

export function telegramExtension(host: Host): JapaExtension {
	let bot: Bot | undefined;
	let stopAdvertising: (() => void) | undefined;
	/** How cards are rendered, once open. */
	let render: Channel["show"] | undefined;

	const open: Channel["open"] = async ({ inbox, ui }) => {
		const token = host.secrets.get("telegram.token", "TELEGRAM_BOT_TOKEN");
		if (token === undefined) throw new Error("no bot token (TELEGRAM_BOT_TOKEN, or /settings → Telegram)");
		const live = new Bot(token);
		bot = live;
		// The UI's ids are strings; Telegram's are numbers, converted here at its edge.
		const ref = (chatId: number, messageId: number): CardRef => ({ channel: PLATFORM, chatId: String(chatId), messageId: String(messageId) });
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

		/** Get a message's answer (new, or admitted before a restart) and send it, as a reply to it when there is one. */
		const deliver = async (requestId: string, get: () => Promise<Answer>, chatId: number, messageId: number | undefined) => {
			const started = Date.now();
			const typing = setInterval(() => void live.api.sendChatAction(chatId, "typing").catch(() => {}), 4000);
			void live.api.sendChatAction(chatId, "typing").catch(() => {});
			try {
				const answer = await get();
				await send(chatId, "text" in answer ? answer.text : `Couldn't answer that: ${answer.error}`, messageId);
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
				await ctx.reply(`Your Telegram user id is ${ctx.from?.id}. Put it in "allowlist": { "telegram": [...] } in ${host.settings.path}.`);
			}
		});

		live.command("whoami", (ctx) => ctx.reply(`Your Telegram user id is ${ctx.from?.id}; you're on the allowlist.`));

		live.on("callback_query:data", async (ctx) => {
			await ctx.answerCallbackQuery();
			const message = ctx.callbackQuery.message;
			if (message !== undefined) await ui.press(ctx.callbackQuery.data, ref(message.chat.id, message.message_id));
		});

		/** A message on its way to the agent: /new, what it replies to, the time it was sent; answered as a reply to it. */
		const arrive = async (message: Message, said: string, attachments: Attachment[]) => {
			let text = said;
			const replied = message.reply_to_message;
			const arrival: Arrival = {};
			// "/new" (optionally followed by the message) starts the model on a fresh slice.
			const fresh = /^\/new(?:@\w+)?(?:\s+|$)/.exec(text);
			if (fresh !== null) {
				arrival.newTopic = true;
				text = text.slice(fresh[0].length);
				if (text.trim() === "" && attachments.length === 0) {
					await live.api.sendMessage(message.chat.id, "Fresh start.", { reply_parameters: { message_id: message.message_id } });
					text = "(New topic.)";
				}
			}
			if (replied !== undefined && (replied.text ?? replied.caption) !== undefined) {
				arrival.replyTo = { messageId: String(replied.message_id), text: replied.text ?? replied.caption ?? "", at: replied.date * 1000 };
			}
			const requestId = `tg:${message.chat.id}:${message.message_id}`;
			const content = `[${stamp(message.date * 1000, host.settings.get().timezone)}] ${text}`;
			const from = message.from?.id ?? message.chat.id;
			const answer = () => inbox.ask(from, requestId, { text: content, attachments }, ref(message.chat.id, message.message_id), context, arrival);
			void deliver(requestId, answer, message.chat.id, message.message_id).catch((error: unknown) => host.log(`${requestId} failed: ${String(error)}`));
		};

		/** A file in a message, as Telegram describes it: what to download, and what to call it. */
		const fileOf = (message: Message): { id: string; name: string; mimeType: string } | undefined => {
			const photo = message.photo?.at(-1);
			if (photo !== undefined) return { id: photo.file_id, name: "photo.jpg", mimeType: "image/jpeg" };
			if (message.voice !== undefined) return { id: message.voice.file_id, name: "voice.ogg", mimeType: message.voice.mime_type ?? "audio/ogg" };
			if (message.audio !== undefined) return { id: message.audio.file_id, name: message.audio.file_name ?? "audio", mimeType: message.audio.mime_type ?? "audio/mpeg" };
			if (message.video !== undefined) return { id: message.video.file_id, name: message.video.file_name ?? "video.mp4", mimeType: message.video.mime_type ?? "video/mp4" };
			if (message.video_note !== undefined) return { id: message.video_note.file_id, name: "video-note.mp4", mimeType: "video/mp4" };
			if (message.document !== undefined) return { id: message.document.file_id, name: message.document.file_name ?? "file", mimeType: message.document.mime_type ?? "application/octet-stream" };
			return undefined;
		};

		const download = async (fileId: string): Promise<Uint8Array> => {
			const file = await live.api.getFile(fileId);
			if (file.file_path === undefined) throw new Error("Telegram gave no file to download");
			const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
			if (!response.ok) throw new Error(`download failed (${response.status})`);
			return new Uint8Array(await response.arrayBuffer());
		};

		live.on("message:text", async (ctx) => {
			const here = ref(ctx.chat.id, ctx.message.message_id);
			const replied = ctx.message.reply_to_message;
			const ask = replied === undefined ? undefined : asks.get(replied.message_id);
			if (ask !== undefined) {
				if (ask.secret === true) await ctx.deleteMessage().catch(() => {});
				asks.delete(replied!.message_id);
				return void (await ui.reply(ask.data, ctx.message.text, here));
			}
			const command = /^\/(\w+)(?:@\w+)?\s*$/.exec(ctx.message.text)?.[1];
			if (command !== undefined && command !== "new" && (await ui.run(command, here))) return;
			await arrive(ctx.message, ctx.message.text, []);
		});

		// Photos, voice notes, audio, video and documents (with their caption), and places: any modality reaches the agent.
		live.on(["message:photo", "message:voice", "message:audio", "message:video", "message:video_note", "message:document"], async (ctx) => {
			const file = fileOf(ctx.message);
			let text = ctx.message.caption ?? "";
			const attachments: Attachment[] = [];
			if (file !== undefined) {
				try {
					attachments.push({ name: file.name, mimeType: file.mimeType, data: await download(file.id) });
				} catch (error) {
					text = `${text}\n[Sent ${file.name} (${file.mimeType}), but it couldn't be fetched: ${error instanceof Error ? error.message : String(error)}]`.trim();
				}
			}
			await arrive(ctx.message, text, attachments);
		});
		live.on("message:location", async (ctx) => {
			const { latitude, longitude } = ctx.message.location;
			await arrive(ctx.message, `[Location: ${latitude}, ${longitude}]`, []);
		});

		// Cards from any extension (and the agent's own messages): to the user's private chat, whose id is their user id.
		render = async (card, replace) => {
			const markup = card.buttons === undefined ? {} : { reply_markup: keyboard(card.buttons) };
			if (replace !== undefined) {
				await live.api.editMessageText(Number(replace.chatId), Number(replace.messageId), card.text, markup).catch(() => {});
				return replace;
			}
			const owner = inbox.owner();
			const chatId = card.replyTo?.channel === PLATFORM ? Number(card.replyTo.chatId) : owner === undefined ? undefined : Number(owner);
			if (chatId === undefined) throw new Error("telegram: no one on the allowlist to show it to");
			const replyTo = card.replyTo?.channel === PLATFORM ? Number(card.replyTo.messageId) : undefined;
			if (card.buttons === undefined && card.ask === undefined) return ref(chatId, await send(chatId, card.text, replyTo, card.buzz ?? true));
			const sent = await live.api.sendMessage(chatId, card.text, {
				...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
				disable_notification: card.buzz === false,
				...(card.ask === undefined ? markup : { reply_markup: { force_reply: true, input_field_placeholder: card.ask.placeholder ?? "" } }),
			});
			if (card.ask !== undefined) asks.set(sent.message_id, card.ask);
			return ref(chatId, sent.message_id);
		};

		// The command menu: every command registered with the UI (by any extension) plus Telegram's own, kept current as
		// extensions add theirs. Telegram allows lowercase names of up to 32 characters.
		let advertising = Promise.resolve();
		const advertise = () => {
			const commands = [...ui.commands(), ...OWN]
				.filter((command) => /^[a-z0-9_]{1,32}$/.test(command.name))
				.map((command) => ({ command: command.name, description: command.description.slice(0, 256) || command.name }));
			advertising = advertising
				.then(() => live.api.setMyCommands(commands, { scope: { type: "all_private_chats" } }))
				.then(() => void 0)
				.catch((error: unknown) => host.log(`telegram: couldn't set the command menu: ${String(error)}`));
		};
		stopAdvertising = ui.onCommands(advertise);
		advertise();

		// Answers admitted before the last restart and never delivered.
		for (const { requestId, content, chatId, messageId } of await inbox.pending(context)) {
			const to = chatId ?? inbox.owner();
			if (to === undefined) continue;
			void deliver(requestId, () => inbox.answer(requestId, content, context), Number(to), messageId === undefined ? undefined : Number(messageId)).catch((error: unknown) => host.log(`${requestId} failed: ${String(error)}`));
		}

		live.catch((error) => host.log(`telegram: ${String(error.error)}`));
		void live.start({ onStart: (me) => host.log(`telegram: polling as @${me.username}`) }).catch((error: unknown) => host.log(`telegram: ${String(error)}`));
	};

	return {
		name: "telegram",
		title: "Telegram",
		about: "Talk to it in a private chat. Only people on allowlist.telegram in settings.json get through.",
		settings: [{ key: "token", label: "Bot token (from @BotFather)", kind: "secret", env: "TELEGRAM_BOT_TOKEN" }],
		channel: {
			platform: PLATFORM,
			open,
			show: (card, replace) => {
				if (render === undefined) throw new Error("telegram isn't open");
				return render(card, replace);
			},
			close: async () => {
				stopAdvertising?.();
				render = undefined;
				await bot?.stop();
				bot = undefined;
			},
		},
	};
}
