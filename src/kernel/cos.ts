import type { Context } from "@earendil-works/chord";
import {
  type Conversation,
  defineExtension,
  type Extension,
  type Harness,
  type ModelRef,
  section,
} from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { readFileSync } from "node:fs";

const identityText = readFileSync(new URL("./identity.md", import.meta.url), "utf8").trim();

/** The CoS's own Pi Durable extension: its identity and the built-in `read` tool. */
export function cosExtension(): Extension {
  return defineExtension({
    name: "japa-cos",
    sections: [section("identity", () => identityText, { tag: false })],
    tools: [createReadTool()],
  });
}

/** Returns the root conversation, creating it on first boot, configured with `model`. */
export async function ensureRoot(harness: Harness, model: ModelRef, context: Context): Promise<Conversation> {
  const root = await harness.root(context, { agent: { model } });
  await root.configure({ model }, context); // a changed setting applies to an existing root
  return root;
}
