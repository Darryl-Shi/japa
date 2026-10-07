import { defineDoc } from "@earendil-works/pi-durable";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Address } from "../core/contracts.ts";

export type Commitment = {
  id: string;
  outcome: string;
  status: "open" | "done" | "cancelled";
  nextAction: string;
  due: string;
};

type AssistantState = {
  focus: string;
  focusUpdatedAt: number;
  /** Optional for old databases; explicit forgetting excludes stale recent dialogue. */
  contextCutoff?: number;
  commitments: Commitment[];
  address?: Address;
  receipts: Record<string, TaskId>;
};

/** Operational truth, not a lossy conversation summary or personal memory. */
export const AssistantState = defineDoc<AssistantState>({
  kind: "japa.assistant",
  version: 1,
  scope: "session",
  initial: () => ({
    focus: "",
    focusUpdatedAt: 0,
    commitments: [],
    receipts: {},
  }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31,
});
