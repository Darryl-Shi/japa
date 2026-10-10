import { type Message, type Models, StringEnum, Type } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  configure,
  defineExtension,
  defineTool,
  type Extension,
  type ModelRef,
  ROOT_CONVERSATION_ID,
  section,
  type Tx,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { sandboxRefusal } from "../sandbox/jobs.ts";
import { type Settings, THINKING_LEVELS } from "../settings.ts";
import { Anchor, BACKGROUND, type JobHooks, jobRun } from "./run.ts";
import { board, byId, goingLive, type Job, JobDoc, JobsDoc } from "./state.ts";
import { WorkerExtension } from "./worker.ts";

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

export function line(m: Message): string {
  const text =
    typeof m.content === "string" ? m.content : m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
  return m.role === "toolResult" ? `tool ${m.toolName}: ${text.slice(0, 200)}` : `${m.role}: ${text}`;
}

export type JobsOptions = JobHooks & {
  settings: Settings;
  models: Models;
  extensions: ReadonlyMap<string, Extension>; // extension-built Pi Durable extensions, by japa extension name
  available: () => ReadonlySet<string>; // the names of the extensions agents may use now
  skills: Extension;
  safety: Extension;
  sandboxProblem: () => string | undefined; // why jobs can't run here, if they can't
};

