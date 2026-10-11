import type { Message, TextContent, ToolCall } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type EntryId,
  type EntryRecord,
  ResetEntry,
  ToolResultEntry,
  UserEntry,
} from "@earendil-works/pi-durable";

/** An input that a job, schedule, secret request, japa itself or an extension wrote, not the user. */
export const AUTOMATED = /^\[(job |schedule |secret |japa\]|[a-z][\w-]*[\]:])/;

/** A message the user saw in the root conversation. */
export type HistoryMessage = {
  id: EntryId; // first entry of the message
  kind: "you" | "japa" | "auto";
  text: string;
  at: number; // ms
  did?: string; // japa only: "did: …", ≤ 160 chars, absent when nothing qualifies
  job?: string; // auto only: job id from a leading `[job <n> `
};

const READ_ONLY = /^(read|.*_list|.*_get|job_transcript|history_.*|page_read|memory_facts|skill_read)$/;
const THING = /\b(job|schedule|change) (\d+)/i;
const JOB = /^\[job (\d+) /;
const DID_CAP = 160;
/** A slim tool result naming nothing keeps this many characters. */
const RESULT_KEEP = 300;
/** The arguments `describe` reads. */
const DESCRIBED = ["id", "title", "name", "path"] as const;
/** A reply that stopped this way was cut off: a retry or a later message in its run replaces its text. */
const CUT_OFF = new Set(["aborted", "error"]);

type Call = { id: string; name: string; arguments?: Record<string, unknown> };

/** An input's text: its text parts, with every other part as `[<type>]`. */
const inputText = (message: Message): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("");

/** The text parts of `message`, which may hold none. */
const textParts = (message: Message): string[] =>
  typeof message.content === "string"
    ? [message.content]
    : message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));

const callsOf = (message: Message): Call[] =>
  message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : [];

/** `call` as `name`, its short identifier, and the thing its result names, e.g. `job_start Cleanup (job 68)`. */
function describe(call: Call, results: ReadonlyMap<string, string>): string {
  const args = call.arguments ?? {};
  const x = [args.id, args.title, args.name, args.path].find(
    (v) => (typeof v === "string" && v !== "") || typeof v === "number",
  );
  const thing = THING.exec(results.get(call.id) ?? "");
  return `${call.name}${x === undefined ? "" : ` ${x}`}${thing ? ` (${thing[1]!.toLowerCase()} ${thing[2]})` : ""}`;
}

/** The `did:` line for `calls`; undefined when every call is read-only. */
function didLine(calls: readonly Call[], results: ReadonlyMap<string, string>): string | undefined {
  const done = calls.filter((c) => !READ_ONLY.test(c.name)).map((c) => describe(c, results));
  if (done.length === 0) return undefined;
  const line = `did: ${done.join(", ")}`;
  return line.length <= DID_CAP ? line : `${line.slice(0, DID_CAP - 1)}…`;
}

/**
 * The arguments of a call that `describe` reads: a number, or a string's first 160 characters, which is all a `did:`
 * line can show of it.
 */
function describedArgs(args: Record<string, unknown> | undefined): Record<string, string | number> {
  const kept: Record<string, string | number> = {};
  for (const k of DESCRIBED) {
    const v = args?.[k];
    if (typeof v === "number") kept[k] = v;
    else if (typeof v === "string") kept[k] = v.slice(0, DID_CAP);
  }
  return kept;
}

/**
 * `message` reduced to what `transcriptMessages` reads: an input's other parts become `[<type>]` text, a reply keeps
 * its text and calls but not its thinking, and a tool result the thing it names.
 */
function slimMessage(message: Message): Message {
  const base = typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {};
  switch (message.role) {
    case "user": {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content.map(
              (part): TextContent => ({ type: "text", text: part.type === "text" ? part.text : `[${part.type}]` }),
            );
      return { ...base, role: "user", content } as Message;
    }
    case "assistant": {
      const content = message.content.flatMap((part): (TextContent | ToolCall)[] => {
        if (part.type === "text") return [{ type: "text", text: part.text }];
        if (part.type !== "toolCall") return [];
        return [{ type: "toolCall", id: part.id, name: part.name, arguments: describedArgs(part.arguments) }];
      });
      return { ...base, role: "assistant", stopReason: message.stopReason, content } as Message;
    }
    case "toolResult": {
      const text = textParts(message).join("");
      const kept = THING.exec(text)?.[0] ?? text.slice(0, RESULT_KEEP);
      const content: TextContent[] = [{ type: "text", text: kept }];
      return { ...base, role: "toolResult", toolCallId: message.toolCallId, content } as Message;
    }
    default:
      return message;
  }
}

