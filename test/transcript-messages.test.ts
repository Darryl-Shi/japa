import type { EntryRecord } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { slim, transcriptMessages } from "../src/kernel/memory/transcript.ts";
import { auto, reply, reset, toolResult, you } from "./history-helpers.ts";

/** Every entry of `entries` slimmed, the dropped ones left out. */
const slimAll = (entries: readonly EntryRecord[]) => entries.flatMap((e) => slim(e) ?? []);

/** The messages of `entries`, checked to be the same from their slim copies. */
function derive(entries: readonly EntryRecord[]) {
  const messages = transcriptMessages(entries);
  expect(transcriptMessages(slimAll(entries))).toEqual(messages);
  return messages;
}

test("user, reply and tool traffic become one you and one japa message", () => {
  const messages = derive([
    you(1, "clean up the server", 1000),
    ...reply(2, "Starting it.", 2000, [{ name: "job_start", args: { title: "Cleanup" }, result: "Started job 68." }]),
    ...reply(4, "Job 68 is running.", 3000),
  ]);
  expect(messages).toEqual([
    { id: 1, kind: "you", text: "clean up the server", at: 1000 },
    { id: 2, kind: "japa", text: "Starting it.\nJob 68 is running.", at: 2000, did: "did: job_start Cleanup (job 68)" },
  ]);
});

test("read-only calls are left out of did", () => {
  const [, japa] = derive([
    you(1, "what's running?", 1000),
    ...reply(2, "", 2000, [
      { name: "read", args: { path: "/x" }, result: "FILE" },
      { name: "job_list", args: {}, result: "job 68: running" },
    ]),
    ...reply(5, "Job 68 is running.", 3000),
  ]);
  expect(japa).toEqual({ id: 2, kind: "japa", text: "Job 68 is running.", at: 2000 });
  expect(japa!.did).toBeUndefined();
});

test("did lists every changing call, and is cut to 160 characters", () => {
  const [, japa] = derive([
    you(1, "go", 1000),
    ...reply(2, "Done.", 2000, [
      { name: "job_message", args: { id: 68, text: "and maria" } },
      { name: "schedule_add", args: { cron: "0 9 * * *" }, result: "Added Schedule 10." },
      { name: "page_write", args: { title: "Server", text: "…" } },
    ]),
  ]);
  expect(japa!.did).toBe("did: job_message 68, schedule_add (schedule 10), page_write Server");

  const [, long] = derive([
    you(1, "go", 1000),
    ...reply(2, "Done.", 2000, [{ name: "page_write", args: { title: "x".repeat(300) } }]),
  ]);
  expect(long!.did!.length).toBe(160);
  expect(long!.did!.startsWith("did: page_write xxx")).toBe(true);
});

test("a run with no assistant text gives no message", () => {
  expect(
    derive([
      you(1, "go", 1000),
      ...reply(2, "", 2000, [{ name: "job_start", args: { title: "Cleanup" }, result: "Started job 68." }]),
    ]),
  ).toEqual([{ id: 1, kind: "you", text: "go", at: 1000 }]);
});

test("automated inputs are auto with their job", () => {
  expect(
    derive([
      auto(1, '[job 68 "Cleanup" done] Server 1 cleanup is done.', 1000),
      auto(2, "[whatsapp] unlinked", 2000),
      auto(3, "[google: couldn't connect: token expired]", 3000),
    ]),
  ).toEqual([
    { id: 1, kind: "auto", text: '[job 68 "Cleanup" done] Server 1 cleanup is done.', at: 1000, job: "68" },
    { id: 2, kind: "auto", text: "[whatsapp] unlinked", at: 2000 },
    { id: 3, kind: "auto", text: "[google: couldn't connect: token expired]", at: 3000 },
  ]);
});

test("an image-only input is you, not auto", () => {
  const image = {
    id: 1,
    conversationId: 1,
    kind: "pi.user",
    model: [
      {
        role: "user",
        content: [
          { type: "text", text: "\n[image saved to /x.png]" },
          { type: "image", data: "...", mimeType: "image/png" },
        ],
        timestamp: 1000,
      },
    ],
  } as unknown as EntryRecord;
  const [message] = derive([image]);
  expect(message!.kind).toBe("you");
  expect(message!.text).toContain("[image saved to /x.png]");
  expect(message!.text).toContain("[image]");
});

