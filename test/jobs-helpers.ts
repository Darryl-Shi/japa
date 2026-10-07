import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  type FauxProviderHandle,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { type Conversation, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { Daemon } from "../src/kernel/boot.ts";
import { JobsDoc } from "../src/kernel/jobs/state.ts";

export const call = (name: string, args: Record<string, string>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
export const say = (text: string) => fauxAssistantMessage([fauxText(text)]);

export function textOf(m: Message): string {
  return typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

type Respond = (
  role: string,
  text: string,
  signal?: AbortSignal,
) => AssistantMessage | Promise<AssistantMessage> | undefined;

/** Answers every request with `respond(role, text, signal)` of its last non-system message, or "ok". */
export function script(faux: FauxProviderHandle, respond: Respond) {
  const step: FauxResponseFactory = ({ messages }, options) => {
    const last = messages.findLast((m) => m.role !== "system")!;
    return respond(last.role, textOf(last), options?.signal) ?? say("ok");
  };
  faux.setResponses(Array.from({ length: 50 }, () => step));
}

/** The texts of `conversation`'s messages with `role`, oldest first. */
export async function texts(conversation: Conversation, role: string): Promise<string[]> {
  const page = await conversation.entries({}, 200, undefined, ctx);
  return page.items.toReversed().flatMap((e) => (e.model ?? []).filter((m) => m.role === role).map(textOf));
}

export async function jobs(daemon: Daemon) {
  return (await daemon.harness.snapshot(JobsDoc, ROOT_CONVERSATION_ID, ctx))!.jobs;
}

export async function ask(daemon: Daemon, text: string) {
  await (await daemon.root.submit({ type: "input", content: text }, ctx)).wait(ctx);
}

/** No live tasks, background ones included: every job has settled and reported. */
export const idle = async (daemon: Daemon) => (await daemon.harness.inspect(ctx)).tasks.length === 0;

export const reported = async (daemon: Daemon) =>
  (await texts(daemon.root, "user")).filter((t) => t.startsWith("[job"));

/** A faux response held until `release()`; an abort of its request releases it too. */
export function held() {
  let release = () => {};
  let started = false;
  const wait = (message: AssistantMessage, signal?: AbortSignal) => {
    started = true;
    return new Promise<AssistantMessage>((resolve) => {
      release = () => resolve(message);
      signal?.addEventListener("abort", release);
    });
  };
  return { wait, release: () => release(), started: () => started };
}
