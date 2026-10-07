import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Jobs } from "../src/extensions/jobs.ts";
import { context, fixture, until } from "./helpers.ts";

test("job history is searchable across restarts without entering personal memory", async (t) => {
  const app = await fixture(
    t,
    (_request, _options, _state, model) =>
      fauxAssistantMessage(
        model.id === "worker" ? "Verified artifact: itinerary.md" : "Reviewed",
      ),
    { sqlite: true },
  );
  for (const [key, title, instructions] of [
    ["old-trip", "Kyoto trip", "Find a quiet hotel near the station"],
    ["new-work", "Project notes", "Summarize the release"],
  ]) {
    await app.host.adapters.jobs.start(
      {
        title: title!,
        instructions: instructions!,
        address: { channel: "test", recipient: "owner" },
      },
      key!,
      context,
    );
  }
  await until(async () =>
    (await app.host.adapters.jobs.list(context)).every(
      (job) => job.status === "completed",
    ),
  );
  await app.reopen();
  assert.deepEqual(
    (await app.host.adapters.jobs.search("Kyoto quiet hotel", 10, context)).map(
      (job) => job.id,
    ),
    ["old-trip"],
  );
  assert.equal(
    (await app.host.adapters.jobs.search("itinerary.md", 10, context)).length,
    2,
  );
  assert.equal(
    (await app.host.adapters.jobs.search("ＫＹＯＴＯ", 1, context))[0]!.id,
    "old-trip",
  );
  const found = await app.host.adapters.jobs.search("Kyoto", 1, context);
  found[0]!.address.recipient = "mutated";
  assert.equal(
    (await app.host.adapters.jobs.search("Kyoto", 1, context))[0]!.address
      .recipient,
    "owner",
  );
  for (const limit of [0, -1, NaN, Infinity])
    assert.deepEqual(
      await app.host.adapters.jobs.search("Kyoto", limit, context),
      [],
    );
  assert.deepEqual(await app.host.adapters.jobs.search("!!!", 10, context), []);
  assert.equal((await app.host.adapters.memory.read(context)).text, "");
});

test("search covers old records rather than only the executive brief's latest jobs", async (t) => {
  const app = await fixture(t, () => fauxAssistantMessage("Hello"));
  const first = await app.host.adapters.jobs.start(
    {
      title: "Needle",
      instructions: "An old decision",
      address: { channel: "test", recipient: "owner" },
    },
    "oldest",
    context,
  );
  await until(
    async () =>
      (await app.host.adapters.jobs.list(context))[0]!.status === "completed",
  );
  await app.host.harness.commit(async (tx) => {
    const doc = await tx.doc(Jobs);
    for (let i = 0; i < 100; i++)
      doc.items.push({
        ...first,
        id: `later-${i}`,
        title: "Other work",
        instructions: "Unrelated",
        status: "completed",
        updatedAt: first.updatedAt + i + 1,
      });
  }, context);
  assert.deepEqual(
    (await app.host.adapters.jobs.search("Needle", 10, context)).map(
      (job) => job.id,
    ),
    ["oldest"],
  );
  assert.equal(
    (await app.host.adapters.jobs.search("Other work", 1_000, context)).length,
    20,
  );
});
