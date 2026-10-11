import type { EntryRecord } from "@earendil-works/pi-durable";

export type Call = { name: string; args: Record<string, unknown>; result?: string };

const entry = (id: number, kind: string, message?: object, extra: object = {}) =>
  ({ id, conversationId: 1, kind, model: message && [message], ...extra }) as unknown as EntryRecord;

const input = (id: number, text: string, at?: number) =>
  entry(id, "pi.user", { role: "user", content: text, ...(at === undefined ? {} : { timestamp: at }) });

/** The tool call id of the result entry `id`. */
const callId = (id: number) => `call-${id}`;

/** A user input. */
export const you = (id: number, text: string, at?: number): EntryRecord => input(id, text, at);

/** An automated input, such as `[job 68 "Cleanup" done] …`. */
export const auto = (id: number, text: string, at?: number): EntryRecord => input(id, text, at);

/** A result entry for the call `call-<id>`. */
export const toolResult = (id: number, name: string, text: string): EntryRecord =>
  entry(id, "pi.tool-result", {
    role: "toolResult",
    toolCallId: callId(id),
    toolName: name,
    content: [{ type: "text", text }],
  });

/**
 * An assistant message with `text` and `calls`, then a result entry for each call that has a `result`. Call `i` is
 * answered by entry `id + 1 + i`, so the next free id is `id + 1 + calls.length`.
 */
export function reply(id: number, text: string, at?: number, calls: Call[] = []): EntryRecord[] {
  const parts = [
    ...(text === "" ? [] : [{ type: "text", text }]),
    ...calls.map((c, i) => ({ type: "toolCall", id: callId(id + 1 + i), name: c.name, arguments: c.args })),
  ];
  const results = calls.flatMap((c, i) => (c.result === undefined ? [] : [toolResult(id + 1 + i, c.name, c.result)]));
  const message = { role: "assistant", content: parts, ...(at === undefined ? {} : { timestamp: at }) };
  return [entry(id, "pi.assistant", message), ...results];
}

/** A context reset carrying over an earlier exchange. */
export const reset = (id: number): EntryRecord =>
  entry(id, "pi.reset", { role: "user", content: "[Your last exchange]\nuser: older" }, { head: id });
