import type { AuthInteraction } from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vitest";
import type { FlowView } from "../extensions/webui/app/src/lib/protocol.ts";
import { createFlows, FLOW_IDLE_MS } from "../extensions/webui/flows.ts";
import { settingsBridge } from "../extensions/webui/settings.ts";
import type { AdminContext, ExtensionInfo, SurfaceContext } from "../src/sdk.ts";

afterEach(() => void vi.useRealTimers());

type Login = (provider: string, type: "oauth" | "api_key", i: AuthInteraction) => Promise<void>;

/** A fake AdminContext: settings in memory, the calls it got, and swappable login/authorize. */
function fakeAdmin(overrides: Partial<AdminContext> = {}) {
  const calls: unknown[][] = [];
  let settings: Record<string, unknown> = { models: { cos: { provider: "anthropic", modelId: "claude-x" } }, jobs: { maxConcurrent: 2 } };
  const extensions: ExtensionInfo[] = [
    { name: "google", state: "not set up", workspace: false, loaded: true, secrets: [{ name: "google.clientId", set: false }], values: {}, signIn: true },
    { name: "telegram", summary: "Chat", state: "on", status: "@bot", workspace: false, loaded: true, signIn: false, secrets: [{ name: "telegram.botToken", description: "Bot token", set: true }], values: { x: 1 } },
    { name: "webui", state: "off", workspace: false, loaded: true, signIn: false, secrets: [], values: {} },
    { name: "broken", state: "not set up", error: "boom", workspace: true, loaded: false, signIn: false, secrets: [], values: {} },
  ];
  const schedules = [{ id: "1", text: "water the plants", cron: "0 9 * * *", next: 1000, paused: false, label: "water" }];
  let update: Awaited<ReturnType<AdminContext["update"]["state"]>>;
  const login: { fn: Login } = { fn: async () => {} };
  const admin: AdminContext = {
    settings: () => structuredClone(settings) as never,
    async setSetting(path, value) {
      calls.push(["set", path, value]);
      if (path === "jobs.maxConcurrent" && typeof value !== "number") return "Not changed: jobs.maxConcurrent must be a number.";
      settings = { ...settings, [path]: value };
      return `Set ${path}.`;
    },
    extensions: async () => extensions,
    async setSecret(extension, name, value) {
      calls.push(["secret", extension, name, value]);
      return `Set ${name}.`;
    },
    rollback: async (e) => `Rolled back ${e}.`,
    changes: async () =>
      Array.from({ length: 12 }, (_, i) => ({ id: String(12 - i), at: 1000 - i, title: `Change ${12 - i}`, howToUse: `use ${12 - i}`, undo: { commits: [] } })),
    undoChange: async (id) => `Undid change ${id}.`,
    clearFinishedJobs: async () => 3,
    async tool(name, args) {
      calls.push(["tool", name, args]);
      if (name === "schedule_list") return { content: [{ type: "text", text: "…" }], details: schedules };
      if (name.startsWith("schedule_")) return { content: [{ type: "text", text: `${name} ${args.id} done` }], details: {} };
      return undefined;
    },
    update: {
      check: async () => ({ current: "a".repeat(40), target: "b".repeat(40), commits: ["bbbbbbb new"] }),
      current: async () => "c".repeat(40),
      async start(chat, from, to, rollback) {
        calls.push(["update", chat, from, to, rollback]);
      },
      state: async () => update,
    },
    providers: async () => [{ id: "anthropic", name: "Anthropic", connected: true, credential: "oauth", signIn: { label: "Claude Pro/Max", subscription: true }, apiKey: { label: "Anthropic API key" } }],
    models: async () => [{ id: "claude-x", name: "Claude X" }],
    login: (p, t, i) => login.fn(p, t, i),
    authorize: async (e) => `Signed in to ${e}.`,
    ...overrides,
  };
  return { admin, calls, login, setUpdate: (u: typeof update) => void (update = u) };
}

const ctx = (jobs: { status: string }[] = []) =>
  ({
    home: "/home/me/.japa",
    status: () => ({ extensions: [], errors: [{ name: "broken", error: "boom" }] }),
    jobs: async (listener: (jobs: never[]) => void) => {
      listener(jobs as never[]);
      return { stop: async () => {} };
    },
  }) as unknown as Pick<SurfaceContext, "status" | "jobs" | "home">;

test("overview: the CoS model, the errors naming their extension, and counts by state", async () => {
  const { admin } = fakeAdmin();
  const s = settingsBridge(admin, ctx());
  expect(await s.overview()).toEqual({
    model: { provider: "anthropic", modelId: "claude-x" },
    errors: [{ name: "broken", error: "boom" }],
    counts: { on: 1, off: 1, notSetUp: 1, error: 1 },
  });
});

