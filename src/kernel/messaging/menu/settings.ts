import type { JsonObject, ModelRef, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Change } from "../../changes.ts";
import type { KernelContext, MessagingContext } from "../../contracts.ts";
import { DEFAULT_SETTINGS, getPath, type Settings, THINKING_LEVELS } from "../../settings.ts";
import { extensionsMenu } from "./extensions.ts";
import { ago, type Button, type Nav, PAGE, type Page } from "./nav.ts";
import { schedulesMenu } from "./schedules.ts";

const ROLES = [
  ["CoS", "cos"],
  ["Worker", "worker"],
  ["Consolidation", "consolidation"],
] as const;
type Role = (typeof ROLES)[number][1];

/** The General screen's settings: label, path. */
const GENERAL = [
  ["Max concurrent jobs", "jobs.maxConcurrent"],
  ["Keep finished jobs (days)", "jobs.keepFinishedDays"],
  ["Memory: max facts", "memory.maxFacts"],
  ["Memory: max tokens", "memory.maxTokens"],
  ["Tool errors before rollback", "safety.toolErrorThreshold"],
  ["Minutes until marked good", "safety.goodAfterMinutes"],
  ["Tool result tokens", "context.toolResultTokens"],
] as const;

/** Changes listed under Recent changes. */
const RECENT = 10;

const textOf = (result: ToolExecutionResult | undefined) => (result!.content![0] as { text: string }).text;
const refText = (ref: ModelRef | undefined) => (ref === undefined ? undefined : `${ref.provider}/${ref.modelId}`);

/** The /settings menu: its home, Settings, leading to Models, Extensions, Schedules, General and Recent changes. */
export function settingsMenu(nav: Nav, kernel: KernelContext, messaging: MessagingContext): Page {
  /** The text reply of tool `name`; throws when there is no such tool. */
  const call = async (name: string, args: JsonObject = {}) => {
    const result = await messaging.tool(name, args);
    if (result === undefined) throw new Error(`No tool ${name}.`);
    return textOf(result);
  };
  /** The live settings, as `settings_get` shows them. */
  const current = async () => JSON.parse(await call("settings_get")) as Settings;

  const home: Page = async (outcome) =>
    nav.screen({
      title: "Settings",
      rows: [
        [nav.button("Models", models)],
        [nav.button("Extensions", extensions)],
        [nav.button("Schedules", schedules)],
        [nav.button("General", general)],
        [nav.button("Recent changes", recent(0))],
      ],
      outcome,
    });

  const extensions = extensionsMenu(nav, messaging, home);
  const schedules = schedulesMenu(nav, messaging, home);

  /** `jobs.thinking`: the thinking level of a job started without one. */
  const jobThinking = async () => (await current()).jobs?.thinking ?? DEFAULT_SETTINGS.jobs.thinking;

  // Each role's model, an unset Worker or Consolidation using the CoS's; then the jobs' thinking level.
  const models: Page = async (outcome) => {
    const refs = (await current()).models;
    const value = (role: Role) => refText(refs[role]) ?? (role === "cos" ? "not set" : "same as CoS");
    const lines = ROLES.map(([label, role]) => `${label}: ${value(role)}`);
    return nav.paged({
      title: "Models",
      body: [...lines, `Job thinking: ${await jobThinking()}`].join("\n"),
      items: [...ROLES.map(([label, role]) => [label, providers(role)] as const), ["Job thinking", thinking] as const],
      back: home,
      home,
      outcome,
    });
  };
  // The thinking levels, the current one ticked.
  const thinking: Page = async (outcome) => {
    const now = await jobThinking();
    const items = THINKING_LEVELS.map((level) => {
      const set = () => messaging.setSetting("jobs.thinking", level);
      return [`${level === now ? "✓ " : ""}${level}`, nav.perform(set, models)] as const;
    });
    return nav.paged({ title: "Job thinking", items, back: models, home, outcome });
  };
  // The providers with credentials and at least one model.
  const providers = (role: Role): Page => async (outcome) => {
    const list = kernel.models.getProviders().filter((p) => kernel.models.getModels(p.id).length > 0);
    const auth = await Promise.all(list.map((p) => kernel.models.checkAuth(p.id).catch(() => undefined)));
    const items: (readonly [string, Page] | Button)[] = list
      .filter((_, i) => auth[i] !== undefined)
      .map((p) => [p.id, modelsOf(role, p.id, 0)] as const);
    const useCos = () => messaging.setSetting(`models.${role}`, undefined);
    if (role !== "cos") items.unshift(nav.act("Use CoS model", useCos, models));
    return nav.paged({ title: "Choose a provider", items, back: models, home, outcome });
  };
  // Page `page` of `provider`'s models, built afresh each time it is shown; only its own buttons are made, as a
  // provider can have more models than buttons are kept.
  const modelsOf = (role: Role, provider: string, page: number): Page => async (outcome) => {
    const now = (await current()).models[role];
    const set = (modelId: string) => () => messaging.setSetting(`models.${role}`, { provider, modelId });
    const items = kernel.models.getModels(provider).map((m) => {
      const tick = now?.provider === provider && now.modelId === m.id ? "✓ " : "";
      return [`${tick}${m.id}`, nav.perform(set(m.id), models)] as const;
    });
    const render = (p: number) => modelsOf(role, provider, p);
    return nav.paged({ title: "Choose a model", items, page, render, back: providers(role), home, outcome });
  };

  // A button per setting, asking for its new value as typed text, which the settings validator converts.
  const general: Page = async (outcome) => {
    const settings = await current();
    const rows = GENERAL.map(([label, path]) => {
      const apply = (text: string) => messaging.setSetting(path, text);
      const ask = nav.ask({ title: label, apply, then: general, cancel: general });
      return [nav.button(`${label}: ${String(getPath(settings, path) ?? "not set")}`, ask)];
    });
    return nav.screen({ title: "General", rows, back: home, home, outcome });
  };

  // Page `page` of the newest changes, built afresh each time it is shown.
  const recent = (page: number): Page => async (outcome) => {
    const changes = (await messaging.changes()).slice(0, RECENT);
    const now = Date.now();
    const items = changes.map(
      (c, i) => [`${c.id} ${c.title} · ${ago(now - c.at)}`, change(c, Math.floor(i / PAGE))] as const,
    );
    const body = changes.length === 0 ? "No changes yet." : undefined;
    return nav.paged({ title: "Recent changes", body, items, page, render: recent, back: home, home, outcome });
  };
  // A change listed on page `page`, which Back returns to.
  const change = (c: Change, page: number): Page => async (outcome) => {
    const back = recent(page);
    const when = new Date(c.at).toLocaleString();
    const body = [`${c.title}\n${when}`, c.howToUse].filter((p) => p !== "").join("\n\n");
    const confirm = nav.confirm(`Undo "${c.title}"?`, "Undo", () => messaging.undoChange(c.id), back, change(c, page));
    const rows = [[nav.button("Undo", confirm)]];
    return nav.screen({ title: `Change ${c.id}`, body, rows, back, home, outcome });
  };

  return home;
}
