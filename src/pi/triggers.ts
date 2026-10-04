// Triggers: extensions waking the chief of staff by themselves. A time trigger is a durable task that sleeps until
// its next time (surviving restarts), then sends the chief of staff its prompt; an event trigger fires when an
// extension emits the event. Either way the prompt arrives as a message starting "[Trigger", and the chief of staff
// decides what, if anything, the user hears.
import type { Context } from "@earendil-works/chord";
import { type Conversation, type ConversationId, defineDoc, defineExtension, defineTask, type Extension, type Tx } from "@earendil-works/pi-durable";
import { nextFire, stamp } from "../core/schedule.ts";
import type { Trigger } from "./extension.ts";

export const TRIGGER_PREFIX = "[Trigger ";

/** Live schedule tasks by trigger key ("<extension>/<trigger>"). */
const Schedules = defineDoc<{ tasks: Record<string, string> }>({ kind: "jarvis.schedules", version: 1, scope: "session", initial: () => ({ tasks: {} }) });

const background = { ownership: { kind: "conversation" }, background: true } as const;

export function triggerText(key: string, trigger: Trigger, at: number, timeZone: string | undefined, detail?: string): string {
	return `${TRIGGER_PREFIX}${key}, ${stamp(at, timeZone)}] ${trigger.prompt}${detail === undefined ? "" : `\n${detail}`}`;
}

export function triggers(options: { triggers: () => ReadonlyMap<string, Trigger>; timeZone: () => string | undefined }): {
	/** The schedule task, installed for the chief of staff. */
	extension: Extension;
	/** Start a schedule for every time trigger that's on and has none. */
	sync: (chief: Conversation, context: Context) => Promise<void>;
	/** Fire the event triggers listening for `event`. */
	emit: (chief: Conversation, event: string, detail: string | undefined, context: Context) => Promise<void>;
} {
	type Input = { key: string; chief: ConversationId };
	type State = { phase: "wait"; next?: number } | { phase: "fire"; at: number };
	/** Stop for good (the trigger is gone, turned off, or has no next time); sync starts a new one if it comes back. */
	const end = (key: string) => async (tx: Tx) => {
		delete (await tx.doc(Schedules)).tasks[key];
		return { status: "terminal", outcome: { status: "completed", result: null } } as const;
	};
	const timed = (key: string) => {
		const trigger = options.triggers().get(key);
		return trigger === undefined || "event" in trigger.when ? undefined : trigger;
	};

	const Schedule = defineTask<Input, State, null>({
		name: "jarvis.schedule",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (task, runtime, context) => {
				const trigger = timed(task.input.key);
				if (trigger === undefined) return runtime.commit(end(task.input.key), context);
				const next = task.state.checkpoint.next;
				if (next === undefined) {
					const at = nextFire(trigger.when, runtime.now(), options.timeZone());
					if (at === undefined) return runtime.commit(end(task.input.key), context);
					return runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait", next: at } }), context);
				}
				await runtime.sleep(next, context);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "fire", at: next } }), context);
			},
			fire: async (task, runtime, context) => {
				const trigger = timed(task.input.key);
				if (trigger === undefined) return runtime.commit(end(task.input.key), context);
				const at = task.state.checkpoint.at;
				const chief = await runtime.conversation(task.input.chief, context);
				await chief?.submit({ type: "input", content: triggerText(task.input.key, trigger, at, options.timeZone()), requestId: `trigger:${task.input.key}:${at}`, whenBusy: "followUp" }, context);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait" } }), context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

	return {
		extension: defineExtension({ name: "jarvis.triggers", tasks: [Schedule] }),
		sync: async (chief, context) => {
			const keys = [...options.triggers().keys()].filter((key) => timed(key) !== undefined);
			if (keys.length === 0) return;
			await chief.commit(async (tx) => {
				const doc = await tx.doc(Schedules);
				for (const key of keys) {
					if (doc.tasks[key] !== undefined) continue;
					doc.tasks[key] = String(await tx.createTask(Schedule, { key, chief: chief.id }, background));
				}
			}, context);
		},
		emit: async (chief, event, detail, context) => {
			for (const [key, trigger] of options.triggers()) {
				if (!("event" in trigger.when) || trigger.when.event !== event) continue;
				const at = Date.now();
				await chief.submit({ type: "input", content: triggerText(key, trigger, at, options.timeZone(), detail), requestId: `trigger:${key}:${at}`, whenBusy: "followUp" }, context);
			}
		},
	};
}
