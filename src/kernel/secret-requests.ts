import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { type Conversation, defineDoc, defineTool, type Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { SecretsStore } from "./contracts.ts";

export type SecretRequest = { id: string; name: string; why: string; at: number };

// On the root conversation.
export const SecretRequestsDoc = defineDoc<{ nextId: number; pending: SecretRequest[] }>({
  kind: "japa.secretRequests",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ nextId: 1, pending: [] }),
});

const SECRET_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** The CoS's tool to ask the user for a secret; the value goes straight to the secrets store. */
export const secretRequest = defineTool({
  name: "secret_request",
  description:
    "Ask the user for a secret, such as an API key, by name (e.g. svc.token) and why it's needed. " +
    "A model provider's API key is `<provider>.apiKey`, e.g. `openai.apiKey`. " +
    "Returns at once; you'll be told when it's provided. You never see the value.",
  parameters: Type.Object({ name: Type.String(), why: Type.String() }),
  execute: async ({ name, why }, api, context) => {
    if (!SECRET_NAME.test(name)) return reply("Invalid secret name.");
    const added = await api.commit(async (tx) => {
      const doc = await tx.doc(SecretRequestsDoc, ROOT_CONVERSATION_ID);
      if (doc.pending.some((r) => r.name === name)) return false;
      doc.pending.push({ id: String(doc.nextId++), name, why, at: Date.now() });
      return true;
    }, context);
    return reply(added ? `Asked the user for ${name}. You'll be told when it's provided.` : `Already asked for ${name}.`);
  },
});

/** Stores `value` as the secret pending request `requestId` asked for, removes the request and tells the CoS. */
export async function fulfilSecret(
  harness: Harness,
  root: Conversation,
  secrets: SecretsStore,
  requestId: string,
  value: string,
  context: Context,
): Promise<void> {
  const { pending } = (await harness.snapshot(SecretRequestsDoc, root.id, context))!;
  const request = pending.find((r) => r.id === requestId);
  if (request === undefined) throw new Error(`No pending request ${requestId}`);
  await secrets.set(request.name, value);
  await root.commit(async (tx) => {
    const doc = await tx.doc(SecretRequestsDoc, root.id);
    doc.pending = doc.pending.filter((r) => r.id !== requestId);
  }, context);
  const content = `[secret ${request.name} provided]`;
  await root.submit({ type: "input", content, requestId: `secret:${requestId}` }, context);
}
