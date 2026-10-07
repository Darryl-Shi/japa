import type { JsonRepresentation } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import type { Action, Address } from "../core/contracts.ts";
import type { Extension } from "../core/host.ts";
import { Jobs } from "./jobs.ts";
import { turnAddress } from "./messaging.ts";

export type Approval = {
  id: string;
  action: JsonRepresentation<Action>;
  reason: string;
  address: Address;
  expiresAt: number;
  status: "pending" | "approved" | "denied";
};
export const Approvals = defineDoc<{ items: Approval[] }>({
  kind: "japa.approvals",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31,
});

export function approvalsExtension(timeoutMs = 10 * 60_000): Extension {
  return {
    name: "japa.approvals",
    adapters: {
      approvals: (host) => ({
        async request(action, reason, context) {
          const jobs = await host.harness.snapshot(Jobs, context);
          const address =
            jobs?.items.find(
              (job) => job.conversationId === action.conversationId,
            )?.address ?? (await turnAddress(host, context));
          if (!address) return false;
          await host.harness.commit(async (tx) => {
            const approvals = await tx.doc(Approvals);
            if (!approvals.items.some((item) => item.id === action.id)) {
              approvals.items.push({
                id: action.id,
                action: JSON.parse(
                  JSON.stringify(action),
                ) as JsonRepresentation<Action>,
                reason,
                address,
                expiresAt: Date.now() + timeoutMs,
                status: "pending",
              });
            }
          }, context);
          const watch = (await host.harness.watchDoc(Approvals, context))!;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const pending = watch.value!.items.find(
              (item) => item.id === action.id,
            )!;
            if (pending.status !== "pending")
              return pending.status === "approved";
            const remaining = pending.expiresAt - Date.now();
            if (remaining <= 0) {
              await host.adapters.approvals.resolve(
                action.id,
                false,
                pending.address,
                context,
              );
              return false;
            }
            await host.adapters.channel.send(
              pending.address,
              {
                text: `${reason}\nTool: ${action.call.name}\nArguments: ${JSON.stringify(action.call.arguments)}\n/approve ${action.id}\n/deny ${action.id}`,
              },
              `approval:${action.id}`,
              context,
            );
            const decision = new Promise<boolean>((resolve) => {
              watch.start(async (value) => {
                const item = value?.items.find((item) => item.id === action.id);
                if (item && item.status !== "pending")
                  resolve(item.status === "approved");
              });
              timer = setTimeout(
                () => resolve(false),
                Math.max(0, pending.expiresAt - Date.now()),
              );
            });
            const approved = await awaitWithContext(decision, context);
            if (!approved)
              await host.adapters.approvals.resolve(
                action.id,
                false,
                pending.address,
                context,
              );
            return approved;
          } finally {
            clearTimeout(timer);
            await watch.stop();
          }
        },
        async resolve(id, approved, address, context) {
          await host.harness.commit(async (tx) => {
            const item = (await tx.doc(Approvals)).items.find(
              (item) => item.id === id,
            );
            if (!item) throw new Error(`Unknown approval: ${id}`);
            if (
              item.address.channel !== address.channel ||
              item.address.recipient !== address.recipient
            ) {
              throw new Error("This approval belongs to a different address");
            }
            if (item.status === "pending")
              item.status =
                approved && Date.now() < item.expiresAt ? "approved" : "denied";
          }, context);
        },
      }),
    },
  };
}
