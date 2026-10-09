import type { MessagingContext } from "../../contracts.ts";
import type { Job, JobStatus } from "../../jobs/state.ts";
import type { Settings } from "../../settings.ts";
import { ago, dur, type Nav, PAGE, type Page } from "./nav.ts";

const ICONS: Record<JobStatus, string> = {
  queued: "⏳",
  running: "🔄",
  needs_input: "❓",
  done: "✅",
  failed: "❌",
  cancelled: "⛔",
};
/** The heading of what a job's status calls for, shown under its brief. */
const SECTIONS: Partial<Record<JobStatus, [string, (j: Job) => string | undefined]>> = {
  running: ["Progress:", (j) => j.progress],
  done: ["Result:", (j) => j.result],
  needs_input: ["Question:", (j) => j.result],
  failed: ["Reason:", (j) => j.result],
};
/** Characters of a button label. */
const LABEL = 64;
/** Characters of a brief shown on a job's detail. */
const BRIEF = 800;

/** Queued, running or waiting for an answer: not finished. */
export const isActive = (j: Job) => j.status === "queued" || j.status === "running" || j.status === "needs_input";
const statusName = (status: JobStatus) => status.replace("_", " ");

/** `text` cut to `max` characters, ending `…` when cut. */
function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** `<icon> #<id> <title> · <age>`, the title cut so it fits `LABEL` characters. */
function label(job: Job, now: number): string {
  const head = `${ICONS[job.status]} #${job.id} `;
  const tail = ` · ${ago(now - job.updatedAt)}`;
  return `${head}${cut(job.title, LABEL - [...head].length - [...tail].length)}${tail}`;
}

/** `N running · N needs input · N queued · N finished`, without the zero ones. */
function counts(jobs: Job[]): string {
  const count = (statuses: JobStatus[]) => jobs.filter((j) => statuses.includes(j.status)).length;
  const parts: [number, string][] = [
    [count(["running"]), "running"],
    [count(["needs_input"]), "needs input"],
    [count(["queued"]), "queued"],
    [count(["done", "failed", "cancelled"]), "finished"],
  ];
  return parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`).join(" · ");
}

/**
 * `job`'s model and thinking level. One stored before jobs had them runs on the settings' (see `agentOf` in
 * jobs/cos.ts): the worker model, else the CoS's, and `jobs.thinking`; read with `settings_get`, "default" when that
 * fails.
 */
async function runsOn(job: Job, messaging: MessagingContext): Promise<{ model: string; thinking: string }> {
  if (job.model !== undefined && job.thinking !== undefined) return { model: job.model, thinking: job.thinking };
  let settings: Settings | undefined;
  try {
    const result = await messaging.tool("settings_get", {});
    settings = JSON.parse((result?.content?.[0] as { text: string }).text) as Settings;
  } catch {}
  const ref = settings?.models?.worker ?? settings?.models?.cos;
  return {
    model: job.model ?? (ref === undefined ? "default model" : `${ref.provider}/${ref.modelId}`),
    thinking: job.thinking ?? settings?.jobs?.thinking ?? "default",
  };
}

/** `N finished job(s)`. */
const finished = (n: number) => `${n} finished job${n === 1 ? "" : "s"}`;

/**
 * The /jobs menu: its home lists the active jobs by id, then the finished ones newest first, each leading to its
 * detail, and clears the finished ones.
 */
export function jobsMenu(nav: Nav, jobs: () => Job[], messaging: MessagingContext): Page {
  const find = (id: string) => {
    const job = jobs().find((j) => j.id === id);
    if (job === undefined) throw new Error(`No job ${id}.`);
    return job;
  };
  const fullBrief = (id: string, back: Page): Page => async (outcome) => {
    const job = find(id);
    return nav.screen({ title: `#${job.id} ${job.title}`, body: job.brief, rows: [], back, home: list(0), outcome });
  };
  const detail = (id: string, page: number): Page => {
    const self: Page = async (outcome) => {
      const job = find(id);
      const now = Date.now();
      const ran = (isActive(job) ? now : job.updatedAt) - job.createdAt;
      const { model, thinking } = await runsOn(job, messaging);
      const lines = [
        `${ICONS[job.status]} ${statusName(job.status)} · ${model} · thinking ${thinking}`,
        `Started ${ago(now - job.createdAt)} ago · updated ${ago(now - job.updatedAt)} ago · ran ${dur(ran)}`,
        "",
        `Brief:\n${cut(job.brief, BRIEF)}`,
      ];
      const [heading, text] = SECTIONS[job.status] ?? [];
      const shown = text?.(job);
      if (shown) lines.push("", `${heading}\n${shown}`);
      const rows = [...job.brief].length > BRIEF ? [[nav.button("Full brief", fullBrief(id, self))]] : [];
      const title = `#${job.id} ${job.title}`;
      return nav.screen({ title, body: lines.join("\n"), rows, back: list(page), home: list(0), outcome });
    };
    return self;
  };
  const list = (page: number): Page => async (outcome) => {
    const all = jobs();
    const now = Date.now();
    const active = all.filter(isActive).sort((a, b) => Number(a.id) - Number(b.id));
    const done = all.filter((j) => !isActive(j)).sort((a, b) => b.updatedAt - a.updatedAt);
    const items = [...active, ...done].map((j, i) => [label(j, now), detail(j.id, Math.floor(i / PAGE))] as const);
    const clear = async () => {
      const n = await messaging.clearFinishedJobs();
      return n === 0 ? "No finished jobs cleared." : `Cleared ${finished(n)}`;
    };
    const confirm = nav.confirm(`Clear ${finished(done.length)}?`, "Clear", clear, list(0), list(page));
    const rows = done.length > 0 ? [[nav.button("Clear finished", confirm)]] : [];
    const body = all.length === 0 ? "No jobs." : counts(all);
    return nav.paged({ title: "Jobs", body, items, page, rows, render: list, outcome });
  };
  return list(0);
}
