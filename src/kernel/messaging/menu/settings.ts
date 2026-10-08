import type { JsonObject, ModelRef, ToolExecutionResult } from "@earendil-works/pi-durable";
import { join } from "node:path";
import type { Change } from "../../changes.ts";
import type { KernelContext, MessagingContext } from "../../contracts.ts";
import { discoverExtensions } from "../../loader.ts";
import { getPath, type Settings } from "../../settings.ts";
import { ago, type Button, type Nav, type Page } from "./nav.ts";

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
const NOT_UNDONE = "Not undone: ";

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
        [nav.button("Recent changes", recent)],
      ],
      outcome,
    });

  // Each role's model; an unset Worker or Consolidation uses the CoS's.
  const models: Page = async (outcome) => {
    const refs = (await current()).models;
    const value = (role: Role) => refText(refs[role]) ?? (role === "cos" ? "not set" : "same as CoS");
    return nav.paged({
      title: "Models",
      body: ROLES.map(([label, role]) => `${label}: ${value(role)}`).join("\n"),
      items: ROLES.map(([label, role]) => [label, providers(role)] as const),
      back: home,
      home,
      outcome,
    });
  };
  // The providers with credentials and at least one model.
  const providers = (role: Role): Page => async (outcome) => {
    const list = kernel.models.getProviders().filter((p) => kernel.models.getModels(p.id).length > 0);
    const auth = await Promise.all(list.map((p) => kernel.models.checkAuth(p.id).catch(() => undefined)));
    const items: (readonly [string, Page] | Button)[] = list
      .filter((_, i) => auth[i] !== undefined)
      .map((p) => [p.id, modelsOf(role, p.id)] as const);
    const useCos = () => messaging.setSetting(`models.${role}`, undefined);
    if (role !== "cos") items.unshift(nav.act("Use CoS model", useCos, models));
    return nav.paged({ title: "Choose a provider", items, back: models, home, outcome });
  };
  const modelsOf = (role: Role, provider: string): Page => async (outcome) => {
    const now = (await current()).models[role];
    const set = (modelId: string) => () => messaging.setSetting(`models.${role}`, { provider, modelId });
    const items = kernel.models.getModels(provider).map((m) => {
      const tick = now?.provider === provider && now.modelId === m.id ? "✓ " : "";
      return nav.act(`${tick}${m.id}`, set(m.id), models);
    });
    return nav.paged({ title: "Choose a model", items, back: providers(role), home, outcome });
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

  const recent: Page = async (outcome) => {
    const changes = (await messaging.changes()).slice(0, RECENT);
    const now = Date.now();
    const items = changes.map((c) => [`${c.id} ${c.title} · ${ago(now - c.at)}`, change(c)] as const);
    const body = changes.length === 0 ? "No changes yet." : undefined;
    return nav.paged({ title: "Recent changes", body, items, back: home, home, outcome });
  };
  const change = (c: Change): Page => async (outcome) => {
    const when = new Date(c.at).toLocaleString();
    const body = [`${c.title}\n${when}`, c.howToUse].filter((p) => p !== "").join("\n\n");
    const confirm = nav.confirm(`Undo "${c.title}"?`, "Undo", undo(c), recent, change(c));
    const rows = [[nav.button("Undo", confirm)]];
    return nav.screen({ title: `Change ${c.id}`, body, rows, back: recent, home, outcome });
  };
  // As `change_undo`, or, for a change undone by a tool call (as schedules are), that call.
  const undo = (c: Change) => async () => {
    const by = c.undo.call;
    const reply = by === undefined ? await call("change_undo", { id: c.id }) : await call(by.tool, by.args);
    if (reply.startsWith(NOT_UNDONE)) throw new Error(reply.slice(NOT_UNDONE.length));
    if (reply === `No change ${c.id}.`) throw new Error(`Change ${c.id} is gone.`);
    return reply;
  };

  const schedules: Page = async (outcome) => {
    const list = ((await messaging.tool("schedule_list", {}))?.details ?? []) as { id: string; label: string }[];
    const remove = (id: string) => async () => textOf(await messaging.tool("schedule_remove", { id }));
    const items = list.map(({ id, label }) => {
      const page = nav.confirm(`Remove schedule "${label}"?`, "Remove", remove(id), schedules, schedules);
      return [label, page] as const;
    });
    const body = list.length === 0 ? "No schedules." : undefined;
    return nav.paged({ title: "Schedules", body, items, back: home, home, outcome });
  };

  // The loaded extensions and the workspace ones, which may have failed to load.
  const extensions: Page = async (outcome) => {
    const { extensions: loaded, errors } = kernel.surface.status();
    const workspace = discoverExtensions([join(kernel.home, "extensions")]).map((f) => f.name);
    const names = [...new Set([...loaded.map((e) => e.name), ...workspace])];
    const items = names.map((name) => {
      const error = errors.find((e) => e.name === name)?.error;
      const summary = loaded.find((e) => e.name === name)?.summary ?? "not loaded";
      const text = `${name}: ${summary}${error === undefined ? "" : `\nError: ${error}`}`;
      const rollback = () => messaging.rollback(name);
      const page = nav.confirm(text, "Roll back to last known good", rollback, extensions, extensions);
      return [`${name} (${error === undefined ? "ok" : "error"})`, page] as const;
    });
    return nav.paged({ title: "Extensions", items, back: home, home, outcome });
  };

  return home;
}
