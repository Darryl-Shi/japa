// /settings as a menu of cards, independent of the channel that shows it. The first page has the general settings
// and every extension with its switch; each extension's page is built from the fields it declares, so an extension
// adds its own settings just by listing them. Values go to settings.json, secrets to data/secrets.json. The allowlist
// is deliberately not here.
import type { Button, CardRef, UI } from "../core/ui.ts";
import type { SecretsFile } from "../credentials.ts";
import type { ExtensionSet, Field } from "../pi/extension.ts";
import type { ModelChoice, SettingsFile } from "../settings.ts";

export type View = { text: string; buttons: Button[][] };
/** A field waiting for a typed value. */
export type Prompt = { page: string; field: number; label: string; secret: boolean };

const GENERAL: readonly Field[] = [
	{ key: "model", label: "Chief of staff model", kind: "model" },
	{ key: "delegateModel", label: "Default job model", kind: "model" },
	{ key: "user.name", label: "Your name", kind: "text" },
	{ key: "timezone", label: "Time zone", kind: "text" },
	{ key: "context.idleMinutes", label: "New slice after idle (minutes)", kind: "number" },
];

const show = (value: unknown): string => {
	if (value === undefined || value === "" || value === null) return "–";
	if (typeof value === "object" && "provider" in value && "modelId" in value) return `${(value as ModelChoice).provider}/${(value as ModelChoice).modelId}`;
	return String(value);
};

export class SettingsMenu {
	private readonly settings: SettingsFile;
	private readonly secrets: SecretsFile;
	private readonly extensions: ExtensionSet;
	private readonly modelExists: (choice: ModelChoice) => boolean;
	private readonly changed: () => Promise<void>;

	constructor(options: {
		settings: SettingsFile;
		secrets: SecretsFile;
		extensions: ExtensionSet;
		modelExists?: (choice: ModelChoice) => boolean;
		/** After any change: apply it (extensions started or stopped, the model switched). */
		changed?: () => Promise<void>;
	}) {
		this.settings = options.settings;
		this.secrets = options.secrets;
		this.extensions = options.extensions;
		this.modelExists = options.modelExists ?? (() => true);
		this.changed = options.changed ?? (async () => {});
	}

	/** Show it through the UI: /settings opens it, its buttons and replies come back here. */
	attach(ui: UI): void {
		ui.command("settings", "Models, extensions and their options", async (at) => void (await ui.show({ ...this.main(), replyTo: at })));
		ui.handle("settings", {
			press: async (payload, ref) => {
				const next = this.press(payload);
				await this.changed();
				if ("buttons" in next) return void (await ui.show(next, ref));
				await ui.show({
					text: `Send the new value for "${next.label}" as a reply to this message ("-" to clear).${next.secret ? " I'll delete your message once it's saved." : ""}`,
					ask: { data: `settings:${next.page}:${next.field}`, placeholder: next.label, secret: next.secret },
					replyTo: ref,
				});
			},
			reply: async (payload, text, ref: CardRef) => {
				const [page = "", field] = payload.split(":");
				const result = this.answer({ page, field: Number(field), label: "", secret: false }, text);
				await this.changed();
				await ui.show("error" in result ? { text: result.error } : { ...result, replyTo: ref });
			},
		});
	}

	private fields(page: string): readonly Field[] {
		return page === "general" ? GENERAL : (this.extensions.get(page)?.settings ?? []);
	}

