// Schedules: messages the chief of staff gets at set times, and answers like any other (its answer reaches the user).
// An extension registers its own (pi.registerSchedule) while it's on; the chief of staff makes its own when the user
// asks (the schedule tool), kept until they're done or cancelled. When each last ran is kept, so a time missed while
// japa was down runs once when it's back. Both are in schedules.json, in the data directory.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import { Cron } from "croner";
import { stamp } from "../core/schedule.ts";
import type { Owner, Schedule } from "./extension.ts";

export const SCHEDULE_PREFIX = "[Schedule ";

/** The chief of staff's own (with when each was made), and when each schedule last ran, by key. */
type Saved = { own: Record<string, Schedule & { since: number }>; last: Record<string, number> };

/** A schedule as the chief of staff and /jobs see it. */
export type Scheduled = { name: string; when: string; message: string; next: number | undefined; own: boolean };

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class Schedules {
	private readonly running = new Map<string, { schedule: Schedule; cron: Cron }>();
	private readonly path: string;
	private readonly timezone: () => string | undefined;
	private readonly fire: (name: string, message: string) => void;

	constructor(options: {
		path: string;
		/** The user's time zone (settings), for a schedule that doesn't give one. */
		timezone: () => string | undefined;
		/** Its time came: a message to the chief of staff. */
		fire: (name: string, message: string) => void;
	}) {
		this.path = options.path;
		this.timezone = options.timezone;
		this.fire = options.fire;
	}

	private load(): Saved {
		const saved = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Partial<Saved>) : {};
		return { own: saved.own ?? {}, last: saved.last ?? {} };
	}

	private save(saved: Saved): void {
		writeFileSync(`${this.path}.tmp`, `${JSON.stringify(saved, null, "\t")}\n`);
		renameSync(`${this.path}.tmp`, this.path);
	}

	/** Its next time, checked: a bad `when`, or a time that has passed, throws. */
	private cron(schedule: Schedule, run?: () => void): Cron {
		const timezone = schedule.timezone ?? this.timezone();
		const cron = new Cron(schedule.when, { paused: true, ...(timezone === undefined ? {} : { timezone }) }, run ?? (() => {}));
		if (cron.nextRun() === null && run === undefined) {
			cron.stop();
			throw new Error(`${schedule.when} has passed`);
		}
		return cron;
	}

	/** Run it on time, from now on; once now if a time came while it wasn't running (since it last ran, or was made). */
	private start(name: string, schedule: Schedule, since: number | undefined): void {
		this.stop(name);
		const cron = this.cron(schedule, () => this.run(name));
		this.running.set(name, { schedule, cron });
		cron.resume();
		const missed = since === undefined ? undefined : cron.nextRun(new Date(since));
		if (missed !== undefined && missed !== null && missed.getTime() <= Date.now()) this.run(name);
	}

	private run(name: string): void {
		const entry = this.running.get(name);
		if (entry === undefined) return;
		const saved = this.load();
		const done = entry.cron.nextRun() === null;
		if (done && saved.own[name] !== undefined) {
			delete saved.own[name];
			delete saved.last[name];
		} else saved.last[name] = Date.now();
		this.save(saved);
		if (done) this.stop(name);
		this.fire(name, entry.schedule.message);
	}

	private stop(name: string): void {
		this.running.get(name)?.cron.stop();
		this.running.delete(name);
	}

	/** An extension's, while it's on: named "<extension>/<name>". */
	owner(): Owner<Schedule> {
		return {
			add: (name, schedule, from) => {
				this.cron(schedule).stop();
				this.start(`${from.name}/${name}`, schedule, this.load().last[`${from.name}/${name}`]);
			},
			remove: (name, _schedule, from) => this.stop(`${from.name}/${name}`),
		};
	}

	/** The chief of staff's own, made again at start. */
	resume(): void {
		const saved = this.load();
		for (const [name, schedule] of Object.entries(saved.own)) {
			try {
				this.start(name, schedule, saved.last[name] ?? schedule.since);
			} catch {
				// Unreadable now (its time zone gone): left in the file, not run.
			}
		}
	}

	add(name: string, schedule: Schedule): number | undefined {
		if (name.includes("/") || name.trim() === "") throw new Error("name it without slashes");
		this.cron(schedule).stop();
		const saved = this.load();
		saved.own[name] = { ...schedule, since: Date.now() };
		delete saved.last[name];
		this.save(saved);
		this.start(name, schedule, undefined);
		return this.running.get(name)?.cron.nextRun()?.getTime();
	}

	cancel(name: string): boolean {
		const saved = this.load();
		if (saved.own[name] === undefined) return false;
		delete saved.own[name];
		delete saved.last[name];
		this.save(saved);
		this.stop(name);
		return true;
	}

	list(): Scheduled[] {
		const own = this.load().own;
		return [...this.running].map(([name, { schedule, cron }]) => ({ name, when: schedule.when, message: schedule.message, next: cron.nextRun()?.getTime(), own: own[name] !== undefined }));
	}

	stopAll(): void {
		for (const name of [...this.running.keys()]) this.stop(name);
	}
}

/** The chief of staff's: what's scheduled, in its prompt, and its own schedules, made and cancelled when the user asks. */
export function schedulesExtension(schedules: Schedules, timezone: () => string | undefined): Extension {
	const at = (next: number | undefined) => (next === undefined ? "no next time" : `next ${stamp(next, timezone())}`);
	return defineExtension({
		name: "japa.schedules",
		sections: [
			section("schedules", () => {
				const all = schedules.list();
				if (all.length === 0) return undefined;
				return [`Scheduled (each comes to you at its time, as a message starting "${SCHEDULE_PREFIX}<name>]"):`, ...all.map((each) => `- ${each.name} (${each.when}, ${at(each.next)}): ${each.message}`)].join("\n");
			}),
		],
		tools: [
			defineTool({
				name: "schedule",
				description:
					'Have a message come to you at a time, as a reminder or recurring work the user asks for: once (a date and time, e.g. "2026-10-09T17:00") or repeatedly (a cron expression, e.g. "0 9 * * 1-5"), in the user\'s time zone unless you give one. When it comes, do what it says. The same name replaces one.',
				parameters: Type.Object({
					name: Type.String({ description: "Short, lowercase-with-dashes" }),
					when: Type.String(),
					message: Type.String({ description: "What you'll get: what to do then, with whatever you'll need to know" }),
					timezone: Type.Optional(Type.String({ description: "IANA zone, if not the user's" })),
				}),
				execute: async (args) => {
					try {
						const next = schedules.add(args.name, { when: args.when, message: args.message, ...(args.timezone === undefined ? {} : { timezone: args.timezone }) });
						return text(`Scheduled ${args.name}: ${at(next)}.`);
					} catch (error) {
						return text(`Couldn't schedule it: ${message(error)}.`);
					}
				},
			}),
			defineTool({
				name: "cancel_schedule",
				description: "Cancel one of your own schedules.",
				parameters: Type.Object({ name: Type.String() }),
				execute: async (args) => text(schedules.cancel(args.name) ? `Cancelled ${args.name}.` : `You have no schedule called ${args.name}.`),
			}),
		],
	});
}
