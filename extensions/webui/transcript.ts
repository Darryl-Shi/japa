// The root conversation as the web UI shows it: the same rules as the gateway's (extensions/gateway/transcript.ts),
// copied rather than imported so extensions stay independent; it also shows text carried on `message_start`.
import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import type { Line } from "./app/src/lib/protocol.ts";

export type Transcript = { lines: Line[]; streaming: string; busy: boolean };

/** Returns the transcript after `events`; a `snapshot` event resets it. */
export function applyEvents(t: Transcript, events: readonly AgentEvent[]): Transcript {
  for (const e of events) {
    switch (e.type) {
      case "snapshot":
        t = { lines: e.entries.flatMap(linesOf), streaming: "", busy: e.run !== undefined };
        break;
      case "message_start":
        // A streamed reply's first text may come with its start rather than as a delta.
        if (e.message.role === "assistant") t = { ...t, streaming: textOf(e.message.content) };
        break;
      case "message_update": {
        const deltas = e.changes.map((c) => (c.type === "text_delta" ? c.delta : ""));
        t = { ...t, streaming: t.streaming + deltas.join("") };
        break;
      }
      case "message_end":
        t = { ...t, lines: [...t.lines, ...linesOf(e.entry)], streaming: "" };
        break;
      case "run_start":
      case "run_end":
        t = { ...t, busy: e.type === "run_start" };
        break;
      case "auto_retry_start":
        t = { ...t, lines: [...t.lines, { kind: "info", text: `retrying: ${e.errorMessage}` }] };
        break;
    }
  }
  return t;
}

function linesOf(entry: EntryRecord): Line[] {
  // Reset handoffs and compaction summaries are for the model, not the user.
  if (entry.kind === "pi.reset" || entry.kind === "pi.compaction") return [];
  return (entry.model ?? []).flatMap((m): Line[] => {
    if (m.role === "user") return [{ kind: "user", text: typeof m.content === "string" ? m.content : textOf(m.content) }];
    if (m.role !== "assistant") return [];
    const lines: Line[] = [];
    const text = textOf(m.content);
    if (text !== "") lines.push({ kind: "assistant", text });
    for (const b of m.content) if (b.type === "toolCall") lines.push({ kind: "tool", text: `⚙ ${b.name}` });
    if (m.errorMessage) lines.push({ kind: "info", text: m.errorMessage });
    return lines;
  });
}

function textOf(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
}
