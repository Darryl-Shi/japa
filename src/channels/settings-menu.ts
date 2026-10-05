// /settings as a menu of cards, independent of the channel that shows it. The first page has the general settings
// and every extension with its switch; each extension's page is built from the fields it declares, so an extension
// adds its own settings just by listing them. Values go to settings.json, secrets to data/secrets.json. The allowlist
// is deliberately not here. Model fields pick from the models pi can actually use (providers with credentials), a
// page at a time, rather than asking for an id.
import type { Button, CardRef, UI } from "../core/ui.ts";
import type { SecretsFile } from "../credentials.ts";
import type { ExtensionSet, Field } from "../pi/extension.ts";
import type { ModelChoice, SettingsFile } from "../settings.ts";

export type View = { text: string; buttons: Button[][] };
/** A model pi can use now: its provider has credentials. `vision`: it takes images. */
export type AvailableModel = { provider: string; id: string; name?: string; vision?: boolean };
/** A field waiting for a typed value. */
export type Prompt = { page: string; field: number; label: string; secret: boolean };

const GENERAL: readonly Field[] = [
	{ key: "model", label: "Chief of staff model", kind: "model" },
	{ key: "delegateModel", label: "Default job model", kind: "model" },
	{ key: "jobModels.fast", label: "Fast model (approvals, summaries)", kind: "model" },
	{ key: "user.name", label: "Your name", kind: "text" },
	{ key: "timezone", label: "Time zone", kind: "text" },
	{ key: "context.idleMinutes", label: "New slice after idle (minutes)", kind: "number" },
];

/** Models per page of the picker: one button each, so a page fits a phone screen. */
const PER_PAGE = 8;

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
	private readonly available: () => Promise<readonly AvailableModel[]>;
	private readonly changed: () => Promise<void>;

	constructor(options: {
		settings: SettingsFile;
		secrets: SecretsFile;
		extensions: ExtensionSet;
		modelExists?: (choice: ModelChoice) => boolean;
		/** The models to offer in a model field. */
		available?: () => Promise<readonly AvailableModel[]>;
		/** After any change: apply it (extensions started or stopped, the model switched). */
		changed?: () => Promise<void>;
	}) {
		this.settings = options.settings;
		this.secrets = options.secrets;
		this.extensions = options.extensions;
		this.modelExists = options.modelExists ?? (() => true);
		this.available = options.available ?? (async () => []);
		this.changed = options.changed ?? (async () => {});
	}

	/** Show it through the UI: /settings opens it, its buttons and replies come back here. */
	attach(ui: UI): void {
		ui.command("settings", "Models, extensions and their options", async (at) => void (await ui.show({ ...this.main(), replyTo: at })));
		ui.handle("settings", {
			press: async (payload, ref) => {
				const next = await this.press(payload);
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

	/** The available models, grouped by provider in pi's order. */
	private async providers(): Promise<Array<{ provider: string; models: AvailableModel[] }>> {
		const groups = new Map<string, AvailableModel[]>();
		for (const model of await this.available()) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
		return [...groups].map(([provider, models]) => ({ provider, models }));
	}

	/**
	 * Choosing a model for a field: its providers, or (with one provider, or once one is chosen) a page of its models.
	 * Buttons carry indexes, not ids, since model ids can outgrow a button's data.
	 */
	private async picker(page: string, at: number, provider?: number, from = 0): Promise<View> {
		const field = this.fields(page)[at]!;
		const current = this.get(page, field) as ModelChoice | undefined;
		const groups = await this.providers();
		const back: Button[] = [{ text: "⌨ Type an id", data: `settings:k:${page}:${at}` }, { text: "« Back", data: `settings:p:${page}` }];
		if (groups.length === 0) return { text: `${field.label}\n\nNo model provider has credentials yet.`, buttons: [back] };
		if (provider === undefined && groups.length > 1) {
			return {
				text: `${field.label}: ${show(current)}\n\nChoose a provider.`,
				buttons: [...groups.map((group, index) => [{ text: `${group.provider === current?.provider ? "✅ " : ""}${group.provider} (${group.models.length})`, data: `settings:mp:${page}:${at}:${index}:0` }]), back],
			};
		}
		const index = provider ?? 0;
		const group = groups[index] ?? groups[0]!;
		const start = Math.max(0, Math.min(from, group.models.length - 1));
		const rows: Button[][] = group.models.slice(start, start + PER_PAGE).map((model, offset) => [
			{
				text: `${model.provider === current?.provider && model.id === current.modelId ? "✅ " : ""}${model.name ?? model.id}${model.vision === true ? " 👁" : ""}`,
				data: `settings:ms:${page}:${at}:${index}:${start + offset}`,
			},
		]);
		const nav: Button[] = [];
		if (start > 0) nav.push({ text: "◀", data: `settings:mp:${page}:${at}:${index}:${Math.max(0, start - PER_PAGE)}` });
		if (start + PER_PAGE < group.models.length) nav.push({ text: "▶", data: `settings:mp:${page}:${at}:${index}:${start + PER_PAGE}` });
		if (nav.length > 0) rows.push(nav);
		if (groups.length > 1) rows.push([{ text: "« Providers", data: `settings:mp:${page}:${at}` }]);
		rows.push(back);
		const pages = Math.ceil(group.models.length / PER_PAGE);
		return { text: `${field.label}: ${show(current)}\n\n${group.provider}${pages > 1 ? `, page ${Math.floor(start / PER_PAGE) + 1} of ${pages}` : ""}. 👁 takes images.`, buttons: rows };
	}

	/** A button press (its data after "settings:"): the view to show next, or a field that needs a typed value. */
	async press(payload: string): Promise<View | Prompt> {
		const [action, name = "", a, b, c] = payload.split(":");
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
		if (action === "mp") return this.picker(name, Number(a), b === undefined ? undefined : Number(b), Number(c ?? 0));
		if (action === "ms") {
			const group = (await this.providers())[Number(b)];
			const model = group?.models[Number(c)];
			if (model === undefined) return this.picker(name, Number(a));
			this.set(name, field, { provider: model.provider, modelId: model.id });
			return this.page(name);
		}
		if (action === "k") return { page: name, field: Number(a), label: field.label, secret: false };
		if (field.kind === "model") return this.picker(name, Number(a));
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
