import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Daemon } from "../src/kernel/boot.ts";
import type { Incoming, KernelContext, MessagingContext } from "../src/kernel/contracts.ts";
import type { Job } from "../src/kernel/jobs/state.ts";
import { COMMANDS, createMenu } from "../src/kernel/messaging/menu/index.ts";
import type { Nav, Page } from "../src/kernel/messaging/menu/nav.ts";
import { addSecretRequest } from "../src/kernel/secret-requests.ts";
import { statusText } from "../src/kernel/status.ts";
import { echo, stage, testKit, waitFor } from "./helpers.ts";
import { ask, call, idle, reported, script, texts, tool } from "./jobs-helpers.ts";
import { bootMessaging, fakeAdapter, sleep } from "./messaging-helpers.ts";

// When `hook.ask` is set, the Settings home gains an `Input` button opening the screen it makes: there is no
// user-facing input screen yet to test typed input with.
const hook = vi.hoisted(() => ({ ask: undefined as ((nav: Nav, home: Page) => Page) | undefined }));
vi.mock("../src/kernel/messaging/menu/settings.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/kernel/messaging/menu/settings.ts")>();
  return {
    ...real,
    settingsMenu: (nav: Nav, ...rest: [KernelContext, MessagingContext]) => {
      const home = real.settingsMenu(nav, ...rest);
      const withInput: Page = async (outcome) => {
        const m = await home(outcome);
        if (hook.ask === undefined) return m;
        return { ...m, buttons: [...(m.buttons ?? []), [nav.button("Input", hook.ask(nav, withInput))]] };
      };
      return withInput;
    },
  };
});

let fake: ReturnType<typeof fakeAdapter>;
let daemon: Daemon;
let faux: FauxProviderHandle;
let home: string;

beforeEach(async () => {
  fake = fakeAdapter();
  ({ daemon, faux, home } = await bootMessaging(fake));
});

afterEach(async () => {
  hook.ask = undefined;
  await daemon.close();
});

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

/** Has the Settings home offer an `Input` screen whose typed values are collected in the returned list. */
function typed(secret = false) {
  const got: string[] = [];
  hook.ask = (nav, home) =>
    nav.ask({
      title: "Name",
      secret,
      apply: async (text) => {
        got.push(text);
        return "Set name.";
      },
      then: home,
      cancel: home,
    });
  return got;
}

const PROMPT = "japa needs `svc.token`: to sync. Send it as your next message; I'll delete it at once.";
const prompts = () => fake.sent.filter((s) => s.markdown === PROMPT).length;
const transcript = async () => JSON.stringify((await daemon.root.entries({}, 500, undefined, ctx)).items);

// A menu driven directly, with a kernel offering provider "p" with model "a".
const msg = { chat: "42", user: "42", id: "1", messageId: "1" };
const fakeKernel = {
  models: { getProviders: () => [{ id: "p" }], getModels: () => [{ id: "a" }] },
} as unknown as KernelContext;

/** Presses the button labelled `label` in the newest message `f` got (edited, else sent), through `menu`. */
function presser(menu: ReturnType<typeof createMenu>, f: ReturnType<typeof fakeAdapter>) {
  return (label: string) => {
    const newest = f.edited.at(-1) ?? f.sent.at(-1)!;
    const action = newest.buttons!.flat().find((b) => b.label === label)!.action;
    return menu.press({ ...msg, action } as Incoming);
  };
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
  expect(statusText({ model: { provider: "p", modelId: "m" }, extensions: [{ name: "a", summary: "A", provides: [], status: "up" }], errors: [] }))
    .toBe("model: p/m\nextensions:\n  a — A\n    up");
});

