import type { AgentEvent, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import type { InputSource } from "../../src/sdk.ts";

/** `user` is only a person's input; a job's report is a `report`, any other kernel-posted input a `note`. */
export type Line =
  | { kind: "user" | "assistant" | "tool" | "info"; text: string }
  | { kind: "report"; jobId: string; title: string; status: string; text: string }
  | { kind: "note"; text: string };
export type Transcript = { lines: Line[]; streaming: string; busy: boolean };

/**
 * Returns the transcript after `events`; a `snapshot` event resets it. `sources` (the batch's, from
 * `SurfaceContext.root.events`) tells a person's input from a job report or a kernel note; a user entry without one is
 * a person's.
 */
export function applyEvents(
  t: Transcript,
  events: readonly AgentEvent[],
  sources: ReadonlyMap<EntryId, InputSource> = new Map(),
): Transcript {
  const lines = (entry: EntryRecord) => linesOf(entry, sources.get(entry.id));
  for (const e of events) {
    switch (e.type) {
      case "snapshot":
        t = { lines: e.entries.flatMap(lines), streaming: "", busy: e.run !== undefined };
        break;
      case "message_update": {
        const deltas = e.changes.map((c) => (c.type === "text_delta" ? c.delta : ""));
        t = { ...t, streaming: t.streaming + deltas.join("") };
        break;
      }
      case "message_end":
        t = { ...t, lines: [...t.lines, ...lines(e.entry)], streaming: "" };
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

function linesOf(entry: EntryRecord, source: InputSource | undefined): Line[] {
  // Reset handoffs and compaction summaries are for the model, not the user.
  if (entry.kind === "pi.reset" || entry.kind === "pi.compaction") return [];
  return (entry.model ?? []).flatMap((m): Line[] => {
    if (m.role === "user") {
      // A person's input is a `user` line; a job's report a `report`, any other kernel input a `note`.
      if (source?.type === "job_report") {
        const { jobId, title, status, text } = source;
        return [{ kind: "report", jobId, title, status, text }];
      }
      const text = typeof m.content === "string" ? m.content : textOf(m.content);
      return [{ kind: source?.type === "note" ? "note" : "user", text }];
    }
    // A file the CoS sent: it's already local, so just its path.
    if (m.role === "toolResult") {
      const sent = m.toolName === "send_file" && !m.isError;
      const file = sent ? (m.details as { file?: { path?: unknown } } | undefined)?.file : undefined;
      return typeof file?.path === "string" ? [{ kind: "tool", text: `📎 ${file.path}` }] : [];
    }
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

const PREFIX = { user: "› ", assistant: "", tool: "", info: "! " };
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

/** How `japa chat` prints a line: a person's input after `› `, a report under `◆ job "<title>" <status>`, a note muted after `· `. */
export function lineText(line: Line): string {
  if (line.kind === "report") return `◆ job "${line.title}" ${line.status}${line.text === "" ? "" : `\n${line.text}`}`;
  if (line.kind === "note") return dim(`· ${line.text}`);
  return PREFIX[line.kind] + line.text;
}
