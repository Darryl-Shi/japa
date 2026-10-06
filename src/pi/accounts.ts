// Accounts: what the user logs in to for an extension's own use (a service it calls, a channel's bot). An account has
// pi-ai's auth, as a model provider has, and the same store (auth.json), so /login logs in to either the same way, and
// an OAuth credential is refreshed when it needs it. An extension asks for its credentials (pi.accounts.get, which also
// gives a model provider's); not logged in, the user gets a card to log in with, and the extension an error saying so.
import type { AuthContext, AuthInteraction, AuthResult, AuthType, CredentialStore, MutableModels, ProviderAuth } from "@earendil-works/pi-ai";
import type { UI } from "../core/ui.ts";
import type { Account, Owner } from "./extension.ts";

/** Something /login offers: a model provider or an account. */
export type Login = { id: string; name: string; kind: "model provider" | "account"; auth: ProviderAuth };

/** An OAuth token this close to expiring is refreshed first. */
const MIN_VALIDITY_MS = 5 * 60_000;

export class Accounts {
	private readonly registered = new Map<string, Account>();
	/** Asked to log in (once until they do). */
	private readonly asked = new Set<string>();
	private readonly models: MutableModels;
	private readonly credentials: CredentialStore;
	private readonly authContext: AuthContext;
	private readonly ui: UI;
	private readonly loggedIn: (id: string) => void;

	constructor(options: {
		models: MutableModels;
		credentials: CredentialStore;
		authContext: AuthContext;
		ui: UI;
		/** After a login: what needed it can start again. */
		loggedIn: (id: string) => void;
	}) {
		this.models = options.models;
		this.credentials = options.credentials;
		this.authContext = options.authContext;
		this.ui = options.ui;
		this.loggedIn = options.loggedIn;
	}

	owner(): Owner<Account> {
		return {
			add: (id, account) => {
				if (this.registered.has(id)) throw new Error(`another extension has the account ${id}`);
				if (this.models.getProvider(id) !== undefined) throw new Error(`${id} is a model provider's id`);
				this.registered.set(id, account);
				void this.probe(id);
			},
			remove: (id, account) => {
				if (this.registered.get(id) === account) this.registered.delete(id);
			},
		};
	}

	/** What /login offers: the accounts, then the model providers. */
	list(): Login[] {
		return [
			...[...this.registered.values()].map((account): Login => ({ ...account, kind: "account" })),
			...this.models.getProviders().map((provider): Login => ({ id: provider.id, name: provider.name, kind: "model provider", auth: provider.auth })),
		];
	}

	find(id: string): Login | undefined {
		return this.list().find((login) => login.id === id);
	}

	/**
	 * Reads its environment fallbacks (every login's, without an id), whether or not a stored credential is used
	 * instead, so a variable holding a key is known as one, and kept out of commands, from the start.
	 */
	async probe(id?: string): Promise<void> {
		const logins = id === undefined ? this.list() : this.list().filter((login) => login.id === id);
		await Promise.all(
			logins.map(async ({ auth: { apiKey } }) => {
				if (apiKey === undefined) return;
				const input = { ctx: this.authContext, signal: AbortSignal.timeout(10_000) };
				await (apiKey.check === undefined ? apiKey.resolve(input) : apiKey.check(input)).catch(() => undefined);
			}),
		);
	}

	/** Whether it has credentials, without refreshing them. */
	async check(id: string): Promise<boolean> {
		const account = this.registered.get(id);
		if (account === undefined) return (await this.models.checkAuth(id)) !== undefined;
		const stored = await this.credentials.read(id);
		if (stored?.type === "oauth") return account.auth.oauth !== undefined;
		const apiKey = account.auth.apiKey;
		if (apiKey === undefined) return false;
		const input = { ctx: this.authContext, ...(stored?.type === "api_key" ? { credential: stored } : {}), signal: AbortSignal.timeout(10_000) };
		return (await (apiKey.check === undefined ? apiKey.resolve(input) : apiKey.check(input))) !== undefined;
	}

	/** Its credentials, refreshed if they need it; not logged in, the user is asked to, and this throws. */
	async get(id: string, options: { signal?: AbortSignal } = {}): Promise<AuthResult> {
		const login = this.find(id);
		if (login === undefined) throw new Error(`there's no account or model provider called ${id}`);
		const result = await this.resolve(id, options.signal ?? AbortSignal.timeout(30_000));
		if (result !== undefined) {
			this.asked.delete(id);
			return result;
		}
		if (!this.asked.has(id)) {
			this.asked.add(id);
			void this.ui.show({ text: `${login.name}: you're not logged in, and it's needed.`, buttons: [[{ text: `Log in to ${login.name}`, data: `login:s:${id}` }]] }).catch(() => {});
		}
		throw new Error(`Not logged in to ${login.name}: the user has been asked to log in (/login).`);
	}

	private async resolve(id: string, signal: AbortSignal): Promise<AuthResult | undefined> {
		const account = this.registered.get(id);
		if (account === undefined) return this.models.getAuth(id, { signal });
		const stored = await this.credentials.read(id, { signal });
		if (stored?.type === "oauth") {
			const oauth = account.auth.oauth;
			if (oauth === undefined) return undefined;
			const stale = (expires: number) => Date.now() + MIN_VALIDITY_MS >= expires;
			let credential = stored;
			if (stale(credential.expires)) {
				// Under the store's lock, so two requests never refresh a rotating token twice.
				const fresh = await this.credentials.modify(id, async (current) => (current?.type === "oauth" && stale(current.expires) ? oauth.refresh(current, signal) : undefined), { signal });
				if (fresh?.type !== "oauth") return undefined;
				credential = fresh;
			}
			return { auth: await oauth.toAuth(credential), source: "OAuth" };
		}
		return account.auth.apiKey?.resolve({ ctx: this.authContext, ...(stored?.type === "api_key" ? { credential: stored } : {}), signal });
	}

	/** Run its own login (an API key, or OAuth) and keep the credential. */
	async login(id: string, type: AuthType, interaction: AuthInteraction & { signal: AbortSignal }): Promise<void> {
		const account = this.registered.get(id);
		if (account === undefined) {
			await this.models.login(id, type, interaction);
			// Its models, if it fetches them, come with the credential.
			await this.models.refresh({ providers: [id], force: true, signal: AbortSignal.timeout(10_000) });
		} else {
			const method = type === "oauth" ? account.auth.oauth : account.auth.apiKey;
			if (method?.login === undefined) throw new Error(`${account.name} has no ${type === "oauth" ? "OAuth" : "API key"} login`);
			const credential = await method.login(interaction);
			await this.credentials.modify(id, async () => credential, { signal: interaction.signal });
		}
		this.asked.delete(id);
		this.loggedIn(id);
	}

	async logout(id: string): Promise<void> {
		if (this.registered.has(id)) await this.credentials.delete(id);
		else await this.models.logout(id);
	}
}
