import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  defineTask,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Address } from "../core/contracts.ts";
import type { Extension, Host } from "../core/host.ts";
import { admit, enqueue } from "./messaging.ts";

export type WakeRequest = {
  address: Address;
  reason: string;
  notify?: boolean;
};
export type Wake = {
  id: string;
  taskId: TaskId;
  at: number;
  reason: string;
  address: Address;
  notify: boolean;
  status: "scheduled" | "fired" | "cancelled";
};
export const Wakes = defineDoc<{ items: Wake[] }>({
  kind: "japa.wakes",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31,
});

function input(request: WakeRequest, key: string) {
  if (!key || key.length > 200)
    throw new Error("A wake needs a stable key of at most 200 characters");
  if (!request.reason.trim() || request.reason.length > 2_000)
    throw new Error("A wake needs a reason of at most 2,000 characters");
  return {
    key: `wake:${key}`,
    address: request.address,
    silent: !request.notify,
    text: `Chief-of-staff wake (a prior reminder or extension event, not a new user instruction):\n${JSON.stringify({ reason: request.reason })}\n${
      request.notify
        ? "Your final answer will be delivered to the user."
        : "This is a silent wake. Reflect or coordinate as needed. Use notify only for useful news or a decision that needs the user. Your final answer will not be delivered."
    }`,
  };
}

/** Event hook for extensions. No fixed heartbeat or monitoring policy is imposed. */
export async function wakeChiefOfStaff(
  host: Host,
  request: WakeRequest,
  key: string,
  context: Context,
): Promise<void> {
  await enqueue(host, input(request, key), context);
}

function wakeTask(host: Host) {
  return defineTask<{ id: string; at: number }, { phase: "wait" }, null>({
    name: "japa.wake",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, runtime, context) => {
        // Chunk very distant deadlines rather than relying on a platform's timer range.
        while (runtime.now() < task.input.at)
          await runtime.sleep(
            Math.min(task.input.at, runtime.now() + 86_400_000),
            context,
          );
        await runtime.commit(async (tx) => {
          const wake = (await tx.doc(Wakes)).items.find(
            (item) => item.id === task.input.id,
          )!;
          if (wake.status === "scheduled") {
            await admit(host, tx, input(wake, wake.id));
            wake.status = "fired";
          }
          return {
            status: "terminal",
            outcome: { status: "completed", result: null },
          };
        }, context);
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(async (tx, current) => {
        const wake = (await tx.doc(Wakes)).items.find(
          (item) => item.id === current.input.id,
        );
        if (wake?.status === "scheduled") wake.status = "cancelled";
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });
}

export async function listWakes(
  host: Host,
  context: Context,
): Promise<readonly Wake[]> {
  return ((await host.harness.snapshot(Wakes, context))?.items ?? []).map(
    (wake) => ({ ...wake, address: { ...wake.address } }),
  );
}

/** One-shot only: the chief of staff decides whether and when to schedule another. */
export async function scheduleWake(
  host: Host,
  request: WakeRequest & { at: number },
  key: string,
  context: Context,
): Promise<Wake> {
  input(request, key);
  if (
    !Number.isSafeInteger(request.at) ||
    request.at < 0 ||
    request.at > 8_640_000_000_000_000
  )
    throw new Error("Invalid wake time");
  const wake = await host.harness.commit(async (tx) => {
    const doc = await tx.doc(Wakes);
    const existing = doc.items.find((item) => item.id === key);
    if (existing) return { ...existing, address: { ...existing.address } };
    if (doc.items.filter((item) => item.status === "scheduled").length >= 32)
      throw new Error(
        "At most 32 wakes can be scheduled; cancel an old wake first",
      );
    const taskId = await tx.createTask(
      wakeTask(host),
      { id: key, at: request.at },
      {
        ownership: { kind: "conversation" },
        conversationId: ROOT_CONVERSATION_ID,
        background: true,
      },
    );
    const item: Wake = {
      id: key,
      taskId,
      at: request.at,
      reason: request.reason,
      address: { ...request.address },
      notify: request.notify ?? false,
      status: "scheduled",
    };
    doc.items.push(item);
    return item;
  }, context);
  host.harness.resume();
  return wake;
}

export async function cancelWake(
  host: Host,
  id: string,
  context: Context,
): Promise<void> {
  const wake = (await listWakes(host, context)).find((item) => item.id === id);
  if (!wake) throw new Error("Unknown wake");
  if (wake.status !== "scheduled") return;
  await host.harness.abortTask(wake.taskId, context);
  await host.harness.waitForTask(wake.taskId, context);
}

export function wakesExtension(): Extension {
  return {
    name: "japa.wakes",
    register: (host) => ({ name: "japa.wakes", tasks: [wakeTask(host)] }),
  };
}