/** `<provider>/<modelId>` as a model ref (the id may hold more slashes); undefined when it isn't one. */
export function parseModel(text: string | undefined): ModelRef | undefined {
  const slash = text?.indexOf("/") ?? -1;
  if (text === undefined || slash <= 0 || slash === text.length - 1) return undefined;
  return { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
}

const modelText = (ref: ModelRef) => `${ref.provider}/${ref.modelId}`;

/**
 * The agent of `job`: its model and thinking level (the settings' when it has none, as a job stored before it could),
 * and every coding tool, skill and available extension. One started by a worker profile may have stored a tool filter,
 * a cwd and instructions: they are cleared.
 */
function agentOf(
  { settings, extensions, available, skills, safety }: JobsOptions,
  job: Pick<Job, "model" | "thinking">,
): AgentChange {
  const names = [...extensions.keys()].filter((name) => available().has(name));
  return {
    model: parseModel(job.model) ?? settings.models.worker ?? settings.models.cos,
    thinkingLevel: job.thinking ?? settings.jobs.thinking,
    extensions: [
      WorkerExtension,
      CodingTools,
      skills,
      safety,
      ...names.flatMap((name) => extensions.get(name) ?? []),
    ],
    tools: null,
    cwd: null,
    instructions: null,
  };
}

/**
 * `job_start`'s refusal of model `name`: `known` when japa has it but its provider has no credentials; `available`, the
 * models it could use instead.
 */
export function modelRefusal(name: string, known: boolean, available: string[]): string {
  const why = known ? `Model "${name}" has no credentials.` : `Unknown model "${name}".`;
  return `${why} ${available.length === 0 ? "No models are usable." : `Models: ${available.join(", ")}.`}`;
}

/** The models a job can run on: `<provider>/<modelId>` of each one whose provider has credentials. */
async function availableModels(models: Models): Promise<string[]> {
  return (await models.getAvailable()).map((m) => `${m.provider}/${m.id}`);
}

/**
 * Re-applies each unfinished job's agent, so it picks up reloaded extensions and skills; one with no conversation, or
 * whose conversation is gone, is skipped: the doc is stored data, and one bad job mustn't fail a boot.
 */
export async function reconfigureJobs(tx: Tx, options: JobsOptions): Promise<void> {
  const { jobs } = await tx.doc(JobsDoc, ROOT_CONVERSATION_ID);
  for (const job of Object.values(jobs)) {
    if (!["queued", "running", "needs_input"].includes(job.status)) continue;
    if (!Number.isSafeInteger(job.conversationId)) continue;
    if ((await tx.conversation(job.conversationId)) === undefined) continue;
    await configure(tx, job.conversationId, agentOf(options, job));
  }
}

/** The CoS's job extension: the job tools, the jobs board section, and the job tasks. */
export function jobsExtension(options: JobsOptions): Extension {
  const { settings } = options;
  const { publish, closeSandbox, ended } = options;
  const { JobRun, start } = jobRun(settings, { publish, closeSandbox, ended });

  const jobStart = defineTool({
    name: "job_start",
    description:
      "Start a background job: a worker that does the brief and reports back. It has read, write, edit and bash, " +
      "every skill and every extension's tools.",
    parameters: Type.Object({
      title: Type.String(),
      brief: Type.String(),
      model: Type.Optional(
        Type.String({ description: '"<provider>/<modelId>"; by default, the worker model (models.worker).' }),
      ),
      thinking: Type.Optional(
        StringEnum([...THINKING_LEVELS], { description: "How hard the model thinks; by default, jobs.thinking." }),
      ),
    }),
    execute: async ({ title, brief, model: name, thinking }, api, context) => {
      const problem = options.sandboxProblem();
      if (problem !== undefined) return reply(sandboxRefusal(problem));
      let model = settings.models.worker ?? settings.models.cos!;
      if (name !== undefined) {
        // Unknown, or its provider has no credentials.
        const available = await availableModels(options.models);
        const ref = parseModel(name);
        if (ref === undefined || !available.includes(modelText(ref))) {
          const known = ref !== undefined && options.models.getModel(ref.provider, ref.modelId) !== undefined;
          return reply(modelRefusal(name, known, available));
        }
        model = ref;
      }
      const job = { model: modelText(model), thinking: thinking ?? settings.jobs.thinking };
      const started = await api.commit(async (tx) => {
        const doc = await tx.doc(JobsDoc, ROOT_CONVERSATION_ID);
        const id = String(doc.nextId++);
        const anchor = await tx.createTask(Anchor, null, BACKGROUND);
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
        await configure(tx, child.id, agentOf(options, job));
        Object.assign(await tx.doc(JobDoc, child.id), { jobId: id });
        const now = Date.now();
        doc.jobs[id] = {
          id,
          title,
          brief,
          ...job,
          status: "queued",
          conversationId: child.id,
          createdAt: now,
          updatedAt: now,
          seq: 0,
          reported: [],
        };
        await start(tx, doc.jobs);
        return doc.jobs[id]!.status === "running"
          ? `Started job ${id}.`
          : `Queued job ${id}; it starts when a running job finishes.`;
      }, context);
      return reply(started);
    },
  });

  const jobMessage = defineTool({
    name: "job_message",
    description: "Send a message to a job: steer it while it works, or follow up once it has answered.",
    parameters: Type.Object({ id: Type.String(), text: Type.String(), mode: StringEnum(["steer", "followup"]) }),
    execute: async ({ id, text, mode }, api, context) => {
      const refusal = await api.commit(async (tx) => {
        const job = (await tx.doc(JobsDoc, ROOT_CONVERSATION_ID)).jobs[id];
        if (job === undefined) return `No job ${id}.`;
        if (job.status === "queued") return `Job ${id} hasn't started yet.`;
        if (job.status === "cancelled") return `Job ${id} was stopped.`;
        // Its sandbox couldn't start: its clone is being published.
        if (job.publishing !== undefined) return goingLive(id);
        job.status = "running";
        job.updatedAt = Date.now();
        const input = {
          jobId: id,
          conversationId: job.conversationId,
          text,
          mode: mode === "steer" ? "steer" : "followUp",
        } as const;
        await tx.createTask(JobRun, input, BACKGROUND);
      }, context);
      return reply(refusal ?? `Sent to job ${id}.`);
    },
  });

  const jobStop = defineTool({
    name: "job_stop",
    description: "Stop a job: it is cancelled and reports nothing more.",
    parameters: Type.Object({ id: Type.String() }),
    execute: async ({ id }, api, context) => {
      const { text, stopped, abort } = await api.commit(async (tx) => {
        const job = (await tx.doc(JobsDoc, ROOT_CONVERSATION_ID)).jobs[id];
        if (job === undefined) return { text: `No job ${id}.` };
        if (["done", "failed", "cancelled"].includes(job.status)) return { text: `Job ${id} already finished.` };
        // A needs_input job's turn may still be going: job_ask beside another call doesn't end it.
        const abort = ["running", "needs_input"].includes(job.status) ? job.conversationId : undefined;
        job.status = "cancelled";
        job.updatedAt = Date.now();
        return { text: `Stopped job ${id}.`, stopped: true, abort };
      }, context);
      if (abort !== undefined) await (await api.conversation(abort, context))!.abort(context);
      // With everything the job left running; its clone is kept, from now: a job waiting for an answer has no run whose
      // end would say so (a running one's says so again).
      if (stopped) {
        options.closeSandbox(id);
        options.ended(id);
      }
      return reply(text);
    },
  });

  const jobList = defineTool({
    name: "job_list",
    description: "List all jobs with their status.",
    parameters: Type.Object({}),
    execute: async (_args, api, context) => {
      const doc = await api.snapshot(JobsDoc, ROOT_CONVERSATION_ID, context);
      const lines = byId(doc?.jobs ?? {}).map((j) => {
        const detail = j.status === "running" ? j.progress : j.result;
        return `${j.id} "${j.title}" ${j.status}${detail ? `: ${detail}` : ""}`;
      });
      return reply(lines.length ? lines.join("\n") : "No jobs.");
    },
  });

  const jobTranscript = defineTool({
    name: "job_transcript",
    description: "Show the last messages of a job's conversation (default 10).",
    parameters: Type.Object({ id: Type.String(), tail: Type.Optional(Type.Number()) }),
    execute: async ({ id, tail = 10 }, api, context) => {
      const lines = await api.commit(async (tx) => {
        const job = (await tx.doc(JobsDoc, ROOT_CONVERSATION_ID)).jobs[id];
        if (job === undefined) return undefined;
        const messages: Message[] = [];
        let cursor;
        do {
          const page = await tx.scanEntries({ conversationId: job.conversationId }, 50, cursor);
          messages.push(...page.items.flatMap((e) => e.model ?? []).filter((m) => m.role !== "system"));
          cursor = page.next;
        } while (cursor !== undefined && messages.length < tail);
        return messages.slice(0, tail).reverse().map(line);
      }, context);
      return reply(lines === undefined ? `No job ${id}.` : lines.join("\n"));
    },
  });

  return defineExtension({
    name: "japa-jobs",
    tasks: [Anchor, JobRun],
    tools: [jobStart, jobMessage, jobStop, jobList, jobTranscript],
    sections: [
      section("jobs", async ({ read }, context) => {
        const doc = await read.snapshot(JobsDoc, ROOT_CONVERSATION_ID, context);
        return doc && board(doc.jobs);
      }),
    ],
  });
}
