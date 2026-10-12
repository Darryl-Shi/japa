import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect, test } from "vitest";
import { WorkerExtension } from "../src/kernel/jobs/worker.ts";

type Render = (input: unknown, context: unknown) => Promise<string | undefined>;
const render = (jobId: string | undefined) => {
  const worker = WorkerExtension.sections!.find((s) => s.key === "worker")!;
  const read = { snapshot: async () => (jobId === undefined ? undefined : { jobId }) };
  return (worker.render as unknown as Render)({ conversationId: "c", read }, BACKGROUND_CONTEXT);
};

test("the worker's role names its own outbox folder for files meant for the user", async () => {
  expect(await render("7")).toContain("Files meant for the user go in ~/.japa/outbox/7/");
  expect(await render(undefined)).toContain("~/.japa/outbox/<job id>/");
});
