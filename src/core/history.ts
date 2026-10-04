// Full-text search over everything said in the main thread, with the date of each hit so answers can cite it.
// Our own SQLite file, fed from the transcript; it can always be rebuilt from there.
import { DatabaseSync } from "node:sqlite";

export type HistoryLine = { entry: number; at: number; role: "user" | "assistant"; text: string };
export type HistoryHit = { at: number; role: "user" | "assistant"; snippet: string };

export class History {
	private readonly db: DatabaseSync;

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS lines USING fts5(text, role UNINDEXED, at UNINDEXED, entry UNINDEXED);
			CREATE TABLE IF NOT EXISTS indexed (id INTEGER PRIMARY KEY CHECK (id = 1), last_entry INTEGER NOT NULL);
		`);
	}

	/** The newest transcript entry already indexed. */
	lastEntry(): number {
		const row = this.db.prepare("SELECT last_entry FROM indexed WHERE id = 1").get() as { last_entry: number } | undefined;
		return row?.last_entry ?? 0;
	}

	add(lines: readonly HistoryLine[], lastEntry: number): void {
		const insert = this.db.prepare("INSERT INTO lines (text, role, at, entry) VALUES (?, ?, ?, ?)");
		this.db.exec("BEGIN");
		try {
			for (const line of lines) insert.run(line.text, line.role, line.at, line.entry);
			this.db.prepare("INSERT INTO indexed (id, last_entry) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET last_entry = excluded.last_entry").run(lastEntry);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Best matches first. Free text: every word is matched as a prefix, any order. */
	search(query: string, limit = 8): HistoryHit[] {
		const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
		if (terms.length === 0) return [];
		const match = terms.map((term) => `"${term}"*`).join(" OR ");
		const rows = this.db
			.prepare("SELECT at, role, snippet(lines, 0, '«', '»', '…', 24) AS snippet FROM lines WHERE lines MATCH ? ORDER BY bm25(lines) LIMIT ?")
			.all(match, limit) as Array<{ at: number; role: "user" | "assistant"; snippet: string }>;
		return rows.map((row) => ({ at: Number(row.at), role: row.role, snippet: row.snippet }));
	}

	close(): void {
		this.db.close();
	}
}
