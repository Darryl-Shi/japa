import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { SurfaceContext } from "../src/kernel/contracts.ts";
import { FEATURED } from "../src/kernel/credentials.ts";
import type { JapaExtension } from "../src/kernel/extension.ts";
import { bootTest, probe } from "./helpers.ts";
import { tool } from "./jobs-helpers.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Resolves or rejects from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/** An interaction whose prompts answer `answer`'s value; it records the prompts. */
function interaction(answer: Promise<string>) {
  const prompts: AuthPrompt[] = [];
  const io: AuthInteraction = {
    signal: new AbortController().signal,
    notify: () => {},
    prompt: async (q) => {
      prompts.push(q);
      return answer;
    },
  };
  return { io, prompts };
}

async function bootAdmin(extra: JapaExtension[] = []) {
  const probed = probe();
  const booted = await bootTest({}, [probed.extension, ...extra]);
  return { ...booted, surface: probed.surface, admin: probed.surface().admin! };
}

const userFile = (home: string) => readFileSync(join(home, "settings.json"), "utf8");

test("a packaged surface gets admin; a workspace one doesn't", async () => {
  const { daemon, home, admin } = await bootAdmin();
  expect(admin).toBeDefined();
  const g = globalThis as { wsSurface?: SurfaceContext };
  mkdirSync(join(home, "extensions", "wsprobe"), { recursive: true });
  writeFileSync(
    join(home, "extensions", "wsprobe", "index.ts"),
    `import { defineJapaExtension } from "japa/sdk";
export default defineJapaExtension({
  name: "wsprobe",
  summary: "Test",
  provides: { surface: [{ name: "wsprobe", start: async (c) => { globalThis.wsSurface = c; return () => {}; } }] },
});
`,
  );
  expect((await daemon.reconcile()).errors).toEqual([]);
  expect(g.wsSurface).toBeDefined();
  expect(g.wsSurface!.admin).toBeUndefined();
  delete g.wsSurface;
  await daemon.close();
});

test("setSetting goes through settings_set; settings() is a copy", async () => {
  const { daemon, home, admin } = await bootAdmin();
  const before = userFile(home);
  expect(await admin.setSetting("jobs.maxConcurrent", "abc")).toMatch(/^Not changed: jobs\.maxConcurrent: /);
  expect(userFile(home)).toBe(before);

  expect(await admin.setSetting("jobs.maxConcurrent", 2)).toMatch(/^Set jobs\.maxConcurrent\./);
  const settings = admin.settings() as { jobs: { maxConcurrent: number } };
  expect(settings.jobs.maxConcurrent).toBe(2);
  settings.jobs.maxConcurrent = 9;
  expect((admin.settings() as typeof settings).jobs.maxConcurrent).toBe(2);
  expect((await admin.changes()).map((c) => c.title)).toEqual(["Set jobs.maxConcurrent"]);
  await daemon.close();
});

test("extensions() lists them; tool() runs only schedule tools", async () => {
  const { daemon, admin } = await bootAdmin();
  expect((await admin.extensions()).find((e) => e.name === "schedule")).toMatchObject({ loaded: true, workspace: false });
  expect(await admin.tool("settings_set", { path: "jobs.maxConcurrent", value: 3 })).toBeUndefined();
  expect(await admin.tool("schedule_list", {})).toMatchObject({ content: [{ type: "text" }] });
  await daemon.close();
});

test("providers() lists featured first, then by name, with their sign-ins", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  const { daemon, admin } = await bootAdmin();
  const providers = await admin.providers();
  const ids = providers.map((p) => p.id);
  const featured = ids.filter((id) => FEATURED.includes(id));
  expect(ids.slice(0, featured.length)).toEqual(FEATURED.filter((id) => featured.includes(id)));
  const rest = providers.slice(featured.length).map((p) => p.name);
  expect(rest).toEqual(rest.toSorted((a, b) => a.localeCompare(b)));
  const anthropic = providers.find((p) => p.id === "anthropic")!;
  expect(anthropic).toMatchObject({ connected: false, apiKey: { label: "Anthropic API key" } });
  expect(anthropic.credential).toBeUndefined();
  expect(anthropic.signIn?.label).toBeTruthy();
  const cos = daemon.status().model!;
  expect(providers.find((p) => p.id === cos.provider)?.connected).toBe(true);
  await daemon.close();
});

test("models() lists a provider's models; an unknown provider throws", async () => {
  const { daemon, admin } = await bootAdmin();
  const cos = daemon.status().model!;
  expect(await admin.models(cos.provider)).toContainEqual({ id: cos.modelId, name: expect.any(String) });
  await expect(admin.models("nope")).rejects.toThrow("No provider nope.");
  await daemon.close();
});

test("login stores an API key, one sign-in per provider at a time", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  const { daemon, home, admin } = await bootAdmin();
  const key = deferred<string>();
  const { io, prompts } = interaction(key.promise);
  const first = admin.login("anthropic", "api_key", io);
  await vi.waitFor(() => expect(prompts).toMatchObject([{ type: "secret" }]));
  await expect(admin.login("anthropic", "api_key", interaction(key.promise).io)).rejects.toThrow(
    "Already signing in to Anthropic.",
  );
  key.resolve("sk-test");
  await first;
  expect(readFileSync(join(home, "secrets", "anthropic.apiKey"), "utf8")).toBe("sk-test");
  expect((await admin.providers()).find((p) => p.id === "anthropic")).toMatchObject({
    credential: "api_key",
    connected: true,
  });
  await daemon.close();
});

test("a failed login throws why", async () => {
  const { daemon, admin } = await bootAdmin();
  const io: AuthInteraction = {
    signal: new AbortController().signal,
    notify: () => {},
    prompt: async () => {
      throw new Error("no key", { cause: new Error("typed nothing") });
    },
  };
  await expect(admin.login("anthropic", "api_key", io)).rejects.toThrow(
    /^Couldn't connect to Anthropic: .*no key: typed nothing/,
  );
  await daemon.close();
});

test("authorize runs the hook, one at a time, and refuses an extension without one", async () => {
  const gate = deferred<void>();
  let runs = 0;
  const fake: JapaExtension = {
    name: "fake",
    summary: "Test",
    authorize: {
      connected: async () => false,
      run: async (_ctx, io) => {
        runs++;
        io.notify({ type: "auth_url", url: "https://example.test/a" });
        await gate.promise;
        return "Connected as x";
      },
    },
  };
  const { daemon, faux, admin } = await bootAdmin([fake]);
  const { io } = interaction(Promise.resolve(""));
  const first = admin.authorize("fake", io);
  await expect(admin.authorize("fake", io)).rejects.toThrow("Already signing in to fake.");
  // Nor can the CoS's connect start one meanwhile.
  expect(await tool(daemon, faux, "connect", { extension: "fake" })).toBe("Already signing in.");
  await expect(admin.authorize("probe", io)).rejects.toThrow("probe has no sign-in.");
  gate.resolve();
  expect(await first).toBe("Connected as x");
  expect(runs).toBe(1);
  // Once it's done, another can run.
  const gone = admin.authorize("fake", io);
  expect(await gone).toBe("Connected as x");
  await daemon.close();
});
