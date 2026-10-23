// The root conversation as the web UI shows it: the same rules as the gateway's (extensions/gateway/transcript.ts),
// copied rather than imported so extensions stay independent; it also shows text carried on `message_start`.
import { statSync } from "node:fs";
import type { AgentEvent, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import type { InputSource } from "japa/sdk";
import type { FileView, Line } from "./app/src/lib/protocol.ts";

/** A transcript file as the download endpoint serves it; `upload`: from a person's input (under `<home>/attachments/`). */
export type FileRef = { path: string; name: string; mimeType: string; upload: boolean };

/**
 * The projection. `files` maps each `FileView.id` in `lines` to its file on the host (the host path never goes into a
 * line); a snapshot rebuilds it, appended entries add to it.
 */
export type Transcript = { lines: Line[]; streaming: string; busy: boolean; files: Map<string, FileRef> };

export const emptyTranscript = (): Transcript => ({ lines: [], streaming: "", busy: false, files: new Map() });

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
  for (const e of events) {
    switch (e.type) {
      case "snapshot": {
        const files = new Map<string, FileRef>();
        const lines = e.entries.flatMap((entry) => linesOf(entry, sources.get(entry.id), files));
        t = { lines, streaming: "", busy: e.run !== undefined, files };
        break;
      }
      case "message_start":
        // A streamed reply's first text may come with its start rather than as a delta.
        if (e.message.role === "assistant") t = { ...t, streaming: textOf(e.message.content) };
        break;
      case "message_update": {
        const deltas = e.changes.map((c) => (c.type === "text_delta" ? c.delta : ""));
        t = { ...t, streaming: t.streaming + deltas.join("") };
        break;
      }
      case "message_end": {
        const added = new Map<string, FileRef>();
        const lines = linesOf(e.entry, sources.get(e.entry.id), added);
        const files = added.size === 0 ? t.files : new Map([...t.files, ...added]);
        t = { ...t, lines: [...t.lines, ...lines], streaming: "", files };
        break;
      }
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

/** The file's size in bytes: `known`, else read from the host now; undefined when neither works. */
function sizeOf(path: string, known: number | undefined): number | undefined {
  if (typeof known === "number" && Number.isFinite(known) && known >= 0) return known;
  try {
    const info = statSync(path);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

/** `entry`'s lines; the references of its files go into `files`. */
function linesOf(entry: EntryRecord, source: InputSource | undefined, files: Map<string, FileRef>): Line[] {
  // Reset handoffs and compaction summaries are for the model, not the user.
  if (entry.kind === "pi.reset" || entry.kind === "pi.compaction") return [];
  let index = 0;
  /** The view of the entry's next file (its id the entry's id and the file's index), recorded in `files`. */
  const fileView = (path: string, name: string, mimeType: string, size: number | undefined, upload: boolean): FileView => {
    const id = `${entry.id}-${index++}`;
    files.set(id, { path, name, mimeType, upload });
    const known = sizeOf(path, size);
    return { id, name, mimeType, ...(known !== undefined && { size: known }) };
  };
  return (entry.model ?? []).flatMap((m): Line[] => {
    if (m.role === "user") {
      // A person's input is a `user` line; a job's report a `report`, any other kernel input a `note`.
      if (source?.type === "job_report") {
        const { jobId, title, status, text } = source;
        return [{ kind: "report", jobId, title, status, text }];
      }
      const content = typeof m.content === "string" ? m.content : textOf(m.content);
      if (source?.type === "note") return [{ kind: "note", text: content }];
      // A person's input shows what they typed and the files saved for it; without a source, or with an older-style
      // one without `text`, its content as it is.
      if (source?.type !== "person" || typeof source.text !== "string") return [{ kind: "user", text: content }];
      const attached = Array.isArray(source.files) ? source.files : [];
      const views = attached
        .filter((f) => typeof f?.path === "string" && typeof f.name === "string")
        .map((f) => fileView(f.path, f.name, f.mimeType || "application/octet-stream", f.size, true));
      return [{ kind: "user", text: source.text, ...(views.length > 0 && { files: views }) }];
    }
    // A file the CoS sent (`send_file`'s recorded `OutgoingFile`): a file line, served by the download endpoint.
    if (m.role === "toolResult") {
      if (m.toolName !== "send_file" || m.isError) return [];
      const file = (m.details as { file?: Record<string, unknown> } | undefined)?.file;
      if (typeof file?.path !== "string") return [];
      const name = typeof file.name === "string" && file.name !== "" ? file.name : "file";
      const mimeType =
        typeof file.mimeType === "string" && file.mimeType !== "" ? file.mimeType : "application/octet-stream";
      const view = fileView(file.path, name, mimeType, typeof file.size === "number" ? file.size : undefined, false);
      const caption = typeof file.caption === "string" && file.caption !== "" ? file.caption : undefined;
      return [{ kind: "file", file: view, ...(caption !== undefined && { caption }) }];
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
