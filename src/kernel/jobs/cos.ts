import { type Message, StringEnum, Type } from "@earendil-works/pi-ai";
import {
  configure,
  defineExtension,
  defineTool,
  type Extension,
  ROOT_CONVERSATION_ID,
  section,
  type Tx,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Settings } from "../settings.ts";
import type { WorkerProfile } from "../workers.ts";
import { Anchor, BACKGROUND, jobRun } from "./run.ts";
import { board, byId, JobDoc, JobsDoc } from "./state.ts";
import { WorkerExtension } from "./worker.ts";

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

export function line(m: Message): string {
  const text =
    typeof m.content === "string" ? m.content : m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
  return m.role === "toolResult" ? `tool ${m.toolName}: ${text.slice(0, 200)}` : `${m.role}: ${text}`;
}

export type JobsOptions = {
  profiles: ReadonlyMap<string, WorkerProfile>;
  settings: Settings;
  extensions: ReadonlyMap<string, Extension>; // extension-built Pi Durable extensions, by japa extension name
  available: () => ReadonlySet<string>; // the names of the extensions agents may use now
  skills: Extension;
  safety: Extension;
};

/** The agent of a job run by `profile`, with the available extensions it names (all available ones when unnamed). */
function agentOf({ settings, extensions, available, skills, safety }: JobsOptions, profile: WorkerProfile) {
  const names = (profile.extensions ?? [...extensions.keys()]).filter((name) => available().has(name));
  return {
    model: profile.model ?? settings.models.worker ?? settings.models.cos,
    thinkingLevel: profile.thinking,
    cwd: profile.cwd,
    instructions: profile.instructions,
    extensions: [
      WorkerExtension,
      CodingTools,
      skills,
      safety,
      ...names.flatMap((name) => extensions.get(name) ?? []),
    ],
    tools: { remove: CodingTools.tools!.filter((t) => !profile.tools.includes(t.name)) },
  };
}

/**
 * Re-applies each unfinished job's profile, so it picks up reloaded extensions and skills; one whose conversation is
 * gone is skipped, so it can't fail a boot.
 */
export async function reconfigureJobs(tx: Tx, options: JobsOptions): Promise<void> {
  const { jobs } = await tx.doc(JobsDoc, ROOT_CONVERSATION_ID);
  for (const job of Object.values(jobs)) {
    const profile = options.profiles.get(job.worker);
    if (profile === undefined || !["queued", "running", "needs_input"].includes(job.status)) continue;
    if ((await tx.conversation(job.conversationId)) === undefined) continue;
    await configure(tx, job.conversationId, agentOf(options, profile));
  }
}

/** The CoS's job extension: the job tools, the jobs board section, and the job tasks. */
export function jobsExtension(options: JobsOptions): Extension {
  const { profiles, settings } = options;
  const { JobRun, start } = jobRun(settings);

  const jobStart = defineTool({
    name: "job_start",
    description:
      "Start a background job: a worker that does the brief and reports back. Workers:\n" +
      [...profiles.values()].map((p) => `${p.name}: ${p.description}`).join("\n"),
    parameters: Type.Object({ title: Type.String(), brief: Type.String(), worker: Type.Optional(Type.String()) }),
    execute: async ({ title, brief, worker: name = "general" }, api, context) => {
      const profile = profiles.get(name);
      if (profile === undefined) return reply(`Unknown worker "${name}". Workers: ${[...profiles.keys()].join(", ")}.`);
      const started = await api.commit(async (tx) => {
        const doc = await tx.doc(JobsDoc, ROOT_CONVERSATION_ID);
        const id = String(doc.nextId++);
        const anchor = await tx.createTask(Anchor, null, BACKGROUND);
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
        await configure(tx, child.id, agentOf(options, profile));
        Object.assign(await tx.doc(JobDoc, child.id), {
          jobId: id,
          environment: profile.environment,
          ...(profile.skills && { skills: profile.skills }),
        });
        const now = Date.now();
        doc.jobs[id] = {
          id,
          title,
          brief,
          worker: name,
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
      const { text, abort } = await api.commit(async (tx) => {
        const job = (await tx.doc(JobsDoc, ROOT_CONVERSATION_ID)).jobs[id];
        if (job === undefined) return { text: `No job ${id}.` };
        if (["done", "failed", "cancelled"].includes(job.status)) return { text: `Job ${id} already finished.` };
        // A needs_input job's turn may still be going: job_ask beside another call doesn't end it.
        const abort = ["running", "needs_input"].includes(job.status) ? job.conversationId : undefined;
        job.status = "cancelled";
        job.updatedAt = Date.now();
        return { text: `Stopped job ${id}.`, abort };
      }, context);
      if (abort !== undefined) await (await api.conversation(abort, context))!.abort(context);
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
