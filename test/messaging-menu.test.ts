import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Daemon } from "../src/kernel/boot.ts";
import type { KernelContext, MessagingContext } from "../src/kernel/contracts.ts";
import type { Job } from "../src/kernel/jobs/state.ts";
import { COMMANDS, createMenu } from "../src/kernel/messaging/menu.ts";
import { statusText } from "../src/kernel/status.ts";
import { echo, stage, testKit, waitFor } from "./helpers.ts";
import { ask, call, idle, reported, script, texts, tool } from "./jobs-helpers.ts";
import { bootMessaging, fakeAdapter, sleep } from "./messaging-helpers.ts";

let fake: ReturnType<typeof fakeAdapter>;
let daemon: Daemon;
let faux: FauxProviderHandle;
let home: string;

beforeEach(async () => {
  fake = fakeAdapter();
  ({ daemon, faux, home } = await bootMessaging(fake));
});

afterEach(() => daemon.close());

/** Boots again with `kit`'s models and a fresh fake adapter. */
async function reboot(kit: ReturnType<typeof testKit>) {
  await daemon.close();
  fake = fakeAdapter();
  ({ daemon, faux, home } = await bootMessaging(fake, {}, [], kit));
}

/** The button labels of the newest edited message. */
const labels = () => fake.edited.at(-1)!.buttons!.flat().map((b) => b.label);

/** Presses `›` until the newest edited message has a button labelled `label`, then presses it. */
async function choose(label: string) {
  while (!labels().includes(label)) await fake.press("›");
  await fake.press(label);
}

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

test("a button from before a restart says the menu expired", async () => {
  const job = { id: "1", title: "Sum", status: "running", updatedAt: Date.now() } as Job;
  const msg = { chat: "42", user: "42", id: "1", messageId: "1" };
  const menus = [1, 2].map(() => createMenu(fake.adapter, {} as KernelContext, {} as MessagingContext, () => [job]));
  for (const menu of menus) await menu.command({ ...msg, command: "jobs" });
  await menus[1]!.press({ ...msg, action: fake.sent.at(-2)!.buttons![0]![0]!.action });
  expect(fake.edited.at(-1)!.markdown).toBe("This menu expired — send /settings again.");
});

test("a stale button says the menu expired", async () => {
  await fake.receive({ action: "999", messageId: "5" });
  expect(fake.edited.at(-1)).toMatchObject({ messageId: "5", markdown: "This menu expired — send /settings again." });
});

test("a model is set from the menu, logged, and undoable", async () => {
  await reboot(testKit({ models: [{ id: "a" }, { id: "b" }] }));
  await fake.receive({ command: "settings" });
  expect(fake.sent.at(-1)!.markdown).toBe("Settings");
  await fake.press("Models");
  for (const label of ["CoS", "faux", "b"]) await choose(label);
  expect(fake.edited.at(-1)!.markdown).toBe("Set models.cos. (change 1)");
  expect(daemon.status().model).toEqual({ provider: "faux", modelId: "b" });
  expect(await tool(daemon, faux, "change_undo", { id: "1" })).toBe("Undid: Set models.cos");
  const buttons = [...fake.sent, ...fake.edited].flatMap((m) => (m.buttons ?? []).flat());
  expect(buttons.every((b) => Buffer.byteLength(b.action) <= 64)).toBe(true);
});

test("long lists are paged 8 at a time", async () => {
  await reboot(testKit({ models: Array.from({ length: 10 }, (_, i) => ({ id: `m${i + 1}` })) }));
  await fake.receive({ command: "settings" });
  await fake.press("Models");
  for (const label of ["CoS", "faux"]) await choose(label);
  expect(labels()).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "›"]);
  await fake.press("›");
  expect(labels()).toEqual(["m9", "m10", "‹"]);
});

test("a schedule is removed from the menu after confirmation", async () => {
  await tool(daemon, faux, "schedule_add", { text: "water plants", cron: "0 9 * * *" });
  await fake.receive({ command: "settings" });
  await fake.press("Schedules");
  await fake.press("water plants (0 9 * * *)");
  expect(fake.edited.at(-1)!.markdown).toBe('Remove schedule "water plants (0 9 * * *)"?');
  await fake.press("Remove");
  expect(fake.edited.at(-1)!.markdown).toBe("Removed schedule 1.");
  expect(await tool(daemon, faux, "schedule_list")).toBe("No schedules.");
  expect(await tool(daemon, faux, "changes_list")).toMatch(/Removed schedule "water plants"/);
});

describe("extensions", { timeout: 60_000 }, () => {
  test("an extension is rolled back from the menu after confirmation", async () => {
    stage(home, "extensions/echo/index.ts", echo("v1"));
    await tool(daemon, faux, "install", { kind: "extension", name: "echo" });
    daemon.markGood();
    stage(home, "extensions/echo/index.ts", echo("v2"));
    await tool(daemon, faux, "install", { kind: "extension", name: "echo" });
    expect(await tool(daemon, faux, "echo")).toBe("v2");
    await fake.receive({ command: "settings" });
    await fake.press("Extensions");
    await choose("echo (ok)");
    expect(fake.edited.at(-1)!.markdown).toBe("echo: Echoes");
    await fake.press("Roll back to last known good");
    expect(fake.edited.at(-1)!.markdown).toBe("Rolled back extension echo.");
    expect(await tool(daemon, faux, "echo")).toBe("v1");
    expect(await tool(daemon, faux, "changes_list")).toMatch(/Rolled back extension echo/);
  });
});
