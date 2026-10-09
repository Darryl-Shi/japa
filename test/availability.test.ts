import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import { type Conversation, type JsonObject, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { extensionState, isConfigured, type SecretReader } from "../src/kernel/availability.ts";
import { boot, type Daemon } from "../src/kernel/boot.ts";
import type { KernelContext, MessagingAdapter, SecretsStore, Status } from "../src/kernel/contracts.ts";
import type { JapaExtension } from "../src/kernel/extension.ts";
import { SecretRequestsDoc } from "../src/kernel/secret-requests.ts";
import { statusText } from "../src/kernel/status.ts";
import { defineTool, Type } from "../src/sdk.ts";
import { bootErrors, NO_BWRAP, probe, REPO_EXTENSIONS, tempHome, testKit, waitFor } from "./helpers.ts";
import { ask, call, idle, jobs, reported, script, texts, tool } from "./jobs-helpers.ts";

/** A secrets reader over `values`. */
const reader = (values: Record<string, string> = {}): SecretReader => ({ get: async (name) => values[name] });

const keyed: JapaExtension = { name: "x", summary: "X", secrets: ["x.key"] };

test("an extension whose secret is not stored is not set up", async () => {
  expect(await extensionState(keyed, reader(), {})).toBe("not set up");
  expect(await isConfigured(keyed, reader(), {})).toBe(false);
});

test("an extension whose secret is stored is on", async () => {
  expect(await extensionState(keyed, reader({ "x.key": "k" }), {})).toBe("on");
  expect(await isConfigured(keyed, reader({ "x.key": "k" }), {})).toBe(true);
});

test("a configured extension with enabled false is off", async () => {
  const settings: Record<string, JsonObject | undefined> = { x: { enabled: false } };
  expect(await extensionState(keyed, reader({ "x.key": "k" }), settings)).toBe("off");
  expect(await extensionState(keyed, reader({ "x.key": "k" }), { x: { enabled: true } })).toBe("on");
});

test("an unconfigured extension with enabled false is not set up", async () => {
  expect(await extensionState(keyed, reader(), { x: { enabled: false } })).toBe("not set up");
});

test("an extension whose only secret is generated is on", async () => {
  const e: JapaExtension = { name: "g", summary: "G", secrets: [{ name: "g.token", description: "G token", generated: true }] };
  expect(await extensionState(e, reader(), {})).toBe("on");
});

test("a required setting without a default must be saved", async () => {
  const e: JapaExtension = {
    name: "s",
    summary: "S",
    settings: Type.Object({
      region: Type.String(),
      size: Type.Integer({ default: 3 }),
      note: Type.Optional(Type.String()),
    }),
  };
  expect(await extensionState(e, reader(), {})).toBe("not set up");
  expect(await extensionState(e, reader(), { s: {} })).toBe("not set up");
  expect(await extensionState(e, reader(), { s: { region: "eu" } })).toBe("on");
});

/** An extension `name` with tool `<name>_ping`; `kernel()` is its kernel context once set up. */
function pinging(name: string, more: Partial<JapaExtension> = {}) {
  let kept: KernelContext | undefined;
  const ping = defineTool({
    name: `${name}_ping`,
    description: "Ping",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "pong" }] }),
  });
  const extension: JapaExtension = {
    name,
    summary: `${name} summary`,
    provides: { tool: [ping] },
    setup: (c) => {
      kept = c;
    },
    ...more,
  };
  return { extension, kernel: () => kept! };
}

/** `demo`, which needs the secret `demo.key`. */
const demoExtension = () => pinging("demo", { secrets: ["demo.key"] });

/** A profile `pinger` that names `demo`. */
const pinger = ["---", "name: pinger", "description: Pings", "tools: [read]", "extensions: [demo]", "---", "Ping."];
/** A profile `desk` that names the desktop's skill. */
const desk = ["---", "name: desk", "description: Desk", "tools: [read]", "skills: [using-the-desktop]", "---", "Desk."];

/**
 * Boots on in-memory storage (unless `settings` says otherwise) with `extra` extensions, the `pinger` and `desk`
 * worker profiles and the secrets in `secrets` already stored.
 */
async function bootWith(
  extra: JapaExtension[],
  settings: object = {},
  secrets: Record<string, string> = {},
  kit = testKit(),
) {
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model }, ...settings });
  mkdirSync(join(home, "workers"));
  writeFileSync(join(home, "workers", "pinger.md"), pinger.join("\n"));
  writeFileSync(join(home, "workers", "desk.md"), desk.join("\n"));
  mkdirSync(join(home, "secrets"), { recursive: true });
  for (const [name, value] of Object.entries(secrets)) writeFileSync(join(home, "secrets", name), value);
  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, ...extra] });
  return { daemon, faux: kit.faux, home };
}

