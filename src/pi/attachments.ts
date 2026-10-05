// A message with files, made into what the chief of staff sees. Every file is put on the workbench (its own computer)
// under ~/inbox, and the message says where, so it or a job can work with it in whatever way the file needs. An image
// is also shown to the model directly when the model takes images. Without a workbench, the message says what came
// and that there was nowhere to keep it.
import { type Backend, shellQuote as q } from "../core/backend.ts";
import type { Attachment, Content, Incoming } from "../core/message.ts";

/** Base64 per command, to keep each command a modest size. */
const CHUNK = 512 * 1024;

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** Write a file on the backend, under ~/inbox, without clobbering one already there; returns the path. */
async function keep(backend: Backend, file: Attachment, now: number): Promise<string> {
	const safe = file.name.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "") || "file";
	const path = `inbox/${new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${safe}`;
	const data = Buffer.from(file.data).toString("base64");
	const run = async (command: string) => {
		let output = "";
		const { exitCode } = await backend.exec(command, { onOutput: (chunk) => (output += chunk) });
		if (exitCode !== 0) throw new Error(output.trim() || `exit ${exitCode}`);
	};
	await run(`mkdir -p inbox && : > ${q(`${path}.b64`)}`);
	for (let at = 0; at < data.length; at += CHUNK) await run(`printf %s ${q(data.slice(at, at + CHUNK))} >> ${q(`${path}.b64`)}`);
	await run(`base64 -d < ${q(`${path}.b64`)} > ${q(path)} && rm ${q(`${path}.b64`)}`);
	return `~/${path}`;
}

export async function toInput(message: Incoming, options: { workbench: Backend | undefined; seesImages: boolean; now?: number }): Promise<Content> {
	const files = message.attachments ?? [];
	if (files.length === 0) return message.text;
	const now = options.now ?? Date.now();
	const notes: string[] = [];
	const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
	for (const file of files) {
		const what = `${file.name} (${file.mimeType}, ${size(file.data.byteLength)})`;
		let where: string;
		if (options.workbench === undefined) where = "there's no computer to keep it on";
		else {
			try {
				where = `on your computer at ${await keep(options.workbench, file, now)}`;
			} catch (error) {
				where = `couldn't be put on your computer (${error instanceof Error ? error.message : String(error)})`;
			}
		}
		const shown = options.seesImages && file.mimeType.startsWith("image/");
		if (shown) images.push({ type: "image", data: Buffer.from(file.data).toString("base64"), mimeType: file.mimeType });
		notes.push(`[Attached: ${what}${shown ? ", shown here" : ""}; ${where}]`);
	}
	const text = [message.text, ...notes].filter((line) => line !== "").join("\n");
	return images.length === 0 ? text : [{ type: "text", text }, ...images];
}
