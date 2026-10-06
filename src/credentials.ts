// Credentials, the same shape pi uses: data/auth.json holds every login's (model providers' and accounts': API keys,
// OAuth tokens), set with /login. Only japa reads this file; the agent's commands never get it, nor the environment
// variables a login falls back on (KeyEnvironment).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { type AuthContext, type Credential, type CredentialInfo, type CredentialStore, defaultProviderAuthContext } from "@earendil-works/pi-ai";

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

	/** `fn` returning undefined leaves the credential as it is (pi-ai's contract: a refresh that found it fresh). */
	modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
		return this.serialized(async () => {
			const all = this.load();
			const next = await fn(all[providerId]);
			if (next === undefined) return all[providerId];
			all[providerId] = next;
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
 * pi-ai's auth context (the environment and files a login falls back on), remembering which environment variables
 * held a key when a login read them: those are japa's keys, and its commands start without them.
 */
export class KeyEnvironment implements AuthContext {
	private readonly base = defaultProviderAuthContext();
	private readonly read = new Set<string>();

	async env(name: string): Promise<string | undefined> {
		const value = await this.base.env(name);
		if (value !== undefined) this.read.add(name);
		return value;
	}

	fileExists(path: string): Promise<boolean> {
		return this.base.fileExists(path);
	}

	/** The environment variables that held a key. */
	names(): string[] {
		return [...this.read];
	}
}
