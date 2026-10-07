import {
  defineDoc,
  defineJapaExtension,
  defineTask,
  defineTool,
  logChange,
  ROOT_CONVERSATION_ID,
  section,
  Type,
} from "../../src/sdk.ts";
import { nextAfter } from "./cron.ts";

type Schedule = { id: string; text: string; cron?: string; at?: number; next: number; taskId: number };

// On the root conversation.
const ScheduleDoc = defineDoc<{ nextId: number; schedules: Record<string, Schedule> }>({
  kind: "japa.schedules",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ nextId: 1, schedules: {} }),
});

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
const local = (time: number) => new Date(time).toLocaleString();
const done = { status: "terminal", outcome: { status: "completed", result: null } } as const;

type State = { phase: "wait" } | { phase: "fire"; at: number; text: string; last?: boolean };

// One per schedule: sleeps until its next time, then posts its text to the CoS; exits once the schedule is gone.
const ScheduleTask = defineTask<{ id: string }, State, null>({
  name: "japa.schedule",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      const { id } = task.input;
      const schedule = (await runtime.snapshot(ScheduleDoc, ROOT_CONVERSATION_ID, context))?.schedules[id];
      if (schedule) await runtime.sleep(schedule.next, context);
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(ScheduleDoc, ROOT_CONVERSATION_ID);
        const s = doc.schedules[id];
        if (!s) return done;
        const fire = { phase: "fire", at: s.next, text: s.text } as const;
        // Missed occurrences fire once, then the schedule continues from now; one with no next occurrence ends.
        const next = s.cron === undefined ? undefined : following(s.cron, Math.max(runtime.now(), s.next));
        if (next === undefined) {
          delete doc.schedules[id];
          return { status: "running", checkpoint: { ...fire, last: true } };
        }
        s.next = next;
        return { status: "running", checkpoint: fire };
      }, context);
    },
    fire: async (task, runtime, context) => {
      const { id } = task.input;
      const { at, text, last } = task.state.checkpoint as Extract<State, { phase: "fire" }>;
      const root = (await runtime.conversation(ROOT_CONVERSATION_ID, context))!;
      const content = `[schedule ${id}] ${text}`;
      const requestId = `trigger:schedule:${id}:${at}`;
      await root.submit({ type: "input", content, whenBusy: "followUp", requestId }, context);
      await runtime.commit(() => (last ? done : { status: "running", checkpoint: { phase: "wait" } }), context);
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

function following(cron: string, after: number): number | undefined {
  try {
    return nextAfter(cron, after);
  } catch {
    return undefined;
  }
}

const lines = (schedules: Record<string, Schedule>) =>
  Object.values(schedules)
    .map((s) => `${s.id}  ${s.cron ?? "once"}  next ${local(s.next)}  ${s.text}`)
    .join("\n");

const scheduleAdd = defineTool({
  name: "schedule_add",
  description:
    "Schedule a message to yourself: give `cron` (5 fields, local time) to repeat, or `at` (ISO time) for once.",
  parameters: Type.Object({
    text: Type.String(),
    cron: Type.Optional(Type.String()),
    at: Type.Optional(Type.String()),
  }),
  execute: async ({ text, cron, at }, api, context) => {
    let next: number;
    try {
      if ((cron === undefined) === (at === undefined)) throw new Error("give exactly one of cron and at");
      next = cron === undefined ? Date.parse(at!) : nextAfter(cron, Date.now());
      if (!(next > Date.now())) throw new Error("at must be a future ISO time");
    } catch (error) {
      return reply(`Not scheduled: ${(error as Error).message}`);
    }
    const answer = await api.commit(async (tx) => {
      const doc = await tx.doc(ScheduleDoc, ROOT_CONVERSATION_ID);
      const id = String(doc.nextId++);
      const taskId = await tx.createTask(
        ScheduleTask,
        { id },
        { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true },
      );
      doc.schedules[id] = { id, text, ...(cron === undefined ? { at: next } : { cron }), next, taskId };
      const change = await logChange(tx, {
        title: `Scheduled "${text}" (${cron ?? local(next)})`,
        howToUse: "It will arrive as a message at that time.",
        undo: { commits: [], call: { tool: "schedule_remove", args: { id } } },
      });
      return `Scheduled ${id}: next at ${local(next)}. (change ${change})`;
    }, context);
    return reply(answer);
  },
});

const scheduleList = defineTool({
  name: "schedule_list",
  description: "List the schedules.",
  parameters: Type.Object({}),
  execute: async (_args, api, context) => {
    const doc = await api.snapshot(ScheduleDoc, ROOT_CONVERSATION_ID, context);
    return reply(lines(doc?.schedules ?? {}) || "No schedules.");
  },
});

const scheduleRemove = defineTool({
  name: "schedule_remove",
  description: "Remove the schedule with this id.",
  parameters: Type.Object({ id: Type.String() }),
  execute: async ({ id }, api, context) => {
    const answer = await api.commit(async (tx) => {
      const doc = await tx.doc(ScheduleDoc, ROOT_CONVERSATION_ID);
      const s = doc.schedules[id];
      if (!s) return `No schedule ${id}.`;
      delete doc.schedules[id];
      const args: Record<string, string> = { text: s.text };
      if (s.cron === undefined) args.at = new Date(s.at!).toISOString();
      else args.cron = s.cron;
      await logChange(tx, {
        title: `Removed schedule "${s.text}"`,
        howToUse: "",
        undo: { commits: [], call: { tool: "schedule_add", args } },
      });
      return `Removed schedule ${id}.`;
    }, context);
    return reply(answer);
  },
});

export default defineJapaExtension({
  name: "schedule",
  summary: "Schedules messages to the CoS, once or on a cron schedule",
  examples: [
    "remind me every weekday at 9 to review my inbox",
    "at 3pm tomorrow, check whether the deploy finished",
  ],
  docs:
    "schedule_add({ text, cron? | at? }) posts `[schedule <id>] <text>` to you at each time; cron is 5 fields in " +
    "local time (day-of-month and day-of-week must both match), at is an ISO time. schedule_list, " +
    "schedule_remove({ id }).",
  provides: { tool: [scheduleAdd, scheduleList, scheduleRemove] },
  durable: {
    tasks: [ScheduleTask],
    sections: [
      section("schedules", async ({ read }, context) => {
        const text = lines((await read.snapshot(ScheduleDoc, ROOT_CONVERSATION_ID, context))?.schedules ?? {});
        return text ? `Active schedules:\n${text}` : undefined;
      }),
    ],
  },
});
