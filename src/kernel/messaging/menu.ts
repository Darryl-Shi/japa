import type { Incoming, KernelContext, MessagingAdapter, OutgoingMessage } from "../contracts.ts";
import { recent, reportText, type Job } from "../jobs/state.ts";
import { statusText } from "../status.ts";

export const COMMANDS = [
  { name: "jobs", description: "Running and recent jobs" },
  { name: "status", description: "Model, extensions and errors" },
  { name: "settings", description: "Models, schedules and extensions" },
];

export const HELP = `Commands:\n${COMMANDS.map((c) => `/${c.name} — ${c.description}`).join("\n")}`;

type View = () => Promise<OutgoingMessage>;

/**
 * Answers the owner's commands, and their presses of the buttons it sends: each button's action is a short id mapped,
 * in memory, to the view it edits its message to.
 */
export function createMenu(adapter: MessagingAdapter, kernel: KernelContext, jobs: () => Job[]) {
  let next = 0;
  const views = new Map<string, View>();
  const button = (label: string, view: View) => {
    const action = String(++next);
    views.set(action, view);
    return { label, action };
  };

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

  return {
    async command(m: Incoming) {
      const view = m.command === "jobs" ? jobsView : m.command === "status" ? statusView : undefined;
      await adapter.send(m.chat, view ? await view() : { markdown: HELP });
    },
    async press(m: Incoming) {
      const view = views.get(m.action!);
      const expired = { markdown: "This menu expired — send /settings again." };
      await adapter.edit(m.chat, m.messageId, view ? await view() : expired);
    },
  };
}
