import type { JsonValue } from "@earendil-works/chord";
import { defineDoc, type JsonObject, ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";

/** A settings path and its user value before the change; `before` is absent when the path was not set. */
export type ConfigOp = { path: string; before?: JsonValue };

export type Change = {
  id: string;
  at: number;
  title: string;
  howToUse: string;
  /** `call`: a tool call that undoes the change, for the CoS to make. */
  undo: { commits: string[]; configOps?: ConfigOp[]; call?: { tool: string; args: JsonObject } };
};

// On the root conversation.
export const ChangesDoc = defineDoc<{ nextId: number; changes: Change[] }>({
  kind: "japa.changes",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ nextId: 1, changes: [] }),
});

/** Commits `change` on the root conversation, as a tool's `api.commit` does. */
export type Commit = <T>(change: (tx: Tx) => T | Promise<T>) => Promise<T>;

/** Appends a change to the log; returns its id. */
export async function logChange(tx: Tx, change: Omit<Change, "id" | "at">): Promise<string> {
  const doc = await tx.doc(ChangesDoc, ROOT_CONVERSATION_ID);
  const id = String(doc.nextId++);
  doc.changes.push({ id, at: Date.now(), ...change });
  return id;
}
