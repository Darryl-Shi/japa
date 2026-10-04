// What a new slice of the main thread starts from: what's open, and the working set of the last topic. State, not
// history — both stay small no matter how long the thread runs. Plain JSON files, our own format.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

function load<T>(path: string, fallback: T): T {
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

function save(path: string, value: unknown): void {
	writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, "\t")}\n`);
	renameSync(`${path}.tmp`, path);
}

export type OpenItemKind = "task" | "waiting" | "promise";

export type OpenItem = {
	id: string;
	/** task: work in flight. waiting: a question or proposal waiting on the user. promise: something we said we'd do. */
	kind: OpenItemKind;
	text: string;
	openedAt: number;
	/** The Telegram message it belongs to, so a reply to that message finds it. */
	telegramMessageId?: number;
	closedAt?: number;
	outcome?: string;
};

const CLOSED_KEEP_MS = 30 * 24 * 60 * 60_000;
const PROJECTION_CHARS = 2000;

export class OpenItems {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	all(): OpenItem[] {
		return load<OpenItem[]>(this.path, []);
	}

	open(): OpenItem[] {
		return this.all().filter((item) => item.closedAt === undefined);
	}

	add(kind: OpenItemKind, text: string, telegramMessageId?: number, now = Date.now()): OpenItem {
		const items = this.all();
		const id = `${kind[0]}${(items.reduce((max, item) => Math.max(max, Number(item.id.slice(1)) || 0), 0) + 1).toString()}`;
		const item: OpenItem = { id, kind, text, openedAt: now, ...(telegramMessageId === undefined ? {} : { telegramMessageId }) };
		save(this.path, [...items, item]);
		return item;
	}

	close(id: string, outcome?: string, now = Date.now()): OpenItem {
		const items = this.all();
		const item = items.find((candidate) => candidate.id === id && candidate.closedAt === undefined);
		if (item === undefined) throw new Error(`No open item ${id}`);
		item.closedAt = now;
		if (outcome !== undefined) item.outcome = outcome;
		save(this.path, items.filter((candidate) => candidate.closedAt === undefined || now - candidate.closedAt < CLOSED_KEEP_MS));
		return item;
	}

	forMessage(telegramMessageId: number): OpenItem | undefined {
		return this.all().findLast((item) => item.telegramMessageId === telegramMessageId);
	}

	/** What goes in the prompt. Promises and questions waiting on the user are never dropped; tasks are, oldest first. */
	projection(): string | undefined {
		const open = this.open();
		if (open.length === 0) return undefined;
		const line = (item: OpenItem) => `${item.id} [${item.kind}] ${item.text}`;
		const kept = open.filter((item) => item.kind !== "task").map(line);
		const tasks = open.filter((item) => item.kind === "task").reverse();
		let used = kept.join("\n").length;
		let dropped = 0;
		for (const task of tasks) {
			if (used + line(task).length + 1 > PROJECTION_CHARS) dropped++;
			else {
				kept.push(line(task));
				used += line(task).length + 1;
			}
		}
		return dropped === 0 ? kept.join("\n") : `${kept.join("\n")}\n(+${dropped} older tasks; list_open_items shows all)`;
	}
}

/** The working set of the topic last discussed: options, constraints, decisions, the last question. */
export type WorkingSet = { version: number; text: string };

export class WorkingSetFile {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	read(): WorkingSet | undefined {
		return load<WorkingSet | undefined>(this.path, undefined);
	}

	/** Versioned by the slice it summarizes: a late summary of an older slice never overwrites a newer one. */
	write(next: WorkingSet): boolean {
		const current = this.read();
		if (current !== undefined && current.version >= next.version) return false;
		save(this.path, next);
		return true;
	}
}
