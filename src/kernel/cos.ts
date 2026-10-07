import type { Context } from "@earendil-works/chord";
import {
  type AnyTask,
  type Conversation,
  defineExtension,
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
import { readFileSync } from "node:fs";
import { MemoryDoc, renderFacts, renderLoops } from "./memory/state.ts";
import { memoryTools } from "./memory/tools.ts";
import { secretRequest } from "./secret-requests.ts";
import type { Settings } from "./settings.ts";

const identityText = readFileSync(new URL("./identity.md", import.meta.url), "utf8").trim();

function capped(text: string, max: number): string {
  if (text.length <= max) return text;
  const note = `[Truncated ${text.length - max} characters. Start a job if you need the full output.]`;
  return `${text.slice(0, max)}\n${note}`;
}

/**
 * The CoS's own Pi Durable extension: its identity, its capabilities (the current text of `capabilities()`), its
 * memory sections and tools, the built-in `read` tool, `secret_request`, the cap on tool results it sees, and the
 * kernel's root tools and tasks.
 */
export function cosExtension(
  settings: Settings,
  tasks: AnyTask[],
  tools: ToolRegistration[],
  capabilities: () => string,
): Extension {
  return defineExtension({
    name: "japa-cos",
    sections: [
      section("identity", () => identityText, { tag: false }),
      section("capabilities", capabilities),
      section("about-you", async ({ read }, context) => {
        const memory = await read.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, context);
        return memory && renderFacts(memory.facts);
      }),
      section("open-loops", async ({ read }, context) => {
        const memory = await read.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, context);
        return memory && renderLoops(memory.loops);
      }),
    ],
    tools: [createReadTool(), ...memoryTools, secretRequest, ...tools],
    tasks,
    hooks: [
      hook(GenerationTask, {
        beforeRequest: ({ messages }) => ({
          messages: messages.map((m) =>
            m.role === "toolResult"
              ? {
                  ...m,
                  content: m.content.map((c) =>
                    c.type === "text" ? { ...c, text: capped(c.text, settings.context.toolResultTokens * 4) } : c,
                  ),
                }
              : m,
          ),
        }),
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
