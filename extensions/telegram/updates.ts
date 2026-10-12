import type { Incoming, IncomingFile } from "../../src/sdk.ts";
import type { BotApi } from "./api.ts";

type Chat = { id: number; type: string };
type FileInfo = { file_id: string; file_size?: number };
type NamedFile = FileInfo & { file_name?: string; mime_type?: string };

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
    document?: NamedFile;
    audio?: NamedFile;
    voice?: FileInfo & { mime_type?: string };
    video?: NamedFile;
    video_note?: FileInfo;
    animation?: NamedFile;
    media_group_id?: string;
    reply_to_message?: { message_id: number };
    // Kinds the bot doesn't read (sticker, location, contact, poll, …) are present but unused.
    [kind: string]: unknown;
  };
  callback_query?: { id: string; from: { id: number }; message: { message_id: number; chat: Chat }; data: string };
};

/** The Bot API's download limit. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** The file `message` carries, with its MIME type and name; undefined when it carries none the bot reads. */
function fileOf(message: NonNullable<Update["message"]>): { info: FileInfo; mimeType: string; name?: string } | undefined {
  const named = (info: NamedFile, fallback: string) => ({
    info,
    mimeType: info.mime_type ?? fallback,
    ...(info.file_name ? { name: info.file_name } : {}),
  });
  const photo = message.photo?.at(-1);
  if (photo) return { info: photo, mimeType: "image/jpeg" };
  if (message.document) return named(message.document, "application/octet-stream");
  if (message.audio) return named(message.audio, "audio/mpeg");
  if (message.voice) return { info: message.voice, mimeType: "audio/ogg", name: "voice.ogg" };
  if (message.video) return named(message.video, "video/mp4");
  if (message.video_note) return { info: message.video_note, mimeType: "video/mp4", name: "video_note.mp4" };
  if (message.animation) return named(message.animation, "video/mp4");
  return undefined;
}

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
  const reply = message.reply_to_message;
  const replyTo = reply ? { replyTo: String(reply.message_id) } : {};
  const command = message.entities?.find((e) => e.type === "bot_command" && e.offset === 0);
  if (command) return { ...from, command: message.text!.slice(1, command.length).split("@")[0] };
  const file = fileOf(message);
  if (file === undefined) {
    if (message.text === undefined) return "I can read text and files here.";
    return { ...from, ...replyTo, text: message.text };
  }
  if ((file.info.file_size ?? 0) > MAX_FILE_BYTES) {
    return "That file is too large: Telegram bots can only download files up to 20 MB.";
  }
  const { file_path } = await api.call<{ file_path: string }>("getFile", { file_id: file.info.file_id });
  const data = await api.download(file_path);
  const incoming: IncomingFile = { data, mimeType: file.mimeType, ...(file.name ? { name: file.name } : {}) };
  return { ...from, ...replyTo, text: message.caption, files: [incoming] };
}
