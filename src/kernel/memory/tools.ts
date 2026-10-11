import { Type } from "@earendil-works/pi-ai";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { JobsDoc } from "../jobs/state.ts";
import { corpus, type History } from "./history.ts";
import { findPage, type Page, ScratchpadDoc, writePage } from "./scratchpad.ts";
import { type Doc, rank, snippet } from "./search.ts";
import { applyFactOps, MAX_WORDS, MemoryDoc, nearDuplicate, offScope, wordCount } from "./state.ts";
import { ago, cut, fullLine } from "./window.ts";

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

const memoryFacts = defineTool({
  name: "memory_facts",
  description: "List the facts you remember about the user, with their ids.",
  parameters: Type.Object({}),
  execute: async (_args, api, context) => {
    const { facts } = (await api.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, context))!;
    return reply(facts.length ? facts.map((f) => `${f.id}: ${f.text}`).join("\n") : "Nothing saved yet.");
  },
});

const memoryRemember = defineTool({
  name: "memory_remember",
  description: `Remember something lasting about the user (not project or system details), in at most ${MAX_WORDS} words.`,
  parameters: Type.Object({ text: Type.String() }),
  execute: async ({ text }, api, context) => {
    // The checks `applyFactOps` makes, in its order, so the refusal can say why.
    const reason = offScope(text);
    if (reason !== undefined) return reply(`Not about the user (${reason}): put it on a scratchpad page instead.`);
    if (wordCount(text) > MAX_WORDS) return reply(`Too long — keep it to ${MAX_WORDS} words.`);
    const answer = await api.commit(async (tx) => {
      const memory = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
      const existing = memory.facts.find((f) => nearDuplicate(f.text, text));
      if (existing) return `Already remembered: ${existing.text}`;
      applyFactOps(memory, [{ op: "add", text }], Date.now());
      return "Remembered.";
    }, context);
    return reply(answer);
  },
});

const memoryForget = defineTool({
  name: "memory_forget",
  description: "Forget the fact with this id.",
  parameters: Type.Object({ id: Type.String() }),
  execute: async ({ id }, api, context) => {
    const answer = await api.commit(async (tx) => {
      const memory = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
      const fact = memory.facts.find((f) => f.id === id);
      if (!fact) return `No memory ${id}.`;
      memory.facts = memory.facts.filter((f) => f !== fact);
      return `Forgot: ${fact.text}`;
    }, context);
    return reply(answer);
  },
});

const DAY_MS = 86_400_000;
const SEARCH_HITS = 10;
const SNIPPET = 400;
/** `history_read`'s default reach on each side, and its cap (4,000 tokens). */
const AROUND = 4;
const READ_CHARS = 16_000;
const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i;

/**
 * The time `text` (an ISO date or datetime, UTC unless it names a zone) stands for; a date or datetime is its first
 * millisecond, or with `end` its last (a whole day for a date, a whole minute or second for a datetime). Undefined
 * when it isn't one.
 */
function parseTime(text: string, end: boolean): number | undefined {
  const t = text.trim();
  const match = ISO.exec(t);
  if (!match) return undefined;
  if (t.length === 10) {
    const ms = Date.parse(`${t}T00:00Z`);
    return Number.isNaN(ms) ? undefined : end ? ms + DAY_MS - 1 : ms;
  }
  const iso = t.replace(" ", "T");
  const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(ms)) return undefined;
  const [, , seconds, fraction] = match;
  return !end || fraction ? ms : ms + (seconds ? 999 : 59_999);
}

/** `at` as `YYYY-MM-DD HH:MM`, UTC. */
const stamp = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");

/** `text` on one line. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

const invalidTime = (name: string, value: string) =>
  `Invalid ${name} "${value}": use an ISO date or datetime, e.g. 2026-10-11 or 2026-10-11T14:30.`;

/** `page` with its header: `# <title> (updated <ago>[, archived])`. */
const showPage = (page: Page, now: number) =>
  `# ${page.title} (updated ${ago(page.updatedAt, now)}${page.archivedAt === undefined ? "" : ", archived"})\n${page.text}`;

