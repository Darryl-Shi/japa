import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Conversation, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { createHistory } from "../src/kernel/memory/history.ts";
import { reply, toolResult, you } from "./history-helpers.ts";

type Query = { minEntryId?: EntryId };

/** A stand-in root: `entries` pages newest first with an offset cursor; `gate` (when set) holds each read. */
function stubRoot() {
  const log: EntryRecord[] = [];
  const reads: { query: Query; limit: number }[] = [];
  const stub = {
    log,
    reads,
    gate: undefined as Promise<void> | undefined,
    root: {
      async entries(query: Query, limit: number, cursor: number | undefined) {
        reads.push({ query, limit });
        if (stub.gate !== undefined) await stub.gate;
        const min = query.minEntryId ?? 0;
        const newestFirst = log.filter((e) => e.id >= min).reverse();
        const from = cursor ?? 0;
        const items = newestFirst.slice(from, from + limit);
        return { items, ...(from + limit < newestFirst.length ? { next: from + limit } : {}) };
      },
    } as unknown as Conversation,
  };
  return stub;
}

test("the mirror pages past 200 entries, and a run split across refreshes keeps its id and gets its did", async () => {
  const stub = stubRoot();
  // 130 exchanges: 260 entries.
  for (let i = 0; i < 130; i++) stub.log.push(you(2 * i + 1, `question ${i}`, 1000 + i), ...reply(2 * i + 2, `answer ${i}`));
  const history = createHistory();
  history.attach(stub.root);

  const first = await history.refresh(ctx);
  expect(first.messages).toHaveLength(260);
  expect(first.messages[0]).toMatchObject({ id: 1, kind: "you", text: "question 0" });
  expect(first.messages.at(-1)).toMatchObject({ id: 260, kind: "japa", text: "answer 129" });
  expect(stub.reads.length).toBeGreaterThan(1); // more than one page

  // A run whose tool result hasn't arrived yet.
  stub.log.push(
    you(261, "clean up", 5000),
    reply(262, "Starting.", 5001, [{ name: "job_start", args: { title: "Cleanup" } }])[0]!,
  );
  const second = await history.refresh(ctx);
  expect(stub.reads.at(-1)!.query.minEntryId).toBe(261);
  expect(second.messages.at(-1)).toEqual({ id: 262, kind: "japa", text: "Starting.", at: 5001, did: "did: job_start Cleanup" });

  // Its result and the rest of the run arrive.
  stub.log.push(toolResult(263, "job_start", "Started job 68."), ...reply(264, "Job 68 is running.", 5002));
  const third = await history.refresh(ctx);
  expect(third.messages).toHaveLength(262);
  expect(third.messages.at(-1)).toEqual({
    id: 262,
    kind: "japa",
    text: "Starting.\nJob 68 is running.",
    at: 5001,
    did: "did: job_start Cleanup (job 68)",
  });
});

test("re-attaching mid-refresh drops the stale refresh", async () => {
  const stub = stubRoot();
  stub.log.push(you(1, "one", 1), ...reply(2, "two", 2));
  const history = createHistory();
  history.attach(stub.root);
  await history.refresh(ctx);

  stub.log.push(you(3, "three", 3), ...reply(4, "four", 4));
  let release!: () => void;
  stub.gate = new Promise((resolve) => (release = resolve));
  const stale = history.refresh(ctx);
  while (stub.reads.length < 2) await Promise.resolve(); // the stale refresh is reading
  history.attach(stub.root); // the same root, again
  stub.gate = undefined;
  const fresh = history.refresh(ctx);
  release();
  await stale;
  expect((await fresh).messages.map((m) => m.text)).toEqual(["one", "two", "three", "four"]);
});
