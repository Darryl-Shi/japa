// /login and /logout: pi's own commands, from chat (where the user has no terminal). /login runs the login of a model
// provider or an account (an API key, or OAuth with a link and a pasted code); /logout removes a credential. The same
// for every one, whichever extension registered it; the credentials are kept in auth.json, as pi keeps them.
import type { AuthEvent, AuthType } from "@earendil-works/pi-ai";
import type { Button, Card, CardRef, UI } from "../core/ui.ts";
import type { Accounts, Login } from "../pi/accounts.ts";

/** What can be logged in to: model providers and accounts. */
export type Logins = Pick<Accounts, "list" | "find" | "check" | "login" | "logout">;

const PER_PAGE = 8;
const TIMEOUT_MS = 10 * 60_000;

const types = (login: Login): AuthType[] => [...(login.auth.oauth === undefined ? [] : ["oauth" as const]), ...(login.auth.apiKey?.login === undefined ? [] : ["api_key" as const])];

function describe(event: AuthEvent): string {
	if (event.type === "auth_url") return `Open this link to log in:\n${event.url}${event.instructions === undefined ? "" : `\n${event.instructions}`}`;
	if (event.type === "device_code") return `Go to ${event.verificationUri} and enter ${event.userCode}.`;
	if (event.type === "info") return [event.message, ...(event.links ?? []).map((link) => `${link.label ?? ""} ${link.url}`.trim())].join("\n");
	return event.message;
}

export function attachLogin(ui: UI, logins: Logins): void {
	/** Prompts the login flows are waiting on: an answer by reply, or a choice by button. */
	const waiting = new Map<string, { answer: (text: string) => void; message: string; options?: readonly { id: string; label: string }[] }>();
	let next = 0;

	const list = async (from: number): Promise<Card> => {
		const all = logins.list().filter((login) => types(login).length > 0);
		const start = Math.max(0, Math.min(from, all.length - 1));
		const rows: Button[][] = await Promise.all(
			all.slice(start, start + PER_PAGE).map(async (login) => [{ text: `${(await logins.check(login.id).catch(() => false)) ? "✅ " : ""}${login.name}`, data: `login:s:${login.id}` }]),
		);
		const nav: Button[] = [];
		if (start > 0) nav.push({ text: "◀", data: `login:p:${Math.max(0, start - PER_PAGE)}` });
		if (start + PER_PAGE < all.length) nav.push({ text: "▶", data: `login:p:${start + PER_PAGE}` });
		if (nav.length > 0) rows.push(nav);
		return { text: "Log in to a model provider or an account. ✅ already has credentials.", buttons: rows };
	};

	const login = async (provider: Login, type: AuthType, at: CardRef) => {
		const signal = AbortSignal.timeout(TIMEOUT_MS);
		try {
			await logins.login(provider.id, type, {
				signal,
				prompt: (prompt) =>
					new Promise<string>((resolve, reject) => {
						const id = String(next++);
						const options = prompt.type === "select" ? prompt.options : undefined;
						waiting.set(id, { answer: resolve, message: prompt.message, ...(options === undefined ? {} : { options }) });
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
			await ui.show({ text: `Logged in to ${provider.name}.`, replyTo: at });
		} catch (error) {
			await ui.show({ text: `Couldn't log in to ${provider.name}: ${error instanceof Error ? error.message : String(error)}`, replyTo: at });
		}
	};

	/** What /login offers that has a credential now, each a button to log out of it. */
	const loggedIn = async (): Promise<Card> => {
		const all = logins.list().filter((login) => types(login).length > 0);
		const rows: Button[][] = [];
		for (const login of all) if (await logins.check(login.id).catch(() => false)) rows.push([{ text: `✕ ${login.name}`, data: `logout:s:${login.id}` }]);
		return { text: rows.length === 0 ? "Nothing has credentials." : "Log out of a model provider or an account: its credential is removed.", buttons: rows };
	};

	ui.command("login", "Log in to a model provider or an account", async (at) => void (await ui.show({ ...(await list(0)), replyTo: at })));
	ui.command("logout", "Log out of a model provider or an account", async (at) => void (await ui.show({ ...(await loggedIn()), replyTo: at })));
	ui.handle("logout", {
		press: async (payload, ref) => {
			const [action, id = ""] = payload.split(":");
			const provider = logins.find(id);
			if (provider === undefined) return void (await ui.show(await loggedIn(), ref));
			if (action === "s") {
				const stops = provider.kind === "model provider" ? "Its models stop working" : "What uses it stops working";
				return void (await ui.show({ text: `Log out of ${provider.name}? ${stops} until you log in again.`, buttons: [[{ text: "Yes, log out", data: `logout:y:${id}` }, { text: "No", data: "logout:n:" }]] }, ref));
			}
			if (action !== "y") return void (await ui.show(await loggedIn(), ref));
			try {
				await logins.logout(id);
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
				prompt.answer(option.id);
				return void (await ui.show({ text: `${prompt.message}\n✓ ${option.label}` }, ref));
			}
			const provider = logins.find(a);
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
		reply: async (payload, text, ref, asked) => {
			const [action, id = ""] = payload.split(":");
			const prompt = waiting.get(id);
			// A login that's gone (it timed out, or japa restarted since it asked) can't take the answer.
			if (action !== "a" || prompt === undefined) return void (await ui.show({ text: "That login isn't waiting any more. Start it again with /login.", replyTo: ref }));
			waiting.delete(id);
			prompt.answer(text.trim());
			await ui.show({ text: `${prompt.message} ✓` }, asked);
		},
	});
}
