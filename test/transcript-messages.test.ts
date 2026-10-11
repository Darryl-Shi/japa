import type { EntryRecord } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { transcriptMessages } from "../src/kernel/memory/transcript.ts";
import { auto, reply, reset, you } from "./history-helpers.ts";

test("user, reply and tool traffic become one you and one japa message", () => {
  const messages = transcriptMessages([
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
  const [, japa] = transcriptMessages([
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
  const [, japa] = transcriptMessages([
    you(1, "go", 1000),
    ...reply(2, "Done.", 2000, [
      { name: "job_message", args: { id: 68, text: "and maria" } },
      { name: "schedule_add", args: { cron: "0 9 * * *" }, result: "Added Schedule 10." },
      { name: "page_write", args: { title: "Server", text: "…" } },
    ]),
  ]);
  expect(japa!.did).toBe("did: job_message 68, schedule_add (schedule 10), page_write Server");

  const [, long] = transcriptMessages([
    you(1, "go", 1000),
    ...reply(2, "Done.", 2000, [{ name: "page_write", args: { title: "x".repeat(300) } }]),
  ]);
  expect(long!.did!.length).toBe(160);
  expect(long!.did!.startsWith("did: page_write xxx")).toBe(true);
});

test("a run with no assistant text gives no message", () => {
  expect(
    transcriptMessages([
      you(1, "go", 1000),
      ...reply(2, "", 2000, [{ name: "job_start", args: { title: "Cleanup" }, result: "Started job 68." }]),
    ]),
  ).toEqual([{ id: 1, kind: "you", text: "go", at: 1000 }]);
});

test("automated inputs are auto with their job", () => {
  expect(
    transcriptMessages([
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
  const [message] = transcriptMessages([image]);
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
    transcriptMessages([
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
