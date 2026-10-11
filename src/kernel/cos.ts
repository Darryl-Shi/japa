import type { Context } from "@earendil-works/chord";
import {
  type AnyTask,
  type Conversation,
  defineExtension,
  type DocumentReader,
  type EntryId,
  type Extension,
  GenerationTask,
  type Harness,
  hook,
  type ModelRef,
  ROOT_CONVERSATION_ID,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import type { Message } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { JobsDoc } from "./jobs/state.ts";
import { buildContext, runKey } from "./memory/context.ts";
import type { History } from "./memory/history.ts";
import type { HistoryMessage } from "./memory/transcript.ts";
import { ScratchpadDoc } from "./memory/scratchpad.ts";
import { MemoryDoc, renderFacts } from "./memory/state.ts";
import { memoryTools } from "./memory/tools.ts";
import { renderPending, secretRequest, SecretRequestsDoc } from "./secret-requests.ts";
import type { Settings } from "./settings.ts";

const identityText = readFileSync(new URL("./identity.md", import.meta.url), "utf8").trim();

function capped(text: string, max: number): string {
  if (text.length <= max) return text;
  const note = `[Truncated ${text.length - max} characters. Start a job if you need the full output.]`;
  return `${text.slice(0, max)}\n${note}`;
}

/** `messages` with `text` as a user message before the first non-system one. */
function inject(messages: readonly Message[], text: string): Message[] {
  const at = messages.findIndex((m) => m.role !== "system");
  const i = at === -1 ? messages.length : at;
  return [...messages.slice(0, i), { role: "user", content: text, timestamp: 0 }, ...messages.slice(i)];
}

/** The context for a root run (`buildContext`) from `transcript` and the root's documents; null when it's empty. */
async function build(
  read: DocumentReader,
  transcript: HistoryMessage[],
  lastReset: EntryId | undefined,
  context: Context,
): Promise<string | null> {
  const [memory, pad, jobs] = await Promise.all([
    read.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, context),
    read.snapshot(ScratchpadDoc, ROOT_CONVERSATION_ID, context),
    read.snapshot(JobsDoc, ROOT_CONVERSATION_ID, context),
  ]);
  const text = buildContext({
    messages: transcript,
    ...(lastReset === undefined ? {} : { lastReset }),
    memory: memory ?? { nextId: 1, facts: [] },
    pad: pad ?? { nextId: 1, pages: [] },
    jobs: jobs?.jobs ?? {},
    now: Date.now(),
  });
  return text ?? null;
}

/**
 * The CoS's own Pi Durable extension: its identity, its capabilities (the current text of `capabilities()`), its
 * memory sections and tools, the built-in `read` tool, `secret_request`, the cap on tool results it sees, the
 * conversation context injected into each root run (built once per run from `history`), and the kernel's root tools
 * and tasks.
 */
export function cosExtension(
  settings: Settings,
  tasks: AnyTask[],
  tools: ToolRegistration[],
  capabilities: () => string,
  history: History,
): Extension {
  // The newest run's context. The memo is per generation task, and a run hands over to a new one after every tool
  // round, so this keeps the text, and the cached prefix after it, the same for the whole run.
  let latest: { key: string; text: string | null } | undefined;
  return defineExtension({
    name: "japa-cos",
    sections: [
      section("identity", () => identityText, { tag: false }),
      section("capabilities", capabilities),
      section("about-you", async ({ read }, context) => {
        const memory = await read.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, context);
        return memory && renderFacts(memory.facts);
      }),
      section("waiting-on-you", async ({ read }, context) => {
        const pending = await read.snapshot(SecretRequestsDoc, ROOT_CONVERSATION_ID, context);
        return pending && renderPending(pending.pending);
      }),
    ],
    tools: [createReadTool(), ...memoryTools, secretRequest, ...tools],
    tasks,
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api, context) => {
          const sent = messages.map((m) =>
            m.role === "toolResult"
              ? {
                  ...m,
                  content: m.content.map((c) =>
                    c.type === "text" ? { ...c, text: capped(c.text, settings.context.toolResultTokens * 4) } : c,
                  ),
                }
              : m,
          );
          if (api.conversationId !== ROOT_CONVERSATION_ID) return { messages: sent };
          // Built once per run; the memo keeps it for this request's retries, across restarts too.
          let text = await api.memo<string | null>("japa.context", context);
          if (text === undefined) {
            const { messages: transcript, lastReset } = await history.refresh(context);
            const key = runKey(transcript, lastReset);
            text = latest?.key === key ? latest.text : await build(api, transcript, lastReset, context);
            text = await api.memo<string | null>("japa.context", text, context);
            latest = { key, text };
          }
          return { messages: text === null ? sent : inject(sent, text) };
        },
      }),
    ],
  });
}

/** Returns the root conversation, creating it on first boot, configured with `model`. */
export async function ensureRoot(harness: Harness, model: ModelRef, context: Context): Promise<Conversation> {
  const root = await harness.root(context, { agent: { model } });
  await root.configure({ model }, context); // a changed setting applies to an existing root
  return root;
}
