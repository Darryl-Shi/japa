import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type ModelRef, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { envApiKeyAuth, type FauxProviderHandle, StringEnum } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Daemon } from "../src/kernel/boot.ts";
import { ChangesDoc, logChange } from "../src/kernel/changes.ts";
import type { Incoming, KernelContext, MessagingContext } from "../src/kernel/contracts.ts";
import { type Job, JobsDoc } from "../src/kernel/jobs/state.ts";
import { COMMANDS, createMenu } from "../src/kernel/messaging/menu/index.ts";
import { ago, dur, INPUT_MS, type Nav, outcomeLine, type Page } from "../src/kernel/messaging/menu/nav.ts";
import { MessagingDoc } from "../src/kernel/messaging/surface.ts";
import { boot } from "../src/kernel/boot.ts";
import type { JapaExtension } from "../src/kernel/extension.ts";
import { addSecretRequest, SecretRequestsDoc } from "../src/kernel/secret-requests.ts";
import { defineTool, Type } from "../src/sdk.ts";
import { statusText } from "../src/kernel/status.ts";
import {
  readUpdateState,
  type UpdateCheck,
  type Updater,
  type UpdateState,
  updateLog,
  writeUpdateState,
} from "../src/kernel/update-state.ts";
import { echo, land, NO_BWRAP, REPO_EXTENSIONS, testKit, waitFor } from "./helpers.ts";
import { ask, call, idle, jobs as jobsOf, reported, script, texts, tool } from "./jobs-helpers.ts";
import { bootMessaging, fakeAdapter, sleep } from "./messaging-helpers.ts";

