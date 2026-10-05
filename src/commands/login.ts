// /login and /logout: pi's own commands, from chat (where the user has no terminal). /login runs a provider's own login
// in pi (an API key, or OAuth with a link and a pasted code); /logout removes a credential. The same for every provider
// pi has; pi keeps the credentials, in auth.json.
import type { AuthEvent, AuthType, Models, Provider } from "@earendil-works/pi-ai";
import type { Button, Card, CardRef, UI } from "../core/ui.ts";

const PER_PAGE = 8;
const TIMEOUT_MS = 10 * 60_000;

const types = (provider: Provider): AuthType[] => [...(provider.auth.oauth === undefined ? [] : ["oauth" as const]), ...(provider.auth.apiKey?.login === undefined ? [] : ["api_key" as const])];

function describe(event: AuthEvent): string {
	if (event.type === "auth_url") return `Open this link to log in:\n${event.url}${event.instructions === undefined ? "" : `\n${event.instructions}`}`;
	if (event.type === "device_code") return `Go to ${event.verificationUri} and enter ${event.userCode}.`;
	if (event.type === "info") return [event.message, ...(event.links ?? []).map((link) => `${link.label ?? ""} ${link.url}`.trim())].join("\n");
	return event.message;
}

export function attachLogin(ui: UI, models: Models): void {
	/** Prompts the login flows are waiting on: an answer by reply, or a choice by button. */
	const waiting = new Map<string, { answer: (text: string) => void; options?: readonly { id: string }[] }>();
	let next = 0;

	const list = async (from: number): Promise<Card> => {
		const all = models.getProviders().filter((provider) => types(provider).length > 0);
		const start = Math.max(0, Math.min(from, all.length - 1));
		const rows: Button[][] = await Promise.all(
			all.slice(start, start + PER_PAGE).map(async (provider) => [{ text: `${(await models.checkAuth(provider.id)) === undefined ? "" : "✅ "}${provider.name}`, data: `login:s:${provider.id}` }]),
		);
		const nav: Button[] = [];
		if (start > 0) nav.push({ text: "◀", data: `login:p:${Math.max(0, start - PER_PAGE)}` });
		if (start + PER_PAGE < all.length) nav.push({ text: "▶", data: `login:p:${start + PER_PAGE}` });
		if (nav.length > 0) rows.push(nav);
		return { text: "Log in to a model provider. ✅ already has credentials.", buttons: rows };
	};

	const login = async (provider: Provider, type: AuthType, at: CardRef) => {
		const signal = AbortSignal.timeout(TIMEOUT_MS);
		try {
			await models.login(provider.id, type, {
				signal,
				prompt: (prompt) =>
					new Promise<string>((resolve, reject) => {
						const id = String(next++);
						const options = prompt.type === "select" ? prompt.options : undefined;
						waiting.set(id, { answer: resolve, ...(options === undefined ? {} : { options }) });
						const cancel = () => {
							waiting.delete(id);
							reject(new Error("cancelled"));
						};
						signal.addEventListener("abort", cancel, { once: true });
						prompt.signal?.addEventListener("abort", cancel, { once: true });
						void ui.show(
							prompt.type === "select"
								? { text: prompt.message, buttons: prompt.options.map((option, index) => [{ text: option.label, data: `login:o:${id}:${index}` }]), replyTo: at }
								: { text: prompt.message, ask: { data: `login:a:${id}`, ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }), secret: prompt.type === "secret" }, replyTo: at },
						);
					}),
				notify: (event) => void ui.show({ text: describe(event), buzz: false, replyTo: at }),
			});
			// Its models, if it fetches them, come with the credential.
			await models.refresh({ providers: [provider.id], force: true, signal: AbortSignal.timeout(10_000) });
			await ui.show({ text: `Logged in to ${provider.name}.`, replyTo: at });
		} catch (error) {
			await ui.show({ text: `Couldn't log in to ${provider.name}: ${error instanceof Error ? error.message : String(error)}`, replyTo: at });
		}
	};

	/** The providers /login offers that have a credential now, each a button to log out of it. */
	const loggedIn = async (): Promise<Card> => {
		const all = models.getProviders().filter((provider) => types(provider).length > 0);
		const rows: Button[][] = [];
		for (const provider of all) if ((await models.checkAuth(provider.id)) !== undefined) rows.push([{ text: `✕ ${provider.name}`, data: `logout:s:${provider.id}` }]);
		return { text: rows.length === 0 ? "No model provider has credentials." : "Log out of a model provider: its credential is removed.", buttons: rows };
	};

	ui.command("login", "Log in to a model provider", async (at) => void (await ui.show({ ...(await list(0)), replyTo: at })));
	ui.command("logout", "Log out of a model provider", async (at) => void (await ui.show({ ...(await loggedIn()), replyTo: at })));
	ui.handle("logout", {
		press: async (payload, ref) => {
			const [action, id = ""] = payload.split(":");
			const provider = models.getProvider(id);
			if (provider === undefined) return void (await ui.show(await loggedIn(), ref));
			if (action === "s") {
				return void (await ui.show({ text: `Log out of ${provider.name}? Its models stop working until you log in again.`, buttons: [[{ text: "Yes, log out", data: `logout:y:${id}` }, { text: "No", data: "logout:n:" }]] }, ref));
			}
			if (action !== "y") return void (await ui.show(await loggedIn(), ref));
			try {
				await models.logout(id);
				await ui.show({ text: `Logged out of ${provider.name}.` }, ref);
			} catch (error) {
				await ui.show({ text: `Couldn't log out of ${provider.name}: ${error instanceof Error ? error.message : String(error)}` }, ref);
			}
		},
	});
	ui.handle("login", {
		press: async (payload, ref) => {
			const [action, a = "", b] = payload.split(":");
			if (action === "p") return void (await ui.show(await list(Number(a)), ref));
			if (action === "o") {
				const prompt = waiting.get(a);
				const option = prompt?.options?.[Number(b)];
				if (prompt === undefined || option === undefined) return;
				waiting.delete(a);
				return prompt.answer(option.id);
			}
			const provider = models.getProvider(a);
			if (provider === undefined) return;
			const offered = types(provider);
			const type = action === "t" ? (b as AuthType) : offered.length === 1 ? offered[0] : undefined;
			if (type === undefined) {
				return void (await ui.show(
					{ text: `Log in to ${provider.name} with:`, buttons: [offered.map((each) => ({ text: each === "oauth" ? "Account (OAuth)" : "API key", data: `login:t:${provider.id}:${each}` }))] },
					ref,
				));
			}
			await login(provider, type, ref);
		},
		reply: async (payload, text) => {
			const [action, id = ""] = payload.split(":");
			const prompt = waiting.get(id);
			if (action !== "a" || prompt === undefined) return;
			waiting.delete(id);
			prompt.answer(text.trim());
		},
	});
}
