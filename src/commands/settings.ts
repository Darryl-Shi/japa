// /settings as a menu of cards, independent of the channel that shows it: the general settings, and a page for every
// extension: its switch, and its own settings (the flags it registered, pi's registerFlag), each a switch or a value
// the user sends. Values go to settings.json; keys never do (they're logins, in /login). The allowlist is deliberately
// not here. The model slots
// (the chief of staff's, the jobs') have a page of their own, also opened by pi's /model, and their thinking levels
// another, opened by pi's /thinking. Models are picked from the ones pi can actually use (providers with
// credentials), a page at a time, rather than by typing an id; thinking levels from the ones the model supports.
import type { Button, Card, CardRef, UI } from "../core/ui.ts";
import type { ExtensionSet } from "../pi/extension.ts";
import type { ModelChoice, SettingsFile } from "../settings.ts";

export type View = { text: string; buttons: Button[][] };
/** A model pi can use now: its provider has credentials. `vision`: it takes images. */
export type AvailableModel = { provider: string; id: string; name?: string; vision?: boolean };
/** One setting: the core's, or (on an extension's page) one of the extension's flags. */
type Field = { key: string; label: string; kind: "text" | "number" | "model" | "switch"; default?: unknown };

/** A field waiting for a typed value. */
export type Prompt = { page: string; field: number; label: string };