test("resets and compactions are skipped, and missing timestamps inherit", () => {
  const compaction = {
    id: 4,
    conversationId: 1,
    kind: "pi.compaction",
    model: [{ role: "user", content: "summary", timestamp: 9000 }],
    head: 4,
  } as unknown as EntryRecord;
  const system = {
    id: 5,
    conversationId: 1,
    kind: "pi.system",
    model: [{ role: "system", content: "be nice" }],
  } as unknown as EntryRecord;
  expect(
    derive([
      you(1, "first"),
      ...reply(2, "One."),
      reset(3),
      compaction,
      system,
      you(6, "second", 5000),
      ...reply(7, "Two."),
    ]),
  ).toEqual([
    { id: 1, kind: "you", text: "first", at: 0 },
    { id: 2, kind: "japa", text: "One.", at: 0 },
    { id: 6, kind: "you", text: "second", at: 5000 },
    { id: 7, kind: "japa", text: "Two.", at: 5000 },
  ]);
});

/** A run's assistant message with `text` that stopped for `stopReason`. */
const stopped = (id: number, text: string, at: number, stopReason: string): EntryRecord => {
  const [entry] = reply(id, text, at);
  return { ...entry!, model: [{ ...entry!.model![0]!, stopReason }] } as unknown as EntryRecord;
};

test("an aborted or errored partial is dropped when a later message in the run has text", () => {
  expect(
    derive([
      you(1, "summarise it", 1000),
      stopped(2, "The summary is: half", 2000, "error"),
      stopped(3, "The summ", 2500, "aborted"),
      stopped(4, "The summary is: whole.", 3000, "stop"),
    ]),
  ).toEqual([
    { id: 1, kind: "you", text: "summarise it", at: 1000 },
    { id: 2, kind: "japa", text: "The summary is: whole.", at: 2000 },
  ]);

  // With nothing after it, the partial is all the user saw, so it stays; so does text before it.
  expect(
    derive([
      you(1, "go", 1000),
      stopped(2, "Starting.", 2000, "toolUse"),
      stopped(3, "Half a repl", 3000, "aborted"),
    ]),
  ).toEqual([
    { id: 1, kind: "you", text: "go", at: 1000 },
    { id: 2, kind: "japa", text: "Starting.\nHalf a repl", at: 2000 },
  ]);

  // A later message with no text doesn't replace it.
  expect(
    derive([you(1, "go", 1000), stopped(2, "Half", 2000, "error"), ...reply(3, "", 3000, [{ name: "job_list", args: {} }])]),
  ).toEqual([
    { id: 1, kind: "you", text: "go", at: 1000 },
    { id: 2, kind: "japa", text: "Half", at: 2000 },
  ]);
});

test("slim copies keep what the messages need and little else", () => {
  const image = {
    id: 1,
    conversationId: 1,
    kind: "pi.user",
    model: [
      {
        role: "user",
        content: [
          { type: "text", text: "what's this?\n[image saved to /x.png]" },
          { type: "image", data: "A".repeat(1_000_000), mimeType: "image/png" },
        ],
        timestamp: 1000,
      },
    ],
  } as unknown as EntryRecord;
  const system = {
    id: 2,
    conversationId: 1,
    kind: "pi.system",
    model: [{ role: "system", content: "s".repeat(50_000), timestamp: 1000 }],
  } as unknown as EntryRecord;
  const [call] = reply(3, "Looking.", 2000, [{ name: "bulky_tool", args: { path: "/x", text: "t".repeat(20_000) } }]);
  const thought = {
    ...call!,
    model: [{ ...call!.model![0]!, content: [{ type: "thinking", thinking: "h".repeat(20_000) }, ...(call!.model![0]!.content as object[])] }],
  } as unknown as EntryRecord;
  const bulky = toolResult(4, "bulky_tool", `${"r".repeat(50_000)} job 68 ${"r".repeat(50_000)}`);
  const plain = toolResult(4, "bulky_tool", "p".repeat(100_000));
  const compaction = {
    id: 6,
    conversationId: 1,
    kind: "pi.compaction",
    model: [{ role: "user", content: "c".repeat(20_000), timestamp: 3000 }],
    head: 6,
  } as unknown as EntryRecord;
  const entries = [image, system, thought, bulky, ...reply(5, "It's a diagram.", 3000), compaction, reset(7)];
  const messages = derive(entries);
  expect(messages).toEqual([
    { id: 1, kind: "you", text: "what's this?\n[image saved to /x.png][image]", at: 1000 },
    { id: 3, kind: "japa", text: "Looking.\nIt's a diagram.", at: 2000, did: "did: bulky_tool /x (job 68)" },
  ]);

  const kept = slimAll(entries);
  expect(JSON.stringify(kept).length).toBeLessThan(5000);
  expect(kept.map((e) => e.kind)).toEqual(["pi.user", "pi.assistant", "pi.tool-result", "pi.assistant", "pi.reset"]);
  expect(kept.at(-1)).toEqual({ id: 7, kind: "pi.reset" });
  // A result naming nothing keeps its first 300 characters.
  expect(JSON.stringify(slim(plain)).length).toBeLessThan(500);
  derive([image, thought, plain]);
});
