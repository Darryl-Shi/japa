import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AuthInteraction, FauxProviderHandle } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { boot, type Daemon } from "../src/kernel/boot.ts";
import type { SurfaceContext } from "../src/kernel/contracts.ts";
import type { JapaExtension } from "../src/kernel/extension.ts";
import { addSecretRequest, removeSecretRequest, SecretRequestsDoc } from "../src/kernel/secret-requests.ts";
import { bootTest, probe, REPO_EXTENSIONS, testKit } from "./helpers.ts";
import { script, texts, tool } from "./jobs-helpers.ts";

/** Resolves or rejects from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/**
 * Extension `fake`: its sign-in shows a link, then asks for the address while `loopback` may finish it first (the
 * way google's loopback listener does), aborting its own prompt unless `keepPrompt`; with `skipPrompt` it waits for
 * `loopback` only.
 */
function fake() {
  const state = {
    received: [] as string[],
    loopback: deferred<string>(),
    fail: undefined as Error | undefined,
    keepPrompt: false,
    skipPrompt: false,
    io: undefined as AuthInteraction | undefined,
  };
  const extension: JapaExtension = {
    name: "fake",
    summary: "Test",
    authorize: {
      connected: async () => false,
      run: async (_ctx, io) => {
        state.io = io;
        io.notify({ type: "auth_url", url: "https://example.test/a" });
        if (state.skipPrompt) return `Connected as ${await state.loopback.promise}`;
        const controller = new AbortController();
        const pasted = io.prompt({ type: "manual_code", message: "Paste the address", signal: controller.signal });
        pasted.catch(() => {});
        const code = await Promise.race([pasted, state.loopback.promise]);
        if (!state.keepPrompt) controller.abort();
        state.received.push(code);
        if (state.fail) throw state.fail;
        return "Connected as x";
      },
    },
  };
  return { extension, state };
}

