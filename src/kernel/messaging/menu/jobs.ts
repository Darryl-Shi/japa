import { recent, reportText, type Job } from "../../jobs/state.ts";
import type { Nav, Page } from "./nav.ts";

/** The /jobs menu: its home lists the running and recent jobs, each leading to its report. */
export function jobsMenu(nav: Nav, jobs: () => Job[]): Page {
  const report = (id: string): Page => async (outcome) => {
    const job = jobs().find((j) => j.id === id);
    if (job === undefined) throw new Error(`No job ${id}.`);
    const body = reportText(job, job.result ?? job.progress ?? "");
    return nav.screen({ title: `Job ${job.id}`, body, rows: [], back: list, home: list, outcome });
  };
  const list: Page = async (outcome) => {
    const shown = recent(jobs());
    const items = shown.map((j) => [`${j.id}. ${j.title} (${j.status})`, report(j.id)] as const);
    const body = shown.length === 0 ? "No running or recent jobs." : undefined;
    return nav.paged({ title: "Jobs", body, items, outcome });
  };
  return list;
}
