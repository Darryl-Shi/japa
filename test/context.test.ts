import assert from "node:assert/strict";
import { test } from "node:test";
import { getCurrentTools, Type } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { project } from "../src/extensions/context.ts";

const system: Message = {
  role: "system",
  content: "You coordinate.",
  timestamp: 0,
  toolsAdded: [
    { name: "jobs", description: "Inspect jobs", parameters: Type.Object({}) },
  ],
};
const user = (content: string, timestamp = 1): Message => ({
  role: "user",
  content,
  timestamp,
});

test("executive context stays bounded while its source transcript remains intact", () => {
  const history: Message[] = [system];
  for (let index = 0; index < 100; index++) {
    history.push(user(`Old discussion ${index}: ${"x".repeat(1_000)}`));
    history.push(fauxAssistantMessage("Acknowledged"));
  }
  history.push(user("Where are we with the trip?", Date.now()));
  const original = JSON.stringify(history);
  const brief = JSON.stringify({
    commitments: [{ outcome: "Plan the trip", status: "open" }],
  });
  const projected = project(history, brief, 0, 16_000);
  assert(JSON.stringify(projected).length <= 16_000);
  assert.match(JSON.stringify(projected), /Plan the trip/);
  assert.match(JSON.stringify(projected), /Where are we/);
  assert(!JSON.stringify(projected).includes("Old discussion 0:"));
  assert.equal(JSON.stringify(history), original);
});

test("serialized budgets hold even when input characters expand during JSON encoding", () => {
  const projected = project(
    [system, user(String.fromCharCode(0).repeat(8_000))],
    "",
    0,
    16_000,
  );
  assert(JSON.stringify(projected).length <= 16_000);
  assert.match(JSON.stringify(projected), /truncated/);
});

test("tool calls and results are retained or omitted together", () => {
  const call = fauxAssistantMessage(
    fauxToolCall("jobs", {}, { id: "call-1" }),
    { stopReason: "toolUse" },
  );
  const result: Message = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "jobs",
    content: [{ type: "text", text: "x".repeat(50_000) }],
    isError: false,
    timestamp: 2,
  };
  const projected = project(
    [system, user("Check my jobs"), call, result],
    "Job 1 completed",
    0,
    16_000,
  );
  assert(JSON.stringify(projected).length <= 16_000);
  assert(!projected.some((message) => message.role === "toolResult"));
  assert(!projected.some((message) => message.role === "assistant"));
  assert(projected.some((message) => message.content === "Check my jobs"));
});

test("system deltas are folded without resurrecting removed tools", () => {
  const delta: Message = {
    role: "system",
    content: "",
    toolsRemoved: [{ name: "jobs" }],
    timestamp: 2,
  };
  const projected = project([system, user("Hello"), delta], "", 0, 16_000);
  assert.equal(
    projected.filter((message) => message.role === "system").length,
    1,
  );
  assert.deepEqual(getCurrentTools(projected), []);
});

test("forgetting excludes pre-cutoff dialogue from personalization", () => {
  const projected = project(
    [system, user("I prefer red hotels", 1), user("New topic", 3)],
    "",
    2,
    16_000,
  );
  assert(!JSON.stringify(projected).includes("red hotels"));
  assert(JSON.stringify(projected).includes("New topic"));
});
