import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { envApiKeyAuth, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Daemon } from "../src/kernel/boot.ts";
import { ChangesDoc, logChange } from "../src/kernel/changes.ts";
import type { Incoming, KernelContext, MessagingContext } from "../src/kernel/contracts.ts";
import type { Job } from "../src/kernel/jobs/state.ts";
import { COMMANDS, createMenu } from "../src/kernel/messaging/menu/index.ts";
import { ago, type Nav, outcomeLine, type Page } from "../src/kernel/messaging/menu/nav.ts";
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

/** Boots again with `kit`'s models, `extra` extensions and a fresh fake adapter. */
async function reboot(kit: ReturnType<typeof testKit>, extra: Parameters<typeof bootMessaging>[2] = []) {
  await daemon.close();
  fake = fakeAdapter();
  ({ daemon, faux, home } = await bootMessaging(fake, {}, extra, kit));
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
  models: { getProviders: () => [{ id: "p" }], getModels: () => [{ id: "a" }], checkAuth: async () => ({}) },
} as unknown as KernelContext;
/** A tool result with `text`. */
const result = (text: string) => ({ content: [{ type: "text", text }] });
/** `settings_get` for the fake menus: no models set. */
const settingsGet = async (name: string) => (name === "settings_get" ? result('{"models":{}}') : undefined);
const HOME = ["Models", "Extensions", "Schedules", "General", "Recent changes"];
const MODELS = "**Models**\n\nCoS: faux/a\nWorker: same as CoS\nConsolidation: same as CoS";

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
  const menu = createMenu(f.adapter, fakeKernel, { tool: settingsGet } as unknown as MessagingContext, () => []);
  for (let i = 0; i < 101; i++) await menu.command({ ...msg, command: "settings" }); // 5 actions each: 505
  const oldest = f.sent[0]!.buttons!.flat().at(-1)!; // the 5th
  const kept = f.sent[1]!.buttons!.flat()[0]!; // the 6th: Models
  await menu.press({ ...msg, action: oldest.action });
  expect(f.edited.at(-1)!.markdown).toBe("This menu expired — send /settings again.");
  await menu.press({ ...msg, action: kept.action });
  expect(f.edited.at(-1)!.markdown).toBe("**Models**\n\nCoS: not set\nWorker: same as CoS\nConsolidation: same as CoS");
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
  expect(fake.sent.at(-1)!.buttons!.flat().map((b) => b.label)).toEqual(HOME);
  await fake.press("Models");
  expect(fake.edited.at(-1)!.markdown).toMatch(/^\*\*Models\*\*\n\nCoS: faux\//);
  expect(labels()).toEqual(["CoS", "Worker", "Consolidation", "‹ Back", "⌂ Home"]);
  await fake.press("CoS");
  expect(fake.edited.at(-1)!.markdown).toBe("**Choose a provider**");
  expect(labels().slice(-2)).toEqual(["‹ Back", "⌂ Home"]);
  await choose("faux");
  expect(labels().slice(-2)).toEqual(["‹ Back", "⌂ Home"]);
  await fake.press("‹ Back");
  expect(fake.edited.at(-1)!.markdown).toBe("**Choose a provider**");
  await fake.press("‹ Back");
  expect(fake.edited.at(-1)!.markdown).toMatch(/^\*\*Models\*\*/);
  await fake.press("⌂ Home");
  expect(fake.edited.at(-1)!.markdown).toBe("**Settings**");
  for (const screen of ["Schedules", "Extensions", "General", "Recent changes"]) {
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
    tool: async (name: string) => (name === "settings_get" ? settingsGet(name) : Promise.reject(new Error("down"))),
  } as unknown as MessagingContext;
  const menu = createMenu(f.adapter, fakeKernel, messaging, () => []);
  const press = presser(menu, f);
  await menu.command({ ...msg, command: "settings" });
  await press("Models");
  const models = "**Models**\n\nCoS: not set\nWorker: same as CoS\nConsolidation: same as CoS";
  for (const label of ["CoS", "p", "a"]) await press(label);
  expect(f.edited.at(-1)!.markdown).toBe(`✗ no such model\n\n${models}`);
  for (const label of ["CoS", "p", "a"]) await press(label);
  expect(f.edited.at(-1)!.markdown).toBe(`✗ boom\n\n${models}`);
  await press("⌂ Home");
  await press("Schedules");
  expect(f.edited.at(-1)!.markdown).toBe("✗ down\n\n**Settings**");
  expect(f.edited.at(-1)!.buttons!.flat().map((b) => b.label)).toEqual(HOME);
});