const toolNames = async (c: Conversation) => (await c.agent(ctx)).tools.map((t) => t.name);
const stateOf = (daemon: Daemon, name: string) => daemon.status().extensions.find((e) => e.name === name)?.state;

/** Starts a job with the `pinger` profile; returns its conversation. */
async function startPinger(
  daemon: Daemon,
  faux: FauxProviderHandle,
  onBrief = call("job_ask", { question: "Which one?" }),
) {
  script(faux, (role, text) => {
    if (text === "start ping") return call("job_start", { title: "Ping", brief: "Ping it", worker: "pinger" });
    if (text === "Ping it") return onBrief;
    if (role === "user" && text === "that one") return call("job_complete", { summary: "pinged" });
  });
  await ask(daemon, "start ping");
  return (await daemon.harness.conversation((await jobs(daemon))["1"]!.conversationId, ctx))!;
}

test("an unconfigured extension is hidden from the CoS and its status says not set up", async () => {
  const { daemon } = await bootWith([demoExtension().extension]);
  expect(await toolNames(daemon.root)).not.toContain("demo_ping");
  expect(daemon.registry.snapshot().tools().map((t) => t.tool.name)).toContain("demo_ping"); // still installed
  expect(daemon.capabilities()).not.toContain("demo");
  expect(stateOf(daemon, "demo")).toBe("not set up");
  expect(statusText(daemon.status())).toMatch(/^  demo — demo summary \(not set up\)$/m);
  expect(bootErrors(daemon)).toEqual([]); // the profile naming demo stays valid
  await daemon.close();
});

test("a configured extension is offered to the CoS and its status says nothing more", async () => {
  const { daemon } = await bootWith([demoExtension().extension], {}, { "demo.key": "k" });
  expect(await toolNames(daemon.root)).toContain("demo_ping");
  expect(daemon.capabilities()).toContain("- demo: demo summary");
  expect(stateOf(daemon, "demo")).toBe("on");
  expect(statusText(daemon.status())).toMatch(/^  demo — demo summary$/m);
  await daemon.close();
});

test.skipIf(NO_BWRAP)("a job whose profile names an unavailable extension runs without it", async () => {
  const { daemon, faux } = await bootWith([demoExtension().extension]);
  const job = await startPinger(daemon, faux, call("job_complete", { summary: "done" }));
  expect(await toolNames(job)).not.toContain("demo_ping");
  await waitFor(async () => (await reported(daemon)).length > 0);
  expect((await jobs(daemon))["1"]!.status).toBe("done");
  await daemon.close();
});

test.skipIf(NO_BWRAP)("a job whose profile names an available extension gets its tools", async () => {
  const { daemon, faux } = await bootWith([demoExtension().extension], {}, { "demo.key": "k" });
  const job = await startPinger(daemon, faux, call("job_complete", { summary: "done" }));
  expect(await toolNames(job)).toContain("demo_ping");
  await waitFor(() => idle(daemon));
  await daemon.close();
});

test("storing its secret through the kernel shows the extension live", async () => {
  const demo = demoExtension();
  const { daemon } = await bootWith([demo.extension]);
  await demo.kernel().setSecret("demo.key", "k");
  expect(await toolNames(daemon.root)).toContain("demo_ping");
  expect(daemon.capabilities()).toContain("- demo: demo summary");
  expect(stateOf(daemon, "demo")).toBe("on");
  await daemon.close();
});

test("fulfilling a request for its secret shows the extension live", async () => {
  const probed = probe();
  const { daemon, faux } = await bootWith([demoExtension().extension, probed.extension]);
  await tool(daemon, faux, "secret_request", { name: "demo.key", why: "to ping" });
  const pending = (await daemon.harness.snapshot(SecretRequestsDoc, ROOT_CONVERSATION_ID, ctx))!.pending;
  await probed.surface().secrets.fulfil(pending[0]!.id, "k");
  expect(await toolNames(daemon.root)).toContain("demo_ping");
  expect(stateOf(daemon, "demo")).toBe("on");
  await waitFor(() => idle(daemon));
  await daemon.close();
});

