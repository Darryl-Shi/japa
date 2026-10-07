import type { Message } from "@earendil-works/pi-ai";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";

export function textOf(message: Message | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

export function reply(value: unknown): ToolExecutionResult {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  };
}

export function clip(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, Math.max(0, limit - 14))}\n[truncated]`;
}