test("extensions map to views, with Sign in for those with an authorize hook", async () => {
  const s = settingsBridge(fakeAdmin().admin, ctx());
  const views = await s.extensions();
  expect(views.map((e) => [e.name, e.signIn])).toEqual([["google", true], ["telegram", false], ["webui", false], ["broken", false]]);
  expect(views[1]).toEqual({
    name: "telegram", summary: "Chat", state: "on", status: "@bot", workspace: false, loaded: true, signIn: false,
    secrets: [{ name: "telegram.botToken", description: "Bot token", set: true }], values: { x: 1 },
  });
});

test("set returns the kernel's reply, Not changed for an invalid value; an absent value unsets", async () => {
  const { admin, calls } = fakeAdmin();
  const s = settingsBridge(admin, ctx());
  expect(await s.set("jobs.maxConcurrent", "lots")).toBe("Not changed: jobs.maxConcurrent must be a number.");
  expect(await s.set("jobs.maxConcurrent", 4)).toBe("Set jobs.maxConcurrent.");
  await s.set("models.worker", undefined);
  expect(calls).toContainEqual(["set", "models.worker", undefined]);
  expect(await s.setSecret("telegram", "telegram.botToken", "123:abc")).toBe("Set telegram.botToken.");
});

test("schedules come from schedule_list's details; actions run the schedule tools", async () => {
  const { admin, calls } = fakeAdmin();
  const s = settingsBridge(admin, ctx());
  expect(await s.schedules()).toEqual([{ id: "1", text: "water the plants", cron: "0 9 * * *", next: 1000, paused: false, label: "water" }]);
  expect(await s.schedule("1", "pause")).toBe("schedule_pause 1 done");
  expect(await s.schedule("1", "remove")).toBe("schedule_remove 1 done");
  expect(calls).toContainEqual(["tool", "schedule_pause", { id: "1" }]);
  const none = settingsBridge(fakeAdmin({ tool: async () => undefined }).admin, ctx());
  expect(await none.schedules()).toEqual([]);
  await expect(none.schedule("1", "resume")).rejects.toThrow("Schedules aren't available.");
});

test("changes: the newest 10, their how-to-use as the detail; clear and undo reply", async () => {
  const s = settingsBridge(fakeAdmin().admin, ctx());
  const changes = await s.changes();
  expect(changes).toHaveLength(10);
  expect(changes[0]).toEqual({ id: "12", title: "Change 12", at: 1000, detail: "use 12" });
  expect(await s.undo("12")).toBe("Undid change 12.");
  expect(await s.clearFinishedJobs()).toBe("Cleared 3 finished jobs.");
  const one = settingsBridge(fakeAdmin({ clearFinishedJobs: async () => 1 }).admin, ctx());
  expect(await one.clearFinishedJobs()).toBe("Cleared 1 finished job.");
});

test("update: the last run as liveness reads it; check counts active jobs; start and roll back from webui/web", async () => {
  const { admin, calls, setUpdate } = fakeAdmin();
  const now = 10_000_000;
  const s = settingsBridge(admin, ctx([{ status: "running" }, { status: "done" }, { status: "needs_input" }, { status: "queued" }]), { now: () => now });
  expect(await s.update()).toEqual({});
  const base = { chat: { adapter: "telegram", chat: "1" }, from: "f".repeat(40), rollback: false, reported: true };
  setUpdate({ ...base, state: "updated", started: now - 5000, finished: now - 1000, to: "t".repeat(40) });
  expect(await s.update()).toEqual({ last: { state: "updated", started: now - 5000, finished: now - 1000, from: "f".repeat(40), to: "t".repeat(40), rollback: false } });
  setUpdate({ ...base, state: "running", started: now - 2 * 60_000 }); // no pid 60 s after it started
  expect((await s.update()).last).toMatchObject({ state: "interrupted", summary: "The update was interrupted; see /home/me/.japa/logs/update.log." });
  setUpdate({ ...base, state: "failed", started: now - 5000, summary: "npm ci failed", output: "ERR" });
  expect((await s.update()).last).toMatchObject({ state: "failed", summary: "npm ci failed", output: "ERR" });

  expect(await s.checkUpdate()).toEqual({ current: "a".repeat(40), target: "b".repeat(40), commits: ["bbbbbbb new"], activeJobs: 3 });
  await s.startUpdate("b".repeat(40));
  expect(calls).toContainEqual(["update", { adapter: "webui", chat: "web" }, "c".repeat(40), "b".repeat(40), false]);
  await s.rollbackUpdate("f".repeat(40));
  expect(calls).toContainEqual(["update", { adapter: "webui", chat: "web" }, "c".repeat(40), "f".repeat(40), true]);

  setUpdate({ ...base, state: "running", started: now - 30_000 }); // starting, still within its 60 s
  const before = calls.length;
  await expect(s.rollbackUpdate("f".repeat(40))).rejects.toThrow("An update is already running (started 30s ago).");
  expect(calls.length).toBe(before);
});

