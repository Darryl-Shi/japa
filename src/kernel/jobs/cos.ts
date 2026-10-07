import { StringEnum, Type, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  configure,
  defineExtension,
  defineTool,
  type Extension,
  ROOT_CONVERSATION_ID,
  section,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Settings } from "../settings.ts";
import type { WorkerProfile } from "../workers.ts";
import { Anchor, BACKGROUND, jobRun } from "./run.ts";
import { board, JobDoc, JobsDoc } from "./state.ts";
import { workerExtension } from "./worker.ts";

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** The CoS's job extension: the `job_start` and `job_message` tools, the jobs board section, and the job tasks. */
export function jobsExtension(options: {
  profiles: ReadonlyMap<string, WorkerProfile>;
  settings: Settings;
  extensions: ReadonlyMap<string, Extension>; // extension-built Pi Durable extensions, by japa extension name
}): Extension {
  const { profiles, settings, extensions } = options;
  const { JobRun, start } = jobRun(settings);
  const worker = workerExtension();

  const agentOf = (profile: WorkerProfile) => ({
    model: profile.model ?? settings.models.worker ?? settings.models.cos,
    thinkingLevel: profile.thinking as ModelThinkingLevel | undefined,
    cwd: profile.cwd,
    instructions: profile.instructions,
    extensions: [
      worker,
      CodingTools,
      ...(profile.extensions?.map((name) => extensions.get(name)!) ?? extensions.values()),
    ],
    tools: { remove: CodingTools.tools!.filter((t) => !profile.tools.includes(t.name)) },
  });

  const jobStart = defineTool({
    name: "job_start",
    description:
      "Start a background job: a worker that does the brief and reports back. Workers:\n" +
      [...profiles.values()].map((p) => `${p.name}: ${p.description}`).join("\n"),
    parameters: Type.Object({ title: Type.String(), brief: Type.String(), worker: Type.Optional(Type.String()) }),
    execute: async ({ title, brief, worker: name = "general" }, api, context) => {
      const profile = profiles.get(name);
      if (profile === undefined) return reply(`Unknown worker "${name}". Workers: ${[...profiles.keys()].join(", ")}.`);
      const job = await api.commit(async (tx) => {
        const doc = await tx.doc(JobsDoc, ROOT_CONVERSATION_ID);
        const id = String(doc.nextId++);
        const anchor = await tx.createTask(Anchor, null, BACKGROUND);
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
        await configure(tx, child.id, agentOf(profile));
        Object.assign(await tx.doc(JobDoc, child.id), { jobId: id, environment: profile.environment });
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
        return doc.jobs[id]!;
      }, context);
      return reply(
        job.status === "running"
          ? `Started job ${job.id}.`
          : `Queued job ${job.id}; it starts when a running job finishes.`,
      );
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

  return defineExtension({
    name: "japa-jobs",
    tasks: [Anchor, JobRun],
    tools: [jobStart, jobMessage],
    sections: [
      section("jobs", async ({ read }, context) => {
        const doc = await read.snapshot(JobsDoc, ROOT_CONVERSATION_ID, context);
        return doc && board(doc.jobs);
      }),
    ],
  });
}