test("saving its required setting shows the extension live", async () => {
  const regional = pinging("regional", { settings: Type.Object({ region: Type.String() }) });
  const { daemon, faux } = await bootWith([regional.extension]);
  expect(await toolNames(daemon.root)).not.toContain("regional_ping");
  expect(stateOf(daemon, "regional")).toBe("not set up");
  const set = await tool(daemon, faux, "settings_set", { path: "extensions.regional.region", value: "eu" });
  expect(set).toMatch(/^Set extensions\.regional\.region\./);
  expect(await toolNames(daemon.root)).toContain("regional_ping");
  expect(stateOf(daemon, "regional")).toBe("on");
  await daemon.close();
});

test("turning a configured extension off hides it and its status says off; undo and on show it again", async () => {
  const { daemon, faux } = await bootWith([demoExtension().extension], {}, { "demo.key": "k" });
  const set = await tool(daemon, faux, "settings_set", { path: "extensions.demo.enabled", value: false });
  expect(await toolNames(daemon.root)).not.toContain("demo_ping");
  expect(daemon.capabilities()).not.toContain("demo");
  expect(stateOf(daemon, "demo")).toBe("off");
  expect(statusText(daemon.status())).toMatch(/^  demo — demo summary \(off\)$/m);

  const id = /\(change (\S+)\)/.exec(set!)![1]!;
  expect(await tool(daemon, faux, "change_undo", { id })).toMatch(/^Undid/);
  expect(await toolNames(daemon.root)).toContain("demo_ping");
  expect(stateOf(daemon, "demo")).toBe("on");

  await tool(daemon, faux, "settings_set", { path: "extensions.demo.enabled", value: false });
  expect(stateOf(daemon, "demo")).toBe("off");
  await tool(daemon, faux, "settings_set", { path: "extensions.demo.enabled", value: true });
  expect(await toolNames(daemon.root)).toContain("demo_ping");
  expect(stateOf(daemon, "demo")).toBe("on");
  await daemon.close();
});

test("an extension switched off at boot stays hidden", async () => {
  const settings = { extensions: { demo: { enabled: false } } };
  const { daemon } = await bootWith([demoExtension().extension], settings, { "demo.key": "k" });
  expect(await toolNames(daemon.root)).not.toContain("demo_ping");
  expect(stateOf(daemon, "demo")).toBe("off");
  await daemon.close();
});

test("the adapters of an unconfigured extension still activate", async () => {
  let started = false;
  const adapter: MessagingAdapter = {
    name: "chat",
    maxMessageChars: 4096,
    start: async () => {
      started = true;
      return () => {};
    },
    send: async () => "1",
    edit: async () => {},
    delete: async () => {},
    typing: async () => {},
    commands: async () => {},
  };
  const chat: JapaExtension = {
    name: "chat",
    summary: "Chat",
    secrets: ["chat.token"],
    provides: { messaging: [adapter] },
  };
  const { daemon } = await bootWith([chat]);
  expect(started).toBe(true);
  expect(stateOf(daemon, "chat")).toBe("not set up");
  await daemon.close();
});

test.skipIf(NO_BWRAP)("a running job loses a hidden extension's tools", async () => {
  const { daemon, faux } = await bootWith([demoExtension().extension], {}, { "demo.key": "k" });
  const job = await startPinger(daemon, faux);
  await waitFor(async () => (await reported(daemon)).length === 1);
  expect((await jobs(daemon))["1"]!.status).toBe("needs_input");
  expect(await toolNames(job)).toContain("demo_ping");

  await tool(daemon, faux, "settings_set", { path: "extensions.demo.enabled", value: false });
  expect(await toolNames(job)).not.toContain("demo_ping");
  script(faux, (role, text) => {
    if (text === "answer") return call("job_message", { id: "1", text: "that one", mode: "followup" });
    if (role === "user" && text === "that one") return call("job_complete", { summary: "pinged" });
  });
  await ask(daemon, "answer");
  await waitFor(async () => (await reported(daemon)).length >= 2 && (await idle(daemon)));
  expect((await jobs(daemon))["1"]).toMatchObject({ status: "done", result: "pinged" });
  expect(await texts(job, "toolResult")).not.toContain("pong");
  await daemon.close();
});

