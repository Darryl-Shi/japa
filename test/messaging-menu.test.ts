import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Daemon } from "../src/kernel/boot.ts";
import { COMMANDS } from "../src/kernel/messaging/menu.ts";
import { statusText } from "../src/kernel/status.ts";
import { waitFor } from "./helpers.ts";
import { ask, call, idle, reported, script, texts } from "./jobs-helpers.ts";
import { bootMessaging, fakeAdapter, sleep } from "./messaging-helpers.ts";

let fake: ReturnType<typeof fakeAdapter>;
let daemon: Daemon;
let faux: FauxProviderHandle;

beforeEach(async () => {
  fake = fakeAdapter();
  ({ daemon, faux } = await bootMessaging(fake));
});

afterEach(() => daemon.close());

test("the commands are registered when the surface starts", () => expect(fake.commands.at(-1)).toEqual(COMMANDS));

test("/status shows what japa status prints", async () => {
  await fake.receive({ command: "status" });
  expect(fake.sent.at(-1)!.markdown).toBe(statusText(daemon.status()));
  const status = {
    model: { provider: "p", modelId: "m" },
    extensions: [{ name: "a", summary: "A", provides: [] }],
    errors: [{ name: "b", error: "boom" }],
  };
  expect(statusText(status)).toBe("model: p/m\nextensions:\n  a — A\nerrors:\n  b: boom");
  expect(statusText({ extensions: [], errors: [] })).toBe("model: none\nextensions:");
});

test("/jobs lists running and recent jobs as buttons; pressing one shows its report", async () => {
  script(faux, (_role, text) => (text === "start sum" ? call("job_start", { title: "Sum", brief: "Add" }) : undefined));
  await ask(daemon, "start sum");
  await waitFor(async () => (await reported(daemon)).length > 0 && (await idle(daemon)) && fake.sent.length > 0);
  await fake.receive({ command: "jobs" });
  const list = fake.sent.at(-1)!;
  expect(list.markdown).toBe("Running and recent jobs:");
  expect(list.buttons![0]![0]!.label).toMatch(/^1\. Sum \(/);
  await fake.press(list.buttons![0]![0]!.label);
  expect(fake.edited.at(-1)).toMatchObject({ messageId: list.id, markdown: expect.stringMatching(/^\[job 1 "Sum" /) });
});

test("/jobs without jobs says so", async () => {
  await fake.receive({ command: "jobs" });
  expect(fake.sent.at(-1)!.markdown).toBe("No running or recent jobs.");
});

test("an unknown command gets the help list and never reaches the CoS", async () => {
  await fake.receive({ command: "start" });
  expect(fake.sent.at(-1)!.markdown).toBe(
    "Commands:\n/jobs — Running and recent jobs\n/status — Model, extensions and errors\n/settings — Models, schedules and extensions",
  );
  await sleep(2000);
  expect(await texts(daemon.root, "user")).toEqual([]);
});

test("a stale button says the menu expired", async () => {
  await fake.receive({ action: "999", messageId: "5" });
  expect(fake.edited.at(-1)).toMatchObject({ messageId: "5", markdown: "This menu expired — send /settings again." });
});