/** `n` as a whole number of at least 0, or `fallback` when it isn't a number. */
const reach = (n: number | undefined, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;

/** The lines of `lines` (the one at `target` kept) within `cap` characters joined: the farthest from it dropped first. */
function around(lines: string[], target: number, cap: number): string {
  let first = 0;
  let last = lines.length - 1;
  let length = lines.reduce((sum, l) => sum + 1 + l.length, -1);
  while (length > cap && (first < target || last > target)) {
    if (target - first >= last - target) length -= 1 + lines[first++]!.length;
    else length -= 1 + lines[last--]!.length;
  }
  const out = lines.slice(first, last + 1).join("\n");
  return out.length <= cap ? out : cut(out, out.length - cap);
}

const pageRead = defineTool({
  name: "page_read",
  description:
    "Read the scratchpad page with this title (any case). Without an exact match, it shows the closest page.",
  parameters: Type.Object({ title: Type.String() }),
  execute: async ({ title }, api, context) => {
    const pad = (await api.snapshot(ScratchpadDoc, ROOT_CONVERSATION_ID, context)) ?? { nextId: 1, pages: [] };
    const now = Date.now();
    const page = findPage(pad, title);
    if (page) return reply(showPage(page, now));
    const docs: Doc[] = pad.pages.map((p) => ({ key: p.id, kind: "page", text: `${p.title}\n${p.text}`, at: p.updatedAt }));
    const [best] = rank(docs, title, now, 1);
    const closest = best && pad.pages.find((p) => p.id === best.key);
    return reply(closest ? `No page "${title}"; closest: ${showPage(closest, now)}` : `No page "${title}".`);
  },
});

const pageWrite = defineTool({
  name: "page_write",
  description:
    "Create the scratchpad page with this title, or replace its whole text, in at most 1,500 tokens: the current " +
    "state of a project or topic (what it is, decisions and why, where it lives, what's open), not a log.",
  parameters: Type.Object({ title: Type.String(), text: Type.String() }),
  execute: async ({ title, text }, api, context) => {
    if (!title.trim()) return reply("Give the page a title.");
    const answer = await api.commit(async (tx) => {
      const pad = await tx.doc(ScratchpadDoc, ROOT_CONVERSATION_ID);
      const result = writePage(pad, title, text, Date.now());
      if ("error" in result) return result.error;
      return `${result.created ? "Created" : "Saved"} page "${result.page.title}".`;
    }, context);
    return reply(answer);
  },
});

/**
 * How a `history_search` hit names itself, in a form another tool takes: `page "<title>"` (`page_read`), `job <id>`
 * (`job_transcript`), or `<kind> #<id>` (`history_read`), a job's report as `job <n> report #<id>`. A legacy episode
 * is a `note`, with no id: no tool opens it.
 */
function label(d: Doc, jobReports: ReadonlyMap<number, string>): string {
  if (d.kind === "page") return `page "${d.title}"`;
  if (d.kind === "job") return `job ${d.key.replace(/^job:/, "")}`;
  if (d.kind === "episode") return "note";
  const job = d.id === undefined ? undefined : jobReports.get(d.id);
  if (job !== undefined) return `job ${job} report #${d.id}`;
  return `${d.kind} #${d.id ?? d.key}`;
}

/** The tools that read the conversation `history`. */
function historyTools(history: History) {
  const historySearch = defineTool({
    name: "history_search",
    description:
      "Search everything said in this conversation, job results and scratchpad pages by keywords. `since` and " +
      "`until` are ISO dates or datetimes (UTC), inclusive. Returns up to 10 hits, best first, each with its date " +
      "(UTC) and what it is: read around a message (`#<id>`) with `history_read`, a page with `page_read`, a job " +
      "with `job_transcript`.",
    parameters: Type.Object({
      query: Type.String(),
      since: Type.Optional(Type.String()),
      until: Type.Optional(Type.String()),
    }),
    execute: async ({ query, since, until }, api, context) => {
      const from = since === undefined ? -Infinity : parseTime(since, false);
      if (from === undefined) return reply(invalidTime("since", since!));
      const to = until === undefined ? Infinity : parseTime(until, true);
      if (to === undefined) return reply(invalidTime("until", until!));
      const { messages: all, lastReset } = await history.refresh(context);
      // The current run's own messages (after the newest reset) are its input, not history.
      const messages = lastReset === undefined ? [] : all.filter((m) => m.id <= lastReset);
      const jobReports = new Map(messages.flatMap((m) => (m.job === undefined ? [] : [[m.id, m.job] as const])));
      const [memory, pad, jobs] = await Promise.all([
        api.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, context),
        api.snapshot(ScratchpadDoc, ROOT_CONVERSATION_ID, context),
        api.snapshot(JobsDoc, ROOT_CONVERSATION_ID, context),
      ]);
      const docs = corpus(
        messages,
        memory ?? { nextId: 1, facts: [] },
        pad ?? { nextId: 1, pages: [] },
        jobs?.jobs ?? {},
      ).filter((d) => d.at >= from && d.at <= to);
      const hits = rank(docs, query, Date.now(), SEARCH_HITS);
      const lines = hits.map((d) => `${stamp(d.at)} ${label(d, jobReports)}: ${snippet(flat(d.text), query, SNIPPET)}`);
      return reply(lines.length ? lines.join("\n") : "Nothing found.");
    },
  });

  const historyRead = defineTool({
    name: "history_read",
    description:
      "Read the messages around message #id in full: by default 4 before and 4 after, at most 4,000 tokens.",
    parameters: Type.Object({
      id: Type.Number(),
      before: Type.Optional(Type.Number()),
      after: Type.Optional(Type.Number()),
    }),
    execute: async ({ id, before, after }, _api, context) => {
      const { messages } = await history.refresh(context);
      // An entry inside a message (a tool call, a result) stands for the message it belongs to; past the newest
      // message's first entry, there is no telling where the transcript ends, so only an exact id counts there.
      const exact = messages.findIndex((m) => m.id === id);
      const inside = messages.findLastIndex((m) => m.id < id);
      const i = exact !== -1 ? exact : inside < messages.length - 1 ? inside : -1;
      if (i === -1) return reply(`No message #${id}.`);
      const from = Math.max(0, i - reach(before, AROUND));
      const shown = messages.slice(from, i + reach(after, AROUND) + 1);
      const now = Date.now();
      return reply(around(shown.map((m) => fullLine(m, now)), i - from, READ_CHARS));
    },
  });

  return [historySearch, historyRead];
}

/** The CoS's memory tools: the profile, the scratchpad and the conversation `history`. */
export function memoryTools(history: History) {
  return [memoryFacts, memoryRemember, memoryForget, pageRead, pageWrite, ...historyTools(history)];
}
