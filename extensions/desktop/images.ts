// The durable hook that keeps only the newest desktop screenshots in the model's context; storage keeps them all.
import type { Message } from "@earendil-works/pi-ai";
import { GenerationTask, hook } from "../../src/sdk.ts";

export const OMITTED = "[earlier screenshot omitted]";

const DESKTOP_TOOLS = ["computer", "browser"];

/** `messages` with every `computer` and `browser` image but the newest `keep` replaced by OMITTED; the input is not changed. */
export function recentImagesOnly(messages: readonly Message[], keep = 3): Message[] {
  let left = keep;
  return messages
    .toReversed()
    .map((m) =>
      m.role === "toolResult" && DESKTOP_TOOLS.includes(m.toolName)
        ? {
            ...m,
            content: m.content
              .toReversed()
              .map((c) => (c.type === "image" && left-- <= 0 ? { type: "text" as const, text: OMITTED } : c))
              .toReversed(),
          }
        : m,
    )
    .toReversed();
}

export const keepRecentImages = hook(GenerationTask, {
  beforeRequest: ({ messages }) => ({ messages: recentImagesOnly(messages) }),
});
