// Memory: the agent's own memory of the user and their world — one free-form markdown document it organizes itself
// (who they are, how they work, what they're in the middle of, people, plans, seasons: whatever is worth knowing). The user
// can read and edit it. It changes through small edits, from `remember` when the user asks and from reflection after
// each exchange, never by wholesale rewrite, and stays within a size the user sets; every change is logged (and
// committed when the home is a git repo).
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One change to memory: add a line, or replace an exact passage (an empty `with` removes it). */
export type MemoryEdit = { add: string } | { replace: string; with: string };

export const wordCount = (text: string) => text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

export class Portrait {
	readonly path: string;
	private readonly home: string;

	constructor(home: string) {
		this.home = home;
		this.path = join(home, "memory.md");
	}

	read(): string {
		return existsSync(this.path) ? readFileSync(this.path, "utf8").trim() : "";
	}

	/** Add a line, or replace an existing passage with a corrected one (an empty note forgets it). */
	remember(note: string, replaces?: string): string {
		const next = this.edited(this.read(), note, replaces);
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, `${next}\n`);
		this.commit(replaces === undefined ? `remember: ${note}` : `correct: ${note || "(forget)"}`);
		return next;
	}

	/**
	 * Apply edits that still fit the current text, corrections first; returns the ones applied. One that would leave
	 * memory longer than `words` and longer than it was is refused, so past the limit only what makes room gets in.
	 * Each is logged for the weekly check-in.
	 */
	apply(edits: readonly MemoryEdit[], source: string, options: { words?: number; now?: number } = {}): MemoryEdit[] {
		const applied: MemoryEdit[] = [];
		const ordered = [...edits.filter((edit) => !("add" in edit)), ...edits.filter((edit) => "add" in edit)];
		for (const edit of ordered) {
			try {
				const current = this.read();
				if ("add" in edit && (edit.add.trim() === "" || current.includes(edit.add.trim()))) continue;
				const [note, replaces] = "add" in edit ? [edit.add, undefined] : [edit.with, edit.replace];
				const after = wordCount(this.edited(current, note, replaces));
				if (options.words !== undefined && after > options.words && after > wordCount(current)) continue;
				this.remember(note, replaces);
				applied.push(edit);
				appendFileSync(join(this.home, "memory-changes.jsonl"), `${JSON.stringify({ at: new Date(options.now ?? Date.now()).toISOString(), source, ...edit })}\n`);
			} catch {
				// The passage changed since the edit was proposed: skip it rather than guess.
			}
		}
		return applied;
	}

	private edited(current: string, note: string, replaces: string | undefined): string {
		let next: string;
		if (replaces !== undefined && replaces.trim() !== "") {
			if (!current.includes(replaces)) throw new Error(`Not in memory: ${replaces}`);
			next = current.replace(replaces, note.trim());
		} else {
			next = current === "" ? `- ${note.trim()}` : `${current}\n- ${note.trim()}`;
		}
		return next.replace(/^- *$\n?/gm, "").trim();
	}

	/** Best effort: when the home directory is a git repo, every change is a commit the user can read or revert. */
	private commit(message: string): void {
		if (!existsSync(join(this.home, ".git"))) return;
		execFile("git", ["-C", this.home, "add", "memory.md"], (error) => {
			if (error === null) execFile("git", ["-C", this.home, "commit", "-q", "-m", message.slice(0, 200)], () => {});
		});
	}
}