	private get(page: string, field: Field): unknown {
		if (field.kind === "secret") return this.secrets.get(`${page}.${field.key}`, field.env) === undefined ? "not set" : "set";
		if (page === "general") return field.key.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], this.settings.get());
		return this.settings.options(page, this.extensions.get(page)?.defaults ?? {})[field.key];
	}

	private set(page: string, field: Field, value: unknown): void {
		if (field.kind === "secret") return this.secrets.set(`${page}.${field.key}`, value === undefined ? undefined : String(value));
		if (page !== "general") return this.settings.setOption(page, field.key, value);
		const [head, tail] = field.key.split(".") as [string, string | undefined];
		const current = this.settings.get() as unknown as Record<string, unknown>;
		const next = tail === undefined ? value : { ...(current[head] as Record<string, unknown> | undefined), [tail]: value };
		this.settings.update({ [head]: next });
	}

	main(): View {
		const rows: Button[][] = [[{ text: "General", data: "settings:p:general" }]];
		for (const entry of this.extensions.entries) {
			const row: Button[] = [{ text: `${this.extensions.enabled(entry) ? "✅" : "⬜"} ${entry.title}`, data: `settings:t:${entry.name}` }];
			if ((entry.settings ?? []).length > 0) row.push({ text: "⚙", data: `settings:p:${entry.name}` });
			rows.push(row);
		}
		return { text: "Settings. Tap an extension to turn it on or off, ⚙ for its options.", buttons: rows };
	}

	page(name: string): View {
		const entry = this.extensions.get(name);
		const title = name === "general" ? "General" : (entry?.title ?? name);
		const rows: Button[][] = [];
		this.fields(name).forEach((field, index) => {
			const value = this.get(name, field);
			if (field.kind === "toggle") rows.push([{ text: `${value === true ? "✅" : "⬜"} ${field.label}`, data: `settings:f:${name}:${index}` }]);
			else if (field.kind === "list") {
				const items = Array.isArray(value) ? value : [];
				rows.push([{ text: `${field.label}: ${items.length === 0 ? "none" : items.length}`, data: `settings:p:${name}` }]);
				items.forEach((item, at) => rows.push([{ text: `✕ ${String(item).slice(0, 50)}`, data: `settings:x:${name}:${index}:${at}` }]));
			} else rows.push([{ text: `${field.label}: ${show(value)}${field.kind === "choice" ? " ▸" : ""}`, data: `settings:f:${name}:${index}` }]);
		});
		rows.push([{ text: "« Back", data: "settings:m" }]);
		return { text: [title, entry?.about].filter(Boolean).join("\n\n"), buttons: rows };
	}

	/** A button press (its data after "settings:"): the view to show next, or a field that needs a typed value. */
	press(payload: string): View | Prompt {
		const [action, name = "", a, b] = payload.split(":");
		if (action === "m") return this.main();
		if (action === "p") return this.page(name);
		if (action === "t") {
			const entry = this.extensions.get(name);
			if (entry === undefined) return this.main();
			const refusal = this.extensions.cannotTurnOff(entry);
			if (refusal !== undefined) {
				const main = this.main();
				return { ...main, text: `${refusal} Turn another channel on first.\n\n${main.text}` };
			}
			this.settings.setOption(name, "enabled", !this.extensions.enabled(entry));
			return this.main();
		}
		const field = this.fields(name)[Number(a)];
		if (field === undefined) return this.page(name);
		if (action === "x") {
			const items = this.get(name, field);
			if (Array.isArray(items)) this.set(name, field, items.filter((_, at) => at !== Number(b)));
			return this.page(name);
		}
		if (field.kind === "toggle") {
			this.set(name, field, this.get(name, field) !== true);
			return this.page(name);
		}
		if (field.kind === "choice") {
			const at = field.options.indexOf(String(this.get(name, field)));
			this.set(name, field, field.options[(at + 1) % field.options.length]);
			return this.page(name);
		}
		return { page: name, field: Number(a), label: field.label, secret: field.kind === "secret" };
	}

	/** A typed value for a prompt ("-" clears it); returns an error, or the page to show. */
	answer(prompt: Prompt, raw: string): { error: string } | View {
		const field = this.fields(prompt.page)[prompt.field];
		if (field === undefined) return this.main();
		const text = raw.trim();
		if (text === "-") {
			// Cleared settings fall back to their defaults.
			this.set(prompt.page, field, undefined);
			return this.page(prompt.page);
		}
		if (field.kind === "number") {
			const value = Number(text);
			if (!Number.isFinite(value)) return { error: "That's not a number." };
			this.set(prompt.page, field, value);
		} else if (field.kind === "model") {
			const slash = text.indexOf("/");
			const choice = { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
			if (slash <= 0 || !this.modelExists(choice)) return { error: `Unknown model "${text}". Write it as provider/modelId, e.g. anthropic/claude-sonnet-5-5.` };
			this.set(prompt.page, field, choice);
		} else this.set(prompt.page, field, text);
		return this.page(prompt.page);
	}
}
