import { type FauxProviderHandle, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Daemon } from "../src/kernel/boot.ts";
import { settingsSchema } from "../src/kernel/settings-tools.ts";
import { defineJapaExtension, type KernelContext, Type } from "../src/sdk.ts";
import { bootTest, testKit, waitFor } from "./helpers.ts";
import { ask, call, held, jobs, say, script, texts } from "./jobs-helpers.ts";

/** Has the CoS call `name` with `args`; returns the tool's reply. */
async function tool(daemon: Daemon, faux: FauxProviderHandle, name: string, args: JsonObject = {}) {
  faux.setResponses([fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }), say("ok")]);
  await ask(daemon, name);
  return (await texts(daemon.root, "toolResult")).at(-1);
}

const userFile = (home: string) => JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));

test("settings_set updates the file and the live value, and logs a change", async () => {
  const { daemon, faux, home } = await bootTest();
  expect(await tool(daemon, faux, "settings_set", { path: "jobs.maxConcurrent", value: 2 })).toBe(
    "Set jobs.maxConcurrent. (change 1)",
  );
  expect(userFile(home).jobs).toEqual({ maxConcurrent: 2 });
  expect(await tool(daemon, faux, "changes_list")).toMatch(/^1 \d{4}-\d\d-\d\dT\S+ Set jobs\.maxConcurrent$/);

  const hold = held();
  script(faux, (_role, text, signal) => {
    if (text.startsWith("start ")) return call("job_start", { title: text, brief: `work ${text.slice(6)}` });
    if (text.startsWith("work ")) return hold.wait(call("job_complete", { summary: "done" }), signal);
  });
  for (const n of ["1", "2", "3"]) await ask(daemon, `start ${n}`);
  expect(Object.values(await jobs(daemon)).map((j) => j.status)).toEqual(["running", "running", "queued"]);
  hold.release();
  await daemon.close();
});

test("an invalid settings_set changes nothing", async () => {
  const { daemon, faux, home } = await bootTest();
  const before = userFile(home);
  expect(await tool(daemon, faux, "settings_set", { path: "jobs.maxConcurrent", value: 0 })).toMatch(
    /^Not changed: jobs\.maxConcurrent: /,
  );
  expect(userFile(home)).toEqual(before);
  expect(await tool(daemon, faux, "settings_get", { path: "jobs.maxConcurrent" })).toBe("4");
  expect(await tool(daemon, faux, "changes_list")).toBe("No changes yet.");
  await daemon.close();
});

test("jobs.keepFinishedDays defaults to 7 and must be at least 1", async () => {
  const { daemon, faux } = await bootTest();
  expect(await tool(daemon, faux, "settings_get", { path: "jobs.keepFinishedDays" })).toBe("7");
  expect(await tool(daemon, faux, "settings_set", { path: "jobs.keepFinishedDays", value: 0 })).toMatch(
    /^Not changed: jobs\.keepFinishedDays: /,
  );
  expect(await tool(daemon, faux, "settings_set", { path: "jobs.keepFinishedDays", value: 3 })).toMatch(
    /^Set jobs\.keepFinishedDays\./,
  );
  expect(await tool(daemon, faux, "settings_get", { path: "jobs.keepFinishedDays" })).toBe("3");
  await daemon.close();
});

test("undoing a set of an absent key removes it, and the default applies again", async () => {
  const { daemon, faux, home } = await bootTest();
  await tool(daemon, faux, "settings_set", { path: "jobs.maxConcurrent", value: 2 });
  expect(await tool(daemon, faux, "change_undo", { id: "1" })).toBe("Undid: Set jobs.maxConcurrent");
  expect(userFile(home).jobs).toEqual({});
  expect(await tool(daemon, faux, "settings_get", { path: "jobs.maxConcurrent" })).toBe("4");
  expect(await tool(daemon, faux, "changes_list")).toBe("No changes yet.");
  await daemon.close();
});

test("undoing a set of an existing key restores it", async () => {
  const { daemon, faux, home } = await bootTest({ jobs: { maxConcurrent: 3 } });
  await tool(daemon, faux, "settings_set", { path: "jobs.maxConcurrent", value: 2, title: "Fewer jobs" });
  expect(await tool(daemon, faux, "change_undo", { id: "1" })).toBe("Undid: Fewer jobs");
  expect(userFile(home).jobs).toEqual({ maxConcurrent: 3 });
  expect(await tool(daemon, faux, "settings_get", { path: "jobs.maxConcurrent" })).toBe("3");
  await daemon.close();
});

