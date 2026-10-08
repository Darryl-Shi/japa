import { setTimeout as sleep } from "node:timers/promises";
import {
  defineJapaExtension,
  type KernelContext,
  type MessagingAdapter,
  type MessagingAdapterContext,
  type OutgoingMessage,
} from "../../src/sdk.ts";
import { ApiError, type BotApi, backoff, botApi } from "./api.ts";
import { toHtml } from "./html.ts";
import { parseUpdate, type Update } from "./updates.ts";

const NAME = "telegram.botToken";
const BASE = "https://api.telegram.org";

let kernel!: KernelContext;
let signal!: AbortSignal; // the running adapter's; aborted by its dispose
let api: BotApi | undefined; // for the current token, until a 401
let commands: { name: string; description: string }[] = []; // registered by the polling loop

async function call<T>(method: string, params: object): Promise<T> {
  if (api === undefined) {
    const token = await kernel.secret(NAME);
    if (token === undefined) throw new Error("Telegram is not connected");
    api = botApi(BASE, token, signal);
  }
  try {
    return await api.call<T>(method, params);
  } catch (error) {
    if (error instanceof ApiError && error.code === 401) api = undefined;
    throw error;
  }
}

/** Sends `m` as HTML through `method`, or as plain text when Telegram can't parse the HTML. */
async function post<T>(method: string, params: object, m: OutgoingMessage): Promise<T> {
  for (const b of m.buttons?.flat() ?? []) {
    if (Buffer.byteLength(b.action) > 64) throw new Error(`Button action over 64 bytes: ${b.action}`);
  }
  const reply_markup = m.buttons && {
    inline_keyboard: m.buttons.map((row) => row.map((b) => ({ text: b.label, callback_data: b.action }))),
  };
  try {
    return await call<T>(method, { ...params, text: toHtml(m.markdown), parse_mode: "HTML", reply_markup });
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 400 && error.message.includes("can't parse entities"))) throw error;
    return call<T>(method, { ...params, text: m.markdown, reply_markup });
  }
}

/**
 * Long-polls updates into `ctx.receive` until `signal` aborts; each batch is confirmed (by the next offset) only after
 * it has been handled. Waits for the bot token, and asks for a new one when Telegram rejects it.
 */
async function poll(ctx: MessagingAdapterContext, signal: AbortSignal) {
  const provided = kernel.secretProvided(NAME); // waiting already, so a token provided meanwhile isn't missed
  let token = kernel.secret(NAME).then((t) => t ?? provided);
  let bot: BotApi | undefined;
  let offset: number | undefined;
  for (let attempt = 0; ; ) {
    try {
      if (bot === undefined) {
        const value = await token;
        if (signal.aborted) return; // a waiter of a stopped adapter
        bot = api = botApi(BASE, value, signal);
        const list = commands.map((c) => ({ command: c.name, description: c.description }));
        await bot.call("setMyCommands", { commands: list });
      }
      const allowed_updates = ["message", "callback_query"];
      for (const update of await bot.once<Update[]>("getUpdates", { offset, timeout: 50, allowed_updates })) {
        if (signal.aborted) return;
        await handle(ctx, bot, update).catch((error) => console.error(`telegram: ${error.message}`));
        offset = update.update_id + 1;
      }
      attempt = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiError && error.code === 401) {
        bot = api = undefined;
        token = kernel.requestSecret(NAME, "Telegram rejected the bot token. Send a new one from @BotFather.");
      } else {
        await sleep(backoff(attempt++), undefined, { signal }).catch(() => {});
      }
    }
  }
}

async function handle(ctx: MessagingAdapterContext, bot: BotApi, update: Update) {
  if (update.callback_query) {
    await bot.call("answerCallbackQuery", { callback_query_id: update.callback_query.id }).catch(() => {});
  }
  const parsed = await parseUpdate(update, bot);
  if (typeof parsed === "string") await adapter.send(String(update.message!.chat.id), { markdown: parsed });
  else if (parsed) await ctx.receive(parsed);
}

const adapter: MessagingAdapter = {
  name: "telegram",
  maxMessageChars: 4096,
  start: async (ctx) => {
    const controller = new AbortController();
    signal = controller.signal;
    api = undefined;
    void poll(ctx, signal);
    return async () => controller.abort();
  },
  send: async (chat, m) => String((await post<{ message_id: number }>("sendMessage", { chat_id: chat }, m)).message_id),
  edit: async (chat, id, m) => {
    await post("editMessageText", { chat_id: chat, message_id: Number(id) }, m);
  },
  delete: async (chat, id) => {
    await call("deleteMessage", { chat_id: chat, message_id: Number(id) });
  },
  typing: async (chat) => {
    await call("sendChatAction", { chat_id: chat, action: "typing" });
  },
  commands: async (list) => {
    commands = list;
  },
};

export default defineJapaExtension({
  name: "telegram",
  summary:
    "Chat with japa on Telegram. To connect, ask the user for the secret telegram.botToken (a bot token from " +
    "@BotFather); the bot then tells them their Telegram user id, which goes in settings extensions.telegram.owner.",
  secrets: [NAME],
  setup: (ctx) => {
    kernel = ctx;
  },
  provides: { messaging: [adapter] },
});
