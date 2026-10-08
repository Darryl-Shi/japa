import type { UserInput } from "@earendil-works/pi-durable";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Incoming } from "../contracts.ts";

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

/**
 * The CoS input for `messages`: their texts, merged. Each image is saved to `<home>/attachments/<date>/<id>.<ext>`
 * and noted by its path (or by why it could not be saved); a saved image is sent along as an image part when the model
 * has `vision`.
 */
export function inputOf(home: string, messages: Incoming[], vision: boolean): UserInput {
  const texts = messages.flatMap((m) => (m.text === undefined ? [] : [m.text]));
  const images = messages.flatMap((m) =>
    (m.images ?? []).map((image, i) => ({ ...image, name: i === 0 ? m.id : `${m.id}-${i + 1}` })),
  );
  if (images.length === 0) return texts.join("\n\n");
  const dir = join(home, "attachments", new Date().toISOString().slice(0, 10));
  const saved: typeof images = [];
  const notes = images.map((image) => {
    const path = join(dir, `${image.name}.${EXTENSIONS[image.mimeType] ?? image.mimeType.split("/")[1]}`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, image.data);
    } catch (error) {
      return `[image could not be saved: ${(error as Error).message}]`;
    }
    saved.push(image);
    return `[image saved to ${path}]`;
  });
  const text = [...(texts.length > 0 ? [texts.join("\n\n")] : []), ...notes].join("\n");
  if (!vision) return `${text}\n(this model cannot see images)`;
  const parts = saved.map((image) => ({
    type: "image" as const,
    data: Buffer.from(image.data).toString("base64"),
    mimeType: image.mimeType,
  }));
  return [{ type: "text", text }, ...parts];
}
