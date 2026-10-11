import type { Message } from "@earendil-works/pi-ai";
import { AssistantEntry, type EntryId, type EntryRecord, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";

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
 * The messages `entries` (the root's entries, oldest first) showed the user, oldest first: each input, and each run's
 * assistant text with the calls that changed something. Resets, compactions, system messages and tool traffic are
 * left out; a message without a timestamp takes the time of the message before it.
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
    const texts = messages.flatMap(textParts).filter((t) => t !== "");
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
