// Approvals and the audit log. A request is what the agent wanted to do and why it needs the user; a decision is
// theirs. Kept in data/approvals.json so a request survives a restart, and every reviewed action is appended to
// data/audit.jsonl.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type ApprovalRequest = {
	id: string;
	/** The tool task that asked: a retry after a restart finds the same request. */
	taskId: string;
	conversationId: string;
	tool: string;
	/** Canonical JSON of the arguments; an approval lets exactly this call through, once. */
	args: string;
	summary: string;
	/** The kind of action, offered as a standing permission. */
	rule: string;
	at: number;
	status: "pending" | "approved" | "denied";
	/** The Telegram message that asked. */
	messageId?: number;
	/** The agent has been told the decision. */
	told?: boolean;
	/** The approved call has run. */
	used?: boolean;
};

export type Decision = "approve" | "deny" | "always";

/** JSON with sorted keys, so the same call always looks the same. */
export function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) =>
		inner !== null && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner,
	);
}

export class Approvals {
	private readonly path: string;
	private readonly auditPath: string;
	private readonly requestListeners = new Set<(request: ApprovalRequest) => void>();
	private readonly decisionListeners = new Set<(request: ApprovalRequest, decision: Decision) => void>();

	constructor(path: string, auditPath: string) {
		this.path = path;
		this.auditPath = auditPath;
	}

	private load(): Record<string, ApprovalRequest> {
		return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Record<string, ApprovalRequest>) : {};
	}

	private save(all: Record<string, ApprovalRequest>): void {
		// Decided requests are kept for a week (the audit log keeps everything).
		const cutoff = Date.now() - 7 * 86_400_000;
		const kept = Object.fromEntries(Object.entries(all).filter(([, request]) => request.status === "pending" || request.at > cutoff));
		writeFileSync(`${this.path}.tmp`, `${JSON.stringify(kept, null, "\t")}\n`);
		renameSync(`${this.path}.tmp`, this.path);
	}

	all(): ApprovalRequest[] {
		return Object.values(this.load());
	}

	get(id: string): ApprovalRequest | undefined {
		return this.load()[id];
	}

	/** Ask, once per tool task. */
	request(fields: Omit<ApprovalRequest, "id" | "at" | "status">): ApprovalRequest {
		const all = this.load();
		const existing = Object.values(all).find((request) => request.taskId === fields.taskId);
		if (existing !== undefined) return existing;
		const id = `a${Object.keys(all).length + 1}-${Date.now().toString(36).slice(-4)}`;
		const request: ApprovalRequest = { ...fields, id, at: Date.now(), status: "pending" };
		all[id] = request;
		this.save(all);
		this.audit({ conversationId: fields.conversationId, tool: fields.tool, args: fields.args, verdict: "asked", approval: id, summary: fields.summary });
		for (const listener of this.requestListeners) listener(request);
		return request;
	}

	/** An approved, unused request for exactly this call: it goes through, once. */
	consume(conversationId: string, tool: string, args: string): ApprovalRequest | undefined {
		const all = this.load();
		const granted = Object.values(all).find((request) => request.status === "approved" && request.used !== true && request.conversationId === conversationId && request.tool === tool && request.args === args);
		if (granted === undefined) return undefined;
		granted.used = true;
		this.save(all);
		this.audit({ conversationId, tool, args, verdict: "ran-approved", approval: granted.id });
		return granted;
	}

	decide(id: string, decision: Decision): ApprovalRequest | undefined {
		const all = this.load();
		const request = all[id];
		if (request === undefined || request.status !== "pending") return undefined;
		request.status = decision === "deny" ? "denied" : "approved";
		this.save(all);
		this.audit({ conversationId: request.conversationId, tool: request.tool, args: request.args, verdict: decision, approval: id });
		for (const listener of this.decisionListeners) listener(request, decision);
		return request;
	}

	update(id: string, change: Partial<Pick<ApprovalRequest, "messageId" | "told">>): void {
		const all = this.load();
		if (all[id] === undefined) return;
		all[id] = { ...all[id], ...change };
		this.save(all);
	}

	/** Is this conversation paused on the user? */
	waiting(conversationId: string): boolean {
		return this.all().some((request) => request.conversationId === conversationId && (request.status === "pending" || request.told !== true));
	}

	onRequest(listener: (request: ApprovalRequest) => void): void {
		this.requestListeners.add(listener);
	}

	onDecision(listener: (request: ApprovalRequest, decision: Decision) => void): void {
		this.decisionListeners.add(listener);
	}

	audit(record: { conversationId: string; tool: string; args: string; verdict: string; approval?: string; summary?: string; reason?: string }): void {
		appendFileSync(this.auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...record, args: record.args.slice(0, 1000) })}\n`);
	}
}
