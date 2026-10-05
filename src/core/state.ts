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
	/** The chat messages it belongs to (the request, the report), so a reply to any of them finds it. */
	messageIds?: string[];
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

	add(kind: OpenItemKind, text: string, messageId?: string, now = Date.now()): OpenItem {
		const items = this.all();
		const id = `${kind[0]}${(items.reduce((max, item) => Math.max(max, Number(item.id.slice(1)) || 0), 0) + 1).toString()}`;
		const item: OpenItem = { id, kind, text, openedAt: now, ...(messageId === undefined ? {} : { messageIds: [messageId] }) };
		save(this.path, [...items, item]);
		return item;
	}

	private change(id: string, edit: (item: OpenItem) => void): OpenItem | undefined {
		const items = this.all();
		const item = items.find((candidate) => candidate.id === id);
		if (item === undefined) return undefined;
		edit(item);
		save(this.path, items);
		return item;
	}

	/** Close an item. Closing one that's already closed is a no-op, so a retried report is harmless. */
	close(id: string, outcome?: string, now = Date.now()): OpenItem {
		const items = this.all();
		const item = items.find((candidate) => candidate.id === id);
		if (item === undefined) throw new Error(`No open item ${id}`);
		if (item.closedAt !== undefined) return item;
		item.closedAt = now;
		if (outcome !== undefined) item.outcome = outcome;
		save(this.path, items.filter((candidate) => candidate.closedAt === undefined || now - candidate.closedAt < CLOSED_KEEP_MS));
		return item;
	}

	/** Open a closed item again (e.g. a finished job given more to do). False if it's gone. */
	reopen(id: string): boolean {
		const items = this.all();
		const item = items.find((candidate) => candidate.id === id);
		if (item === undefined) return false;
		delete item.closedAt;
		delete item.outcome;
		save(this.path, items);
		return true;
	}

	/** Remember another chat message that belongs to this item. */
	link(id: string, messageId: string): void {
		this.change(id, (item) => {
			item.messageIds = [...new Set([...(item.messageIds ?? []).map(String), messageId])];
		});
	}

	forMessage(messageId: string): OpenItem | undefined {
		// String(): items saved before ids were strings hold numbers.
		return this.all().findLast((item) => item.messageIds?.map(String).includes(messageId) === true);
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