/**
 * A copy of `entry` that keeps only what `transcriptMessages` and the history read, so a long-lived mirror holds no
 * image data, tool output, thinking or prompts: an input's other parts become `[<type>]`, a reply keeps its text and
 * its calls' identifying arguments, a tool result keeps the thing it names (or its first 300 characters), and a reset
 * keeps its id. Undefined for every other kind (system prompts, compactions): the messages never show them.
 * `transcriptMessages` gives the same messages for the slim copies as for the entries.
 */
export function slim(entry: EntryRecord): EntryRecord | undefined {
  if (entry.kind === ResetEntry.kind) return { id: entry.id, kind: entry.kind } as EntryRecord;
  const role =
    entry.kind === UserEntry.kind
      ? "user"
      : entry.kind === AssistantEntry.kind
        ? "assistant"
        : entry.kind === ToolResultEntry.kind
          ? "toolResult"
          : undefined;
  if (role === undefined) return undefined;
  const model = (entry.model ?? []).filter((m) => m.role === role).map(slimMessage);
  return { id: entry.id, kind: entry.kind, ...(entry.model === undefined ? {} : { model }) } as EntryRecord;
}

/** The text parts of `messages` (a run's replies), less a cut-off reply's when a later one has text. */
function replyTexts(messages: readonly Message[]): string[] {
  const texts = messages.map((m) => textParts(m).filter((t) => t !== ""));
  let later = false; // a later message has text
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const cutOff = message.role === "assistant" && CUT_OFF.has(message.stopReason);
    if (cutOff && later) texts[i] = [];
    if (texts[i]!.length > 0) later = true;
  }
  return texts.flat();
}

/**
 * The messages `entries` (the root's entries, oldest first, or their `slim` copies) showed the user, oldest first:
 * each input, and each run's assistant text with the calls that changed something. A reply that was aborted or failed
 * is left out when a later message in its run has text (it was retried). Resets, compactions, system messages and tool
 * traffic are left out; a message without a timestamp takes the time of the message before it.
 */
export function transcriptMessages(entries: readonly EntryRecord[]): HistoryMessage[] {
  const results = new Map<string, string>();
  for (const e of entries) {
    if (e.kind !== ToolResultEntry.kind) continue;
    for (const m of e.model ?? []) if (m.role === "toolResult") results.set(m.toolCallId, textParts(m).join(""));
  }

  const out: HistoryMessage[] = [];
  let at = 0;
  let run: EntryRecord[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const messages = run.flatMap((e) => (e.kind === AssistantEntry.kind ? (e.model ?? []) : []));
    const texts = replyTexts(messages);
    if (texts.length > 0) {
      const stamp = run.flatMap((e) => e.model ?? []).find((m) => typeof m.timestamp === "number")?.timestamp;
      at = stamp ?? at;
      const did = didLine(messages.flatMap(callsOf), results);
      out.push({ id: run[0]!.id, kind: "japa", text: texts.join("\n"), at, ...(did === undefined ? {} : { did }) });
    }
    run = [];
  };

  for (const e of entries) {
    if (e.kind === AssistantEntry.kind || e.kind === ToolResultEntry.kind) {
      run.push(e);
    } else if (e.kind === UserEntry.kind) {
      flush();
      const inputs = (e.model ?? []).filter((m) => m.role === "user");
      if (inputs.length === 0) continue;
      const text = inputs.map(inputText).join("\n");
      at = inputs.find((m) => typeof m.timestamp === "number")?.timestamp ?? at;
      if (!AUTOMATED.test(text)) {
        out.push({ id: e.id, kind: "you", text, at });
        continue;
      }
      const job = JOB.exec(text)?.[1];
      out.push({ id: e.id, kind: "auto", text, at, ...(job === undefined ? {} : { job }) });
    }
  }
  flush();
  return out;
}