test("extension settings are validated against its schema and visible to it immediately", async () => {
  let kernel: KernelContext | undefined;
  const ext = defineJapaExtension({
    name: "limited",
    summary: "Has a limit",
    settings: Type.Object({ limit: Type.Optional(Type.Integer({ maximum: 10 })) }),
    setup: (k) => {
      kernel = k;
    },
  });
  const { daemon, faux } = await bootTest({}, [ext]);
  await waitFor(() => kernel !== undefined);
  expect(kernel!.settings()).toEqual({});
  expect(await tool(daemon, faux, "settings_set", { path: "extensions.limited.limit", value: 11 })).toMatch(
    /^Not changed: extensions\.limited\.limit: /,
  );
  await tool(daemon, faux, "settings_set", { path: "extensions.limited.limit", value: 5 });
  expect(kernel!.settings()).toEqual({ limit: 5 });
  await daemon.close();
});

test("every extension's settings schema has an optional enabled", () => {
  const schema = settingsSchema({ name: "plain", summary: "No settings" }) as any;
  expect(schema.properties.enabled.type).toBe("boolean");
  expect(schema.properties.enabled.description).toBe("Set false to hide this extension from japa");
  expect(schema.required ?? []).toEqual([]);
});

test("an extension's own settings keep their required list next to enabled", () => {
  const settings = Type.Object({ region: Type.String(), note: Type.Optional(Type.String()) });
  const schema = settingsSchema({ name: "own", summary: "Own", settings }) as any;
  expect(Object.keys(schema.properties).sort()).toEqual(["enabled", "note", "region"]);
  expect(schema.required).toEqual(["region"]);
});

test("settings_set accepts extensions.<name>.enabled as a boolean only", async () => {
  const { daemon, faux, home } = await bootTest();
  expect(await tool(daemon, faux, "settings_set", { path: "extensions.brave.enabled", value: "no" })).toMatch(
    /^Not changed: extensions\.brave\.enabled: /,
  );
  expect(await tool(daemon, faux, "settings_set", { path: "extensions.brave.enabled", value: false })).toBe(
    "Set extensions.brave.enabled. (change 1)",
  );
  expect(userFile(home).extensions.brave).toEqual({ enabled: false });
  await daemon.close();
});

test("an unknown model is refused, and nothing changes", async () => {
  const { daemon, faux, home } = await bootTest();
  const before = userFile(home);
  const value = { provider: "anthropic", modelId: "typo" };
  expect(await tool(daemon, faux, "settings_set", { path: "models.worker", value })).toBe(
    "Not changed: Unknown model anthropic/typo",
  );
  expect(userFile(home)).toEqual(before);
  expect(await tool(daemon, faux, "settings_get", { path: "models.worker" })).toBe("Not set.");
  expect(await tool(daemon, faux, "changes_list")).toBe("No changes yet.");
  await daemon.close();
});

test("a models.cos change applies to the CoS's next request, and its undo too", async () => {
  const kit = testKit({ models: [{ id: "one" }, { id: "two" }] });
  const { daemon, faux } = await bootTest({}, [], kit);
  const modelOf = async () => {
    faux.setResponses([(_c, _o, _s, model) => say(model.id)]);
    await ask(daemon, "which model?");
    return (await texts(daemon.root, "assistant")).at(-1);
  };
  expect(await modelOf()).toBe("one");
  await tool(daemon, faux, "settings_set", { path: "models.cos", value: { ...kit.model, modelId: "two" } });
  expect(await modelOf()).toBe("two");
  await tool(daemon, faux, "change_undo", { id: "1" });
  expect(await modelOf()).toBe("one");
  await daemon.close();
});

test("a storage change takes effect after a restart", async () => {
  const { daemon, faux } = await bootTest();
  expect(await tool(daemon, faux, "settings_set", { path: "storage.file", value: "/x.db" })).toBe(
    "Set storage.file. (change 1) Takes effect after a restart.",
  );
  await daemon.close();
});

test("setting models without cos is refused, and nothing changes", async () => {
  const { daemon, faux, home } = await bootTest();
  const before = userFile(home);
  const value = { worker: { provider: "faux", modelId: "faux-1" } };
  expect(await tool(daemon, faux, "settings_set", { path: "models", value })).toMatch(/^Not changed: /);
  expect(userFile(home)).toEqual(before);
  expect(await tool(daemon, faux, "changes_list")).toBe("No changes yet.");
  await daemon.close();
});

test("a path through __proto__ is refused", async () => {
  const { daemon, faux } = await bootTest();
  expect(await tool(daemon, faux, "settings_set", { path: "__proto__.polluted", value: 1 })).toBe(
    "Not changed: invalid path",
  );
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  await daemon.close();
});

test("setting an object writes only the given keys to the user file", async () => {
  const { daemon, faux, home } = await bootTest();
  await tool(daemon, faux, "settings_set", { path: "context", value: { resetTokens: 100 } });
  expect(userFile(home).context).toEqual({ resetTokens: 100 });
  await daemon.close();
});

test("status reports the live CoS model", async () => {
  const kit = testKit({ models: [{ id: "one" }, { id: "two" }] });
  const { daemon, faux } = await bootTest({}, [], kit);
  const two = { ...kit.model, modelId: "two" };
  await tool(daemon, faux, "settings_set", { path: "models.cos", value: two });
  expect(daemon.status().model).toEqual(two);
  await daemon.close();
});
