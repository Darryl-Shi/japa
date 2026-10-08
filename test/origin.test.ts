import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { originOf, requestIdFor } from "../src/kernel/origin.ts";
import { bootTest, probe } from "./helpers.ts";
import { texts } from "./jobs-helpers.ts";

test("a surface origin is encoded in the requestId", () => {
  expect(requestIdFor({ surface: "telegram", chat: "42", id: "7" })).toBe("surface:telegram:42:7");
  expect(requestIdFor({ surface: "gateway" })).toMatch(/^surface:gateway::[0-9a-f-]{36}$/);
  expect(requestIdFor({ surface: "x", chat: "a:b", id: "1" })).toBe("surface:x:a%3Ab:1");
});

test("origins are read back from requestIds", () => {
  expect(originOf("surface:telegram:42:7")).toEqual({ surface: "telegram", chat: "42" });
  expect(originOf("surface:gateway::d1e2")).toEqual({ surface: "gateway" });
  expect(originOf("surface:x:a%3Ab:1")).toEqual({ surface: "x", chat: "a:b" });
  expect(originOf(undefined)).toEqual({ surface: "gateway" });
  for (const id of [
    "trigger:schedule:1:5",
    "report:1:2",
    "job:9",
    "secret:3",
    "rollback:abc",
    "rollback-none:echo:abc",
    "safe-mode:abc",
    "memory:v2-loops",
  ]) {
    expect([id, originOf(id)]).toEqual([id, "proactive"]);
  }
});

test("a surface input with an id is admitted once", async () => {
  const { extension, surface } = probe();
  const { daemon } = await bootTest({}, [extension]);
  await surface().root.submit("hi", undefined, { surface: "fake", chat: "9", id: "5" });
  await surface().root.submit("hi", undefined, { surface: "fake", chat: "9", id: "5" });
  await daemon.root.waitForIdle(ctx);
  expect((await texts(daemon.root, "user")).filter((t) => t === "hi")).toHaveLength(1);
  const record = await daemon.harness.commit(
    (tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, "surface:fake:9:5"),
    ctx,
  );
  expect(record).toBeDefined();
  await daemon.close();
});

test("a surface submits text and image parts", async () => {
  const { extension, surface } = probe();
  const { daemon } = await bootTest({}, [extension]);
  const parts = [
    { type: "text", text: "look" },
    { type: "image", data: "aGk=", mimeType: "image/png" },
  ] as const;
  await surface().root.submit([...parts]);
  await daemon.root.waitForIdle(ctx);
  const user = (await daemon.root.entries({}, 200, undefined, ctx)).items.findLast((e) => e.kind === "pi.user");
  expect(user?.model?.[0]?.content).toEqual(parts);
  await daemon.close();
});
