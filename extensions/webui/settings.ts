// The Settings bridge: the web UI's view of the kernel's `AdminContext` (the same code paths as Telegram's menus), and
// the sign-in flows run through it.
import { join } from "node:path";
import { type AdminContext, type ExtensionInfo, liveness, type SurfaceContext } from "japa/sdk";
import type {
  ChangeView,
  ExtensionView,
  Json,
  ScheduleView,
  SettingsBridge,
  UpdateView,
} from "./app/src/lib/protocol.ts";
import { createFlows, type Flows } from "./flows.ts";

/** The chat an update started from the web UI is asked in. */
export const WEB_CHAT = { adapter: "webui", chat: "web" } as const;
const ACTIVE = ["queued", "running", "needs_input"];
const CHANGES = 10;

export type SettingsOptions = {
  /** How many jobs are active (queued, running or waiting for input); default: read once through `ctx.jobs`. */
  activeJobs?(): number | Promise<number>;
  now?(): number;
  /** The flows' idle timeout and how long a finished one is kept (tests). */
  flowIdleMs?: number;
  flowKeepMs?: number;
};

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** `ms` as a rough duration: `45s`, `12m`, `3h`. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function extensionView(e: ExtensionInfo): ExtensionView {
  return {
    name: e.name,
    ...(e.summary !== undefined && { summary: e.summary }),
    state: e.state,
    ...(e.error !== undefined && { error: e.error }),
    ...(e.status !== undefined && { status: e.status }),
    workspace: e.workspace,
    loaded: e.loaded,
    signIn: e.signIn,
    secrets: e.secrets.map((s) => ({
      name: s.name,
      ...(s.description !== undefined && { description: s.description }),
      set: s.set,
    })),
    ...(e.schema !== undefined && { schema: JSON.parse(JSON.stringify(e.schema)) as Json }),
    values: JSON.parse(JSON.stringify(e.values ?? {})) as { [key: string]: Json },
  };
}

/** The text of a tool result's first content block. */
function toolText(result: { content?: unknown[] }): string {
  const first = result.content?.[0] as { type?: string; text?: string } | undefined;
  return first?.type === "text" && typeof first.text === "string" ? first.text : "Done.";
}

