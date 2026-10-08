import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Incoming, KernelContext, MessagingAdapter, MessagingContext, OutgoingMessage } from "../contracts.ts";
import { recent, reportText, type Job } from "../jobs/state.ts";
import { discoverExtensions, message } from "../loader.ts";
import { statusText } from "../status.ts";

export const COMMANDS = [
  { name: "jobs", description: "Running and recent jobs" },
  { name: "status", description: "Model, extensions and errors" },
  { name: "settings", description: "Models, schedules and extensions" },
];

export const HELP = `Commands:\n${COMMANDS.map((c) => `/${c.name} — ${c.description}`).join("\n")}`;

/** Buttons per page of a list. */
const PAGE = 8;
const ROLES = [
  ["CoS", "cos"],
  ["Worker", "worker"],
  ["Consolidation", "consolidation"],
] as const;

type View = () => Promise<OutgoingMessage>;

const textOf = (result: ToolExecutionResult | undefined) => (result!.content![0] as { text: string }).text;

/**
 * Answers the owner's commands, and their presses of the buttons it sends: each button's action is a short id mapped,
 * in memory, to the view it edits its message to. Ids carry a per-run token so buttons from before a restart expire.
 */
export function createMenu(
  adapter: MessagingAdapter,
  kernel: KernelContext,
  messaging: MessagingContext,
  jobs: () => Job[],
) {
  const run = randomUUID().slice(0, 8);
  let next = 0;
  const views = new Map<string, View>();
  const button = (label: string, view: View) => {
    const action = `${run}:${++next}`;
    views.set(action, view);
    return { label, action };
  };
  /** One button per item, `PAGE` to a page, with a last row of `‹` / `›` as needed. */
  const paged = (markdown: string, items: [string, View][], page = 0): OutgoingMessage => {
    const buttons = items.slice(page * PAGE, (page + 1) * PAGE).map(([label, view]) => [button(label, view)]);
    const nav = [];
    if (page > 0) nav.push(button("‹", async () => paged(markdown, items, page - 1)));
    if ((page + 1) * PAGE < items.length) nav.push(button("›", async () => paged(markdown, items, page + 1)));
    return { markdown, buttons: nav.length > 0 ? [...buttons, nav] : buttons };
  };
  const done = (act: () => Promise<string>): View => async () => ({ markdown: await act() });
  const confirm = (markdown: string, yes: string, act: () => Promise<string>) =>
    paged(markdown, [
      [yes, done(act)],
      ["Cancel", done(async () => "Cancelled.")],
    ]);

  const jobsView: View = async () => {
    const list = recent(jobs());
    if (list.length === 0) return { markdown: "No running or recent jobs." };
    const report = (id: string) => async () => {
      const job = jobs().find((j) => j.id === id)!;
      return { markdown: reportText(job, job.result ?? job.progress ?? "") };
    };
    const buttons = list.map((j) => [button(`${j.id}. ${j.title} (${j.status})`, report(j.id))]);
    return { markdown: "Running and recent jobs:", buttons };
  };
  const statusView: View = async () => ({ markdown: statusText(kernel.surface.status()) });

  const modelsView = (role: string, provider: string): View => async () => {
    const set = (modelId: string) => done(() => messaging.setSetting(`models.${role}`, { provider, modelId }));
    return paged("Choose a model", kernel.models.getModels(provider).map((m) => [m.id, set(m.id)]));
  };
  const providersView = (role: string): View => async () => {
    const providers = kernel.models.getProviders().filter((p) => kernel.models.getModels(p.id).length > 0);
    return paged("Choose a provider", providers.map((p) => [p.id, modelsView(role, p.id)]));
  };
  const rolesView: View = async () => paged("Which model?", ROLES.map(([label, role]) => [label, providersView(role)]));

  const schedulesView: View = async () => {
    const schedules = ((await messaging.tool("schedule_list", {}))?.details ?? []) as { id: string; label: string }[];
    if (schedules.length === 0) return { markdown: "No schedules." };
    const remove = (id: string) => async () => textOf(await messaging.tool("schedule_remove", { id }));
    const items = schedules.map(({ id, label }): [string, View] => [
      label,
      async () => confirm(`Remove schedule "${label}"?`, "Remove", remove(id)),
    ]);
    return paged("Active schedules:", items);
  };

  // The loaded extensions and the workspace ones, which may have failed to load.
  const extensionsView: View = async () => {
    const { extensions, errors } = kernel.surface.status();
    const workspace = discoverExtensions([join(kernel.home, "extensions")]).map((f) => f.name);
    const names = [...new Set([...extensions.map((e) => e.name), ...workspace])];
    const items = names.map((name): [string, View] => {
      const error = errors.find((e) => e.name === name)?.error;
      const summary = extensions.find((e) => e.name === name)?.summary ?? "not loaded";
      const text = `${name}: ${summary}${error === undefined ? "" : `\nError: ${error}`}`;
      const view = async () => confirm(text, "Roll back to last known good", () => messaging.rollback(name));
      return [`${name} (${error === undefined ? "ok" : "error"})`, view];
    });
    return paged("Extensions:", items);
  };

  const settingsView: View = async () =>
    paged("Settings", [
      ["Models", rolesView],
      ["Schedules", schedulesView],
      ["Extensions", extensionsView],
    ]);

  const commands = new Map([
    ["jobs", jobsView],
    ["status", statusView],
    ["settings", settingsView],
  ]);
  return {
    async command(m: Incoming) {
      const view = commands.get(m.command!);
      await adapter.send(m.chat, view ? await view() : { markdown: HELP });
    },
    async press(m: Incoming) {
      const view = views.get(m.action!);
      const expired = { markdown: "This menu expired — send /settings again." };
      const shown = view ? await view().catch((error) => ({ markdown: `Not changed: ${message(error)}` })) : expired;
      await adapter.edit(m.chat, m.messageId, shown);
    },
  };
}
