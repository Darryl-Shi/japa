import type { Incoming } from "../../src/sdk.ts";
import type { BotApi } from "./api.ts";

type Chat = { id: number; type: string };
type FileInfo = { file_id: string; file_size?: number };

export type Update = {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number };
    chat: Chat;
    text?: string;
    entities?: { type: string; offset: number; length: number }[];
    caption?: string;
    photo?: FileInfo[];
    document?: FileInfo & { mime_type?: string };
    media_group_id?: string;
  };
  callback_query?: { id: string; from: { id: number }; message: { message_id: number; chat: Chat }; data: string };
};

/** The Bot API's download limit. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * `update` as an `Incoming`; or a reply to send back; or undefined when it is not from a private chat or is another
 * kind of update.
 */
export async function parseUpdate(update: Update, api: BotApi): Promise<Incoming | string | undefined> {
  const query = update.callback_query;
  const m = query?.message ?? update.message;
  if (m?.chat.type !== "private") return undefined;
  const from = {
    chat: String(m.chat.id),
    user: String((query ?? update.message)!.from.id),
    messageId: String(m.message_id),
    id: String(update.update_id),
  };
  if (query) return { ...from, action: query.data };
  const message = update.message!;
  const command = message.entities?.find((e) => e.type === "bot_command" && e.offset === 0);
  if (command) return { ...from, command: message.text!.slice(1, command.length).split("@")[0] };
  const image = message.document?.mime_type?.startsWith("image/") ? message.document : undefined;
  const file = message.photo?.at(-1) ?? image;
  if (file === undefined) {
    return message.text === undefined ? "I can only read text and images here." : { ...from, text: message.text };
  }
  if ((file.file_size ?? 0) > MAX_FILE_BYTES) {
    return "That file is too large: Telegram bots can only download files up to 20 MB.";
  }
  const { file_path } = await api.call<{ file_path: string }>("getFile", { file_id: file.file_id });
  const data = await api.download(file_path);
  return { ...from, text: message.caption, images: [{ data, mimeType: image?.mime_type ?? "image/jpeg" }] };
}