test("a model is set from the menu, logged, and undoable", async () => {
  await reboot(testKit({ models: [{ id: "a" }, { id: "b" }] }));
  await fake.receive({ command: "settings" });
  expect(fake.sent.at(-1)!.markdown).toBe("**Settings**");
  await fake.press("Models");
  for (const label of ["CoS", "faux", "b"]) await choose(label);
  expect(fake.edited.at(-1)!.markdown).toBe(`✓ Set models.cos. (change 1)\n\n${MODELS.replace("faux/a", "faux/b")}`);
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
  const first = ["✓ m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "1/2", "›", "‹ Back", "⌂ Home"];
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

test("outcomeLine: Not changed: X is ✗ X; another No or Not reply is ✗; anything else ✓", () => {
  expect(outcomeLine("Not changed: bad value")).toBe("✗ bad value");
  expect(outcomeLine("Not undone: conflict")).toBe("✗ Not undone: conflict");
  expect(outcomeLine("No schedule 1.")).toBe("✗ No schedule 1.");
  expect(outcomeLine("Set jobs.maxConcurrent. (change 1)")).toBe("✓ Set jobs.maxConcurrent. (change 1)");
  expect(outcomeLine("Notes saved.")).toBe("✓ Notes saved.");
});

test("ago gives an age in minutes, hours under 48, then days", () => {
  const [m, h] = [60_000, 3_600_000];
  expect([0, m - 1, m, 60 * m - 1, h, 48 * h - 1, 48 * h, 100 * h].map(ago)).toEqual(
    ["<1m", "<1m", "1m", "59m", "1h", "47h", "2d", "4d"],
  );
});

describe("models", { timeout: 30_000 }, () => {
  test("Models shows current values and ticks the current model; providers without credentials aren't listed", async () => {
    const nokey = testKit({ provider: "nokey", models: [{ id: "x" }] });
    const provider = { ...nokey.faux.provider, auth: { apiKey: envApiKeyAuth("Nokey", ["JAPA_NOKEY_API_KEY"]) } };
    await reboot(testKit({ models: [{ id: "a" }, { id: "b" }] }), [
      { name: "nokey", summary: "No key", provides: { provider: [provider] } },
    ]);
    await fake.receive({ command: "settings" });
    await fake.press("Models");
    expect(fake.edited.at(-1)!.markdown).toBe(MODELS);
    await fake.press("CoS");
    expect(labels()).toEqual(["faux", "‹ Back", "⌂ Home"]);
    await fake.press("faux");
    expect(labels()).toEqual(["✓ a", "b", "‹ Back", "⌂ Home"]);
    await fake.press("⌂ Home");
    await fake.press("Models");
    await fake.press("Worker");
    expect(labels()).toEqual(["Use CoS model", "faux", "‹ Back", "⌂ Home"]);
    await fake.press("faux");
    expect(labels()).toEqual(["a", "b", "‹ Back", "⌂ Home"]);
    await fake.press("b");
    const worker = MODELS.replace("Worker: same as CoS", "Worker: faux/b");
    expect(fake.edited.at(-1)!.markdown).toBe(`✓ Set models.worker. (change 1)\n\n${worker}`);
    await fake.press("Worker");
    await fake.press("faux");
    expect(labels()).toEqual(["a", "✓ b", "‹ Back", "⌂ Home"]);
  });

  test("Use CoS model clears the role's model, logged", async () => {
    await reboot(testKit({ models: [{ id: "a" }, { id: "b" }] }));
    await fake.receive({ command: "settings" });
    await fake.press("Models");
    for (const label of ["Consolidation", "faux", "b"]) await fake.press(label);
    expect(fake.edited.at(-1)!.markdown).toContain("Consolidation: faux/b");
    await fake.press("Consolidation");
    await fake.press("Use CoS model");
    expect(fake.edited.at(-1)!.markdown).toBe(`✓ Set models.consolidation. (change 2)\n\n${MODELS}`);
    expect(await tool(daemon, faux, "settings_get", { path: "models.consolidation" })).toBe("Not set.");
    expect(await tool(daemon, faux, "changes_list")).toMatch(/^2 \S+ Set models\.consolidation$/m);
  });
});

describe("general", { timeout: 30_000 }, () => {
  test("General lists the settings with their values; a typed value is set, an invalid one rejected", async () => {
    await fake.receive({ command: "settings" });
    await fake.press("General");
    expect(fake.edited.at(-1)!.markdown).toBe("**General**");
    expect(labels()).toEqual([
      "Max concurrent jobs: 4",
      "Keep finished jobs (days): 7",
      "Memory: max facts: 30",
      "Memory: max tokens: 1500",
      "Tool errors before rollback: 5",
      "Minutes until marked good: 10",
      "Tool result tokens: 2000",
      "‹ Back",
      "⌂ Home",
    ]);
    await fake.press("Max concurrent jobs: 4");
    expect(fake.edited.at(-1)!.markdown).toBe("**Max concurrent jobs**\n\nSend the new value as your next message.");
    await fake.receive({ text: "2" });
    expect(fake.edited.at(-1)!.markdown).toBe("✓ Set jobs.maxConcurrent. (change 1)\n\n**General**");
    expect(labels()[0]).toBe("Max concurrent jobs: 2");
    expect(await tool(daemon, faux, "settings_get", { path: "jobs.maxConcurrent" })).toBe("2");
    await fake.press("Max concurrent jobs: 2");
    await fake.receive({ text: "0" });
    expect(fake.edited.at(-1)!.markdown).toMatch(/^✗ .+\n\n\*\*General\*\*$/);
    expect(labels()[0]).toBe("Max concurrent jobs: 2");
    expect(await tool(daemon, faux, "settings_get", { path: "jobs.maxConcurrent" })).toBe("2");
  });
});

describe("recent changes", { timeout: 30_000 }, () => {
  test("a change made by settings_set is listed and undone after confirmation", async () => {
    await tool(daemon, faux, "settings_set", { path: "jobs.maxConcurrent", value: 2, howToUse: "Fewer jobs at once." });
    await fake.receive({ command: "settings" });
    await fake.press("Recent changes");
    expect(fake.edited.at(-1)!.markdown).toBe("**Recent changes**");
    expect(labels()).toEqual(["1 Set jobs.maxConcurrent · <1m", "‹ Back", "⌂ Home"]);
    await fake.press("1 Set jobs.maxConcurrent · <1m");
    const { changes } = (await daemon.harness.snapshot(ChangesDoc, ROOT_CONVERSATION_ID, ctx))!;
    const time = new Date(changes[0]!.at).toLocaleString();
    expect(fake.edited.at(-1)!.markdown).toBe(`**Change 1**\n\nSet jobs.maxConcurrent\n${time}\n\nFewer jobs at once.`);
    expect(labels()).toEqual(["Undo", "‹ Back", "⌂ Home"]);
    await fake.press("Undo");
    expect(fake.edited.at(-1)!.markdown).toBe('**Undo "Set jobs.maxConcurrent"?**');
    expect(labels()).toEqual(["Undo", "Cancel"]);
    await fake.press("Undo");
    const undone = "✓ Undid: Set jobs.maxConcurrent\n\n**Recent changes**\n\nNo changes yet.";
    expect(fake.edited.at(-1)!.markdown).toBe(undone);
    expect(await tool(daemon, faux, "settings_get", { path: "jobs.maxConcurrent" })).toBe("4");
  });

  test("undoing a schedule-add removes the schedule and the change; pressing Undo again shows ✗", async () => {
    await tool(daemon, faux, "schedule_add", { text: "water plants", cron: "0 9 * * *" });
    await fake.receive({ command: "settings" });
    await fake.press("Recent changes");
    await fake.press('1 Scheduled "water plants" (0 9 * * *) · <1m');
    await fake.press("Undo");
    const confirm = fake.edited.at(-1)!;
    await fake.press("Undo");
    expect(fake.edited.at(-1)!.markdown).toMatch(/^✓ Removed schedule 1\.\n\n\*\*Recent changes\*\*$/);
    expect(labels()).toEqual(['2 Removed schedule "water plants" · <1m', "‹ Back", "⌂ Home"]);
    expect(await tool(daemon, faux, "schedule_list")).toBe("No schedules.");
    const again = confirm.buttons!.flat().find((b) => b.label === "Undo")!.action;
    await fake.receive({ action: again, messageId: confirm.messageId });
    expect(fake.edited.at(-1)!.markdown).toMatch(/^✗ No change 1\.\n\n\*\*Recent changes\*\*$/);
    expect(await tool(daemon, faux, "schedule_list")).toBe("No schedules.");
  });

  test("an undo call that does nothing shows ✗ and the change stays listed", async () => {
    await tool(daemon, faux, "schedule_add", { text: "water plants", cron: "0 9 * * *" });
    await fake.receive({ command: "settings" });
    await fake.press("Recent changes");
    await fake.press('1 Scheduled "water plants" (0 9 * * *) · <1m');
    await tool(daemon, faux, "schedule_remove", { id: "1" });
    await fake.press("Undo");
    await fake.press("Undo");
    expect(fake.edited.at(-1)!.markdown).toMatch(/^✗ No schedule 1\.\n\n\*\*Recent changes\*\*$/);
    expect(labels()).toContain('1 Scheduled "water plants" (0 9 * * *) · <1m');
    expect(await tool(daemon, faux, "schedule_list")).toBe("No schedules.");
  });

  test("only the 10 newest changes are listed, newest first", async () => {
    await daemon.root.commit(async (tx) => {
      for (let i = 1; i <= 11; i++) await logChange(tx, { title: `Change ${i}`, howToUse: "", undo: { commits: [] } });
    }, ctx);
    await fake.receive({ command: "settings" });
    await fake.press("Recent changes");
    const shown = labels().slice(0, -2).flatMap((l) => (l.match(/^\d+ /) ? [l.split(" ")[0]] : []));
    expect(shown).toEqual(["11", "10", "9", "8", "7", "6", "5", "4"]);
    await fake.press("›");
    expect(labels().slice(0, 2).map((l) => l.split(" ")[0])).toEqual(["3", "2"]);
  });
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

  test("a secret request made during a menu input is asked for when a command ends the input", async () => {
    const got = typed();
    await fake.receive({ command: "settings" });
    await fake.press("Input");
    await daemon.root.commit((tx) => addSecretRequest(tx, "svc.token", "to sync"), ctx);
    await sleep(500);
    expect(prompts()).toBe(0);
    await fake.receive({ command: "status" });
    await waitFor(() => prompts() === 1);
    await sleep(500);
    expect(prompts()).toBe(1);
    await fake.receive({ messageId: "77", text: "s3cr3t" });
    expect(readFileSync(join(home, "secrets/svc.token"), "utf8")).toBe("s3cr3t");
    expect(got).toEqual([]);
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
