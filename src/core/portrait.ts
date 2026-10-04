// Memory: the agent's own memory of the user and his world — one free-form markdown document it organizes itself
// (who he is, how he works, what he's in the middle of, people, plans, seasons: whatever is worth knowing). The user
// can read and edit it. It changes through small edits, from `remember` in conversation and from reflection after
// each slice, never by wholesale rewrite; every change is logged (and committed when the home is a git repo).
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One change to memory: add a line, or replace an exact passage (an empty `with` removes it). */
export type MemoryEdit = { add: string } | { replace: string; with: string };

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
		const current = this.read();
		let next: string;
		if (replaces !== undefined && replaces.trim() !== "") {
			if (!current.includes(replaces)) throw new Error(`Not in memory: ${replaces}`);
			next = current.replace(replaces, note.trim());
		} else {
			next = current === "" ? `- ${note.trim()}` : `${current}\n- ${note.trim()}`;
		}
		next = next.replace(/^- *$\n?/gm, "").trim();
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, `${next}\n`);
		this.commit(replaces === undefined ? `remember: ${note}` : `correct: ${note || "(forget)"}`);
		return next;
	}

	/** Apply edits that still fit the current text; returns the ones applied. Each is logged for the weekly check-in. */
	apply(edits: readonly MemoryEdit[], source: string, now = Date.now()): MemoryEdit[] {
		const applied: MemoryEdit[] = [];
		for (const edit of edits) {
			try {
				if ("add" in edit) {
					if (edit.add.trim() === "" || this.read().includes(edit.add.trim())) continue;
					this.remember(edit.add);
				} else this.remember(edit.with, edit.replace);
				applied.push(edit);
				appendFileSync(join(this.home, "memory-changes.jsonl"), `${JSON.stringify({ at: new Date(now).toISOString(), source, ...edit })}\n`);
			} catch {
				// The passage changed since the edit was proposed: skip it rather than guess.
			}
		}
		return applied;
	}

	/** Best effort: when the home directory is a git repo, every change is a commit the user can read or revert. */
	private commit(message: string): void {
		if (!existsSync(join(this.home, ".git"))) return;
		execFile("git", ["-C", this.home, "add", "memory.md"], (error) => {
			if (error === null) execFile("git", ["-C", this.home, "commit", "-q", "-m", message.slice(0, 200)], () => {});
		});
	}
}
