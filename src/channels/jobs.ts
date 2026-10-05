// /jobs: the team at a glance, independent of the channel that shows it. The open jobs with their subagents, each a
// button to its detail: status, model, when it started, last reported and was last active, and the last few things it
// was told, said and ran. From there the user can refresh, close a job that has reported (it's done with), or cancel
// one still working (after a confirming tap); the chief of staff sees it closed in its open items.
import type { Button, Card, CardRef, UI } from "../core/ui.ts";
import type { JobDetail, JobSummary } from "../pi/delegation.ts";

const SHOWN = 10;

export type JobsSource = {
	list(): Promise<JobSummary[]>;
	detail(id: string): Promise<JobDetail | undefined>;
	cancel(id: string): Promise<boolean>;
	close(id: string): Promise<boolean>;
};

const open = (job: JobSummary) => job.status === "working" || job.status === "reported";

function ago(at: number | undefined, now: number): string {
	if (at === undefined) return "—";
	const minutes = Math.round((now - at) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const STATUS = { working: "working", reported: "reported, waiting on the chief of staff", concluded: "concluded", cancelled: "cancelled" } as const;

export function attachJobs(ui: UI, source: JobsSource): void {
	const list = async (finished: boolean): Promise<Card> => {
		const now = Date.now();
		const all = await source.list();
		const shown = all.filter((job) => job.depth === 1 && open(job) !== finished).slice(0, SHOWN);
		const subagents = (job: JobSummary) => all.filter((each) => each.depth === 2 && each.id.startsWith(`${job.id}.`));
		const lines = shown.map((job) => {
			const subs = subagents(job).filter(open);
			return `• ${job.title} (${job.id}): ${STATUS[job.status]}, started ${ago(job.startedAt, now)}${subs.length === 0 ? "" : `, ${subs.length} subagent${subs.length === 1 ? "" : "s"} working`}`;
		});
		const done = all.filter((job) => job.depth === 1 && !open(job)).length;
		const heading = finished ? "Finished jobs, newest first." : shown.length === 0 ? "No jobs running." : "Jobs running:";
		const rows: Button[][] = shown.map((job) => [{ text: job.title, data: `jobs:d:${job.id}` }]);
		rows.push(finished ? [{ text: "« Running", data: "jobs:l" }] : [{ text: "↻ Refresh", data: "jobs:l" }, ...(done === 0 ? [] : [{ text: `Finished (${done})`, data: "jobs:f" }])]);
		return { text: [heading, ...lines].join("\n"), buttons: rows };
	};

	const detail = async (id: string): Promise<Card> => {
		const job = await source.detail(id);
		if (job === undefined) return { text: `No job ${id}.`, buttons: [[{ text: "« Jobs", data: "jobs:l" }]] };
		const now = Date.now();
		const text = [
			`${job.title} (${job.id})`,
			`Status: ${STATUS[job.status]}`,
			`Model: ${job.model}`,
			`Started ${ago(job.startedAt, now)} · last report ${ago(job.lastReportAt, now)} · last active ${ago(job.lastActiveAt, now)}`,
			...(job.subagents.length === 0 ? [] : ["Subagents:", ...job.subagents.map((sub) => `  ${sub.title} (${sub.id}): ${STATUS[sub.status]}`)]),
			...(job.recent.length === 0 ? [] : ["Lately:", ...job.recent.map((line) => `  ${line}`)]),
		].join("\n");
		const act: Button[] = !open(job) || job.depth !== 1 ? [] : job.status === "reported" ? [{ text: "Close job", data: `jobs:k:${job.id}` }] : [{ text: "Cancel job", data: `jobs:c:${job.id}` }];
		const rows: Button[][] = [[{ text: "↻ Refresh", data: `jobs:d:${job.id}` }, ...act]];
		rows.push([{ text: "« Jobs", data: "jobs:l" }]);
		return { text, buttons: rows };
	};

	ui.command("jobs", "What the team is working on", async (at) => void (await ui.show({ ...(await list(false)), replyTo: at })));
	ui.handle("jobs", {
		press: async (payload, ref: CardRef) => {
			const [action = "", ...rest] = payload.split(":");
			const id = rest.join(":");
			if (action === "l" || action === "f") return void (await ui.show(await list(action === "f"), ref));
			if (action === "d") return void (await ui.show(await detail(id), ref));
			if (action === "c") {
				return void (await ui.show({ text: `Cancel job ${id} and its subagents?`, buttons: [[{ text: "Yes, cancel it", data: `jobs:x:${id}` }, { text: "No", data: `jobs:d:${id}` }]] }, ref));
			}
			if (action === "k") {
				const closed = await source.close(id);
				const card = await detail(id);
				return void (await ui.show({ ...card, text: `${closed ? "Closed." : "It wasn't open."}\n\n${card.text}` }, ref));
			}
			if (action === "x") {
				const cancelled = await source.cancel(id);
				const card = await detail(id);
				return void (await ui.show({ ...card, text: `${cancelled ? "Cancelled." : "It wasn't running."}\n\n${card.text}` }, ref));
			}
		},
	});
}