test.skipIf(NO_BWRAP)("a job spanning a restart gets the extensions available at boot", async () => {
  const kit = testKit();
  const demo = demoExtension();
  const settings = { storage: { adapter: "sqlite" } };
  let { daemon, faux, home } = await bootWith([demo.extension], settings, { "demo.key": "k" }, kit);
  const job = await startPinger(daemon, faux);
  await waitFor(async () => (await reported(daemon)).length === 1);
  expect((await jobs(daemon))["1"]!.status).toBe("needs_input");
  expect(await toolNames(job)).toContain("demo_ping");
  const conversationId = job.id;
  await waitFor(() => idle(daemon));
  await daemon.close();

  const file = join(home, "settings.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...saved, extensions: { ...saved.extensions, demo: { enabled: false } } }));
  daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, demo.extension] });
  expect(stateOf(daemon, "demo")).toBe("off");
  const after = (await daemon.harness.conversation(conversationId, ctx))!;
  expect(await toolNames(after)).not.toContain("demo_ping");
  await daemon.close();
});

test("an unavailable extension's skills are hidden and come back with it; a profile naming one stays valid", async () => {
  const { daemon, faux } = await bootWith([demoExtension().extension], { extensions: { desktop: { enabled: false } } });
  const skill = () => tool(daemon, faux, "skill_read", { name: "using-the-desktop" });
  expect(stateOf(daemon, "desktop")).toBe("off");
  expect(bootErrors(daemon)).toEqual([]); // desk names the desktop's skill
  expect(await skill()).toMatch(/^No skill "using-the-desktop"/);
  await tool(daemon, faux, "settings_set", { path: "extensions.desktop.enabled", value: true });
  expect(await skill()).not.toMatch(/^No skill/);
  await tool(daemon, faux, "settings_set", { path: "extensions.desktop.enabled", value: false });
  expect(await skill()).toMatch(/^No skill "using-the-desktop"/);
  expect(bootErrors(daemon)).toEqual([]);
  await daemon.close();
});

test("a secrets read that throws counts as not set; it is logged once per refresh and shown in status", async () => {
  let locked = true;
  const values = new Map<string, string>();
  const store: SecretsStore = {
    get: async (name) => {
      if (locked && name.startsWith("demo.")) throw new Error("locked");
      return values.get(name);
    },
    set: async (name, value) => void values.set(name, value),
    delete: async (name) => void values.delete(name),
    list: async () => [...values.keys()],
  };
  const vault: JapaExtension = { name: "vault", summary: "Vault", provides: { secrets: [{ name: "vault", open: async () => store }] } };
  const two = pinging("demo2", { secrets: ["demo.other"] });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const logged = () => errors.mock.calls.filter((call) => String(call[0]).includes("locked"));
  try {
    const { daemon, faux } = await bootWith([vault, demoExtension().extension, two.extension], { secrets: { adapter: "vault" } });
    expect(stateOf(daemon, "demo")).toBe("not set up");
    const shown = () => daemon.status().errors.filter((e) => e.name.startsWith("demo"));
    const both = [
      { name: "demo", error: "secrets: locked" },
      { name: "demo2", error: "secrets: locked" },
    ];
    expect(shown()).toEqual(both);
    expect(logged()).toEqual([["demo, demo2: secrets: locked"]]); // one error, logged once
    await tool(daemon, faux, "settings_set", { path: "jobs.maxConcurrent", value: 2 });
    expect(logged()).toHaveLength(2);
    expect(shown()).toEqual(both);
    expect(statusText(daemon.status())).toContain("demo: secrets: locked");
    locked = false;
    values.set("demo.key", "k");
    await tool(daemon, faux, "settings_set", { path: "jobs.maxConcurrent", value: 3 });
    expect(stateOf(daemon, "demo")).toBe("on");
    expect(shown()).toEqual([]);
    expect(logged()).toHaveLength(2);
    await daemon.close();
  } finally {
    errors.mockRestore();
  }
});

test("statusText shows a state that is not on after the summary", () => {
  const status = (state?: "on" | "off" | "not set up"): Status => ({
    extensions: [{ name: "a", summary: "A", provides: [], status: "up", ...(state && { state }) }],
    errors: [],
  });
  expect(statusText(status("not set up"))).toBe("model: none\nextensions:\n  a — A (not set up)\n    up");
  expect(statusText(status("off"))).toBe("model: none\nextensions:\n  a — A (off)\n    up");
  expect(statusText(status("on"))).toBe("model: none\nextensions:\n  a — A\n    up");
  expect(statusText(status())).toBe("model: none\nextensions:\n  a — A\n    up");
});

test("a secrets reader that throws counts as not set", async () => {
  const failing: SecretReader = {
    get: async () => {
      throw new Error("locked");
    },
  };
  expect(await extensionState(keyed, failing, {})).toBe("not set up");
});