const GENERAL: readonly Field[] = [
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

/** A page, saying so if a change on it couldn't be applied (it's saved; it applies once the problem is fixed). */
const noted = (view: View, problem: string | undefined): View => (problem === undefined ? view : { ...view, text: `Saved, but it couldn't be applied: ${problem}\n\n${view.text}` });

export class SettingsMenu {
	private readonly settings: SettingsFile;
	private readonly extensions: ExtensionSet;
	private readonly modelExists: (choice: ModelChoice) => boolean;
	private readonly available: () => Promise<readonly AvailableModel[]>;
	private readonly changed: () => Promise<void>;
	private readonly thinkingLevels: (choice: ModelChoice) => readonly string[];

	constructor(options: {
		settings: SettingsFile;
		extensions: ExtensionSet;
		modelExists?: (choice: ModelChoice) => boolean;
		/** The models to offer in a model field. */
		available?: () => Promise<readonly AvailableModel[]>;
		/** After any change: apply it (extensions started or stopped, the model switched). */
		changed?: () => Promise<void>;
		/** The thinking levels a model supports. */
		thinkingLevels?: (choice: ModelChoice) => readonly string[];
	}) {
		this.thinkingLevels = options.thinkingLevels ?? (() => ["off"]);
		this.settings = options.settings;
		this.extensions = options.extensions;
		this.modelExists = options.modelExists ?? (() => true);
		this.available = options.available ?? (async () => []);
		this.changed = options.changed ?? (async () => {});
	}

	/** Show it through the UI: /settings opens it, its buttons and replies come back here. */
	attach(ui: UI): void {
		ui.command("settings", "Models, and the extensions: which are on, and their settings", async (at) => void (await ui.show({ ...this.main(), replyTo: at })));
		ui.command("model", "The models it and its jobs use", async (at) => void (await ui.show({ ...this.page("models"), replyTo: at })));
		ui.command("thinking", "How hard each model thinks", async (at) => void (await ui.show({ ...this.page("thinking"), replyTo: at })));
		ui.handle("settings", {
			press: async (payload, ref) => {
				const before = JSON.stringify(this.settings.get());
				const next = await this.press(payload);
				// Only a change is applied; a page turn just shows the next page.
				const problem = JSON.stringify(this.settings.get()) === before ? undefined : await this.apply();
				if ("buttons" in next) return void (await ui.show(noted(next, problem), ref));
				await ui.show({ ...this.ask(next, ref), replyTo: ref });
			},
			// A typed value: the card that asked says it's saved, and the menu it came from shows it, in place.
			reply: async (payload, text, ref, asked) => {
				const [page = "", at = "", chatId, messageId] = payload.split(":");
				const field = this.fields(page)[Number(at)];
				if (field === undefined) return;
				const menu = chatId === undefined || messageId === undefined ? undefined : { channel: ref.channel, chatId: decodeURIComponent(chatId), messageId: decodeURIComponent(messageId) };
				const prompt: Prompt = { page, field: Number(at), label: field.label };
				const result = this.answer(prompt, text);
				if ("error" in result) return void (await ui.show({ ...this.ask(prompt, menu, result.error), replyTo: ref }));
				const problem = await this.apply();
				await ui.show({ text: `${field.label}: ${text.trim() === "-" ? "cleared" : "saved"}.` }, asked);
				await ui.show(menu === undefined ? { ...noted(result, problem), replyTo: ref } : noted(result, problem), menu);
			},
		});
	}

	/** The card asking for a field's value by reply; it carries the menu card it came from, to update once answered. */
	private ask(prompt: Prompt, menu: CardRef | undefined, error?: string): Card {
		const from = menu === undefined ? "" : `:${encodeURIComponent(menu.chatId)}:${encodeURIComponent(menu.messageId)}`;
		return {
			text: `${error === undefined ? "" : `${error} `}Send the new value for "${prompt.label}" as a reply to this message ("-" to clear).`,
			ask: { data: `settings:${prompt.page}:${prompt.field}${from}`, placeholder: prompt.label },
		};
	}

	/** Apply a change; what went wrong, if anything, for the card to say. */
	private async apply(): Promise<string | undefined> {
		try {
			await this.changed();
			return undefined;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	/**
	 * The model slots: the chief of staff's, the jobs' default, and each named job model (`fast` always, since reviews
	 * and summaries use it).
	 */
	private slots(): Field[] {
		const named = [...new Set(["fast", ...Object.keys(this.settings.get().jobModels)])];
		return [
			{ key: "model", label: "Chief of staff", kind: "model" },
			{ key: "delegateModel", label: "Jobs (blank: the chief of staff's)", kind: "model" },
			...named.map((name): Field => ({ key: `jobModels.${name}`, label: name === "fast" ? "Fast (approvals, summaries)" : `Jobs asking for "${name}"`, kind: "model" })),
		];
	}

	/** An extension's page is "@<its name>". */
	private extensionOf(page: string) {
		return page.startsWith("@") ? this.extensions.get(page.slice(1)) : undefined;
	}

	private fields(page: string): readonly Field[] {
		if (page === "general") return GENERAL;
		if (page === "models" || page === "thinking") return this.slots();
		const entry = this.extensionOf(page);
		if (entry === undefined) return [];
		return [...entry.flags].map(([name, flag]): Field => ({ key: name, label: flag.description ?? name, kind: flag.type === "boolean" ? "switch" : "text", ...(flag.default === undefined ? {} : { default: flag.default }) }));
	}

	private get(page: string, field: Field): unknown {
		const entry = this.extensionOf(page);
		if (entry !== undefined) return this.settings.get().extensions[entry.name]?.[field.key] ?? field.default;
		return field.key.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], this.settings.get());
	}

	private set(page: string, field: Field, value: unknown): void {
		const entry = this.extensionOf(page);
		if (entry !== undefined) return this.settings.setOption(entry.name, field.key, value);
		const [head, tail] = field.key.split(".") as [string, string | undefined];
		const current = this.settings.get() as unknown as Record<string, unknown>;
		const next = tail === undefined ? value : { ...(current[head] as Record<string, unknown> | undefined), [tail]: value };
		this.settings.update({ [head]: next });
	}

	main(): View {
		const rows: Button[][] = [[{ text: "General", data: "settings:p:general" }]];
		for (const entry of this.extensions.entries) {
			const failed = this.extensions.enabled(entry) && this.extensions.failure(entry.name) !== undefined;
			rows.push([{ text: `${this.extensions.enabled(entry) ? (failed ? "⚠️" : "✅") : "⬜"} ${entry.name}`, data: `settings:p:@${entry.name}` }]);
		}
		return { text: "Settings. Tap an extension for its switch and its settings.", buttons: rows };
	}

	/** An extension's page: its switch, its settings, and what it offers. */
	private extensionPage(name: string): View {
		const entry = this.extensions.get(name);
		if (entry === undefined) return this.main();
		const on = this.extensions.enabled(entry);
		const failure = on ? this.extensions.failure(name) : undefined;
		const commands = [...entry.registered.commands.keys()].map((command) => `/${command}`);
		const rows: Button[][] = [[{ text: on ? "✅ On (tap to turn off)" : "⬜ Off (tap to turn on)", data: `settings:t:${name}` }]];
		this.fields(`@${name}`).forEach((field, index) => {
			const value = this.get(`@${name}`, field);
			rows.push([{ text: field.kind === "switch" ? `${value === true ? "✅" : "⬜"} ${field.label}` : `${field.label}: ${show(value)}`, data: `settings:f:@${name}:${index}` }]);
		});
		rows.push([{ text: "« Back", data: "settings:m" }]);
		const text = [name, ...(failure === undefined ? [] : [`⚠️ It isn't working: ${failure}`]), ...(commands.length === 0 ? [] : [`Its commands: ${commands.join(" ")}`])].join("\n");
		return { text, buttons: rows };
	}

	/** Each model slot and its thinking level; a slot opens the levels its model supports. */
	private thinking(): View {
		const rows: Button[][] = this.slots().flatMap((field, index) => {
			const choice = this.get("thinking", field) as ModelChoice | undefined;
			return choice === undefined ? [] : [[{ text: `${field.label}: ${choice.thinking ?? "off"}`, data: `settings:th:thinking:${index}` }]];
		});
		rows.push([{ text: "« Back", data: "settings:p:general" }]);
		return { text: "Thinking: how hard each model thinks before it answers. More is slower and costs more.", buttons: rows };
	}

	private levels(at: number): View {
		const field = this.slots()[at];
		const choice = field === undefined ? undefined : (this.get("thinking", field) as ModelChoice | undefined);
		if (field === undefined || choice === undefined) return this.thinking();
		const current = choice.thinking ?? "off";
		return {
			text: `${field.label} (${show(choice)}): how hard it thinks.`,
			buttons: [
				...this.thinkingLevels(choice).map((level) => [{ text: `${level === current ? "✅ " : ""}${level}`, data: `settings:tl:thinking:${at}:${level}` }]),
				[{ text: "« Back", data: "settings:p:thinking" }],
			],
		};
	}

	page(name: string): View {
		if (name === "thinking") return this.thinking();
		if (name.startsWith("@")) return this.extensionPage(name.slice(1));
		const title = name === "general" ? "General" : name === "models" ? "Models" : name;
		const rows: Button[][] = name === "general" ? [[{ text: "Models ▸", data: "settings:p:models" }], [{ text: "Thinking ▸", data: "settings:p:thinking" }]] : [];
		this.fields(name).forEach((field, index) => {
			const value = this.get(name, field);
			rows.push([{ text: `${field.label}: ${show(value)}`, data: `settings:f:${name}:${index}` }]);
		});
		rows.push([{ text: "« Back", data: name === "models" ? "settings:p:general" : "settings:m" }]);
		return { text: title, buttons: rows };
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
			const refusal = this.extensions.enabled(entry) ? this.extensions.cannotTurnOff(entry) : undefined;
			if (refusal !== undefined) {
				const page = this.extensionPage(name);
				return { ...page, text: `${refusal}\n\n${page.text}` };
			}
			this.settings.setOption(name, "enabled", !this.extensions.enabled(entry));
			return this.extensionPage(name);
		}
		if (action === "th") return this.levels(Number(a));
		const field = this.fields(name)[Number(a)];
		if (field === undefined) return this.page(name);
		if (action === "tl") {
			const choice = this.get(name, field) as ModelChoice | undefined;
			if (choice !== undefined && b !== undefined) this.set(name, field, b === "off" ? { provider: choice.provider, modelId: choice.modelId } : { ...choice, thinking: b });
			return this.thinking();
		}
		if (action === "mp") return this.picker(name, Number(a), b === undefined ? undefined : Number(b), Number(c ?? 0));
		if (action === "ms") {
			const group = (await this.providers())[Number(b)];
			const model = group?.models[Number(c)];
			if (model === undefined) return this.picker(name, Number(a));
			// A new model keeps the slot's thinking level (pi clamps it to what the model supports).
			const thinking = (this.get(name, field) as ModelChoice | undefined)?.thinking;
			this.set(name, field, { provider: model.provider, modelId: model.id, ...(thinking === undefined ? {} : { thinking }) });
			return this.page(name);
		}
		if (action === "k") return { page: name, field: Number(a), label: field.label };
		if (field.kind === "model") return this.picker(name, Number(a));
		if (field.kind === "switch") {
			this.set(name, field, this.get(name, field) !== true);
			return this.page(name);
		}
		return { page: name, field: Number(a), label: field.label };
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
			const thinking = (this.get(prompt.page, field) as ModelChoice | undefined)?.thinking;
			this.set(prompt.page, field, { ...choice, ...(thinking === undefined ? {} : { thinking }) });
		} else this.set(prompt.page, field, text);
		return this.page(prompt.page);
	}
}
