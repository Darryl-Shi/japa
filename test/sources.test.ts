import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type AgentEvent, type EntryId, UserEntry } from "@earendil-works/pi-durable";
import { expect, test, vi } from "vitest";
import { reportText } from "../src/kernel/jobs/state.ts";
import type { Job } from "../src/kernel/jobs/state.ts";
import { sourceOf } from "../src/kernel/origin.ts";
import type { InputSource } from "../src/sdk.ts";
import { bootTest, probe } from "./helpers.ts";
import { script } from "./jobs-helpers.ts";

const job = (title: string, status: Job["status"]) => ({ id: "7", title, status }) as Job;

test("a person's input is a person's, whatever its text", () => {
  expect(sourceOf("surface:telegram:42:7", "hi")).toEqual({ type: "person", surface: "telegram", chat: "42" });
  expect(sourceOf("surface:webui::1", '[job abc "x" done] hi')).toEqual({ type: "person", surface: "webui" });
  expect(sourceOf(undefined, '[job 7 "x" done] hi')).toEqual({ type: "person", surface: "gateway" });
});

test("a job report is parsed from the header reportText wrote", () => {
  const text = `${reportText(job("Find flights", "done"), "Found **3**.")}\n\nThe changes are live.`;
  expect(sourceOf("report:7:2", text)).toEqual({
    type: "job_report",
    jobId: "7",
    title: "Find flights",
    status: "done",
    text: "Found **3**.\n\nThe changes are live.",
  });
  // A retried report's requestId has an attempt.
  expect(sourceOf("report:7:2:1", reportText(job("x", "failed"), "boom"))).toMatchObject({
    jobId: "7",
    status: "failed",
    text: "boom",
  });
  expect(sourceOf("report:7:3", reportText(job("x", "cancelled"), ""))).toMatchObject({
    status: "cancelled",
    text: "",
  });
  expect(sourceOf("report:7:4", reportText(job("x", "needs_input"), "Which?"))).toMatchObject({
    status: "needs_input",
  });
});

test("a job title may hold quotes and brackets", () => {
  const title = 'Say "hi" [then] "bye" done';
  expect(sourceOf("report:7:1", reportText(job(title, "done"), 'He said "ok" done] fine'))).toEqual({
    type: "job_report",
    jobId: "7",
    title,
    status: "done",
    text: 'He said "ok" done] fine',
  });
});

test("a report whose text doesn't parse, or names another job, is a note", () => {
  expect(sourceOf("report:7:1", "something else")).toEqual({ type: "note" });
  expect(sourceOf("report:7:1", '[job 8 "x" done] hi')).toEqual({ type: "note" });
  expect(sourceOf("report:7:1", '[job 7 "x" exploded] hi')).toEqual({ type: "note" });
});

test("other kernel inputs are notes; a trigger's names its extension", () => {
  expect(sourceOf("trigger:schedule:3:5", "[schedule] Call mum")).toEqual({ type: "note", from: "schedule" });
  for (const id of ["secret:3", "secret-declined:3", "rollback:abc", "safe-mode:abc", "memory:v2-loops", "connect:1"]) {
    expect(sourceOf(id, "[japa] x")).toEqual({ type: "note" });
  }
});

type Batch = { events: readonly AgentEvent[]; sources: ReadonlyMap<EntryId, InputSource> };
const userIds = (b: Batch) =>
  b.events
    .flatMap((e) => (e.type === "snapshot" ? e.entries : e.type === "message_end" ? [e.entry] : []))
    .filter((e) => e.kind === UserEntry.kind)
    .map((e) => e.id);

test("each batch carries the sources of its user entries, live and in snapshots", async () => {
  const { extension, surface } = probe();
  const { daemon, faux } = await bootTest({}, [extension]);
  script(faux, () => undefined);
  const live: Batch[] = [];
  const watch = await surface().root.events((events, sources) => live.push({ events, sources }));

  const report = reportText(job('Say "hi" [now]', "done"), "All **good**.");
  await surface().root.submit("hello", undefined, { surface: "webui" });
  await daemon.root.waitForIdle(ctx);
  await daemon.root.submit({ type: "input", content: report, requestId: "report:7:1" }, ctx);
  await daemon.root.waitForIdle(ctx);
  await daemon.root.submit({ type: "input", content: "[schedule] wake", requestId: "trigger:schedule:a:1" }, ctx);
  await daemon.root.waitForIdle(ctx);
  await surface().root.submit('[job abc "x" done] typed', undefined, { surface: "webui" });
  await daemon.root.waitForIdle(ctx);

  const expected = [
    { type: "person", surface: "webui" },
    { type: "job_report", jobId: "7", title: 'Say "hi" [now]', status: "done", text: "All **good**." },
    { type: "note", from: "schedule" },
    { type: "person", surface: "webui" },
  ];
  await vi.waitFor(() => expect(live.flatMap(userIds)).toHaveLength(4));
  // Every user entry's source is in its own batch.
  for (const b of live) for (const id of userIds(b)) expect(b.sources.has(id)).toBe(true);
  expect(live.flatMap((b) => userIds(b).map((id) => b.sources.get(id)))).toEqual(expected);

  // A fresh snapshot carries them all.
  const again: Batch[] = [];
  const second = await surface().root.events((events, sources) => again.push({ events, sources }));
  expect(again[0]!.events[0]!.type).toBe("snapshot");
  expect(userIds(again[0]!).map((id) => again[0]!.sources.get(id))).toEqual(expected);
  await watch.stop();
  await second.stop();
  await daemon.close();
});

test("a one-argument listener still works", async () => {
  const { extension, surface } = probe();
  const { daemon } = await bootTest({}, [extension]);
  const seen: AgentEvent[][] = [];
  const watch = await surface().root.events((events) => seen.push([...events]));
  expect(seen[0]![0]!.type).toBe("snapshot");
  await watch.stop();
  await daemon.close();
});
