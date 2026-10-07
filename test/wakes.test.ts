import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ToolCall } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { AssistantState } from "../src/extensions/state.ts";
import { textOf } from "../src/extensions/text.ts";
import {
  cancelWake,
  listWakes,
  scheduleWake,
  wakeChiefOfStaff,
} from "../src/extensions/wakes.ts";
import { context, fixture, until } from "./helpers.ts";

const address = { channel: "test", recipient: "alice" };
const call = (name: string, args: ToolCall["arguments"]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("an overdue SQLite wake resumes once, retains its address, and deduplicates scheduling", async (t) => {
  let turns = 0;
  const app = await fixture(
    t,
    () => {
      turns++;
      return fauxAssistantMessage("Time to follow through");
    },
    { sqlite: true },
  );
  const request = {
    address,
    at: Date.now() + 150,
    reason: "Review the trip",
    notify: true,
  };
  const first = await scheduleWake(app.host, request, "trip-review", context);
  const repeat = await scheduleWake(
    app.host,
    { ...request, reason: "Changed retry" },
    "trip-review",
    context,
  );
  assert.equal(first.taskId, repeat.taskId);
  assert.equal(repeat.reason, request.reason);
  await app.host.close();
  await delay(180);
  await app.reopen();
  await until(() => app.sent.length === 1);
  assert.equal(app.sent[0]!.recipient, "alice");
  assert.equal((await listWakes(app.host, context))[0]!.status, "fired");
  await app.reopen();
  assert.equal(turns, 1);
  const state = await app.host.harness.snapshot(AssistantState, context);
  assert.equal(
    Object.keys(state!.receipts).filter((key) => key === "wake:trip-review")
      .length,
    1,
  );
  assert.deepEqual(app.errors, []);
});

test("root abort leaves wakes alive, while explicit cancellation survives restart", async (t) => {
  let turns = 0;
  const app = await fixture(
    t,
    () => {
      turns++;
      return fauxAssistantMessage("Unexpected");
    },
    { sqlite: true },
  );
  const item = await scheduleWake(
    app.host,
    { address, at: Date.now() + 60_000, reason: "Later" },
    "cancel-me",
    context,
  );
  await (await app.host.harness.root(context)).abort(context);
  assert.equal((await listWakes(app.host, context))[0]!.status, "scheduled");
  await cancelWake(app.host, item.id, context);
  await cancelWake(app.host, item.id, context);
  await app.reopen();
  assert.equal((await listWakes(app.host, context))[0]!.status, "cancelled");
  assert.equal(
    (await app.host.harness.getTask(item.taskId, context))!.state.status,
    "terminal",
  );
  assert.equal(turns, 0);
});

test("extension event hooks are silent and deduplicated; notify sends without another model turn", async (t) => {
  let turns = 0;
  const app = await fixture(t, (request) => {
    turns++;
    const message = request.messages.findLast(
      (item) => item.role !== "system",
    )!;
    return message.role === "toolResult"
      ? fauxAssistantMessage("Internal reflection complete")
      : call("notify", { text: "Your decision is needed" });
  });
  await wakeChiefOfStaff(
    app.host,
    { address, reason: "An integration found a decision" },
    "event-1",
    context,
  );
  await wakeChiefOfStaff(
    app.host,
    { address, reason: "An integration found a decision" },
    "event-1",
    context,
  );
  await until(() => app.sent.length === 1 && turns === 2);
  const state = await app.host.harness.snapshot(AssistantState, context);
  await Promise.all(
    Object.values(state!.receipts).map((id) =>
      app.host.harness.waitForTask(id, context),
    ),
  );
  assert.deepEqual(
    app.sent.map(({ text, recipient }) => ({ text, recipient })),
    [{ text: "Your decision is needed", recipient: "alice" }],
  );
  assert.equal(turns, 2);
  assert.deepEqual(app.errors, []);
});

test("the chief of staff schedules its own silent reflection and rewrites MEMORY.md", async (t) => {
  const app = await fixture(t, (request) => {
    const message = request.messages.findLast(
      (item) => item.role !== "system",
    )!;
    if (textOf(message) === "Reflect later")
      return call("wake", {
        action: "schedule",
        at: new Date(Date.now() + 100).toISOString(),
        reason: "Reflect on useful working preferences",
        notify: false,
      });
    if (textOf(message).startsWith("Chief-of-staff wake")) {
      const brief = request.messages.find((item) =>
        textOf(item).startsWith("Executive brief"),
      )!;
      const memory = JSON.parse(
        textOf(brief).split("\n").slice(1).join("\n"),
      ).memory;
      return call("memory", {
        action: "rewrite",
        revision: memory.revision,
        text: "# Memory\nKeep recommendations concise and evidence-backed.\n",
      });
    }
    return fauxAssistantMessage("Scheduled or reflected");
  });
  await app.say("Reflect later");
  await until(async () =>
    (await app.host.adapters.memory.read(context)).text.includes(
      "evidence-backed",
    ),
  );
  const state = await app.host.harness.snapshot(AssistantState, context);
  await Promise.all(
    Object.values(state!.receipts).map((id) =>
      app.host.harness.waitForTask(id, context),
    ),
  );
  assert.equal(app.sent.length, 1, "reflection does not create a notification");
  assert.equal((await listWakes(app.host, context))[0]!.status, "fired");
  assert.deepEqual(app.errors, []);
});

test("wakes reject invalid times and oversized event data", async (t) => {
  const app = await fixture(t, () => fauxAssistantMessage("Hello"));
  for (const at of [NaN, Infinity, -1, 1.5, 9_000_000_000_000_000])
    await assert.rejects(
      scheduleWake(app.host, { address, at, reason: "Later" }, "bad", context),
      /time/,
    );
  await assert.rejects(
    wakeChiefOfStaff(
      app.host,
      { address, reason: "x".repeat(2_001) },
      "bad",
      context,
    ),
    /reason/,
  );
  assert.equal((await listWakes(app.host, context)).length, 0);
});
