import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type FauxProviderHandle, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Daemon } from "../src/kernel/boot.ts";
import { type Contract, defineJapaExtension, type KernelContext, logChange, Type } from "../src/sdk.ts";
import { bootTest, waitFor } from "./helpers.ts";
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

test("undoing a set of an absent key removes it, and the default applies again", async () => {
  const { daemon, faux, home } = await bootTest();
  await tool(daemon, faux, "settings_set", { path: "jobs.maxConcurrent", value: 2 });
  expect(await tool(daemon, faux, "change_undo", { id: "1" })).toBe("Undid: Set jobs.maxConcurrent");
  expect(userFile(home).jobs).toEqual({});
  expect(await tool(daemon, faux, "settings_get", { path: "jobs.maxConcurrent" })).toBe("4");
  expect(await tool(daemon, faux, "changes_list")).toBe("No changes yet.");
  await daemon.close();
});

test("undoing a set of an existing key restores it; a change with commits can't be undone yet", async () => {
  const { daemon, faux, home } = await bootTest({ jobs: { maxConcurrent: 3 } });
  await tool(daemon, faux, "settings_set", { path: "jobs.maxConcurrent", value: 2, title: "Fewer jobs" });
  expect(await tool(daemon, faux, "change_undo", { id: "1" })).toBe("Undid: Fewer jobs");
  expect(userFile(home).jobs).toEqual({ maxConcurrent: 3 });
  expect(await tool(daemon, faux, "settings_get", { path: "jobs.maxConcurrent" })).toBe("3");

  await daemon.harness.commit((tx) => logChange(tx, { title: "Code", howToUse: "", undo: { commits: ["abc"] } }), ctx);
  expect(await tool(daemon, faux, "change_undo", { id: "2" })).toBe("Can't undo that yet.");
  await daemon.close();
});

test("extension settings are validated against its schema and visible to it immediately", async () => {
  let kernel: KernelContext | undefined;
  const probe: Contract = {
    name: "probe",
    docs: "Captures the kernel context.",
    phase: "runtime",
    cardinality: "many",
    validate: () => undefined,
    activate: async (_c, k) => {
      kernel = k;
      return () => {};
    },
  };
  const ext = defineJapaExtension({
    name: "limited",
    summary: "Has a limit",
    settings: Type.Object({ limit: Type.Optional(Type.Integer({ maximum: 10 })) }),
    contracts: [probe],
    provides: { probe: [{}] },
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

test("a storage change takes effect after a restart", async () => {
  const { daemon, faux } = await bootTest();
  expect(await tool(daemon, faux, "settings_set", { path: "storage.file", value: "/x.db" })).toBe(
    "Set storage.file. (change 1) Takes effect after a restart.",
  );
  await daemon.close();
});
