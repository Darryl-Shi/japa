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

// `gen` counts resumes (missing = 0): a task whose input `gen` differs belongs to an earlier run and exits.
type Schedule = { id: string; text: string; cron?: string; at?: number; next: number; paused?: boolean; gen?: number };

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

type Input = { id: string; gen?: number };

/** Whether the task with `input` should keep running `s`: it exists, isn't paused and is of the task's `gen`. */
const live = (s: Schedule | undefined, input: Input): s is Schedule =>
  s !== undefined && !s.paused && (s.gen ?? 0) === (input.gen ?? 0);

// One per schedule run: sleeps until its next time, then posts its text to the CoS; exits once the schedule is gone,
// paused, or resumed (a new run, with its own task).
const ScheduleTask = defineTask<Input, State, null>({
  name: "japa.schedule",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      const { id } = task.input;
      const schedule = (await runtime.snapshot(ScheduleDoc, ROOT_CONVERSATION_ID, context))?.schedules[id];
      if (live(schedule, task.input)) await runtime.sleep(schedule.next, context);
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(ScheduleDoc, ROOT_CONVERSATION_ID);
        const s = doc.schedules[id];
        if (!live(s, task.input)) return done;
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
    .map((s) => `${s.id}  ${s.cron ?? "once"}  next ${local(s.next)}  ${s.text}${s.paused ? " (paused)" : ""}`)
    .join("\n");

const scheduleAdd = defineTool({
  name: "schedule_add",
  description:
    "Schedule a message to yourself: give `cron` (5 fields, local time) to repeat, or `at` (ISO date-time; without an offset it is local time) for once.",
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
      await tx.createTask(
        ScheduleTask,
        { id },
        { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true },
      );
      doc.schedules[id] = { id, text, ...(cron === undefined ? { at: next } : { cron }), next };
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
    const schedules = (await api.snapshot(ScheduleDoc, ROOT_CONVERSATION_ID, context))?.schedules ?? {};
    const label = (s: Schedule) => `${s.text} (${s.cron ?? local(s.next)})`;
    const details = Object.values(schedules).map((s) => ({
      id: s.id,
      text: s.text,
      ...(s.cron === undefined ? { at: s.at! } : { cron: s.cron }),
      next: s.next,
      paused: s.paused ?? false,
      label: label(s),
    }));
    return { ...reply(lines(schedules) || "No schedules."), details };
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

const schedulePause = defineTool({
  name: "schedule_pause",
  description: "Pause the schedule with this id: it doesn't fire until resumed.",
  parameters: Type.Object({ id: Type.String() }),
  execute: async ({ id }, api, context) => {
    const answer = await api.commit(async (tx) => {
      const s = (await tx.doc(ScheduleDoc, ROOT_CONVERSATION_ID)).schedules[id];
      if (!s) return `No schedule ${id}.`;
      if (s.paused) return `Schedule ${id} is already paused.`;
      s.paused = true;
      await logChange(tx, {
        title: `Paused schedule "${s.text}"`,
        howToUse: "",
        undo: { commits: [], call: { tool: "schedule_resume", args: { id } } },
      });
      return `Paused schedule ${id}.`;
    }, context);
    return reply(answer);
  },
});

const scheduleResume = defineTool({
  name: "schedule_resume",
  description:
    "Resume the paused schedule with this id: a repeating one continues from its next time, a once one whose time " +
    "has passed fires now.",
  parameters: Type.Object({ id: Type.String() }),
  execute: async ({ id }, api, context) => {
    const answer = await api.commit(async (tx) => {
      const s = (await tx.doc(ScheduleDoc, ROOT_CONVERSATION_ID)).schedules[id];
      if (!s) return `No schedule ${id}.`;
      if (!s.paused) return `Schedule ${id} isn't paused.`;
      delete s.paused;
      // A new run: the earlier run's task, still asleep, sees another gen and exits instead of firing too.
      const gen = (s.gen ?? 0) + 1;
      s.gen = gen;
      if (s.cron !== undefined) s.next = nextAfter(s.cron, Date.now());
      await tx.createTask(
        ScheduleTask,
        { id, gen },
        { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true },
      );
      await logChange(tx, {
        title: `Resumed schedule "${s.text}"`,
        howToUse: "",
        undo: { commits: [], call: { tool: "schedule_pause", args: { id } } },
      });
      return `Resumed schedule ${id}: next at ${local(s.next)}.`;
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
    "schedule_remove({ id }), schedule_pause({ id }) (it doesn't fire until resumed), schedule_resume({ id }) (a " +
    "repeating one continues from its next time; a once one already due fires at once).",
  provides: { tool: [scheduleAdd, scheduleList, scheduleRemove, schedulePause, scheduleResume] },
  durable: {
    tasks: [ScheduleTask],
    sections: [
      section("schedules", async ({ read }, context) => {
        const text = lines((await read.snapshot(ScheduleDoc, ROOT_CONVERSATION_ID, context))?.schedules ?? {});
        const now = new Date().toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
        const head = `Now: ${now} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
        return text ? `${head}\nActive schedules:\n${text}` : head;
      }),
    ],
  },
});