/** Waits for the flow to show a prompt. */
async function promptOf(s: { flow(id: string): FlowView | undefined }, id: string) {
  await vi.waitFor(() => expect(s.flow(id)?.prompt).toBeDefined());
  return s.flow(id)!.prompt!;
}

test("a provider flow: events and prompts in its view, answers resume the login, then the outcome", async () => {
  const { admin, login } = fakeAdmin();
  login.fn = async (_p, _t, i) => {
    i.notify({ type: "auth_url", url: "https://example.com/auth", instructions: "Open it" });
    i.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.com/device", intervalSeconds: 5 });
    const method = await i.prompt({ type: "select", message: "How?", options: [{ id: "browser", label: "Browser" }] });
    expect(method).toBe("browser");
    const code = await i.prompt({ type: "manual_code", message: "Paste the redirect URL", placeholder: "http://localhost/…" });
    expect(code).toBe("http://localhost/cb?code=1");
    i.notify({ type: "progress", message: "Exchanging…" });
  };
  const s = settingsBridge(admin, ctx());
  const flow = s.startFlow({ kind: "provider", provider: "anthropic", method: "oauth" });
  expect(flow).toMatchObject({ kind: "provider", target: "anthropic" });
  const select = await promptOf(s, flow.id);
  expect(select).toEqual({ id: expect.any(String), type: "select", message: "How?", options: [{ id: "browser", label: "Browser" }] });
  expect(() => s.answer(flow.id, select.id, "carrier pigeon")).toThrow("Not one of the options.");
  expect(() => s.answer(flow.id, "nope", "browser")).toThrow("isn't open");
  s.answer(flow.id, select.id, "browser");
  await vi.waitFor(() => expect(s.flow(flow.id)?.prompt?.type).toBe("manual_code"));
  const manual = s.flow(flow.id)!.prompt!;
  expect(manual).toMatchObject({ message: "Paste the redirect URL", placeholder: "http://localhost/…" });
  expect(() => s.answer(flow.id, select.id, "browser")).toThrow(); // answered already
  s.answer(flow.id, manual.id, "http://localhost/cb?code=1");
  await vi.waitFor(() => expect(s.flow(flow.id)?.outcome).toBeDefined());
  const done = s.flow(flow.id)!;
  expect(done.outcome).toEqual({ ok: true, text: "Connected to Anthropic." });
  expect(done.prompt).toBeUndefined();
  expect(done.events).toEqual([
    { type: "auth_url", url: "https://example.com/auth", instructions: "Open it" },
    { type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.com/device" },
    { type: "progress", message: "Exchanging…" },
  ]);
  expect(JSON.stringify(done)).not.toContain("code=1");
});

test("a manual_code prompt raced against the callback disappears when the callback wins", async () => {
  const { admin, login } = fakeAdmin();
  let win!: () => void;
  login.fn = async (_p, _t, i) => {
    const abort = new AbortController();
    const manual = i.prompt({ type: "manual_code", message: "Or paste the URL", signal: abort.signal }).catch(() => "aborted");
    await new Promise<void>((resolve) => (win = resolve));
    abort.abort();
    expect(await manual).toBe("aborted");
  };
  const s = settingsBridge(admin, ctx());
  const { id } = s.startFlow({ kind: "provider", provider: "anthropic", method: "oauth" });
  expect((await promptOf(s, id)).type).toBe("manual_code");
  win();
  await vi.waitFor(() => expect(s.flow(id)?.outcome?.ok).toBe(true));
  expect(s.flow(id)!.prompt).toBeUndefined();
});

test("an API key typed in Settings answers the first secret prompt and is never in the flow's view", async () => {
  const { admin, login } = fakeAdmin();
  const seen: string[] = [];
  login.fn = async (_p, type, i) => {
    expect(type).toBe("api_key");
    seen.push(await i.prompt({ type: "secret", message: "Enter Anthropic API key" }));
    seen.push(await i.prompt({ type: "secret", message: "And another" }));
  };
  const s = settingsBridge(admin, ctx());
  const flow = s.startFlow({ kind: "provider", provider: "anthropic", method: "api_key", key: "sk-very-secret" });
  expect(JSON.stringify(flow)).not.toContain("sk-very-secret");
  const second = await promptOf(s, flow.id);
  expect(second).toMatchObject({ type: "secret", message: "And another" });
  expect(JSON.stringify(s.flow(flow.id))).not.toContain("sk-very-secret");
  s.answer(flow.id, second.id, "typed");
  await vi.waitFor(() => expect(s.flow(flow.id)?.outcome?.ok).toBe(true));
  expect(seen).toEqual(["sk-very-secret", "typed"]);
  expect(JSON.stringify(s.flow(flow.id))).not.toMatch(/sk-very-secret|typed/);
});

test("cancel aborts the flow's signal and rejects the open prompt; one flow per target", async () => {
  const { admin, login } = fakeAdmin();
  let signal: AbortSignal | undefined;
  let rejected: unknown;
  login.fn = async (_p, _t, i) => {
    signal = i.signal;
    await i.prompt({ type: "text", message: "Name?" }).catch((e) => {
      rejected = e;
      throw e;
    });
  };
  const s = settingsBridge(admin, ctx());
  const flow = s.startFlow({ kind: "provider", provider: "anthropic", method: "oauth" });
  await promptOf(s, flow.id);
  expect(() => s.startFlow({ kind: "provider", provider: "anthropic", method: "api_key" })).toThrow("Already signing in to anthropic.");
  const other = s.startFlow({ kind: "extension", extension: "google" }); // another target is fine
  await vi.waitFor(() => expect(s.flow(other.id)?.outcome).toEqual({ ok: true, text: "Signed in to google." }));
  s.cancel(flow.id);
  expect(signal?.aborted).toBe(true);
  await vi.waitFor(() => expect(rejected).toBeInstanceOf(Error));
  expect(s.flow(flow.id)).toMatchObject({ outcome: { ok: false, text: "Cancelled." } });
  expect(s.flow(flow.id)!.prompt).toBeUndefined();
  // Its target is free again.
  login.fn = async () => {};
  const again = s.startFlow({ kind: "provider", provider: "anthropic", method: "oauth" });
  await vi.waitFor(() => expect(s.flow(again.id)?.outcome?.ok).toBe(true));
});

test("a failed login reads Couldn't connect, and a flow with no answer for 10 minutes is cancelled, then forgotten", async () => {
  vi.useFakeTimers();
  const { admin, login } = fakeAdmin();
  login.fn = async () => {
    throw new Error("bad key");
  };
  const s = settingsBridge(admin, ctx());
  const failed = s.startFlow({ kind: "provider", provider: "anthropic", method: "api_key" });
  await vi.advanceTimersByTimeAsync(0);
  expect(s.flow(failed.id)!.outcome).toEqual({ ok: false, text: "Couldn't connect: bad key" });

  let signal: AbortSignal | undefined;
  login.fn = (_p, _t, i) => {
    signal = i.signal;
    return i.prompt({ type: "text", message: "?" }).then(() => {});
  };
  const flow = s.startFlow({ kind: "provider", provider: "anthropic", method: "oauth" });
  await vi.advanceTimersByTimeAsync(FLOW_IDLE_MS - 1000);
  const prompt = s.flow(flow.id)!.prompt!;
  expect(prompt).toBeDefined();
  expect(s.flow(flow.id)!.outcome).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1000);
  expect(s.flow(flow.id)!.outcome).toEqual({ ok: false, text: "Cancelled." });
  expect(signal!.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(s.flow(flow.id)).toBeUndefined();
  expect(s.flow(failed.id)).toBeUndefined();
});

test("an answer restarts the idle timer; stop cancels every flow", async () => {
  vi.useFakeTimers();
  const flows = createFlows(async (_start, i) => {
    await i.prompt({ type: "text", message: "1" });
    await i.prompt({ type: "text", message: "2" });
    return "done";
  });
  const f = flows.start({ kind: "extension", extension: "google" });
  await vi.advanceTimersByTimeAsync(FLOW_IDLE_MS - 1000);
  flows.answer(f.id, flows.flow(f.id)!.prompt!.id, "a");
  await vi.advanceTimersByTimeAsync(FLOW_IDLE_MS - 1000);
  expect(flows.flow(f.id)!.outcome).toBeUndefined();
  expect(flows.flow(f.id)!.prompt!.message).toBe("2");
  flows.stop();
  expect(flows.flow(f.id)).toBeUndefined();
  expect(() => flows.answer(f.id, "x", "y")).toThrow("No such sign-in.");
});
