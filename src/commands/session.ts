// /session: pi's command, from chat: what the session has spent so far. By job, since jobs do the work; the chief of
// staff's own share is one line. Spend is pi's own ledger of each conversation (every model and tool call in it).
import type { Card, UI } from "../core/ui.ts";
import type { JobSpend, Spend } from "../pi/delegation.ts";

const SHOWN = 10;

export type SpendSource = () => Promise<{ chief: Spend; jobs: JobSpend[] }>;

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const money = (cost: number) => `$${cost.toFixed(2)}`;
const of = (spend: Spend) => `${money(spend.cost)}, ${tokens(spend.tokens)} tokens`;

export function attachSession(ui: UI, source: SpendSource): void {
	const card = async (): Promise<Card> => {
		const { chief, jobs } = await source();
		const total = [chief, ...jobs].reduce((sum, each) => ({ tokens: sum.tokens + each.tokens, cost: sum.cost + each.cost }), { tokens: 0, cost: 0 });
		const rest = jobs.slice(SHOWN);
		const lines = [
			`Spent so far: ${of(total)}.`,
			...(jobs.length === 0 ? ["No jobs yet."] : ["By job:", ...jobs.slice(0, SHOWN).map((job) => `• ${job.title} (${job.id}${job.status === "working" ? ", working" : ""}): ${of(job)}`)]),
			...(rest.length === 0 ? [] : [`• ${rest.length} more: ${money(rest.reduce((sum, job) => sum + job.cost, 0))}`]),
			`Chief of staff: ${of(chief)}`,
		];
		return { text: lines.join("\n"), buttons: [[{ text: "↻ Refresh", data: "session:r" }]] };
	};
	ui.command("session", "What it has spent, by job", async (at) => void (await ui.show({ ...(await card()), replyTo: at })));
	ui.handle("session", { press: async (_payload, ref) => void (await ui.show(await card(), ref)) });
}
