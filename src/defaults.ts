import { join } from "node:path";
import type {
  Channel,
  ModelProvider,
  PolicyDecision,
} from "./core/contracts.ts";
import type { Extension } from "./core/host.ts";
import { approvalsExtension } from "./extensions/approvals.ts";
import { assistantExtension } from "./extensions/assistant.ts";
import { computerExtension } from "./extensions/computer.ts";
import { contextExtension } from "./extensions/context.ts";
import { jobsExtension } from "./extensions/jobs.ts";
import { memoryExtension } from "./extensions/memory.ts";
import { modelsExtension } from "./extensions/models.ts";
import { policyExtension } from "./extensions/policy.ts";
import { selfExtension } from "./extensions/self.ts";
import { wakesExtension } from "./extensions/wakes.ts";

export type Defaults = {
  home: string;
  models: ModelProvider;
  channel: Channel;
  safe?: boolean;
  rules?: Readonly<Record<string, PolicyDecision>>;
  contextChars?: number;
  jobTimeoutMs?: number;
  maxJobs?: number;
};

/** The product is this small composition, not a special mode built into core. */
export function defaultExtensions(options: Defaults): Extension[] {
  const workspace = join(options.home, "workspace");
  return [
    modelsExtension(options.models),
    computerExtension(workspace),
    { name: "japa.channel", adapters: { channel: () => options.channel } },
    memoryExtension(join(options.home, "MEMORY.md")),
    contextExtension(options.contextChars),
    jobsExtension(workspace, {
      timeoutMs: options.jobTimeoutMs,
      maxActive: options.maxJobs,
    }),
    wakesExtension(),
    policyExtension(options.rules),
    approvalsExtension(),
    selfExtension(join(options.home, "extensions"), { safe: options.safe }),
    assistantExtension(),
  ];
}
