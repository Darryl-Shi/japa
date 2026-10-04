// Model credentials (API keys, Claude/ChatGPT subscription OAuth) in data/auth.json, the same shape pi uses.
// Only the harness reads this file; the sandbox never sees it.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

export class FileCredentialStore implements CredentialStore {
	private chain: Promise<unknown> = Promise.resolve();
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	private load(): Record<string, Credential> {
		return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Credential>) : {};
	}

	private save(all: Record<string, Credential>): void {
		const temporary = `${this.path}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(all, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temporary, this.path);
	}

	private serialized<T>(work: () => Promise<T>): Promise<T> {
		const next = this.chain.then(work, work);
		this.chain = next.catch(() => {});
		return next;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return this.load()[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
		return this.serialized(async () => {
			const all = this.load();
			const next = await fn(all[providerId]);
			if (next === undefined) delete all[providerId];
			else all[providerId] = next;
			this.save(all);
			return next;
		});
	}

	delete(providerId: string): Promise<void> {
		return this.serialized(async () => {
			const all = this.load();
			delete all[providerId];
			this.save(all);
		});
	}
}

/**
 * Extension secrets (API keys, tokens) in data/secrets.json, set from /settings or the environment. They stay in the
 * harness: an extension that needs one on the workbench passes it to a single command, never writes it there.
 */
export class SecretsFile {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	private load(): Record<string, string> {
		return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Record<string, string>) : {};
	}

	/** `name` is "<extension>.<key>"; the environment variable, when given, is the fallback. */
	get(name: string, env?: string): string | undefined {
		return this.load()[name] ?? (env === undefined ? undefined : process.env[env]);
	}

	set(name: string, value: string | undefined): void {
		const all = this.load();
		if (value === undefined || value === "") delete all[name];
		else all[name] = value;
		const temporary = `${this.path}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(all, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temporary, this.path);
	}
}
