// A message with files, made into what the chief of staff sees. Every file is put on its computer, in inbox/ under
// the agent's home, and the message says where, so it or a job can work with it in whatever way the file needs.
// An image is also shown to the model directly when the model takes images.
import type { Context } from "@earendil-works/chord";
import { type ExecutionEnv, getOrThrow as value } from "@earendil-works/pi-durable/env";
import type { Attachment, Content, Incoming } from "../core/message.ts";

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** Write a file to inbox/ on its computer, without clobbering one already there; returns where it is. */
async function keep(env: ExecutionEnv, file: Attachment, now: number, context: Context): Promise<string> {
	const safe = file.name.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "") || "file";
	const stem = `${new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${safe}`;
	const inbox = value(await env.absolutePath("inbox", context));
	value(await env.createDir(inbox, { recursive: true }, context));
	let name = stem;
	for (let n = 2; value(await env.exists(value(await env.joinPath([inbox, name], context)), context)); n++) name = `${stem}-${n}`;
	const path = value(await env.joinPath([inbox, name], context));
	value(await env.writeFile(path, file.data, context));
	return path;
}

/** `env`: the agent's computer, if there is one. */
export async function toInput(message: Incoming, options: { env: ExecutionEnv | undefined; seesImages: boolean; context: Context; now?: number }): Promise<Content> {
	const files = message.attachments ?? [];
	if (files.length === 0) return message.text;
	const now = options.now ?? Date.now();
	const notes: string[] = [];
	const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
	for (const file of files) {
		const what = `${file.name} (${file.mimeType}, ${size(file.data.byteLength)})`;
		let where: string;
		try {
			if (options.env === undefined) throw new Error("there's no computer");
			where = `on your computer at ${await keep(options.env, file, now, options.context)}`;
		} catch (error) {
			where = `couldn't be put on your computer (${error instanceof Error ? error.message : String(error)})`;
		}
		const shown = options.seesImages && file.mimeType.startsWith("image/");
		if (shown) images.push({ type: "image", data: Buffer.from(file.data).toString("base64"), mimeType: file.mimeType });
		notes.push(`[Attached: ${what}${shown ? ", shown here" : ""}; ${where}]`);
	}
	const text = [message.text, ...notes].filter((line) => line !== "").join("\n");
	return images.length === 0 ? text : [{ type: "text", text }, ...images];
}
