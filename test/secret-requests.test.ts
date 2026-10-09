import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import { type AgentEvent, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Daemon } from "../src/kernel/boot.ts";
import type { KernelContext, SurfaceContext } from "../src/kernel/contracts.ts";
import type { JapaExtension } from "../src/kernel/extension.ts";
import { ChangesDoc } from "../src/kernel/changes.ts";
import { JobsDoc } from "../src/kernel/jobs/state.ts";
import { MemoryDoc } from "../src/kernel/memory/state.ts";
import { type SecretRequest, SecretRequestsDoc } from "../src/kernel/secret-requests.ts";
import { bootTest, probe } from "./helpers.ts";
import { ask, call, idle, script, system, texts, tool } from "./jobs-helpers.ts";

test("a secret request is listed, fulfilled into the store, and announced once without the value", async () => {
  const { extension, surface } = probe();
  const { daemon, faux, home } = await bootTest({}, [extension]);
  script(faux, (role, text) =>
    role === "user" && (text === "go" || text === "again")
      ? call("secret_request", { name: "svc.token", why: "to read your calendar" })
      : role === "user" && text === "bad"
        ? call("secret_request", { name: "Bad/name", why: "x" })
        : role === "user" && text === "sign-in"
          ? call("secret_request", { name: "google.authorize", why: "x" })
          : role === "user" && text === "provider"
            ? call("secret_request", { name: "anthropic.apiKey", why: "to think" })
            : undefined,
  );
  const events: AgentEvent[] = [];
  await surface().root.events((e) => events.push(...e));
  const lists: SecretRequest[][] = [];
  await surface().secrets.pending((pending) => lists.push(pending));
  expect(lists[0]).toEqual([]);

  await ask(daemon, "go");
  await ask(daemon, "again");
  await ask(daemon, "bad");
  await ask(daemon, "sign-in"); // a sign-in's request is connect's
  expect(await texts(daemon.root, "toolResult")).toEqual([
    "Asked the user for svc.token. You'll be told when it's provided.",
    "Already asked for svc.token.",
    "Invalid secret name.",
    "Invalid secret name.",
  ]);
  await vi.waitFor(() => expect(lists.at(-1)).toMatchObject([{ name: "svc.token", why: "to read your calendar" }]));

  const { id } = lists.at(-1)![0]!;
  await surface().secrets.fulfil(id, "s3cr3t");
  await expect(surface().secrets.fulfil(id, "s3cr3t")).rejects.toThrow(`No pending request ${id}`);
  expect(readFileSync(join(home, "secrets/svc.token"), "utf8")).toBe("s3cr3t");
  await vi.waitFor(() => expect(lists.at(-1)).toEqual([]));
  await vi.waitFor(async () =>
    expect((await texts(daemon.root, "user")).filter((t) => t === "[secret svc.token provided]")).toHaveLength(1),
  );
  await vi.waitFor(async () => expect(await idle(daemon)).toBe(true));
  await ask(daemon, "provider"); // provider key names are requestable
  await vi.waitFor(() => expect(lists.at(-1)).toMatchObject([{ name: "anthropic.apiKey" }]));

  const page = await daemon.root.entries({}, 500, undefined, ctx);
  const docs = [
    await daemon.harness.snapshot(JobsDoc, ROOT_CONVERSATION_ID, ctx),
    await daemon.harness.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, ctx),
    await daemon.harness.snapshot(ChangesDoc, ROOT_CONVERSATION_ID, ctx),
    await daemon.harness.snapshot(SecretRequestsDoc, ROOT_CONVERSATION_ID, ctx),
  ];
  expect(JSON.stringify(events)).toContain("[secret svc.token provided]"); // the listener saw the whole flow
  expect(JSON.stringify([page.items, docs, events])).not.toContain("s3cr3t");
  await daemon.close();
});

test("a pending secret request shows in the waiting-on-you section and goes when fulfilled", async () => {
  const { extension, surface } = probe();
  const { daemon, faux } = await bootTest({}, [extension]);
  await tool(daemon, faux, "secret_request", { name: "svc.token", why: "to read your calendar" });
  expect(await system(daemon, faux)).toMatch(/waiting-on-you[\s\S]*- svc\.token: to read your calendar/);
  const pending = (await daemon.harness.snapshot(SecretRequestsDoc, ROOT_CONVERSATION_ID, ctx))!.pending;
  await surface().secrets.fulfil(pending[0]!.id, "s3cr3t");
  expect(await system(daemon, faux)).not.toMatch(/waiting-on-you/);
  await daemon.close();
});

describe("extensions", () => {
  let daemon: Daemon;
  let faux: FauxProviderHandle;
  let kernel: () => KernelContext;
  let surface: () => SurfaceContext;
  const pending = async () => (await daemon.harness.snapshot(SecretRequestsDoc, ROOT_CONVERSATION_ID, ctx))!.pending;
  const pendingId = async () => (await pending())[0]!.id;

  beforeEach(async () => {
    let kept: KernelContext | undefined;
    const svc: JapaExtension = {
      name: "svc",
      summary: "Test",
      secrets: ["svc.token"],
      setup: (c) => {
        kept = c;
      },
    };
    const probed = probe();
    surface = probed.surface;
    kernel = () => kept!;
    ({ daemon, faux } = await bootTest({}, [svc, probed.extension]));
    script(faux, () => undefined);
  });

  afterEach(() => daemon.close());

  test("an extension waits for its secret without asking", async () => {
    const value = kernel().secretProvided("svc.token");
    expect(await pending()).toEqual([]);
    await tool(daemon, faux, "secret_request", { name: "svc.token", why: "to sync" });
    await surface().secrets.fulfil(await pendingId(), "s3cr3t");
    await expect(value).resolves.toBe("s3cr3t");
  });

  test("an extension asks for its secret and gets it once provided", async () => {
    const value = kernel().requestSecret("svc.token", "to sync");
    await vi.waitFor(async () => expect(await pending()).toMatchObject([{ name: "svc.token", why: "to sync" }]));
    await surface().secrets.fulfil(await pendingId(), "s3cr3t");
    await expect(value).resolves.toBe("s3cr3t");
    await vi.waitFor(async () =>
      expect((await texts(daemon.root, "user")).filter((t) => t === "[secret svc.token provided]")).toHaveLength(1),
    );
  });

  test("an extension stores a declared secret and reads it back", async () => {
    await kernel().setSecret("svc.token", "v1");
    expect(await kernel().secret("svc.token")).toBe("v1");
    await expect(kernel().setSecret("other", "x")).rejects.toThrow('Extension svc did not declare secret "other"');
  });

  test("an undeclared secret can't be requested", async () => {
    await expect(kernel().requestSecret("other", "x")).rejects.toThrow('Extension svc did not declare secret "other"');
  });
});