describe("connect", () => {
  let daemon: Daemon;
  let faux: FauxProviderHandle;
  let home: string;
  let surface: () => SurfaceContext;
  let state: ReturnType<typeof fake>["state"];
  const pending = async () => (await daemon.harness.snapshot(SecretRequestsDoc, ROOT_CONVERSATION_ID, ctx))!.pending;
  const users = () => texts(daemon.root, "user");

  beforeEach(async () => {
    const probed = probe();
    const faked = fake();
    surface = probed.surface;
    state = faked.state;
    ({ daemon, faux, home } = await bootTest({}, [probed.extension, faked.extension]));
    script(faux, () => undefined);
  });

  afterEach(() => daemon.close());

  test("sends the link, asks for the address masked, and reports once it's pasted", async () => {
    const reply = await tool(daemon, faux, "connect", { extension: "fake" });
    expect(reply).toContain("Send the user this link to sign in: https://example.test/a");
    expect(reply).toContain("Waiting for the user to sign in.");
    await vi.waitFor(async () => expect(await pending()).toMatchObject([{ name: "fake.authorize", why: "Paste the address" }]));

    await surface().secrets.fulfil((await pending())[0]!.id, " code ");
    await vi.waitFor(async () => expect(await users()).toContain("[fake: Connected as x]"));
    expect(state.received).toEqual(["code"]);
    expect(existsSync(join(home, "secrets/fake.authorize"))).toBe(false);
    expect(await pending()).toEqual([]);
  });

  test("withdraws the request when the flow's own signal aborts it", async () => {
    await tool(daemon, faux, "connect", { extension: "fake" });
    await vi.waitFor(async () => expect(await pending()).toHaveLength(1));
    state.loopback.resolve("from-loopback");
    await vi.waitFor(async () => expect(await pending()).toEqual([]));
    await vi.waitFor(async () => expect(await users()).toContain("[fake: Connected as x]"));
    expect(state.received).toEqual(["from-loopback"]);
  });

  test("withdraws the request when the flow ends without aborting its prompt", async () => {
    state.keepPrompt = true;
    await tool(daemon, faux, "connect", { extension: "fake" });
    await vi.waitFor(async () => expect(await pending()).toHaveLength(1));
    state.loopback.resolve("from-loopback");
    await vi.waitFor(async () => expect(await pending()).toEqual([]));
    expect(state.io!.signal!.aborted).toBe(true);
  });

  test("a second connect while one runs says so and asks only once", async () => {
    await tool(daemon, faux, "connect", { extension: "fake" });
    await vi.waitFor(async () => expect(await pending()).toHaveLength(1));
    const again = await tool(daemon, faux, "connect", { extension: "fake" });
    expect(again).toContain("Send the user this link to sign in: https://example.test/a");
    expect(again).toContain("Already signing in.");
    expect(await pending()).toHaveLength(1);
  });

  test("a failed sign-in is reported", async () => {
    state.fail = new Error("denied");
    await tool(daemon, faux, "connect", { extension: "fake" });
    await vi.waitFor(async () => expect(await pending()).toHaveLength(1));
    state.loopback.resolve("x");
    await vi.waitFor(async () => expect(await users()).toContain("[fake: couldn't connect: denied]"));
  });

  test("a flow that ends before asking returns its outcome", async () => {
    state.skipPrompt = true;
    state.loopback.resolve("x");
    const reply = await tool(daemon, faux, "connect", { extension: "fake" });
    expect(reply).toContain("Send the user this link to sign in: https://example.test/a");
    expect(reply).toContain("Connected as x");
    expect(reply).not.toContain("Waiting for the user to sign in.");
    expect(await pending()).toEqual([]);
    expect(await users()).not.toContain("[fake: Connected as x]"); // the reply carried it
  });

  test("closing the daemon aborts a pending sign-in", async () => {
    await tool(daemon, faux, "connect", { extension: "fake" });
    await vi.waitFor(async () => expect(await pending()).toHaveLength(1));
    await daemon.close();
    expect(state.io!.signal!.aborted).toBe(true);
    // The flow ends against the closed daemon without reporting to it.
    state.loopback.resolve("late");
    await new Promise((resolve) => setTimeout(resolve, 10));
    ({ daemon, faux } = await bootTest());
  });

  test("an extension without a sign-in", async () => {
    expect(await tool(daemon, faux, "connect", { extension: "web" })).toBe("web has no sign-in.");
    expect(await tool(daemon, faux, "connect", { extension: "nope" })).toBe("nope has no sign-in.");
  });

  test("text and select prompts need japa setup", async () => {
    const promptOnly: JapaExtension = {
      name: "texty",
      summary: "Test",
      authorize: {
        connected: async () => false,
        run: async (_ctx, io) => io.prompt({ type: "text", message: "Name?" }),
      },
    };
    await daemon.close();
    ({ daemon, faux } = await bootTest({}, [promptOnly]));
    script(faux, () => undefined);
    expect(await tool(daemon, faux, "connect", { extension: "texty" })).toContain(
      "couldn't connect: This sign-in needs japa setup",
    );
  });
});

test("a sign-in request left by a previous run is withdrawn at boot", async () => {
  const kit = testKit();
  const { extension } = fake();
  const { daemon, home } = await bootTest({ storage: { adapter: "sqlite" } }, [extension], kit);
  await daemon.root.commit(async (tx) => {
    await addSecretRequest(tx, "fake.authorize", "Paste the address");
    await addSecretRequest(tx, "svc.token", "to sync");
  }, ctx);
  await daemon.close();
  const again = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, extension] });
  const { pending } = (await again.harness.snapshot(SecretRequestsDoc, ROOT_CONVERSATION_ID, ctx))!;
  expect(pending.map((r) => r.name)).toEqual(["svc.token"]);
  await again.close();
});

test("removeSecretRequest removes a pending request by name", async () => {
  const { daemon } = await bootTest();
  await daemon.root.commit((tx) => addSecretRequest(tx, "svc.token", "to sync"), ctx);
  expect(await daemon.root.commit((tx) => removeSecretRequest(tx, "svc.token"), ctx)).toBe(true);
  expect(await daemon.root.commit((tx) => removeSecretRequest(tx, "svc.token"), ctx)).toBe(false);
  expect((await daemon.harness.snapshot(SecretRequestsDoc, ROOT_CONVERSATION_ID, ctx))!.pending).toEqual([]);
  await daemon.close();
});