// When `hook.ask` is set, the Settings home gains an `Input` button opening the screen it makes: there is no
// user-facing input screen yet to test typed input with. `hook.messaging` is the newest menu's messaging context.
const hook = vi.hoisted(() => ({
  ask: undefined as ((nav: Nav, home: Page) => Page) | undefined,
  messaging: undefined as MessagingContext | undefined,
  jobs: undefined as (() => Job[]) | undefined,
}));
// `hook.jobs` is the newest menu's jobs, as the surface last saw them.
vi.mock("../src/kernel/messaging/menu/jobs.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/kernel/messaging/menu/jobs.ts")>();
  return {
    ...real,
    jobsMenu: (...args: Parameters<typeof real.jobsMenu>) => {
      hook.jobs = args[1];
      return real.jobsMenu(...args);
    },
  };
});
vi.mock("../src/kernel/messaging/menu/settings.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/kernel/messaging/menu/settings.ts")>();
  return {
    ...real,
    settingsMenu: (nav: Nav, ...rest: [KernelContext, MessagingContext]) => {
      hook.messaging = rest[1];
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

const PROMPT = "japa needs `svc.token`: to sync. Reply to this message with it; I'll delete your reply at once.";
const DECLINE = "Don't want to provide `svc.token`?";
/** The open time of the fake adapter's secret input marker, if any. */
const marker = async () => (await daemon.harness.snapshot(MessagingDoc, ROOT_CONVERSATION_ID, ctx))?.secretInput?.fake;
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
const MODELS = "**Models**\n\nCoS: faux/a\nWorker: same as CoS\nConsolidation: same as CoS\nJob thinking: medium";

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

/** A job `id` titled `t<id>`, created and updated now, with `fields` over that. */
const jobOf = (id: string, fields: Partial<Job> = {}): Job => ({
  id,
  title: `t${id}`,
  brief: "b",
  model: "p/m",
  thinking: "medium",
  status: "running",
  conversationId: (1000 + Number(id)) as Job["conversationId"],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  seq: 0,
  reported: [],
  ...fields,
});
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("jobs", { timeout: 30_000 }, () => {
  /** Replaces the root's jobs with `list` (in id order), then waits until the surface has them. */
  async function seed(list: Job[]) {
    await daemon.root.commit(async (tx) => {
      const doc = await tx.doc(JobsDoc, daemon.root.id);
      doc.jobs = Object.fromEntries(list.map((j) => [j.id, j]));
      doc.nextId = list.length + 1;
    }, ctx);
    await waitFor(() => JSON.stringify(hook.jobs!()) === JSON.stringify(list));
  }
  /** Sends /jobs; returns the list it shows. */
  async function openJobs() {
    await fake.receive({ command: "jobs" });
    return fake.sent.at(-1)!;
  }

  test("the list counts jobs and shows active ones by id, then finished ones newest first, with icons and ages", async () => {
    const now = Date.now();
    await seed([
      jobOf("1", { status: "done", updatedAt: now - 3 * HOUR }),
      jobOf("2", { status: "running", updatedAt: now - 5 * MINUTE }),
      jobOf("3", { status: "failed", updatedAt: now - 50 * HOUR }),
      jobOf("4", { status: "needs_input", updatedAt: now - MINUTE }),
      jobOf("5", { status: "queued" }),
      jobOf("6", { status: "cancelled", updatedAt: now - 10 * MINUTE }),
      jobOf("7", { status: "done", updatedAt: now - MINUTE }),
      jobOf("8", { status: "queued" }),
    ]);
    const list = await openJobs();
    expect(list.markdown).toBe("**Jobs**\n\n1 running · 1 needs input · 2 queued · 4 finished");
    expect(list.buttons!.flat().map((b) => b.label)).toEqual([
      "🔄 #2 t2 · 5m",
      "❓ #4 t4 · 1m",
      "⏳ #5 t5 · <1m",
      "⏳ #8 t8 · <1m",
      "✅ #7 t7 · 1m",
      "⛔ #6 t6 · 10m",
      "✅ #1 t1 · 3h",
      "❌ #3 t3 · 2d",
      "Clear finished",
    ]);
    await seed([jobOf("1", { status: "running" }), jobOf("2", { status: "done" })]);
    expect((await openJobs()).markdown).toBe("**Jobs**\n\n1 running · 1 finished");
    await seed([jobOf("1", { status: "queued" })]);
    const queued = await openJobs();
    expect(queued.markdown).toBe("**Jobs**\n\n1 queued");
    expect(queued.buttons!.flat().map((b) => b.label)).toEqual(["⏳ #1 t1 · <1m"]);
  });

  test("without jobs the list says No jobs.", async () => {
    const list = await openJobs();
    expect(list.markdown).toBe("**Jobs**\n\nNo jobs.");
    expect(list.buttons).toEqual([]);
  });

  test("the list is paged 8 at a time; a long title is cut so the label fits 64 characters", async () => {
    const long = "x".repeat(100);
    await seed(Array.from({ length: 10 }, (_, i) => jobOf(String(i + 1), i === 0 ? { title: long } : {})));
    const list = await openJobs();
    const shown = list.buttons!.flat().map((b) => b.label);
    expect(shown.slice(1)).toEqual([...[2, 3, 4, 5, 6, 7, 8].map((i) => `🔄 #${i} t${i} · <1m`), "1/2", "›"]);
    expect(shown[0]).toMatch(/^🔄 #1 x+… · <1m$/);
    expect([...shown[0]!].length).toBe(64);
    await fake.press("›");
    expect(labels()).toEqual(["🔄 #9 t9 · <1m", "🔄 #10 t10 · <1m", "‹", "2/2"]);
  });

  test("/jobs shows model and thinking", async () => {
    // A job from before jobs had them, started by a worker profile.
    const legacy = { ...jobOf("2"), worker: "coder" } as Job;
    delete legacy.model;
    delete legacy.thinking;
    await seed([jobOf("1", { model: "anthropic/opus", thinking: "xhigh" }), legacy]);
    await openJobs();
    await fake.press("🔄 #1 t1 · <1m");
    expect(fake.edited.at(-1)!.markdown).toMatch(/^\*\*#1 t1\*\*\n\n🔄 running · anthropic\/opus · thinking xhigh\n/);
    // It runs on the settings' worker model (else the CoS's) and jobs.thinking.
    const cos = JSON.parse((await tool(daemon, faux, "settings_get", { path: "models.cos" }))!) as ModelRef;
    await tool(daemon, faux, "settings_set", { path: "jobs.thinking", value: "high" });
    await openJobs();
    await fake.press("🔄 #2 t2 · <1m");
    expect(fake.edited.at(-1)!.markdown.split("\n")[2]).toBe(`🔄 running · ${cos.provider}/${cos.modelId} · thinking high`);
  });

  test("a job's detail shows its status, model, thinking, times, brief and what its status calls for", async () => {
    const now = Date.now();
    await seed([
      jobOf("1", { title: "Research flights", model: "anthropic/opus", thinking: "high", brief: "Find flights", progress: "checking", createdAt: now - 2 * HOUR, updatedAt: now - 5 * MINUTE }),
      jobOf("2", { status: "done", result: "Found 3", createdAt: now - 72 * HOUR, updatedAt: now - 29 * HOUR }),
      jobOf("3", { status: "needs_input", result: "Which date?", createdAt: now - 65 * MINUTE }),
      jobOf("4", { status: "failed", result: "No network", createdAt: now - 3 * MINUTE }),
      jobOf("5", { status: "queued" }),
      jobOf("6", { status: "cancelled", result: "stopped" }),
    ]);
    const detail = async (label: string) => {
      await openJobs();
      await fake.press(label);
      return fake.edited.at(-1)!.markdown;
    };
    expect(await detail("🔄 #1 Research flights · 5m")).toBe(
      "**#1 Research flights**\n\n🔄 running · anthropic/opus · thinking high\nStarted 2h ago · updated 5m ago · ran 2h 0m\n\nBrief:\nFind flights\n\nProgress:\nchecking",
    );
    expect(labels()).toEqual(["‹ Back", "⌂ Home"]);
    expect(await detail("✅ #2 t2 · 29h")).toBe(
      "**#2 t2**\n\n✅ done · p/m · thinking medium\nStarted 3d ago · updated 29h ago · ran 1d 19h\n\nBrief:\nb\n\nResult:\nFound 3",
    );
    expect(await detail("❓ #3 t3 · <1m")).toBe(
      "**#3 t3**\n\n❓ needs input · p/m · thinking medium\nStarted 1h ago · updated <1m ago · ran 1h 5m\n\nBrief:\nb\n\nQuestion:\nWhich date?",
    );
    expect(await detail("❌ #4 t4 · <1m")).toBe(
      "**#4 t4**\n\n❌ failed · p/m · thinking medium\nStarted 3m ago · updated <1m ago · ran 3m\n\nBrief:\nb\n\nReason:\nNo network",
    );
    expect(await detail("⏳ #5 t5 · <1m")).toBe(
      "**#5 t5**\n\n⏳ queued · p/m · thinking medium\nStarted <1m ago · updated <1m ago · ran <1m\n\nBrief:\nb",
    );
    expect(await detail("⛔ #6 t6 · <1m")).toBe(
      "**#6 t6**\n\n⛔ cancelled · p/m · thinking medium\nStarted <1m ago · updated <1m ago · ran <1m\n\nBrief:\nb",
    );
  });

  test("durations", () => {
    expect([0, MINUTE - 1, 5 * MINUTE, 65 * MINUTE, 25 * HOUR, 49 * HOUR + 59 * MINUTE].map(dur)).toEqual([
      "<1m",
      "<1m",
      "5m",
      "1h 5m",
      "1d 1h",
      "2d 1h",
    ]);
  });

  test("a long brief is cut at 800 characters; Full brief shows it whole", async () => {
    const brief = `${"a".repeat(850)}z`;
    await seed([jobOf("1", { brief })]);
    await openJobs();
    await fake.press("🔄 #1 t1 · <1m");
    expect(fake.edited.at(-1)!.markdown).toContain(`\n\nBrief:\n${"a".repeat(799)}…`);
    expect(fake.edited.at(-1)!.markdown).not.toContain("aaaz");
    expect(labels()).toEqual(["Full brief", "‹ Back", "⌂ Home"]);
    await fake.press("Full brief");
    expect(fake.edited.at(-1)!.markdown).toBe(`**#1 t1**\n\n${brief}`);
    expect(labels()).toEqual(["‹ Back", "⌂ Home"]);
    await fake.press("‹ Back");
    expect(fake.edited.at(-1)!.markdown).toMatch(/^\*\*#1 t1\*\*\n\n🔄 running/);
    await seed([jobOf("1", { brief: "a".repeat(800) })]);
    await openJobs();
    await fake.press("🔄 #1 t1 · <1m");
    expect(fake.edited.at(-1)!.markdown).toContain(`\n\nBrief:\n${"a".repeat(800)}`);
    expect(labels()).toEqual(["‹ Back", "⌂ Home"]);
  });

  test("a job report longer than a message is cut to fit", async () => {
    const small = fakeAdapter({ maxMessageChars: 100 });
    const job = jobOf("1", { title: "Sum", status: "done", result: "word ".repeat(100) });
    const menu = createMenu(small.adapter, {} as KernelContext, {} as MessagingContext, () => [job]);
    await menu.command({ ...msg, command: "jobs" });
    await menu.press({ ...msg, action: small.sent.at(-1)!.buttons![0]![0]!.action });
    expect(small.edited.at(-1)!.markdown).toMatch(/^\*\*#1 Sum\*\*\n\n✅ done/);
    expect(small.edited.at(-1)!.markdown.length).toBeLessThanOrEqual(100);
  });

  test("Clear finished, after confirmation, removes the finished jobs and keeps the active ones", async () => {
    await seed([jobOf("1"), jobOf("2", { status: "done" }), jobOf("3", { status: "failed" })]);
    await openJobs();
    await fake.press("Clear finished");
    expect(fake.edited.at(-1)!.markdown).toBe("**Clear 2 finished jobs?**");
    expect(labels()).toEqual(["Clear", "Cancel"]);
    await fake.press("Cancel");
    expect(fake.edited.at(-1)!.markdown).toBe("**Jobs**\n\n1 running · 2 finished");
    await fake.press("Clear finished");
    await fake.press("Clear");
    expect(fake.edited.at(-1)!.markdown).toBe("✓ Cleared 2 finished jobs\n\n**Jobs**\n\n1 running");
    expect(labels()).toEqual(["🔄 #1 t1 · <1m"]);
    expect(Object.keys(await jobsOf(daemon))).toEqual(["1"]);
    await seed([jobOf("1", { status: "cancelled" })]);
    await openJobs();
    await fake.press("Clear finished");
    expect(fake.edited.at(-1)!.markdown).toBe("**Clear 1 finished job?**");
    await fake.press("Clear");
    expect(fake.edited.at(-1)!.markdown).toBe("✓ Cleared 1 finished job\n\n**Jobs**\n\nNo jobs.");
  });

  test("Back from a job opened on page 2 returns to page 2; Home to page 1", async () => {
    await seed(Array.from({ length: 10 }, (_, i) => jobOf(String(i + 1))));
    await openJobs();
    await fake.press("›");
    await fake.press("🔄 #9 t9 · <1m");
    expect(fake.edited.at(-1)!.markdown).toMatch(/^\*\*#9 t9\*\*/);
    await fake.press("‹ Back");
    expect(fake.edited.at(-1)!.markdown).toBe("**Jobs**\n\n10 running");
    expect(labels()).toEqual(["🔄 #9 t9 · <1m", "🔄 #10 t10 · <1m", "‹", "2/2"]);
    await fake.press("🔄 #10 t10 · <1m");
    await fake.press("⌂ Home");
    expect(labels().slice(-2)).toEqual(["1/2", "›"]);
  });

  test("paging rebuilds the list from the jobs as they are now; Cancel from Clear on page 2 returns to page 2", async () => {
    await seed(Array.from({ length: 10 }, (_, i) => jobOf(String(i + 1))));
    await openJobs();
    await seed([...Array.from({ length: 8 }, (_, i) => jobOf(String(i + 1))), jobOf("9", { status: "done", updatedAt: Date.now() - 3 * HOUR })]);
    await fake.press("›");
    const page2 = "**Jobs**\n\n8 running · 1 finished";
    expect(fake.edited.at(-1)!.markdown).toBe(page2);
    expect(labels()).toEqual(["✅ #9 t9 · 3h", "‹", "2/2", "Clear finished"]);
    await fake.press("Clear finished");
    expect(fake.edited.at(-1)!.markdown).toBe("**Clear 1 finished job?**");
    await fake.press("Cancel");
    expect(fake.edited.at(-1)!.markdown).toBe(page2);
    expect(labels()).toEqual(["✅ #9 t9 · 3h", "‹", "2/2", "Clear finished"]);
    await seed(Array.from({ length: 9 }, (_, i) => jobOf(String(i + 1))));
    await fake.press("2/2");
    expect(fake.edited.at(-1)!.markdown).toBe("**Jobs**\n\n9 running");
    expect(labels()).toEqual(["🔄 #9 t9 · <1m", "‹", "2/2"]);
    await fake.press("‹");
    expect(labels().slice(-2)).toEqual(["1/2", "›"]);
  });

  test.skipIf(NO_BWRAP)("a job started by the CoS is listed and its detail shown", async () => {
    script(faux, (_role, text) => (text === "start sum" ? call("job_start", { title: "Sum", brief: "Add" }) : undefined));
    await ask(daemon, "start sum");
    await waitFor(async () => (await reported(daemon)).length > 0 && (await idle(daemon)) && fake.sent.length > 0);
    const list = await openJobs();
    expect(list.buttons![0]![0]!.label).toMatch(/^\S+ #1 Sum · /u);
    await fake.press(list.buttons![0]![0]!.label);
    expect(fake.edited.at(-1)).toMatchObject({ messageId: list.id, markdown: expect.stringMatching(/^\*\*#1 Sum\*\*\n\n.+\n\nBrief:\nAdd/s) });
  });
});

test("an unknown command gets the help list and never reaches the CoS", async () => {
  await fake.receive({ command: "start" });
  expect(fake.sent.at(-1)!.markdown).toBe(
    "Commands:\n/jobs — Jobs: progress, results and cleanup\n/status — Model, extensions and errors\n" +
      "/settings — Models, extensions, schedules, general settings and changes\n" +
      "/update — Update japa, or roll back the last update",
  );
  await sleep(2000);
  expect(await texts(daemon.root, "user")).toEqual([]);
});

test("a button from before a restart says the menu expired, naming its command", async () => {
  const job = jobOf("1", { title: "Sum" });
  const messaging = { tool: settingsGet } as unknown as MessagingContext;
  const menus = [1, 2].map(() => createMenu(fake.adapter, fakeKernel, messaging, () => [job]));
  for (const menu of menus) await menu.command({ ...msg, command: "jobs" });
  await menus[1]!.press({ ...msg, action: fake.sent.at(-2)!.buttons![0]![0]!.action });
  expect(fake.edited.at(-1)!.markdown).toBe("This menu expired — send /jobs again.");
  for (const menu of menus) await menu.command({ ...msg, command: "settings" });
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
  expect(f.edited.at(-1)!.markdown).toBe("**Models**\n\nCoS: not set\nWorker: same as CoS\nConsolidation: same as CoS\nJob thinking: medium");
});

test("a stale /jobs button says send /jobs again", async () => {
  const f = fakeAdapter();
  const job = jobOf("1", { title: "Sum" });
  const menu = createMenu(f.adapter, {} as KernelContext, {} as MessagingContext, () => [job]);
  for (let i = 0; i < 501; i++) await menu.command({ ...msg, command: "jobs" });
  await menu.press({ ...msg, action: f.sent[0]!.buttons![0]![0]!.action });
  expect(f.edited.at(-1)!.markdown).toBe("This menu expired — send /jobs again.");
  await menu.press({ ...msg, action: f.sent[1]!.buttons![0]![0]!.action });
  expect(f.edited.at(-1)!.markdown).toMatch(/^\*\*#1 Sum\*\*/);
});

test("every screen but a home has ‹ Back and ⌂ Home; Back returns to the previous screen", async () => {
  await fake.receive({ command: "settings" });
  expect(fake.sent.at(-1)!.markdown).toBe("**Settings**");
  expect(fake.sent.at(-1)!.buttons!.flat().map((b) => b.label)).toEqual(HOME);
  await fake.press("Models");
  expect(fake.edited.at(-1)!.markdown).toMatch(/^\*\*Models\*\*\n\nCoS: faux\//);
  expect(labels()).toEqual(["CoS", "Worker", "Consolidation", "Job thinking", "‹ Back", "⌂ Home"]);
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
  const models = "**Models**\n\nCoS: not set\nWorker: same as CoS\nConsolidation: same as CoS\nJob thinking: medium";
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

test("a provider with more models than buttons are kept makes buttons for the page shown only", async () => {
  await reboot(testKit({ models: Array.from({ length: 600 }, (_, i) => ({ id: `m${i + 1}` })) }));
  await fake.receive({ command: "settings" });
  const home = fake.sent.at(-1)!;
  await fake.press("Models");
  for (const label of ["CoS", "faux"]) await fake.press(label);
  const first = ["✓ m1", ...Array.from({ length: 7 }, (_, i) => `m${i + 2}`), "1/75", "›", "‹ Back", "⌂ Home"];
  expect(labels()).toEqual(first);
  await fake.press("›");
  await fake.press("m9");
  expect(fake.edited.at(-1)!.markdown).toBe(`✓ Set models.cos. (change 1)\n\n${MODELS.replace("faux/a", "faux/m9")}`);
  for (const label of ["CoS", "faux"]) await fake.press(label);
  expect(labels()[0]).toBe("m1");
  await fake.press("›");
  expect(labels()[0]).toBe("✓ m9");
  await fake.press("‹ Back");
  expect(fake.edited.at(-1)!.markdown).toBe("**Choose a provider**");
  await fake.receive({ action: home.buttons![1]![0]!.action, messageId: home.id });
  expect(fake.edited.at(-1)!.markdown).toBe("**Extensions**");
});

test("Back from an extension opened on page 2 returns to page 2; paging shows the list as it is now", async () => {
  await fake.receive({ command: "settings" });
  await fake.press("Extensions");
  expect(labels()).toContain("fake · ✅ on");
  await fake.press("›");
  const page2 = labels();
  expect(page2).toContain("2/2");
  await fake.press(page2[0]!);
  await fake.press("‹ Back");
  expect(labels()).toEqual(page2);
  await hook.messaging!.setSetting("extensions.fake.enabled", false);
  await fake.press("‹");
  expect(labels()).toContain("fake · ⏸ off");
});

describe("schedules", { timeout: 30_000 }, () => {
  test("Back from a schedule opened on page 2 returns to page 2; paging shows the list as it is now", async () => {
    const add = (i: number) => hook.messaging!.tool("schedule_add", { text: `s${i}`, cron: "0 9 * * *" });
    await fake.receive({ command: "settings" });
    for (let i = 1; i <= 9; i++) await add(i);
    await fake.press("Schedules");
    await fake.press("›");
    expect(labels()).toEqual(["s9 (0 9 * * *)", "‹", "2/2", "‹ Back", "⌂ Home"]);
    await fake.press("s9 (0 9 * * *)");
    await fake.press("‹ Back");
    expect(labels()).toEqual(["s9 (0 9 * * *)", "‹", "2/2", "‹ Back", "⌂ Home"]);
    await add(10);
    await fake.press("2/2");
    expect(labels()).toEqual(["s9 (0 9 * * *)", "s10 (0 9 * * *)", "‹", "2/2", "‹ Back", "⌂ Home"]);
  });

  const WATER = "water plants (0 9 * * *)";
  const local = (time: number) => new Date(time).toLocaleString();
  /** The `next` time of schedule `id`, from `schedule_list`'s details. */
  const nextOf = async (id: string) => {
    const details = (await hook.messaging!.tool("schedule_list", {}))!.details as { id: string; next: number }[];
    return details.find((s) => s.id === id)!.next;
  };
  /** Adds the water plants schedule and opens its detail screen. */
  async function openWater() {
    await tool(daemon, faux, "schedule_add", { text: "water plants", cron: "0 9 * * *" });
    await fake.receive({ command: "settings" });
    await fake.press("Schedules");
    expect(labels()).toEqual([WATER, "‹ Back", "⌂ Home"]);
    await fake.press(WATER);
  }

  test("a schedule's detail shows its text, how it repeats and its next time", async () => {
    await openWater();
    const next = await nextOf("1");
    expect(fake.edited.at(-1)!.markdown).toBe(`**Schedule 1**\n\nwater plants\nRepeats: 0 9 * * *\nNext: ${local(next)}`);
    expect(labels()).toEqual(["Pause", "Remove", "‹ Back", "⌂ Home"]);
    await fake.press("‹ Back");
    expect(fake.edited.at(-1)!.markdown).toBe("**Schedules**");
  });

  test("a once schedule's detail shows when it fires", async () => {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    await tool(daemon, faux, "schedule_add", { text: "call mum", at });
    await fake.receive({ command: "settings" });
    await fake.press("Schedules");
    const when = local(Date.parse(at));
    await fake.press(`call mum (${when})`);
    expect(fake.edited.at(-1)!.markdown).toBe(`**Schedule 1**\n\ncall mum\nOnce: ${when}\nNext: ${when}`);
  });

  test("Pause pauses a schedule, marked ⏸ in the list; Resume resumes it", async () => {
    await openWater();
    await fake.press("Pause");
    expect(fake.edited.at(-1)!.markdown).toBe(
      "✓ Paused schedule 1.\n\n**Schedule 1**\n\nwater plants\nRepeats: 0 9 * * *\nPaused",
    );
    expect(labels()).toEqual(["Resume", "Remove", "‹ Back", "⌂ Home"]);
    expect(await tool(daemon, faux, "schedule_list")).toMatch(/water plants \(paused\)$/);
    await fake.press("‹ Back");
    expect(labels()).toEqual([`⏸ ${WATER}`, "‹ Back", "⌂ Home"]);
    await fake.press(`⏸ ${WATER}`);
    await fake.press("Resume");
    const next = local(await nextOf("1"));
    expect(fake.edited.at(-1)!.markdown).toBe(
      `✓ Resumed schedule 1: next at ${next}.\n\n**Schedule 1**\n\nwater plants\nRepeats: 0 9 * * *\nNext: ${next}`,
    );
    expect(labels()).toEqual(["Pause", "Remove", "‹ Back", "⌂ Home"]);
    await fake.press("‹ Back");
    expect(labels()).toEqual([WATER, "‹ Back", "⌂ Home"]);
    expect(await tool(daemon, faux, "changes_list")).toMatch(/Resumed schedule "water plants"/);
  });

  test("a schedule is removed from its detail after confirmation; Cancel goes back to the detail", async () => {
    await openWater();
    await fake.press("Remove");
    expect(fake.edited.at(-1)!.markdown).toBe(`**Remove schedule "${WATER}"?**`);
    expect(labels()).toEqual(["Remove", "Cancel"]);
    await fake.press("Cancel");
    expect(fake.edited.at(-1)!.markdown).toMatch(/^\*\*Schedule 1\*\*/);
    await fake.press("Remove");
    await fake.press("Remove");
    expect(fake.edited.at(-1)!.markdown).toBe("✓ Removed schedule 1.\n\n**Schedules**\n\nNo schedules.");
    expect(labels()).toEqual(["‹ Back", "⌂ Home"]);
    expect(await tool(daemon, faux, "schedule_list")).toBe("No schedules.");
    expect(await tool(daemon, faux, "changes_list")).toMatch(/Removed schedule "water plants"/);
  });

  test("a schedule gone meanwhile shows the list with ✗", async () => {
    await openWater();
    await tool(daemon, faux, "schedule_remove", { id: "1" });
    await fake.press("Pause");
    expect(fake.edited.at(-1)!.markdown).toBe("✗ No schedule 1.\n\n**Schedules**\n\nNo schedules.");
    expect(labels()).toEqual(["‹ Back", "⌂ Home"]);
    await tool(daemon, faux, "schedule_add", { text: "feed cat", cron: "0 8 * * *" });
    await fake.press("‹ Back");
    await fake.press("Schedules");
    await tool(daemon, faux, "schedule_remove", { id: "2" });
    await fake.press("feed cat (0 8 * * *)");
    expect(fake.edited.at(-1)!.markdown).toBe("✗ No schedule 2.\n\n**Schedules**\n\nNo schedules.");
  });

  test("without schedules, or without the schedule tools, the list says No schedules.", async () => {
    await fake.receive({ command: "settings" });
    await fake.press("Schedules");
    expect(fake.edited.at(-1)!.markdown).toBe("**Schedules**\n\nNo schedules.");
    expect(labels()).toEqual(["‹ Back", "⌂ Home"]);
    const f = fakeAdapter();
    const menu = createMenu(f.adapter, fakeKernel, { tool: settingsGet } as unknown as MessagingContext, () => []);
    await menu.command({ ...msg, command: "settings" });
    await presser(menu, f)("Schedules");
    expect(f.edited.at(-1)!.markdown).toBe("**Schedules**\n\nNo schedules.");
    expect(f.edited.at(-1)!.buttons!.flat().map((b) => b.label)).toEqual(["‹ Back", "⌂ Home"]);
  });
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

  test("Job thinking lists the levels, ticks the current one, and sets jobs.thinking, logged", async () => {
    await reboot(testKit({ models: [{ id: "a" }] }));
    await fake.receive({ command: "settings" });
    await fake.press("Models");
    await fake.press("Job thinking");
    expect(fake.edited.at(-1)!.markdown).toBe("**Job thinking**");
    expect(labels()).toEqual(["off", "minimal", "low", "✓ medium", "high", "xhigh", "‹ Back", "⌂ Home"]);
    await fake.press("high");
    const high = MODELS.replace("Job thinking: medium", "Job thinking: high");
    expect(fake.edited.at(-1)!.markdown).toBe(`✓ Set jobs.thinking. (change 1)\n\n${high}`);
    expect(await tool(daemon, faux, "settings_get", { path: "jobs.thinking" })).toBe('"high"');
    await fake.press("Job thinking");
    expect(labels()).toContain("✓ high");
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

  test("Back from a change opened on page 2 returns to page 2", async () => {
    await daemon.root.commit(async (tx) => {
      for (let i = 1; i <= 10; i++) await logChange(tx, { title: `Change ${i}`, howToUse: "", undo: { commits: [] } });
    }, ctx);
    await fake.receive({ command: "settings" });
    await fake.press("Recent changes");
    await fake.press("›");
    const page2 = labels();
    expect(page2.slice(0, 2).map((l) => l.split(" ")[0])).toEqual(["2", "1"]);
    await fake.press(page2[0]!);
    expect(fake.edited.at(-1)!.markdown).toMatch(/^\*\*Change 2\*\*/);
    await fake.press("‹ Back");
    expect(labels()).toEqual(page2);
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

  test("a request is prompted even while a menu input waits; a reply fulfils it and plain text goes to the input", async () => {
    const got = typed();
    await fake.receive({ command: "settings" });
    await fake.press("Input");
    await daemon.root.commit((tx) => addSecretRequest(tx, "svc.token", "to sync"), ctx);
    await waitFor(() => fake.sent.some((s) => s.markdown === DECLINE));
    const prompt = fake.sent.find((s) => s.markdown === PROMPT)!;
    await fake.receive({ messageId: "77", text: "s3cr3t", replyTo: prompt.id });
    expect(readFileSync(join(home, "secrets/svc.token"), "utf8")).toBe("s3cr3t");
    expect(fake.deleted[0]).toEqual({ chat: "42", messageId: "77" });
    expect(got).toEqual([]);
    await fake.receive({ text: "value" });
    expect(got).toEqual(["value"]);
    expect(await transcript()).not.toContain("s3cr3t");
  });

  test("an input expires 10 minutes after it opens: the next text goes to the CoS", async () => {
    const got = typed();
    const real = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
    try {
      await fake.receive({ command: "settings" });
      await fake.press("Input");
      offset = INPUT_MS - 5000;
      await fake.receive({ text: "a" });
      expect(got).toEqual(["a"]);
      await fake.press("Input");
      offset += INPUT_MS;
      await fake.receive({ text: "yes" });
      await waitFor(async () => (await texts(daemon.root, "user")).includes("yes"));
      expect(got).toEqual(["a"]);
    } finally {
      clock.mockRestore();
    }
  });

  test("an expired secret input's marker is cleared and the next text goes to the CoS", async () => {
    const got = typed(true);
    const real = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
    try {
      await fake.receive({ command: "settings" });
      await fake.press("Input");
      expect(await marker()).toBeTypeOf("number");
      offset = INPUT_MS;
      await fake.receive({ text: "hello" });
      await waitFor(async () => (await texts(daemon.root, "user")).includes("hello"));
      expect(got).toEqual([]);
      expect(fake.deleted).toEqual([]);
      expect(await marker()).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  test("a secret input's marker is cleared when it is applied, cancelled, or ended by a command or a press", async () => {
    typed(true);
    type Sent = (typeof fake.sent)[number];
    const enders = [
      () => fake.receive({ text: "s3cr3t" }),
      () => fake.press("Cancel"),
      () => fake.receive({ command: "status" }),
      (home: Sent) => fake.receive({ action: home.buttons![0]![0]!.action, messageId: home.id }),
    ];
    for (const end of enders) {
      await fake.receive({ command: "settings" });
      const home = fake.sent.at(-1)!;
      await fake.press("Input");
      expect(await marker()).toBeTypeOf("number");
      await end(home);
      expect(await marker()).toBeUndefined();
    }
  });

});

describe("extensions", { timeout: 60_000 }, () => {
  const ping = defineTool({
    name: "demo_ping",
    description: "Ping",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "pong" }] }),
  });
  /** `demo`: tool `demo_ping`, secret `demo.key`, and a boolean, two enums, a string and a number setting. */
  const demo = () => {
    let kept: KernelContext | undefined;
    const extension: JapaExtension = {
      name: "demo",
      summary: "Demo pings",
      secrets: [{ name: "demo.key", description: "Demo API key" }],
      settings: Type.Object({
        loud: Type.Optional(Type.Boolean({ default: false })),
        mode: Type.Optional(StringEnum(["fast", "slow"], { default: "fast" })),
        size: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])),
        label: Type.Optional(Type.String({ description: "Shown in pings" })),
        limit: Type.Optional(Type.Number()),
      }),
      provides: { tool: [ping] },
      setup: (c) => {
        kept = c;
      },
    };
    return { extension, kernel: () => kept! };
  };
  const rootTools = async () => (await daemon.root.agent(ctx)).tools.map((t) => t.name);
  /** Every item label of the paged list on screen, from its first page on. */
  async function allLabels() {
    while (labels().includes("‹")) await fake.press("‹");
    const all = labels().filter((l) => !/^(‹|›|\d+\/\d+|‹ Back|⌂ Home)$/.test(l));
    while (labels().includes("›")) {
      await fake.press("›");
      all.push(...labels().filter((l) => !/^(‹|›|\d+\/\d+|‹ Back|⌂ Home)$/.test(l)));
    }
    return all;
  }
  /** Opens /settings, Extensions, then the extension `name`. */
  async function open(name: string) {
    await fake.receive({ command: "settings" });
    await fake.press("Extensions");
    while (!labels().some((l) => l.startsWith(`${name} · `))) await fake.press("›");
    await fake.press(labels().find((l) => l.startsWith(`${name} · `))!);
  }
  const body = (state: string, secret: string, settings: string[]) =>
    `**demo · ${state}**\n\nDemo pings\n\nSecrets:\n- demo.key: ${secret}\n\nSettings:\n${settings.join("\n")}`;
  const DEFAULTS = ["- loud: default (false)", '- mode: default ("fast")', "- size: not set", "- label: not set", "- limit: not set"];
  const BUTTONS = ["loud: off", "mode", "size", "label", "limit"];
  const shown = () => fake.edited.at(-1)!.markdown;

  test("the list labels each extension on, not set up or error, sorted; a failed workspace one is listed", async () => {
    await reboot(testKit(), [demo().extension]);
    mkdirSync(join(home, "extensions", "broken"), { recursive: true });
    writeFileSync(join(home, "extensions", "broken", "index.ts"), 'export default { name: "wrong", summary: "W" };\n');
    await daemon.reconcile();
    await fake.receive({ command: "settings" });
    await fake.press("Extensions");
    expect(fake.edited.at(-1)!.markdown).toBe("**Extensions**");
    const all = await allLabels();
    expect(all).toEqual(expect.arrayContaining(["broken · ⚠️ error", "demo · ⚪ not set up", "fake · ✅ on"]));
    const names = all.map((l) => l.split(" · ")[0]!);
    expect(names).toEqual(names.toSorted());
    const broken = (await hook.messaging!.extensions()).find((e) => e.name === "broken");
    expect(broken).toMatchObject({ state: "not set up", workspace: true, loaded: false, error: "manifest name must match directory" });
    await open("broken");
    expect(shown()).toBe("**broken · ⚠️ error**\n\nError: manifest name must match directory");
    expect(labels()).toEqual(["Roll back to last known good", "‹ Back", "⌂ Home"]);
  });

  test("a messaging extension's owner is shown, never offered for editing", async () => {
    await open("fake");
    expect(shown()).toBe('**fake · ✅ on**\n\nFake chat\n\nSettings:\n- owner: "42"');
    expect(labels()).toEqual(["Turn off", "‹ Back", "⌂ Home"]);
  });

  test("an unset boolean without a default reads not set and is set on; with one it reads the default", async () => {
    const quiet: JapaExtension = {
      name: "quiet",
      summary: "Quiet",
      settings: Type.Object({ hush: Type.Optional(Type.Boolean()) }),
    };
    await reboot(testKit(), [quiet]);
    await open("quiet");
    expect(shown()).toBe("**quiet · ✅ on**\n\nQuiet\n\nSettings:\n- hush: not set");
    expect(labels()).toEqual(["hush: not set", "Turn off", "‹ Back", "⌂ Home"]);
    await fake.press("hush: not set");
    expect(shown()).toMatch(/^✓ Set extensions\.quiet\.hush\. \(change 1\)\n\n.+\n- hush: true$/s);
    expect(labels()[0]).toBe("hush: on");
    await open("desktop");
    expect(shown()).toContain("- autostart: default (true)");
    expect(labels()).toContain("autostart: on");
  });

  test("the detail shows secrets as set or not set, never their value, and each setting", async () => {
    await reboot(testKit(), [demo().extension]);
    await open("demo");
    expect(shown()).toBe(body("⚪ not set up", "not set", DEFAULTS));
    expect(labels()).toEqual(["Set demo.key", ...BUTTONS, "‹ Back", "⌂ Home"]);
    const info = (await hook.messaging!.extensions()).find((e) => e.name === "demo")!;
    expect(info).toMatchObject({ summary: "Demo pings", state: "not set up", workspace: false, loaded: true, values: {} });
    expect(info.secrets).toEqual([{ name: "demo.key", description: "Demo API key", set: false }]);
    expect(Object.keys((info.schema as { properties: object }).properties)).toContain("enabled");
    expect(await hook.messaging!.setSecret("demo", "demo.key", "s3cr3t")).toBe("Set demo.key.");
    await open("demo");
    expect(shown()).toBe(body("✅ on", "set", DEFAULTS));
    expect(JSON.stringify(await hook.messaging!.extensions())).not.toContain("s3cr3t");
  });

  test("Set <secret> stores the typed secret, deletes it, and the extension becomes available to the CoS", async () => {
    const d = demo();
    await reboot(testKit(), [d.extension]);
    expect(await rootTools()).not.toContain("demo_ping");
    const provided = d.kernel().secretProvided("demo.key");
    await open("demo");
    await fake.press("Set demo.key");
    expect(shown()).toBe("**Set demo.key**\n\nDemo API key\n\nSend the new value as your next message.");
    expect(labels()).toEqual(["Cancel"]);
    await fake.receive({ messageId: "77", text: "s3cr3t" });
    expect(fake.deleted).toEqual([{ chat: "42", messageId: "77" }]);
    expect(readFileSync(join(home, "secrets", "demo.key"), "utf8")).toBe("s3cr3t");
    expect(await provided).toBe("s3cr3t");
    expect(shown()).toBe(`✓ Set demo.key.\n\n${body("✅ on", "set", DEFAULTS)}`);
    expect(labels()).toEqual(["Set demo.key", ...BUTTONS, "Turn off", "‹ Back", "⌂ Home"]);
    expect(await rootTools()).toContain("demo_ping");
    expect(daemon.capabilities()).toContain("- demo: Demo pings");
    await fake.press("‹ Back");
    expect(await allLabels()).toContain("demo · ✅ on");
    for (const m of [...fake.sent, ...fake.edited]) expect(m.markdown).not.toContain("s3cr3t");
    await sleep(500);
    expect(await transcript()).not.toContain("s3cr3t");
  });

  describe("a secret prompt open when the daemon stopped", () => {
    const EXPIRED = "That prompt expired — tap Set again.";
    /**
     * Boots on sqlite storage with `demo`, opens Set demo.key, runs `meanwhile`, then restarts the daemon with a fresh
     * adapter.
     */
    async function askThenRestart(meanwhile?: () => Promise<unknown>) {
      const kit = testKit();
      const d = demo();
      await daemon.close();
      fake = fakeAdapter();
      ({ daemon, faux, home } = await bootMessaging(fake, { storage: { adapter: "sqlite" } }, [d.extension], kit));
      await open("demo");
      await fake.press("Set demo.key");
      expect(await marker()).toBeTypeOf("number");
      await meanwhile?.();
      await daemon.close();
      fake = fakeAdapter();
      daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, fake.extension, d.extension] });
    }

    test("it holds the next plain text, not a reply to a request prompt: deleted, never submitted, the owner told to tap Set again", async () => {
      await askThenRestart();
      await daemon.root.commit((tx) => addSecretRequest(tx, "svc.token", "to sync"), ctx);
      await waitFor(() => fake.sent.some((s) => s.markdown === DECLINE)); // prompted while the text is held
      const [prompt, decline] = fake.sent;
      expect(prompt).toMatchObject({ markdown: PROMPT });
      await fake.receive({ messageId: "76", text: "v4lu3", replyTo: prompt!.id });
      expect(readFileSync(join(home, "secrets", "svc.token"), "utf8")).toBe("v4lu3");
      expect(await marker()).toBeTypeOf("number");
      await fake.receive({ id: "s", messageId: "77", text: "s3cr3t" });
      expect(fake.deleted).toEqual(
        ["76", prompt!.id, decline!.id, "77"].map((messageId) => ({ chat: "42", messageId })),
      );
      expect(fake.sent.map((s) => s.markdown)).toContain(EXPIRED);
      expect(prompts()).toBe(1);
      expect(await marker()).toBeUndefined();
      expect(existsSync(join(home, "secrets", "demo.key"))).toBe(false);
      await fake.receive({ id: "s", messageId: "77", text: "s3cr3t" }); // delivered again
      expect(fake.deleted).toHaveLength(5);
      await fake.receive({ text: "hello" });
      await waitFor(async () => (await texts(daemon.root, "user")).includes("hello"));
      expect(await transcript()).not.toContain("s3cr3t");
      expect(await transcript()).not.toContain("v4lu3");
    });

    test("after 10 minutes the marker is just cleared and the next text goes to the CoS", async () => {
      const real = Date.now.bind(Date);
      let offset = 0;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
      try {
        await askThenRestart(async () => {
          offset = INPUT_MS;
        });
        await fake.receive({ text: "hello" });
        await waitFor(async () => (await texts(daemon.root, "user")).includes("hello"));
        expect(fake.deleted).toEqual([]);
        expect(fake.sent.map((s) => s.markdown)).not.toContain(EXPIRED);
        expect(await marker()).toBeUndefined();
      } finally {
        clock.mockRestore();
      }
    });

    test("a command ends it: the marker is cleared and the next text goes to the CoS", async () => {
      await askThenRestart();
      await fake.receive({ command: "status" });
      expect(await marker()).toBeUndefined();
      await fake.receive({ text: "hello" });
      await waitFor(async () => (await texts(daemon.root, "user")).includes("hello"));
      expect(fake.deleted).toEqual([]);
    });
  });

  test("setting a requested secret from the menu fulfils the request and deletes its prompt", async () => {
    await reboot(testKit(), [demo().extension]);
    expect(await tool(daemon, faux, "secret_request", { name: "demo.key", why: "to ping" })).toMatch(/^Asked the user/);
    await waitFor(() => fake.sent.some((s) => s.markdown === "Don't want to provide `demo.key`?"));
    const [prompt, decline] = fake.sent;
    await open("demo");
    await fake.press("Set demo.key");
    await fake.receive({ messageId: "77", text: "s3cr3t" });
    expect(fake.deleted[0]).toEqual({ chat: "42", messageId: "77" });
    await waitFor(() => fake.deleted.length === 3);
    expect(fake.deleted.slice(1)).toEqual([
      { chat: "42", messageId: prompt!.id },
      { chat: "42", messageId: decline!.id },
    ]);
    expect(shown()).toMatch(/^✓ Set demo\.key\.\n\n\*\*demo · ✅ on\*\*/);
    expect((await daemon.harness.snapshot(SecretRequestsDoc, ROOT_CONVERSATION_ID, ctx))!.pending).toEqual([]);
    await waitFor(async () => (await texts(daemon.root, "user")).includes("[secret demo.key provided]"));
    expect(await rootTools()).toContain("demo_ping");
    expect(await transcript()).not.toContain("s3cr3t");
  });

  test("a secret the extension doesn't declare is not set", async () => {
    await reboot(testKit(), [demo().extension]);
    expect(await hook.messaging!.setSecret("demo", "other.key", "x")).toBe("Not changed: demo doesn't use other.key");
    expect(existsSync(join(home, "secrets", "other.key"))).toBe(false);
  });

  test("boolean toggle, enum choices and typed settings are set and logged; an invalid one shows ✗", async () => {
    await reboot(testKit(), [demo().extension]);
    await open("demo");
    await fake.press("loud: off");
    const loud = ["- loud: true", ...DEFAULTS.slice(1)];
    expect(shown()).toBe(`✓ Set extensions.demo.loud. (change 1)\n\n${body("⚪ not set up", "not set", loud)}`);
    expect(labels()).toContain("loud: on");
    await fake.press("mode");
    expect(shown()).toBe("**mode**");
    expect(labels()).toEqual(["✓ fast", "slow", "‹ Back", "⌂ Home"]);
    await fake.press("slow");
    expect(shown()).toMatch(/^✓ Set extensions\.demo\.mode\. \(change 2\)\n\n\*\*demo/);
    expect(shown()).toContain('- mode: "slow"');
    await fake.press("size");
    expect(labels()).toEqual(["1", "2", "‹ Back", "⌂ Home"]);
    await fake.press("2");
    expect(shown()).toContain("- size: 2");
    await fake.press("size");
    expect(labels()).toEqual(["1", "✓ 2", "‹ Back", "⌂ Home"]);
    await fake.press("‹ Back");
    await fake.press("label");
    expect(shown()).toBe("**label**\n\nShown in pings\n\nSend the new value as your next message.");
    await fake.receive({ text: "hello" });
    expect(shown()).toMatch(/^✓ Set extensions\.demo\.label\. \(change 4\)/);
    expect(shown()).toContain('- label: "hello"');
    await fake.press("limit");
    await fake.receive({ text: "5" });
    expect(shown()).toContain("- limit: 5");
    await fake.press("limit");
    await fake.receive({ text: "lots" });
    expect(shown()).toMatch(/^✗ .+\n\n\*\*demo/);
    expect(shown()).toContain("- limit: 5");
    await fake.press("limit");
    await fake.receive({ text: "null" });
    expect(shown()).toMatch(/^✗ limit can't be null\n\n\*\*demo/);
    expect(shown()).toContain("- limit: 5");
    await fake.press("loud: on");
    expect(shown()).toContain("- loud: false");
    const changes = await tool(daemon, faux, "changes_list");
    for (const prop of ["loud", "mode", "size", "label", "limit"]) expect(changes).toContain(`Set extensions.demo.${prop}`);
    expect(await tool(daemon, faux, "settings_get", { path: "extensions.demo" })).toBe(
      JSON.stringify({ loud: false, mode: "slow", size: 2, label: "hello", limit: 5 }, null, 2),
    );
    // A text setting keeps exactly what was typed, even when it reads as JSON.
    const label = async () => {
      const got = await hook.messaging!.tool("settings_get", { path: "extensions.demo.label" });
      return (got!.content![0] as { text: string }).text;
    };
    for (const text of ["12345678901234567890", "1e3", "1.50", "null", '"quoted"']) {
      await open("demo");
      await fake.press("label");
      await fake.receive({ text });
      expect(shown()).toMatch(/^✓ Set extensions\.demo\.label\./);
      expect(await label()).toBe(JSON.stringify(text));
    }
  });

  test("Turn off hides the extension from the CoS; Turn on shows it again", async () => {
    await reboot(testKit(), [demo().extension]);
    await hook.messaging!.setSecret("demo", "demo.key", "k");
    expect(await rootTools()).toContain("demo_ping");
    await open("demo");
    await fake.press("Turn off");
    expect(shown()).toMatch(/^✓ Set extensions\.demo\.enabled\. \(change 1\)\n\n\*\*demo · ⏸ off\*\*/);
    expect(labels()).toContain("Turn on");
    expect(await rootTools()).not.toContain("demo_ping");
    expect(daemon.capabilities()).not.toContain("demo");
    await fake.press("‹ Back");
    expect(await allLabels()).toContain("demo · ⏸ off");
    await open("demo");
    await fake.press("Turn on");
    expect(shown()).toMatch(/^✓ Set extensions\.demo\.enabled\. \(change 2\)\n\n\*\*demo · ✅ on\*\*/);
    expect(labels()).toContain("Turn off");
    expect(await rootTools()).toContain("demo_ping");
    expect(await tool(daemon, faux, "settings_get", { path: "extensions.demo.enabled" })).toBe("Not set.");
  });

  test("an extension is rolled back from the menu after confirmation", async () => {
    land(home, "extensions/echo/index.ts", echo("v1"));
    await daemon.reconcile();
    await daemon.markGood();
    land(home, "extensions/echo/index.ts", echo("v2"));
    await daemon.reconcile();
    expect(await tool(daemon, faux, "echo")).toBe("v2");
    await open("echo");
    expect(shown()).toBe("**echo · ✅ on**\n\nEchoes");
    expect(labels()).toEqual(["Turn off", "Roll back to last known good", "‹ Back", "⌂ Home"]);
    await fake.press("Roll back to last known good");
    expect(shown()).toBe("**Roll back echo to last known good?**");
    expect(labels()).toEqual(["Roll back to last known good", "Cancel"]);
    await fake.press("Roll back to last known good");
    expect(shown()).toMatch(/^✓ Rolled back extension echo\.\n\n\*\*Extensions\*\*$/);
    expect(await tool(daemon, faux, "echo")).toBe("v1");
    expect(await tool(daemon, faux, "changes_list")).toMatch(/Rolled back extension echo/);
  });
});

describe("update", { timeout: 30_000 }, () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const CHAT = { adapter: "fake", chat: "42" };
  const UPDATING = "Updating… japa will restart and report back here.";
  const CONFIRM = "**Roll back to aaaaaaa? japa will restart.**";
  // What the fake `Updater`'s check and current answer (and how often they were asked), what its launch throws, and
  // the launches it was asked for.
  let check: () => Promise<UpdateCheck>;
  let current: () => Promise<string>;
  let asked: { check: number; current: number };
  let launchError: Error | undefined;
  let launches: [string, boolean][];
  let kit: ReturnType<typeof testKit>;
  const updater: Updater = {
    check: () => {
      asked.check++;
      return check();
    },
    current: () => {
      asked.current++;
      return current();
    },
    launch: async (to, rollback) => {
      launches.push([to, rollback]);
      if (launchError !== undefined) throw launchError;
    },
  };
  const oneCommit = async () => ({ current: A, target: B, commits: ["bbbbbbb two"] });
  /** A finished update from A to B, asked in `chat`, unreported. */
  const updated = (chat = CHAT): UpdateState => ({
    state: "updated",
    started: Date.now(),
    finished: Date.now(),
    chat,
    from: A,
    to: B,
    rollback: false,
    restarted: "service",
    commits: ["bbbbbbb two"],
    whatsNew: [],
    reported: false,
  });

  const offline = async (): Promise<UpdateCheck> => {
    throw new Error("could not fetch origin main: unable to access");
  };

  beforeEach(async () => {
    check = oneCommit;
    current = async () => A;
    asked = { check: 0, current: 0 };
    launchError = undefined;
    launches = [];
    kit = testKit();
    await daemon.close();
    fake = fakeAdapter();
    ({ daemon, faux, home } = await bootMessaging(fake, {}, [], kit, { updater }));
  });

  /** Sends /update: it says it's checking, then that message shows the result, which is returned. */
  async function openUpdate() {
    await fake.receive({ command: "update" });
    const checking = fake.sent.at(-1)!;
    expect(checking.markdown).toBe("Checking for updates…");
    const shown = fake.edited.at(-1)!;
    expect(shown.messageId).toBe(checking.id);
    return shown;
  }
  /** Presses the button labelled `label` on the screen `shown`. */
  const pressOn = (shown: { messageId: string; buttons?: { label: string; action: string }[][] }, label: string) =>
    fake.receive({ action: shown.buttons!.flat().find((b) => b.label === label)!.action, messageId: shown.messageId });
  /** The newest message the surface sent, once there is one besides the first `before`. */
  async function nextSent(before: number) {
    await waitFor(() => fake.sent.length > before);
    return fake.sent.at(-1)!;
  }

  test("/update when current says so", async () => {
    check = async () => ({ current: A, target: A, commits: [] });
    const shown = await openUpdate();
    expect(shown.markdown).toBe("✓ japa is up to date (aaaaaaa)");
    expect(shown.buttons ?? []).toEqual([]);
    expect(launches).toEqual([]);
  });

  test("/update on a checkout ahead of origin, with no new commits, says it is up to date", async () => {
    check = async () => ({ current: B, target: A, commits: [] });
    const shown = await openUpdate();
    expect(shown.markdown).toBe("✓ japa is up to date (bbbbbbb)");
    expect(shown.buttons ?? []).toEqual([]);
    expect(launches).toEqual([]);
  });

  test("/update lists new commits, 20 at most, with the active job count", async () => {
    await daemon.root.commit(async (tx) => {
      const doc = await tx.doc(JobsDoc, daemon.root.id);
      doc.jobs = { "1": jobOf("1"), "2": jobOf("2", { status: "done" }) };
      doc.nextId = 3;
    }, ctx);
    await waitFor(() => hook.jobs!().length === 2);
    const commits = Array.from({ length: 23 }, (_, i) => `${String(23 - i).padStart(7, "c")} commit ${23 - i}`);
    check = async () => ({ current: A, target: B, commits });
    const shown = await openUpdate();
    expect(shown.markdown).toBe(
      `**23 new commits**\n\naaaaaaa → bbbbbbb\n\n${commits.slice(0, 20).join("\n")}\n+3 more\n\n` +
        "japa will restart; 1 job active.",
    );
    expect(labels()).toEqual(["Update now", "Cancel"]);
    for (const b of shown.buttons!.flat()) expect(Buffer.byteLength(b.action)).toBeLessThanOrEqual(64);
    check = oneCommit;
    expect((await openUpdate()).markdown).toBe(
      "**1 new commit**\n\naaaaaaa → bbbbbbb\n\nbbbbbbb two\n\njapa will restart; 1 job active.",
    );
  });

  test("Update now launches the checked commit and says japa will restart", async () => {
    const shown = await openUpdate();
    expect(shown.markdown).toBe("**1 new commit**\n\naaaaaaa → bbbbbbb\n\nbbbbbbb two\n\njapa will restart; 0 jobs active.");
    check = async () => ({ current: A, target: "c".repeat(40), commits: ["ccccccc three", "bbbbbbb two"] }); // moved on since
    await fake.press("Update now");
    expect(fake.edited.at(-1)).toMatchObject({ messageId: shown.messageId, markdown: UPDATING });
    expect(fake.edited.at(-1)!.buttons ?? []).toEqual([]);
    expect(launches).toEqual([[B, false]]);
    expect(readUpdateState(home)).toMatchObject({ state: "running", chat: CHAT, from: A, to: B, rollback: false, reported: false });
  });

  test("a second Update now while one runs launches nothing", async () => {
    const first = await openUpdate();
    const second = await openUpdate();
    await pressOn(first, "Update now");
    expect(fake.edited.at(-1)!.markdown).toBe(UPDATING);
    await pressOn(second, "Update now");
    expect(fake.edited.at(-1)!.messageId).toBe(second.messageId);
    expect(fake.edited.at(-1)!.markdown).toContain("An update is already running (started");
    expect(fake.edited.at(-1)!.markdown).toMatch(/^✗ An update is already running \(started <1m ago\)\.\n\n\*\*1 new commit\*\*/);
    const again = await openUpdate();
    expect(again.markdown).toBe("An update is already running (started <1m ago).");
    expect(again.buttons ?? []).toEqual([]);
    expect(launches).toEqual([[B, false]]);
  });

  test("Cancel ends it without launching", async () => {
    await openUpdate();
    await fake.press("Cancel");
    expect(fake.edited.at(-1)!.markdown).toBe("Update cancelled.");
    expect(fake.edited.at(-1)!.buttons ?? []).toEqual([]);
    expect(launches).toEqual([]);
    expect(readUpdateState(home)).toBeUndefined();
  });

  test("a check error is shown on the screen", async () => {
    check = async () => {
      throw new Error("could not fetch origin main: offline");
    };
    expect((await openUpdate()).markdown).toBe("✗ could not fetch origin main: offline");
    await daemon.close(); // a daemon without an updater: not started by `japa daemon`
    fake = fakeAdapter();
    ({ daemon, faux, home } = await bootMessaging(fake));
    expect((await openUpdate()).markdown).toBe("✗ Updating from chat isn't available: japa wasn't started as a daemon.");
  });

  test("a launch that fails is shown on the screen, recorded as failed and not reported again", async () => {
    launchError = new Error("systemd-run exited with code 1: Access denied");
    const shown = await openUpdate();
    await fake.press("Update now");
    expect(fake.edited.at(-1)).toMatchObject({
      messageId: shown.messageId,
      markdown: `✗ systemd-run exited with code 1: Access denied\n\n${shown.markdown}`,
    });
    expect(readUpdateState(home)).toMatchObject({ state: "failed", summary: launchError.message, reported: true });
    const sent = fake.sent.length;
    await sleep(2500);
    expect(fake.sent).toHaveLength(sent);
  });

  test("an interrupted update is reported once and /update works again after", async () => {
    // Running, but with no pid a minute after it started: it never got going. Asked from another chat app, whose
    // surface would report it; /update sees it first.
    const other = { adapter: "other", chat: "1" };
    writeUpdateState(home, { ...updated(other), state: "running", started: Date.now() - 61_000, finished: undefined });
    const interrupted = `✗ The update was interrupted; see \`${updateLog(home)}\`.`;
    const shown = await openUpdate();
    expect(shown.markdown).toBe(interrupted);
    expect(shown.buttons ?? []).toEqual([]);
    expect(readUpdateState(home)!.reported).toBe(true);
    expect((await openUpdate()).markdown).toMatch(/^\*\*1 new commit\*\*/);
    expect([...fake.sent, ...fake.edited].filter((m) => m.markdown === interrupted)).toHaveLength(1);
    await fake.press("Update now");
    expect(launches).toEqual([[B, false]]);
  });

  test("Roll back asks first, then launches the previous commit as a rollback, from the commit japa is on", async () => {
    writeUpdateState(home, updated());
    const report = await nextSent(0);
    expect(report.buttons).toEqual([[{ label: "Roll back", action: `rb:${A}` }]]);
    current = async () => B;
    await fake.press("Roll back");
    const confirm = fake.sent.at(-1)!; // a message of its own: the report stays
    expect(confirm.markdown).toBe(CONFIRM);
    expect(confirm.buttons!.flat().map((b) => b.label)).toEqual(["Roll back", "Cancel"]);
    await fake.press("Cancel");
    expect(fake.edited.at(-1)).toMatchObject({ messageId: confirm.id, markdown: "Roll back cancelled." });
    expect(launches).toEqual([]);
    await fake.press("Roll back", report.id);
    const again = fake.sent.at(-1)!;
    expect(again.markdown).toBe(CONFIRM);
    await fake.press("Roll back");
    expect(fake.edited.at(-1)).toMatchObject({ messageId: again.id, markdown: UPDATING });
    expect(fake.edited.at(-1)!.buttons ?? []).toEqual([]);
    expect(launches).toEqual([[A, true]]);
    expect(readUpdateState(home)).toMatchObject({ state: "running", chat: CHAT, from: B, to: A, rollback: true, reported: false });
  });

  test("Roll back works offline: it never fetches", async () => {
    writeUpdateState(home, updated());
    await nextSent(0);
    check = offline;
    current = async () => B;
    await fake.press("Roll back");
    await fake.press("Roll back");
    expect(fake.edited.at(-1)!.markdown).toBe(UPDATING);
    expect(launches).toEqual([[A, true]]);
    expect(readUpdateState(home)).toMatchObject({ state: "running", from: B, to: A, rollback: true });
    expect(asked).toEqual({ check: 0, current: 1 });
  });

  test("Roll back pressed while an update runs says so, and asks and launches nothing", async () => {
    writeUpdateState(home, updated());
    await nextSent(0);
    await fake.press("Roll back");
    const confirm = fake.sent.at(-1)!;
    writeUpdateState(home, { ...updated(), state: "running", pid: process.pid, finished: undefined }); // started meanwhile
    await fake.press("Roll back");
    expect(fake.edited.at(-1)).toMatchObject({
      messageId: confirm.id,
      markdown: `✗ An update is already running (started <1m ago).\n\n${CONFIRM}`,
    });
    expect(fake.edited.at(-1)!.markdown).toContain("An update is already running (started");
    expect(asked).toEqual({ check: 0, current: 0 });
    expect(launches).toEqual([]);
    expect(readUpdateState(home)).toMatchObject({ state: "running", pid: process.pid });
  });

  test("the Roll back button still works after a restart; the confirm screen's buttons expire", async () => {
    writeUpdateState(home, updated());
    const rollBack = (await nextSent(0)).buttons![0]![0]!.action;
    await fake.press("Roll back");
    const confirm = fake.sent.at(-1)!;
    const yes = confirm.buttons!.flat().find((b) => b.label === "Roll back")!.action;
    await daemon.close();
    fake = fakeAdapter();
    daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, fake.extension], updater });
    await fake.receive({ action: yes, messageId: confirm.id });
    expect(fake.edited.at(-1)).toMatchObject({ messageId: confirm.id, markdown: "This menu expired — send /update again." });
    await fake.receive({ action: "rb:not-a-sha", messageId: "9" });
    expect(fake.edited.at(-1)).toMatchObject({ messageId: "9", markdown: "This menu expired — send /update again." });
    expect(launches).toEqual([]);
    current = async () => B;
    await fake.receive({ action: rollBack, messageId: "1" });
    expect(fake.sent.at(-1)!.markdown).toBe(CONFIRM);
    await fake.press("Roll back");
    expect(launches).toEqual([[A, true]]);
    expect(fake.sent.filter((m) => m.markdown.startsWith("✓ Updated"))).toEqual([]); // reported before the restart
  });
});
