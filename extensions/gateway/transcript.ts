import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";

export type Line = { kind: "user" | "assistant" | "tool" | "info"; text: string };
export type Transcript = { lines: Line[]; streaming: string; busy: boolean };

/** Returns the transcript after `events`; a `snapshot` event resets it. */
export function applyEvents(t: Transcript, events: readonly AgentEvent[]): Transcript {
  for (const e of events) {
    switch (e.type) {
      case "snapshot":
        t = { lines: e.entries.flatMap(linesOf), streaming: "", busy: e.run !== undefined };
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
  if (entry.kind === "pi.reset") return []; // the handoff is for the model, not the user
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
