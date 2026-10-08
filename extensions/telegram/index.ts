import { defineJapaExtension, type KernelContext, type MessagingAdapter, type OutgoingMessage } from "../../src/sdk.ts";
import { ApiError, type BotApi, botApi } from "./api.ts";
import { toHtml } from "./html.ts";

const NAME = "telegram.botToken";

let kernel!: KernelContext;
let signal!: AbortSignal; // the running adapter's; aborted by its dispose
let api: BotApi | undefined; // for the current token, until a 401
let commands: { name: string; description: string }[] = []; // registered by the polling loop

async function call<T>(method: string, params: object): Promise<T> {
  if (api === undefined) {
    const token = await kernel.secret(NAME);
    if (token === undefined) throw new Error("Telegram is not connected");
    api = botApi("https://api.telegram.org", token, signal);
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

const adapter: MessagingAdapter = {
  name: "telegram",
  maxMessageChars: 4096,
  start: async () => {
    const controller = new AbortController();
    signal = controller.signal;
    api = undefined;
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
