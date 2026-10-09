import type { MessagingContext } from "../../contracts.ts";
import type { Nav, Page } from "./nav.ts";

/** A schedule as `schedule_list`'s details give it. */
type Schedule = { id: string; text: string; cron?: string; at?: number; next: number; paused: boolean; label: string };

const local = (time: number) => new Date(time).toLocaleString();

/**
 * The Schedules list and each schedule's screen: what it says, when it repeats or fires, and its next time, with
 * Pause or Resume and Remove, all through the schedule tools. `home` is the Settings home.
 */
export function schedulesMenu(nav: Nav, messaging: MessagingContext, home: Page): Page {
  /** The schedules; none when the schedule tools aren't there. */
  const schedules = async () => ((await messaging.tool("schedule_list", {}))?.details ?? []) as Schedule[];
  /** Runs schedule tool `name` on schedule `id`; its text reply. */
  const run = (name: string, id: string) => async () => {
    const result = await messaging.tool(name, { id });
    if (result === undefined) throw new Error(`No tool ${name}.`);
    return (result.content![0] as { text: string }).text;
  };

  const list: Page = async (outcome) => {
    const all = await schedules();
    const items = all.map((s) => [`${s.paused ? "⏸ " : ""}${s.label}`, detail(s.id)] as const);
    const body = all.length === 0 ? "No schedules." : undefined;
    return nav.paged({ title: "Schedules", body, items, back: home, home, outcome });
  };

  // One gone meanwhile (removed, or a once one that fired) shows the list instead.
  const detail = (id: string): Page => async (outcome) => {
    const s = (await schedules()).find((x) => x.id === id);
    if (s === undefined) return list(`✗ No schedule ${id}.`);
    const self = detail(id);
    const body = [
      s.text,
      s.cron === undefined ? `Once: ${local(s.at!)}` : `Repeats: ${s.cron}`,
      s.paused ? "Paused" : `Next: ${local(s.next)}`,
    ].join("\n");
    const [label, tool] = s.paused ? ["Resume", "schedule_resume"] : ["Pause", "schedule_pause"];
    const toggle = nav.act(label, run(tool, id), self);
    const remove = nav.confirm(`Remove schedule "${s.label}"?`, "Remove", run("schedule_remove", id), list, self);
    const rows = [[toggle], [nav.button("Remove", remove)]];
    return nav.screen({ title: `Schedule ${id}`, body, rows, back: list, home, outcome });
  };

  return list;
}