test("/jobs lists running and recent jobs as buttons; pressing one shows its report", async () => {
  script(faux, (_role, text) => (text === "start sum" ? call("job_start", { title: "Sum", brief: "Add" }) : undefined));
  await ask(daemon, "start sum");
  await waitFor(async () => (await reported(daemon)).length > 0 && (await idle(daemon)) && fake.sent.length > 0);
  await fake.receive({ command: "jobs" });
  const list = fake.sent.at(-1)!;
  expect(list.markdown).toBe("**Jobs**");
  expect(list.buttons![0]![0]!.label).toMatch(/^1\. Sum \(/);
  await fake.press(list.buttons![0]![0]!.label);
  expect(fake.edited.at(-1)).toMatchObject({ messageId: list.id, markdown: expect.stringMatching(/^\*\*Job 1\*\*\n\n\[job 1 "Sum" /) });
  expect(labels()).toEqual(["‹ Back", "⌂ Home"]);
  await fake.press("‹ Back");
  expect(fake.edited.at(-1)!.markdown).toBe("**Jobs**");
});

test("a job report longer than a message is cut to fit", async () => {
  const small = fakeAdapter({ maxMessageChars: 100 });
  const job = { id: "1", title: "Sum", status: "done", result: "word ".repeat(100), updatedAt: Date.now() } as Job;
  const menu = createMenu(small.adapter, {} as KernelContext, {} as MessagingContext, () => [job]);
  await menu.command({ ...msg, command: "jobs" });
  await menu.press({ ...msg, action: small.sent.at(-1)!.buttons![0]![0]!.action });
  expect(small.edited.at(-1)!.markdown).toMatch(/^\*\*Job 1\*\*\n\n\[job 1 "Sum" done\] word/);
  expect(small.edited.at(-1)!.markdown.length).toBeLessThanOrEqual(100);
});

test("/jobs without jobs says so", async () => {
  await fake.receive({ command: "jobs" });
  expect(fake.sent.at(-1)!.markdown).toBe("**Jobs**\n\nNo running or recent jobs.");
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
  const menus = [1, 2].map(() => createMenu(fake.adapter, {} as KernelContext, {} as MessagingContext, () => [job]));
  for (const menu of menus) await menu.command({ ...msg, command: "jobs" });
  await menus[1]!.press({ ...msg, action: fake.sent.at(-2)!.buttons![0]![0]!.action });
  expect(fake.edited.at(-1)!.markdown).toBe("This menu expired — send /settings again.");
});

test("a stale button says the menu expired", async () => {
  await fake.receive({ action: "999", messageId: "5" });
  expect(fake.edited.at(-1)).toMatchObject({ messageId: "5", markdown: "This menu expired — send /settings again." });
});

test("the 501st-oldest action expires", async () => {
  const f = fakeAdapter();
  const menu = createMenu(f.adapter, fakeKernel, { tool: async () => undefined } as unknown as MessagingContext, () => []);
  for (let i = 0; i < 167; i++) await menu.command({ ...msg, command: "settings" }); // 3 actions each: 501
  const [oldest, kept] = f.sent[0]!.buttons!.flat();
  await menu.press({ ...msg, action: oldest!.action });
  expect(f.edited.at(-1)!.markdown).toBe("This menu expired — send /settings again.");
  await menu.press({ ...msg, action: kept!.action });
  expect(f.edited.at(-1)!.markdown).toBe("**Schedules**\n\nNo schedules.");
});

test("a stale /jobs button says send /jobs again", async () => {
  const f = fakeAdapter();
  const job = { id: "1", title: "Sum", status: "running", updatedAt: Date.now() } as Job;
  const menu = createMenu(f.adapter, {} as KernelContext, {} as MessagingContext, () => [job]);
  for (let i = 0; i < 501; i++) await menu.command({ ...msg, command: "jobs" });
  await menu.press({ ...msg, action: f.sent[0]!.buttons![0]![0]!.action });
  expect(f.edited.at(-1)!.markdown).toBe("This menu expired — send /jobs again.");
  await menu.press({ ...msg, action: f.sent[1]!.buttons![0]![0]!.action });
  expect(f.edited.at(-1)!.markdown).toMatch(/^\*\*Job 1\*\*/);
});

test("every screen but a home has ‹ Back and ⌂ Home; Back returns to the previous screen", async () => {
  await fake.receive({ command: "settings" });
  expect(fake.sent.at(-1)!.markdown).toBe("**Settings**");
  expect(fake.sent.at(-1)!.buttons!.flat().map((b) => b.label)).toEqual(["Models", "Schedules", "Extensions"]);
  await fake.press("Models");
  expect(fake.edited.at(-1)!.markdown).toBe("**Models**\n\nWhich model?");
  expect(labels()).toEqual(["CoS", "Worker", "Consolidation", "‹ Back", "⌂ Home"]);
  await fake.press("CoS");
  expect(fake.edited.at(-1)!.markdown).toBe("**Choose a provider**");
  expect(labels().slice(-2)).toEqual(["‹ Back", "⌂ Home"]);
  await choose("faux");
  expect(labels().slice(-2)).toEqual(["‹ Back", "⌂ Home"]);
  await fake.press("‹ Back");
  expect(fake.edited.at(-1)!.markdown).toBe("**Choose a provider**");
  await fake.press("‹ Back");
  expect(fake.edited.at(-1)!.markdown).toBe("**Models**\n\nWhich model?");
  await fake.press("⌂ Home");
  expect(fake.edited.at(-1)!.markdown).toBe("**Settings**");
  for (const screen of ["Schedules", "Extensions"]) {
    await fake.press(screen);
    expect(labels().slice(-2)).toEqual(["‹ Back", "⌂ Home"]);
    await fake.press("‹ Back");
    expect(fake.edited.at(-1)!.markdown).toBe("**Settings**");
  }
});

test("a rejected or failed action shows ✗ on the screen it came from", async () => {
  const f = fakeAdapter();
  const replies = [async () => "Not changed: no such model", async () => Promise.reject(new Error("boom"))];
  const messaging = {
    setSetting: () => replies.shift()!(),
    tool: async () => Promise.reject(new Error("down")),
  } as unknown as MessagingContext;
  const menu = createMenu(f.adapter, fakeKernel, messaging, () => []);
  const press = presser(menu, f);
  await menu.command({ ...msg, command: "settings" });
  await press("Models");
  for (const label of ["CoS", "p", "a"]) await press(label);
  expect(f.edited.at(-1)!.markdown).toBe("✗ no such model\n\n**Models**\n\nWhich model?");
  for (const label of ["CoS", "p", "a"]) await press(label);
  expect(f.edited.at(-1)!.markdown).toBe("✗ boom\n\n**Models**\n\nWhich model?");
  await press("⌂ Home");
  await press("Schedules");
  expect(f.edited.at(-1)!.markdown).toBe("✗ down\n\n**Settings**");
  expect(f.edited.at(-1)!.buttons!.flat().map((b) => b.label)).toEqual(["Models", "Schedules", "Extensions"]);
});

test("a model is set from the menu, logged, and undoable", async () => {
  await reboot(testKit({ models: [{ id: "a" }, { id: "b" }] }));
  await fake.receive({ command: "settings" });
  expect(fake.sent.at(-1)!.markdown).toBe("**Settings**");
  await fake.press("Models");
  for (const label of ["CoS", "faux", "b"]) await choose(label);
  expect(fake.edited.at(-1)!.markdown).toBe("✓ Set models.cos. (change 1)\n\n**Models**\n\nWhich model?");
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
  const first = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "1/2", "›", "‹ Back", "⌂ Home"];
  expect(labels()).toEqual(first);
  await fake.press("1/2");
  expect(labels()).toEqual(first);
  await fake.press("›");
  expect(labels()).toEqual(["m9", "m10", "‹", "2/2", "‹ Back", "⌂ Home"]);
  await fake.press("‹");
  expect(labels()).toEqual(first);
});

test("a schedule is removed from the menu after confirmation", async () => {
  await tool(daemon, faux, "schedule_add", { text: "water plants", cron: "0 9 * * *" });
  await fake.receive({ command: "settings" });
  await fake.press("Schedules");
  await fake.press("water plants (0 9 * * *)");
  expect(fake.edited.at(-1)!.markdown).toBe('**Remove schedule "water plants (0 9 * * *)"?**');
  expect(labels()).toEqual(["Remove", "Cancel"]);
  await fake.press("Remove");
  expect(fake.edited.at(-1)!.markdown).toBe("✓ Removed schedule 1.\n\n**Schedules**\n\nNo schedules.");
  expect(await tool(daemon, faux, "schedule_list")).toBe("No schedules.");
  expect(await tool(daemon, faux, "changes_list")).toMatch(/Removed schedule "water plants"/);
});

describe("typed input", { timeout: 30_000 }, () => {
  test("typed input reaches the menu, not the CoS", async () => {
    const got = typed();
    await fake.receive({ command: "settings" });
    const menuId = fake.sent.at(-1)!.id;
    await fake.press("Input");
    expect(fake.edited.at(-1)!.markdown).toBe("**Name**\n\nSend the new value as your next message.");
    expect(labels()).toEqual(["Cancel"]);
    await fake.receive({ text: "bob" });
    expect(got).toEqual(["bob"]);
    expect(fake.edited.at(-1)).toMatchObject({ messageId: menuId, markdown: "✓ Set name.\n\n**Settings**" });
    expect(fake.deleted).toEqual([]);
    await sleep(2000);
    expect(await texts(daemon.root, "user")).toEqual([]);
    await fake.receive({ text: "hello" });
    await waitFor(async () => (await texts(daemon.root, "user")).includes("hello"));
    expect(got).toEqual(["bob"]);
  });

  test("secret input is deleted and a re-delivery is dropped", async () => {
    const got = typed(true);
    await fake.receive({ command: "settings" });
    const menuId = fake.sent.at(-1)!.id;
    await fake.press("Input");
    await fake.receive({ id: "s", messageId: "77", text: "s3cr3t" });
    expect(fake.deleted).toEqual([{ chat: "42", messageId: "77" }]);
    expect(got).toEqual(["s3cr3t"]);
    expect(fake.edited.at(-1)).toMatchObject({ messageId: menuId, markdown: "✓ Set name.\n\n**Settings**" });
    await fake.receive({ id: "s", messageId: "77", text: "s3cr3t" });
    await sleep(2000);
    expect(fake.deleted).toEqual([
      { chat: "42", messageId: "77" },
      { chat: "42", messageId: "77" },
    ]);
    expect(got).toEqual(["s3cr3t"]);
    expect(await transcript()).not.toContain("s3cr3t");
  });

  test("a secret input that can't be deleted is still applied, and the owner is told", async () => {
    const got = typed(true);
    fake.failDelete = true;
    await fake.receive({ command: "settings" });
    await fake.press("Input");
    await fake.receive({ text: "s3cr3t" });
    expect(fake.sent.at(-1)!.markdown).toBe("Couldn't delete your message — please delete it yourself.");
    expect(got).toEqual(["s3cr3t"]);
  });

  test("a command, Cancel, or another button cancels the input; the next text goes to the CoS", async () => {
    const got = typed();
    const cancels = [
      () => fake.receive({ command: "status" }),
      () => fake.press("Cancel"),
      (home: { id: string; buttons?: { action: string }[][] }) =>
        fake.receive({ action: home.buttons![0]![0]!.action, messageId: home.id }),
    ];
    for (const [i, cancel] of cancels.entries()) {
      await fake.receive({ command: "settings" });
      const home = fake.sent.at(-1)!;
      await fake.press("Input");
      await cancel(home);
      await fake.receive({ text: `hello ${i}` });
      await waitFor(async () => (await texts(daemon.root, "user")).includes(`hello ${i}`));
    }
    expect(got).toEqual([]);
  });

  test("Cancel returns to the screen it names", async () => {
    typed();
    await fake.receive({ command: "settings" });
    await fake.press("Input");
    await fake.press("Cancel");
    expect(fake.edited.at(-1)!.markdown).toBe("**Settings**");
  });

  test("a menu input takes precedence over a pending secret request; the prompt is sent again after", async () => {
    script(faux, (role, text) =>
      role === "user" && text === "connect" ? call("secret_request", { name: "svc.token", why: "to sync" }) : undefined,
    );
    await fake.receive({ text: "connect" });
    await waitFor(() => prompts() === 1);
    const got = typed();
    await fake.receive({ command: "settings" });
    await fake.press("Input");
    await fake.receive({ text: "value" });
    expect(got).toEqual(["value"]);
    expect(existsSync(join(home, "secrets/svc.token"))).toBe(false);
    await waitFor(() => prompts() === 2);
    await fake.receive({ messageId: "77", text: "s3cr3t" });
    expect(readFileSync(join(home, "secrets/svc.token"), "utf8")).toBe("s3cr3t");
    expect(fake.deleted).toEqual([{ chat: "42", messageId: "77" }]);
  });

  test("a secret request made during a menu input is asked for when the input ends", async () => {
    const got = typed();
    await fake.receive({ command: "settings" });
    await fake.press("Input");
    await daemon.root.commit((tx) => addSecretRequest(tx, "svc.token", "to sync"), ctx);
    await sleep(500);
    expect(prompts()).toBe(0);
    await fake.receive({ text: "value" });
    expect(got).toEqual(["value"]);
    await waitFor(() => prompts() === 1);
    await sleep(500);
    expect(prompts()).toBe(1);
  });
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
    expect(fake.edited.at(-1)!.markdown).toBe("**echo: Echoes**");
    await fake.press("Roll back to last known good");
    expect(fake.edited.at(-1)!.markdown).toMatch(/^✓ Rolled back extension echo\.\n\n\*\*Extensions\*\*$/);
    expect(await tool(daemon, faux, "echo")).toBe("v1");
    expect(await tool(daemon, faux, "changes_list")).toMatch(/Rolled back extension echo/);
  });
});
