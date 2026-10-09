import { setTimeout as sleep } from "node:timers/promises";
import {
  defineJapaExtension,
  type KernelContext,
  type MessagingAdapter,
  type MessagingAdapterContext,
  type OutgoingMessage,
  splitMessage,
} from "../../src/sdk.ts";
import { ApiError, type BotApi, backoff, botApi } from "./api.ts";
import { toHtml, toPlain, visibleLength } from "./html.ts";
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

/** Telegram's limit on `input_field_placeholder`, in characters. */
const MAX_PLACEHOLDER = 64;

/** `text` cut to `max` characters, ending in "…" when cut. */
function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** Telegram's limit on a message's text after entity parsing, in characters. */
const MAX_TEXT = 4096;

/**
 * The `reply_markup` for `m`: a message with `input` asks for a reply (force_reply), showing its placeholder in the
 * input field; one with buttons gets an inline keyboard. Throws for a message Telegram would refuse.
 */
function replyMarkup(m: OutgoingMessage) {
  if (m.input && m.buttons) throw new Error("A message can't have both input and buttons");
  for (const b of m.buttons?.flat() ?? []) {
    if (Buffer.byteLength(b.action) > 64) throw new Error(`Button action over 64 bytes: ${b.action}`);
  }
  return m.input
    ? { force_reply: true, input_field_placeholder: truncate(m.input.placeholder, MAX_PLACEHOLDER) }
    : m.buttons && {
        inline_keyboard: m.buttons.map((row) => row.map((b) => ({ text: b.label, callback_data: b.action }))),
      };
}

/** Sends `markdown` as HTML through `method`, or as plain text when Telegram can't parse the HTML. */
async function post<T>(method: string, params: object, markdown: string, reply_markup?: object): Promise<T> {
  try {
    return await call<T>(method, { ...params, text: toHtml(markdown), parse_mode: "HTML", reply_markup });
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 400 && error.message.includes("can't parse entities"))) throw error;
    return call<T>(method, { ...params, text: toPlain(markdown), reply_markup });
  }
}

/**
 * `markdown` in parts whose rendered text fits Telegram's limit: a part rendering over it (padded tables grow) is
 * split again at half its size.
 */
function fit(markdown: string): string[] {
  if (visibleLength(toHtml(markdown)) <= MAX_TEXT) return [markdown];
  const parts = splitMessage(markdown, Math.ceil(markdown.length / 2));
  return parts.length > 1 ? parts.flatMap(fit) : parts;
}

/** Sends `m` to `chat` in as many messages as its rendered text needs, the markup on the last; that one's id. */
async function send(chat: string, m: OutgoingMessage): Promise<string> {
  const reply_markup = replyMarkup(m);
  const parts = fit(m.markdown);
  let id = 0;
  for (const [i, part] of parts.entries()) {
    const markup = i === parts.length - 1 ? reply_markup : undefined;
    id = (await post<{ message_id: number }>("sendMessage", { chat_id: chat }, part, markup)).message_id;
  }
  return String(id);
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
        const fresh = (api = botApi(BASE, value, signal));
        const list = commands.map((c) => ({ command: c.name, description: c.description }));
        await fresh.call("setMyCommands", { commands: list });
        bot = fresh;
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
        console.error(`telegram: ${(error as Error).message}`);
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
  send,
  edit: async (chat, id, m) => {
    await post("editMessageText", { chat_id: chat, message_id: Number(id) }, m.markdown, replyMarkup(m));
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
  summary: "Chat with japa on Telegram, with /jobs, /status and /settings menus",
  secrets: [{ name: NAME, description: "Bot token from @BotFather (/newbot)" }],
  setup: (ctx) => {
    kernel = ctx;
  },
  provides: { messaging: [adapter] },
});
