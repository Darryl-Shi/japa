// A message with files, made into what the chief of staff sees. Every file is put on its computer, in inbox/ under
// the agent's home, and the message says where, so it or a job can work with it in whatever way the file needs.
// An image is also shown to the model directly when the model takes images.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Attachment, Content, Incoming } from "../core/message.ts";

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** Write a file under <home>/inbox, without clobbering one already there; returns the path. */
async function keep(home: string, file: Attachment, now: number): Promise<string> {
	const safe = file.name.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "") || "file";
	const stem = `${new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${safe}`;
	await mkdir(join(home, "inbox"), { recursive: true });
	let name = stem;
	for (let n = 2; existsSync(join(home, "inbox", name)); n++) name = `${stem}-${n}`;
	await writeFile(join(home, "inbox", name), file.data);
	return join(home, "inbox", name);
}

/** `home`: the agent's home directory, where its working files are. */
export async function toInput(message: Incoming, options: { home: string; seesImages: boolean; now?: number }): Promise<Content> {
	const files = message.attachments ?? [];
	if (files.length === 0) return message.text;
	const now = options.now ?? Date.now();
	const notes: string[] = [];
	const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
	for (const file of files) {
		const what = `${file.name} (${file.mimeType}, ${size(file.data.byteLength)})`;
		let where: string;
		try {
			where = `on your computer at ${await keep(options.home, file, now)}`;
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
