import { hook, ToolTask } from "@earendil-works/pi-durable";
import type { PolicyDecision } from "../core/contracts.ts";
import type { Extension } from "../core/host.ts";

/** Explicit tool rules, not a shell-command classifier or a security sandbox. */
export function policyExtension(
  rules: Readonly<Record<string, PolicyDecision>> = {},
): Extension {
  return {
    name: "japa.policy",
    adapters: {
      policy: () => ({
        async decide(action) {
          return rules[action.call.name] ?? { action: "allow" };
        },
      }),
    },
    register: (host) => ({
      name: "japa.policy",
      hooks: [
        hook(ToolTask, {
          async beforeTool(call, api, context) {
            const action = {
              id: `action-${api.taskId}`,
              conversationId: api.conversationId,
              call,
            };
            const decision = await host.adapters.policy.decide(action, context);
            if (decision.action === "deny") return { block: decision.reason };
            if (decision.action === "ask") {
              const approved = await host.adapters.approvals.request(
                action,
                decision.reason,
                context,
              );
              if (!approved)
                return {
                  block: "The user denied this action, or the approval expired",
                };
            }
            return undefined;
          },
        }),
      ],
    }),
  };
}
