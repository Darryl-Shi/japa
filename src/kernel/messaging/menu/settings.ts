import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { join } from "node:path";
import type { KernelContext, MessagingContext } from "../../contracts.ts";
import { discoverExtensions } from "../../loader.ts";
import type { Nav, Page } from "./nav.ts";

const ROLES = [
  ["CoS", "cos"],
  ["Worker", "worker"],
  ["Consolidation", "consolidation"],
] as const;

const textOf = (result: ToolExecutionResult | undefined) => (result!.content![0] as { text: string }).text;

/** The /settings menu: its home, Settings, leading to Models, Schedules and Extensions. */
export function settingsMenu(nav: Nav, kernel: KernelContext, messaging: MessagingContext): Page {
  const home: Page = async (outcome) =>
    nav.screen({
      title: "Settings",
      rows: [
        [nav.button("Models", models)],
        [nav.button("Schedules", schedules)],
        [nav.button("Extensions", extensions)],
      ],
      outcome,
    });

  const models: Page = async (outcome) =>
    nav.paged({
      title: "Models",
      body: "Which model?",
      items: ROLES.map(([label, role]) => [label, providers(role)] as const),
      back: home,
      home,
      outcome,
    });
  const providers = (role: string): Page => async (outcome) => {
    const list = kernel.models.getProviders().filter((p) => kernel.models.getModels(p.id).length > 0);
    const items = list.map((p) => [p.id, modelsOf(role, p.id)] as const);
    return nav.paged({ title: "Choose a provider", items, back: models, home, outcome });
  };
  const modelsOf = (role: string, provider: string): Page => async (outcome) => {
    const set = (modelId: string) => () => messaging.setSetting(`models.${role}`, { provider, modelId });
    const items = kernel.models.getModels(provider).map((m) => nav.act(m.id, set(m.id), models));
    return nav.paged({ title: "Choose a model", items, back: providers(role), home, outcome });
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
