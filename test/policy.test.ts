import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ToolCall } from "@earendil-works/pi-ai";
import { Approvals } from "../src/extensions/approvals.ts";
import { textOf } from "../src/extensions/text.ts";
import { context, fixture, until } from "./helpers.ts";

const call = (name: string, args: ToolCall["arguments"]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("a durable approval waits without blocking conversation and is address-bound", async (t) => {
  const app = await fixture(
    t,
    (request, _options, _state, model) => {
      const message = request.messages.findLast(
        (message) => message.role !== "system",
      )!;
      if (model.id === "worker") {
        return message.role === "toolResult"
          ? fauxAssistantMessage(
              message.isError ? "Write was denied" : "Wrote the file",
            )
          : call("write", { path: "approved.txt", content: "approved" });
      }
      if (textOf(message) === "Do work")
        return call("job_start", {
          title: "Write",
          instructions: "Write approved.txt",
        });
      return fauxAssistantMessage("I'm available.");
    },
    {
      sqlite: true,
      rules: { write: { action: "ask", reason: "Allow this file write?" } },
    },
  );
  await app.say("Do work");
  await until(
    async () =>
      (await app.host.harness.snapshot(Approvals, context))?.items.length === 1,
  );
  const approval = (await app.host.harness.snapshot(Approvals, context))!
    .items[0]!;
  await until(() =>
    app.sent.some((item) => item.key === `approval:${approval.id}`),
  );
  await app.reopen();
  await app.say("Hello while work waits");
  await until(
    () => app.sent.filter((item) => item.text === "I'm available.").length >= 2,
  );
  await assert.rejects(
    app.say(`/approve ${approval.id}`, "wrong-person", "stranger"),
    /different address/,
  );
  assert.equal(
    (await app.host.harness.snapshot(Approvals, context))!.items[0]!.status,
    "pending",
  );
  await app.say(`/approve ${approval.id}`);
  await until(
    async () =>
      (await app.host.adapters.jobs.list(context))[0]?.status === "completed",
  );
  assert.equal(
    await readFile(join(app.home, "workspace", "approved.txt"), "utf8"),
    "approved",
  );
  assert.equal(
    (await app.host.harness.snapshot(Approvals, context))!.items[0]!.status,
    "approved",
  );
  assert.equal(
    app.sent.filter((item) => item.key === `approval:${approval.id}`).length,
    1,
  );
});

test("deny prevents a tool effect", async (t) => {
  const app = await fixture(
    t,
    (request, _options, _state, model) => {
      const message = request.messages.findLast(
        (message) => message.role !== "system",
      )!;
      if (model.id === "worker")
        return message.role === "toolResult"
          ? fauxAssistantMessage(textOf(message))
          : call("write", { path: "denied.txt", content: "should not exist" });
      if (textOf(message) === "Do work")
        return call("job_start", {
          title: "Denied",
          instructions: "Write denied.txt",
        });
      return fauxAssistantMessage("Acknowledged");
    },
    { rules: { write: { action: "deny", reason: "Writes disabled" } } },
  );
  await app.say("Do work");
  await until(
    async () =>
      (await app.host.adapters.jobs.list(context))[0]?.status === "completed",
  );
  await assert.rejects(readFile(join(app.home, "workspace", "denied.txt")), {
    code: "ENOENT",
  });
  assert.match(
    (await app.host.adapters.jobs.list(context))[0]!.result,
    /Writes disabled/,
  );
});
