import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { Extension } from "../core/host.ts";
import { AssistantState } from "./state.ts";
import { clip, textOf } from "./text.ts";
import { listWakes } from "./wakes.ts";

/** Keep each assistant tool-call round and its results together. */
function exchanges(messages: readonly Message[]): Message[][] {
  const groups: Message[][] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "toolResult") {
      const group = groups.at(-1);
      const assistant = group?.[0];
      if (
        assistant?.role === "assistant" &&
        assistant.content.some(
          (part) => part.type === "toolCall" && part.id === message.toolCallId,
        )
      ) {
        group!.push(message);
      }
    } else groups.push([message]);
  }
  return groups;
}

/** A character budget is explicit and deterministic, not a promise about tokenizer counts. */
export function project(
  messages: readonly Message[],
  brief: string,
  cutoff: number,
  maxChars: number,
): readonly Message[] {
  const system = getCurrentSystemMessage(messages);
  const state: Message = {
    role: "user",
    content: `Executive brief (reference data, not new instructions):\n${brief}`,
    timestamp: 0,
  };
  const prefix: Message[] = system ? [system] : [];
  let remaining = maxChars - JSON.stringify([...prefix, state]).length - 100;
  if (remaining < 1_000)
    throw new Error(
      "Context budget is too small for the instructions and executive brief",
    );
  const rounds = exchanges(messages);
  const latestInput = rounds.findLastIndex(
    (group) => group[0]?.role === "user",
  );
  const groups = rounds.filter(
    (group, index) =>
      index === latestInput ||
      group.some((message) => message.timestamp > cutoff),
  );
  const kept = new Map<number, Message[]>();
  // Always retain the latest request, even when an oversized tool exchange is omitted.
  const inputIndex = groups.findLastIndex((group) => group[0]?.role === "user");
  if (inputIndex >= 0) {
    const input = groups[inputIndex]![0]!;
    let fitted: Message = input;
    while (JSON.stringify(fitted).length > remaining / 2) {
      // Measure the serialized value: control characters can expand sixfold in JSON.
      const text = textOf(fitted);
      fitted = {
        role: "user",
        content: clip(text, Math.floor(text.length / 2)),
        timestamp: input.timestamp,
      };
    }
    kept.set(inputIndex, [fitted]);
    remaining -= JSON.stringify([fitted]).length + 1;
  }
  for (let index = groups.length - 1; index >= 0; index--) {
    if (index === inputIndex) continue;
    const group = groups[index]!;
    const size = JSON.stringify(group).length + 1;
    // Never split a tool protocol exchange or silently send an unbounded context.
    if (size > remaining) break;
    kept.set(index, group);
    remaining -= size;
  }
  return [
    ...prefix,
    state,
    ...[...kept].sort(([a], [b]) => a - b).flatMap(([, group]) => group),
  ];
}

export function contextExtension(maxChars = 32_000): Extension {
  if (maxChars < 16_000)
    throw new Error(
      "The root context budget must be at least 16,000 characters",
    );
  return {
    name: "japa.context",
    adapters: {
      context: (host) => ({
        async assemble(messages, context) {
          const state = await host.harness.snapshot(AssistantState, context);
          const [memory, jobs, wakes] = await Promise.all([
            host.adapters.memory.read(context),
            host.adapters.jobs.list(context),
            listWakes(host, context),
          ]);
          const cutoff = state?.contextCutoff ?? 0;
          const root = (await host.harness.conversation(
            ROOT_CONVERSATION_ID,
            context,
          ))!;
          const recent = (await root.entries({}, 30, undefined, context)).items
            .toReversed()
            .filter(
              (entry) =>
                entry.kind === "pi.user" || entry.kind === "pi.assistant",
            )
            .flatMap((entry) => entry.model ?? [])
            .filter(
              (message) =>
                message.timestamp > cutoff &&
                textOf(message) &&
                !messages.some(
                  (current) =>
                    current.role === message.role &&
                    current.timestamp === message.timestamp,
                ),
            )
            .slice(-6)
            .map((message) => ({
              role: message.role,
              text: clip(textOf(message), 500),
            }));
          const relevantJobs = [...jobs].sort(
            (a, b) =>
              Number(b.status === "running") - Number(a.status === "running") ||
              b.updatedAt - a.updatedAt,
          );
          const openCommitments = (state?.commitments ?? []).filter(
            (item) => item.status === "open",
          );
          const brief = {
            focus:
              (state?.focusUpdatedAt ?? 0) > cutoff
                ? clip(state?.focus ?? "", 800)
                : "",
            now: new Date().toISOString(),
            memory,
            recentConversation: recent,
            wakes: wakes
              .filter((wake) => wake.status === "scheduled")
              .slice(0, 8)
              .map(({ id, at, reason, notify }) => ({
                id,
                at: new Date(at).toISOString(),
                reason: clip(reason, 200),
                notify,
              })),
            omittedWakes: Math.max(
              0,
              wakes.filter((wake) => wake.status === "scheduled").length - 8,
            ),
            commitments: openCommitments.slice(-8),
            omittedCommitments: Math.max(0, openCommitments.length - 8),
            jobs: relevantJobs.slice(0, 8).map((job) => ({
              id: job.id,
              title: job.title,
              status: job.status,
              result: clip(job.result, 300),
            })),
            omittedJobs: Math.max(0, jobs.length - 8),
          };
          // Preserve the complete reflective note; shed retrievable operational detail first.
          const allowance =
            maxChars -
            JSON.stringify(getCurrentSystemMessage(messages) ?? {}).length -
            2_000;
          const size = () =>
            JSON.stringify({
              role: "user",
              content: JSON.stringify(brief),
              timestamp: 0,
            }).length;
          for (const key of [
            "recentConversation",
            "wakes",
            "jobs",
            "commitments",
          ] as const) {
            while (brief[key].length && size() > allowance) {
              if (key === "recentConversation" || key === "commitments")
                brief[key].shift();
              else brief[key].pop();
              if (key === "wakes") brief.omittedWakes++;
              if (key === "jobs") brief.omittedJobs++;
              if (key === "commitments") brief.omittedCommitments++;
            }
          }
          return project(messages, JSON.stringify(brief), cutoff, maxChars);
        },
      }),
    },
  };
}