/** The Settings bridge over `admin`; `stop()` cancels its running sign-ins. */
export function settingsBridge(
  admin: AdminContext,
  ctx: Pick<SurfaceContext, "status" | "jobs" | "home">,
  options: SettingsOptions = {},
): SettingsBridge & { stop(): void } {
  const now = options.now ?? Date.now;

  async function activeJobs(): Promise<number> {
    if (options.activeJobs) return options.activeJobs();
    let count = 0;
    const watch = await ctx.jobs((jobs) => (count = jobs.filter((j) => ACTIVE.includes(j.status)).length));
    await watch.stop();
    return count;
  }

  async function runningUpdate() {
    const state = await admin.update.state();
    const at = now();
    if (state !== undefined && liveness(state, at) === "running") {
      throw new Error(`An update is already running (started ${ago(at - state.started)} ago).`);
    }
  }

  async function providerName(id: string): Promise<string> {
    try {
      return (await admin.providers()).find((p) => p.id === id)?.name ?? id;
    } catch {
      return id;
    }
  }

  const flows: Flows = createFlows(
    async (start, interaction) => {
      if (start.kind === "extension") return admin.authorize(start.extension, interaction);
      await admin.login(start.provider, start.method, interaction);
      return `Connected to ${await providerName(start.provider)}.`;
    },
    { idleMs: options.flowIdleMs, keepMs: options.flowKeepMs },
  );

  return {
    async overview() {
      const cos = (admin.settings().models as { cos?: { provider?: unknown; modelId?: unknown } } | undefined)?.cos;
      const extensions = await admin.extensions();
      const counts = { on: 0, off: 0, notSetUp: 0, error: 0 };
      for (const e of extensions) {
        if (e.error !== undefined) counts.error++;
        else if (e.state === "on") counts.on++;
        else if (e.state === "off") counts.off++;
        else counts.notSetUp++;
      }
      return {
        ...(typeof cos?.provider === "string" &&
          typeof cos.modelId === "string" && { model: { provider: cos.provider, modelId: cos.modelId } }),
        errors: ctx.status().errors.map((e) => ({ name: e.name, error: e.error })),
        counts,
      };
    },
    async values() {
      return JSON.parse(JSON.stringify(admin.settings())) as { [key: string]: Json };
    },
    set: (path, value) => admin.setSetting(path, value),
    extensions: async () => (await admin.extensions()).map(extensionView),
    setSecret: (extension, name, value) => admin.setSecret(extension, name, value),
    rollback: (extension) => admin.rollback(extension),
    providers: async () =>
      (await admin.providers()).map((p) => ({
        id: p.id,
        name: p.name,
        ...(p.credential !== undefined && { credential: p.credential }),
        connected: p.connected,
        ...(p.signIn !== undefined && { signIn: { label: p.signIn.label, subscription: p.signIn.subscription } }),
        ...(p.apiKey !== undefined && { apiKey: { label: p.apiKey.label } }),
      })),
    models: async (provider) => (await admin.models(provider)).map((m) => ({ id: m.id, name: m.name })),
    async schedules() {
      const details = (await admin.tool("schedule_list", {}))?.details;
      if (!Array.isArray(details)) return [];
      return (details as ScheduleView[]).map((s) => ({
        id: s.id,
        text: s.text,
        ...(s.cron !== undefined && { cron: s.cron }),
        ...(s.at !== undefined && { at: s.at }),
        next: s.next,
        paused: s.paused,
        label: s.label,
      }));
    },
    async schedule(id, action) {
      const result = await admin.tool(`schedule_${action}`, { id });
      if (result === undefined) throw new Error("Schedules aren't available.");
      return toolText(result as { content?: unknown[] });
    },
    async changes() {
      return (await admin.changes())
        .slice(0, CHANGES)
        .map((c): ChangeView => ({ id: c.id, title: c.title, at: c.at, detail: c.howToUse }));
    },
    undo: (id) => admin.undoChange(id),
    async clearFinishedJobs() {
      const n = await admin.clearFinishedJobs();
      return n === 0 ? "No finished jobs to clear." : `Cleared ${plural(n, "finished job")}.`;
    },
    async update(): Promise<UpdateView> {
      const s = await admin.update.state();
      if (s === undefined) return {};
      const interrupted = liveness(s, now()) === "interrupted";
      return {
        last: {
          state: interrupted ? "interrupted" : s.state,
          started: s.started,
          ...(s.finished !== undefined && { finished: s.finished }),
          from: s.from,
          ...(s.to !== undefined && { to: s.to }),
          rollback: s.rollback,
          ...(s.summary !== undefined
            ? { summary: s.summary }
            : interrupted && { summary: `The update was interrupted; see ${join(ctx.home, "logs", "update.log")}.` }),
          ...(s.output !== undefined && { output: s.output }),
        },
      };
    },
    async checkUpdate() {
      const check = await admin.update.check();
      return { current: check.current, target: check.target, commits: check.commits, activeJobs: await activeJobs() };
    },
    async startUpdate(to) {
      await admin.update.start({ ...WEB_CHAT }, await admin.update.current(), to, false);
    },
    async rollbackUpdate(to) {
      await runningUpdate(); // before touching anything, as Telegram's Roll back
      await admin.update.start({ ...WEB_CHAT }, await admin.update.current(), to, true);
    },
    startFlow: (start) => flows.start(start),
    flow: (id) => flows.flow(id),
    answer: (id, promptId, value) => flows.answer(id, promptId, value),
    cancel: (id) => flows.cancel(id),
    stop: () => flows.stop(),
  };
}
