import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { SettingsPrompt, SettingsUI } from "../src/core/settings.ts";
import {
  createNativeModels,
  modelsFromEnvironment,
} from "../src/extensions/models.ts";
import {
  configureModels,
  chooseModels,
  createCredentialStore,
  runAuthInteraction,
} from "../src/extensions/setup.ts";

const context = BACKGROUND_CONTEXT;
const DEFAULT = Symbol("default");
const key = "private-test-api-key";

async function home(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "japa-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function scripted(answers: (string | undefined | typeof DEFAULT)[]) {
  const prompts: SettingsPrompt[] = [];
  const notices: string[] = [];
  let index = 0;
  const ui: SettingsUI = {
    async prompt(request) {
      assert(index < answers.length, `Unexpected prompt: ${request.title}`);
      prompts.push(request);
      const answer = answers[index++];
      return answer === DEFAULT ? request.defaultValue : answer;
    },
    async notify(message) {
      notices.push(message);
    },
  };
  return {
    ui,
    prompts,
    notices,
    done: () => assert.equal(index, answers.length),
  };
}

const silent: SettingsUI = {
  async prompt(request) {
    throw new Error(`Unexpected prompt: ${request.title}`);
  },
  async notify() {},
};

async function setup(directory: string, provider = "openai") {
  const script = scripted([provider, "api_key", key]);
  const result = await configureModels(directory, script.ui, context, {
    env: {},
  });
  assert(result);
  script.done();
  return { result, ...script };
}

async function files(directory: string) {
  return {
    settings: await readFile(join(directory, "settings.json"), "utf8"),
    credentials: await readFile(join(directory, "credentials.json"), "utf8"),
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("API-key setup uses secret input, private separate files, and reopens without prompts", async (t) => {
  const directory = await home(t);
  const beforeEnv = JSON.stringify(process.env);
  const configured = await setup(directory);
  assert.deepEqual(configured.result.root, {
    provider: "openai",
    modelId: "gpt-5.4",
  });
  assert.deepEqual(configured.result.worker, {
    provider: "openai",
    modelId: "gpt-5.4-mini",
  });
  assert.deepEqual(
    configured.prompts.slice(0, 2).map((request) => request.title),
    ["Model provider", "Authentication"],
  );
  assert.equal(
    configured.prompts.length,
    3,
    "first run must not display model catalogs",
  );
  assert.equal(configured.prompts[2]?.kind, "text");
  assert.equal(
    (configured.prompts[2] as Extract<SettingsPrompt, { kind: "text" }>).secret,
    true,
  );
  const saved = await files(directory);
  assert(!saved.settings.includes(key));
  assert(saved.credentials.includes(key));
  assert(!configured.notices.join().includes(key));
  const data = JSON.parse(saved.settings);
  assert.deepEqual(Object.keys(data).sort(), [
    "deviceId",
    "provider",
    "root",
    "version",
    "worker",
  ]);
  assert.match(data.deviceId, /^[\da-f-]{36}$/);
  for (const filename of ["settings.json", "credentials.json"]) {
    assert.equal((await stat(join(directory, filename))).mode & 0o777, 0o600);
  }
  assert.deepEqual((await readdir(directory)).sort(), [
    "credentials.json",
    "settings.json",
  ]);
  const reopened = await configureModels(directory, silent, context, {
    env: {},
  });
  assert(reopened);
  assert.equal((await reopened.models.getAuth("openai"))?.auth.apiKey, key);
  assert.deepEqual(reopened.root, configured.result.root);
  assert.deepEqual(await files(directory), saved);
  assert(
    JSON.stringify(process.env) === beforeEnv,
    "setup must not mutate the process environment",
  );
});

test("Anthropic API-key setup uses sensible same-provider role defaults", async (t) => {
  const directory = await home(t);
  const { result } = await setup(directory, "anthropic");
  assert.deepEqual(result.root, {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
  });
  assert.deepEqual(result.worker, result.root);
  assert.equal((await result.models.getAuth("anthropic"))?.auth.apiKey, key);
});

test("injected environment works for setup and library callers without global mutation", async (t) => {
  const directory = await home(t);
  const original = JSON.stringify(process.env);
  const env = {
    OPENAI_API_KEY: "injected-openai-key",
    ANTHROPIC_API_KEY: "injected-anthropic-key",
    JAPA_MODEL: "anthropic/claude-sonnet-4-6",
    JAPA_WORKER_MODEL: "openai/gpt-5.4-mini",
  };
  const direct = modelsFromEnvironment(env);
  assert.equal(
    (await direct.models.getAuth("openai"))?.auth.apiKey,
    env.OPENAI_API_KEY,
  );
  assert.equal(
    (await direct.models.getAuth("anthropic"))?.auth.apiKey,
    env.ANTHROPIC_API_KEY,
  );
  const configured = await configureModels(directory, silent, context, { env });
  assert(configured);
  assert.deepEqual(configured.root, direct.root);
  assert.deepEqual(configured.worker, direct.worker);
  assert(
    !JSON.stringify(
      JSON.parse(await readFile(join(directory, "settings.json"), "utf8")),
    ).includes("injected-"),
  );
  const persisted = JSON.parse(
    await readFile(join(directory, "settings.json"), "utf8"),
  );
  assert.deepEqual(persisted.root, { provider: "openai", modelId: "gpt-5.4" });
  assert.deepEqual(persisted.worker, {
    provider: "openai",
    modelId: "gpt-5.4-mini",
  });
  await assert.rejects(readFile(join(directory, "credentials.json")), {
    code: "ENOENT",
  });
  assert.equal(await createNativeModels({}).checkAuth("openai"), undefined);
  assert(
    JSON.stringify(process.env) === original,
    "setup must not mutate the process environment",
  );
  assert.throws(
    () => modelsFromEnvironment({ JAPA_MODEL: "bad" }),
    /Expected provider\/model/,
  );
  const anthropic = modelsFromEnvironment({
    ANTHROPIC_OAUTH_TOKEN: "injected-token",
  });
  assert.equal(anthropic.root.provider, "anthropic");
  assert.equal(
    (await anthropic.models.getAuth("anthropic"))?.auth.apiKey,
    "injected-token",
  );
});

test("explicit environment roles independently override saved selections without persisting them", async (t) => {
  const directory = await home(t);
  const { result: saved } = await setup(directory, "anthropic");
  const before = await files(directory);
  const openaiRoot = { provider: "openai", modelId: "gpt-5.4" };
  const openaiWorker = { provider: "openai", modelId: "gpt-5.4-mini" };
  for (const overrides of [
    {},
    { JAPA_WORKER_MODEL: "openai/gpt-5.4-mini" },
    { JAPA_MODEL: "openai/gpt-5.4" },
    { JAPA_MODEL: "openai/gpt-5.4", JAPA_WORKER_MODEL: "openai/gpt-5.4-mini" },
  ]) {
    const active = await configureModels(directory, silent, context, {
      env: { OPENAI_API_KEY: "ambient-openai", ...overrides },
    });
    assert(active);
    assert.deepEqual(
      active.root,
      overrides.JAPA_MODEL ? openaiRoot : saved.root,
    );
    assert.deepEqual(
      active.worker,
      overrides.JAPA_WORKER_MODEL ? openaiWorker : saved.worker,
    );
    assert.deepEqual(await files(directory), before);
  }
  const restored = await configureModels(directory, silent, context, {
    env: {},
  });
  assert(restored);
  assert.deepEqual(restored.root, saved.root);
  assert.deepEqual(restored.worker, saved.worker);

  // An unrelated API key must not silently replace a saved provider whose login was lost.
  await createCredentialStore(directory).delete("anthropic");
  const cancelled = scripted([undefined]);
  await assert.rejects(
    configureModels(directory, cancelled.ui, context, {
      env: { OPENAI_API_KEY: "ambient-openai" },
    }),
    /setup cancelled/i,
  );
  cancelled.done();
  assert.equal((await files(directory)).settings, before.settings);
});

test("role defaults and forced model choices use the native credential-filtered catalog", async (t) => {
  const directory = await home(t);
  const store = createCredentialStore(directory);
  await store.modify("openai", async () => ({ type: "api_key", key }));
  const models = createNativeModels({}, store);
  const native = models.getProvider("openai")!;
  models.setProvider({
    ...native,
    filterModels(catalog, credential) {
      assert.equal(credential?.type, "api_key");
      return catalog.filter((model) => model.id === "gpt-5.4-mini");
    },
  });
  const defaults = await chooseModels(models, "openai", undefined, context);
  assert.deepEqual(defaults.root, {
    provider: "openai",
    modelId: "gpt-5.4-mini",
  });
  assert.deepEqual(defaults.worker, defaults.root);
  const script = scripted([DEFAULT, DEFAULT]);
  await chooseModels(models, "openai", script.ui, context);
  script.done();
  for (const request of script.prompts) {
    assert.equal(request.kind, "choice");
    if (request.kind === "choice")
      assert.deepEqual(
        request.choices.map((choice) => choice.value),
        ["gpt-5.4-mini"],
      );
  }
});

test("failed first API-key setup throws instead of silently returning disconnected", async (t) => {
  const directory = await home(t);
  const script = scripted(["openai", "api_key", ""]);
  await assert.rejects(
    configureModels(directory, script.ui, context, { env: {} }),
    /invalid credential/i,
  );
  script.done();
  assert.deepEqual(await readdir(directory), []);
});

test("both roles must have configured auth; invalid model refs never silently fall back", async (t) => {
  const directory = await home(t);
  const script = scripted([undefined]);
  await assert.rejects(
    configureModels(directory, script.ui, context, {
      env: {
        OPENAI_API_KEY: key,
        JAPA_WORKER_MODEL: "anthropic/claude-sonnet-4-6",
      },
    }),
    /setup cancelled/i,
  );
  script.done();
  await assert.rejects(
    configureModels(directory, silent, context, {
      env: { OPENAI_API_KEY: key, JAPA_WORKER_MODEL: "openai/not-a-model" },
    }),
    /Unknown worker model/,
  );
  assert.deepEqual(await readdir(directory), []);
});

test("forced login and model edits are staged; cancellation preserves previous files and device ID", async (t) => {
  const directory = await home(t);
  await setup(directory);
  const before = await files(directory);
  const script = scripted([
    "login",
    "anthropic",
    "api_key",
    "replacement-secret",
    DEFAULT,
    DEFAULT,
    "cancel",
  ]);
  const restored = await configureModels(directory, script.ui, context, {
    force: true,
    env: {},
  });
  script.done();
  assert(restored);
  assert.equal(restored.root.provider, "openai");
  assert.deepEqual(await files(directory), before);
  assert.equal((await restored.models.getAuth("openai"))?.auth.apiKey, key);
  assert.equal(await restored.models.getAuth("anthropic"), undefined);

  const change = scripted([
    "models",
    "openai",
    "gpt-5.4-mini",
    "gpt-5.4",
    "save",
  ]);
  const updated = await configureModels(directory, change.ui, context, {
    force: true,
    env: {},
  });
  change.done();
  assert(updated);
  assert.equal(updated.root.modelId, "gpt-5.4-mini");
  const after = await files(directory);
  assert.equal(after.credentials, before.credentials);
  assert.equal(
    JSON.parse(after.settings).deviceId,
    JSON.parse(before.settings).deviceId,
  );
});

test("forced provider changes and logout commit together only on Save", async (t) => {
  const directory = await home(t);
  await setup(directory);
  const script = scripted([
    "login",
    "anthropic",
    "api_key",
    "anthropic-secret",
    DEFAULT,
    DEFAULT,
    "logout",
    "openai",
    "save",
  ]);
  const result = await configureModels(directory, script.ui, context, {
    force: true,
    env: {},
  });
  script.done();
  assert(result);
  assert.equal(result.root.provider, "anthropic");
  assert.equal(result.worker.provider, "anthropic");
  assert.equal(await result.models.getAuth("openai"), undefined);
  assert.equal(
    (await result.models.getAuth("anthropic"))?.auth.apiKey,
    "anthropic-secret",
  );
  const reopened = await configureModels(directory, silent, context, {
    env: {},
  });
  assert(reopened);
  assert.deepEqual(reopened.root, result.root);
  assert.deepEqual(await createCredentialStore(directory).list(), [
    { providerId: "anthropic", type: "api_key" },
  ]);
});

test("replacing an existing provider key then cancelling preserves the original credential", async (t) => {
  const directory = await home(t);
  await setup(directory);
  const before = await files(directory);
  const script = scripted([
    "login",
    "openai",
    "api_key",
    "replacement",
    DEFAULT,
    DEFAULT,
    "cancel",
  ]);
  const result = await configureModels(directory, script.ui, context, {
    force: true,
    env: {},
  });
  script.done();
  assert(result);
  assert.equal((await result.models.getAuth("openai"))?.auth.apiKey, key);
  assert.deepEqual(await files(directory), before);
});

test("cancelling the first API-key prompt does not save credentials or selections", async (t) => {
  const directory = await home(t);
  const script = scripted(["openai", "api_key", undefined]);
  await assert.rejects(
    configureModels(directory, script.ui, context, { env: {} }),
    /setup cancelled/i,
  );
  script.done();
  assert.deepEqual(await readdir(directory), []);
});

test("cancelled native OAuth method selection retains a stable installation UUID without contacting the provider", async (t) => {
  const directory = await home(t);
  const first = scripted(["anthropic", "oauth", undefined]);
  await assert.rejects(
    configureModels(directory, first.ui, context, { env: {} }),
    /setup cancelled/i,
  );
  first.done();
  const initial = await readFile(join(directory, "settings.json"), "utf8");
  assert.deepEqual(Object.keys(JSON.parse(initial)).sort(), [
    "deviceId",
    "version",
  ]);
  const second = scripted(["anthropic", "oauth", undefined]);
  await assert.rejects(
    configureModels(directory, second.ui, context, { env: {} }),
    /setup cancelled/i,
  );
  second.done();
  assert.equal(
    await readFile(join(directory, "settings.json"), "utf8"),
    initial,
  );
  assert.deepEqual(await readdir(directory), ["settings.json"]);
});

test("saving logout of the last provider exits disconnected and preserves roles for a later login", async (t) => {
  const directory = await home(t);
  await setup(directory);
  const changes = scripted([
    "models",
    "openai",
    "gpt-5.4-mini",
    "gpt-5.4",
    "save",
  ]);
  await configureModels(directory, changes.ui, context, {
    force: true,
    env: {},
  });
  changes.done();
  const before = await files(directory);
  const cancel = scripted(["logout", "openai", "cancel"]);
  const retained = await configureModels(directory, cancel.ui, context, {
    force: true,
    env: {},
  });
  assert(retained);
  cancel.done();
  assert.deepEqual(await files(directory), before);

  const logout = scripted(["logout", "openai", "save"]);
  const disconnected = await configureModels(directory, logout.ui, context, {
    force: true,
    env: {},
  });
  logout.done();
  assert.equal(disconnected, undefined);
  assert(logout.notices.some((notice) => notice.includes("disconnected")));
  assert.equal(
    await createCredentialStore(directory).read("openai"),
    undefined,
  );
  const after = await files(directory);
  assert.deepEqual(JSON.parse(after.settings), {
    ...JSON.parse(before.settings),
    disconnected: true,
  });

  const cancelReconnect = scripted([undefined]);
  assert.equal(
    await configureModels(directory, cancelReconnect.ui, context, { env: {} }),
    undefined,
  );
  cancelReconnect.done();
  assert.deepEqual(await files(directory), after);

  const login = scripted(["openai", "api_key", "new-key"]);
  const reconnected = await configureModels(directory, login.ui, context, {
    env: {},
  });
  login.done();
  assert(reconnected);
  assert.equal(reconnected.root.modelId, "gpt-5.4-mini");
  assert.equal(reconnected.worker.modelId, "gpt-5.4");
  assert.equal(
    JSON.parse((await files(directory)).settings).disconnected,
    undefined,
  );
});

test("logout still uses explicitly available ambient credentials", async (t) => {
  const directory = await home(t);
  await setup(directory);
  const logout = scripted(["logout", "openai", "save"]);
  const remaining = await configureModels(directory, logout.ui, context, {
    force: true,
    env: { OPENAI_API_KEY: "ambient-key" },
  });
  logout.done();
  assert(remaining);
  assert.equal(
    await createCredentialStore(directory).read("openai"),
    undefined,
  );
  assert.equal(
    (await remaining.models.getAuth("openai"))?.auth.apiKey,
    "ambient-key",
  );
});

test("malformed config or credentials fail closed without overwrites or secret-bearing errors", async (t) => {
  const directory = await home(t);
  await setup(directory);
  const before = await files(directory);
  for (const bad of [
    "{secret-invalid-json",
    "null",
    JSON.stringify({ ...JSON.parse(before.settings), apiKey: key }),
    JSON.stringify({
      ...JSON.parse(before.settings),
      worker: { provider: "openai", modelId: "missing" },
    }),
  ]) {
    await writeFile(join(directory, "settings.json"), bad);
    await assert.rejects(
      configureModels(directory, silent, context, {
        force: true,
        env: { OPENAI_API_KEY: "fallback" },
      }),
      (error: Error) => {
        assert(!error.message.includes(key));
        assert(!error.message.includes("secret-invalid-json"));
        return /Invalid|Unknown/.test(error.message);
      },
    );
    assert.equal(await readFile(join(directory, "settings.json"), "utf8"), bad);
    assert.equal(
      await readFile(join(directory, "credentials.json"), "utf8"),
      before.credentials,
    );
  }
  await writeFile(join(directory, "settings.json"), before.settings);
  for (const bad of [
    "{private-broken-json",
    JSON.stringify({
      openai: { type: "oauth", access: key, expires: "tomorrow" },
    }),
    "[]",
  ]) {
    await writeFile(join(directory, "credentials.json"), bad);
    await assert.rejects(
      configureModels(directory, silent, context, {
        env: { OPENAI_API_KEY: "fallback" },
      }),
      /Invalid/,
    );
    await assert.rejects(
      createCredentialStore(directory).modify("openai", async () => ({
        type: "api_key",
        key,
      })),
      /Invalid/,
    );
    assert.equal(
      await readFile(join(directory, "credentials.json"), "utf8"),
      bad,
    );
    assert.equal(
      await readFile(join(directory, "settings.json"), "utf8"),
      before.settings,
    );
  }
});

test("credential mutations serialize across instances/providers and undefined means unchanged", async (t) => {
  const directory = await home(t);
  const first = createCredentialStore(directory);
  const second = createCredentialStore(directory);
  await first.modify("openai", async () => ({ type: "api_key", key: "old" }));
  const started = deferred();
  const release = deferred();
  const order: string[] = [];
  const changing = first.modify("openai", async (current) => {
    assert.equal(current?.type, "api_key");
    order.push("first");
    started.resolve();
    await release.promise;
    return { type: "api_key", key: "new" };
  });
  await started.promise;
  const other = second.modify("anthropic", async () => {
    order.push("other-provider");
    return { type: "api_key", key: "anthropic-key" };
  });
  const deleting = second.delete("openai");
  const last = first.modify("openai", async (current) => {
    order.push("last");
    assert.equal(current, undefined);
    return { type: "api_key", key: "final" };
  });
  release.resolve();
  await Promise.all([changing, other, deleting, last]);
  assert.deepEqual(order, ["first", "other-provider", "last"]);
  assert.deepEqual(await first.list(), [
    { providerId: "anthropic", type: "api_key" },
    { providerId: "openai", type: "api_key" },
  ]);
  const before = await readFile(join(directory, "credentials.json"), "utf8");
  const unchanged = await first.modify("openai", async (current) => {
    if (current?.type === "api_key") current.key = "must-not-leak";
    return undefined;
  });
  assert.deepEqual(unchanged, { type: "api_key", key: "final" });
  assert.equal(
    await readFile(join(directory, "credentials.json"), "utf8"),
    before,
  );
});

test("native OAuth refresh is locked and preserves complete credentials; failures retain old tokens", async (t) => {
  const directory = await home(t);
  const credentials = createCredentialStore(directory);
  const expired: OAuthCredential = {
    type: "oauth",
    access: "expired",
    refresh: "rotate-once",
    expires: 1,
    clientId: "issued-client",
    scopes: ["scope"],
  };
  await credentials.modify("openai", async () => expired);
  let refreshes = 0;
  const started = deferred();
  const release = deferred();
  const makeModels = () => {
    const models = createNativeModels({}, createCredentialStore(directory));
    const native = models.getProvider("openai")!;
    models.setProvider({
      ...native,
      auth: {
        ...native.auth,
        oauth: {
          ...native.auth.oauth!,
          async refresh(current) {
            refreshes++;
            assert.equal(current.refresh, "rotate-once");
            started.resolve();
            await release.promise;
            return {
              ...current,
              access: "fresh",
              refresh: "rotated",
              expires: Date.now() + 3_600_000,
            };
          },
          async toAuth(current) {
            return { apiKey: current.access };
          },
        },
      },
    });
    return models;
  };
  const one = makeModels();
  const two = makeModels();
  const first = one.getAuth("openai");
  await started.promise;
  const second = two.getAuth("openai");
  release.resolve();
  assert.equal((await first)?.auth.apiKey, "fresh");
  assert.equal((await second)?.auth.apiKey, "fresh");
  assert.equal(refreshes, 1);
  const persisted = (await credentials.read("openai")) as OAuthCredential;
  assert.equal(persisted.clientId, "issued-client");
  assert.deepEqual(persisted.scopes, ["scope"]);
  assert.equal(persisted.refresh, "rotated");

  await credentials.modify("openai", async () => expired);
  const native = one.getProvider("openai")!;
  one.setProvider({
    ...native,
    auth: {
      ...native.auth,
      oauth: {
        ...native.auth.oauth!,
        async refresh() {
          throw new Error("offline refresh failure");
        },
      },
    },
  });
  await assert.rejects(one.getAuth("openai"), /OAuth refresh failed/);
  assert.deepEqual(await credentials.read("openai"), expired);
});

test("cancelled lock wait never mutates, but an already-started credential write finishes", async (t) => {
  const directory = await home(t);
  const store = createCredentialStore(directory);
  const start = deferred();
  const release = deferred();
  const runningAbort = new AbortController();
  const running = store.modify(
    "openai",
    async () => {
      start.resolve();
      await release.promise;
      return {
        type: "oauth",
        access: "rotated",
        refresh: "new-refresh",
        expires: Date.now() + 3_600_000,
      };
    },
    { signal: runningAbort.signal },
  );
  await start.promise;
  const queuedAbort = new AbortController();
  const queued = store.delete("openai", { signal: queuedAbort.signal });
  const rejected = assert.rejects(queued, /cancel queued/);
  queuedAbort.abort(new Error("cancel queued"));
  runningAbort.abort();
  release.resolve();
  await running;
  await rejected;
  assert.equal(
    ((await store.read("openai")) as OAuthCredential).refresh,
    "new-refresh",
  );
});

test("auth bridge maps native prompts/events and native Models.login persists all OAuth fields offline", async (t) => {
  const directory = await home(t);
  const script = scripted([
    "chosen",
    "plain answer",
    "sensitive answer",
    "callback-url",
  ]);
  const store = createCredentialStore(directory);
  const models = createNativeModels({}, store);
  const native = models.getProvider("openai")!;
  const token: OAuthCredential = {
    type: "oauth",
    access: "oauth-access",
    refresh: "oauth-refresh",
    expires: Date.now() + 3_600_000,
    clientId: "issued-client",
    scopes: ["direct"],
  };
  models.setProvider({
    ...native,
    auth: {
      ...native.auth,
      oauth: {
        ...native.auth.oauth!,
        async login(interaction, options) {
          assert(interaction.signal instanceof AbortSignal);
          assert.equal(options?.getDeviceId?.(), "installation-id");
          interaction.notify({
            type: "info",
            message: "Information",
            links: [{ label: "Help", url: "https://example.com/help" }],
          });
          interaction.notify({
            type: "auth_url",
            url: "https://example.com/login",
            instructions: "Open browser",
          });
          interaction.notify({
            type: "device_code",
            userCode: "ABCD",
            verificationUri: "https://example.com/device",
          });
          interaction.notify({ type: "progress", message: "Waiting" });
          assert.equal(
            await interaction.prompt({
              type: "select",
              message: "Choose",
              options: [{ id: "chosen", label: "Choice" }],
            }),
            "chosen",
          );
          assert.equal(
            await interaction.prompt({
              type: "text",
              message: "Text",
              placeholder: "not a default",
            }),
            "plain answer",
          );
          assert.equal(
            await interaction.prompt({ type: "secret", message: "Secret" }),
            "sensitive answer",
          );
          assert.equal(
            await interaction.prompt({
              type: "manual_code",
              message: "Callback",
            }),
            "callback-url",
          );
          return token;
        },
      },
    },
  });
  await runAuthInteraction(script.ui, context, (interaction) =>
    models.login("openai", "oauth", interaction, {
      getDeviceId: () => "installation-id",
    }),
  );
  script.done();
  assert.deepEqual(script.prompts[0], {
    kind: "choice",
    title: "Choose",
    choices: [{ value: "chosen", label: "Choice" }],
  });
  assert.deepEqual(script.prompts.slice(1), [
    { kind: "text", title: "Text", secret: false },
    { kind: "text", title: "Secret", secret: true },
    { kind: "text", title: "Callback", secret: true },
  ]);
  assert.deepEqual(script.notices, [
    "Information\nHelp: https://example.com/help",
    "https://example.com/login\nOpen browser",
    "Open https://example.com/device\nEnter code: ABCD",
    "Waiting",
  ]);
  assert.deepEqual(await store.read("openai"), token);
});

test("per-prompt OAuth cancellation cancels its Chord context without cancelling the login", async () => {
  const entered = deferred();
  let promptContext: Context | undefined;
  const ui: SettingsUI = {
    async notify() {},
    async prompt(_request, child) {
      promptContext = child;
      entered.resolve();
      return new Promise<string | undefined>(() => {}); // Even a non-cooperative UI cannot block cancellation.
    },
  };
  await runAuthInteraction(ui, context, async (interaction) => {
    const callback = new AbortController();
    const pending = interaction.prompt({
      type: "manual_code",
      message: "Paste callback",
      signal: callback.signal,
    });
    const rejected = assert.rejects(pending, /callback won/);
    await entered.promise;
    callback.abort(new Error("callback won"));
    await rejected;
    assert.equal(promptContext?.abortSignal?.aborted, true);
    assert.equal(interaction.signal?.aborted, false);
  });
});

test("whole-flow cancellation reaches native login and returns previous valid configuration", async (t) => {
  const directory = await home(t);
  await setup(directory);
  const before = await files(directory);
  const cancelled = withCancel(context);
  let signal: AbortSignal | undefined;
  const running = runAuthInteraction(
    silent,
    cancelled.context,
    async (interaction) => {
      signal = interaction.signal;
      cancelled.cancel(new Error("cancel flow"));
      return new Promise<never>(() => {});
    },
  );
  await assert.rejects(running, /cancel flow/);
  assert.equal(signal?.aborted, true);

  const alreadyCancelled = withCancel(context);
  alreadyCancelled.cancel();
  const unchanged = await configureModels(
    directory,
    silent,
    alreadyCancelled.context,
    { force: true, env: {} },
  );
  assert(unchanged);
  assert.equal(unchanged.root.provider, "openai");
  assert.deepEqual(await files(directory), before);

  const settings = withCancel(context);
  const ui: SettingsUI = {
    async notify() {},
    async prompt() {
      settings.cancel();
      return undefined;
    },
  };
  const previous = await configureModels(directory, ui, settings.context, {
    force: true,
    env: {},
  });
  assert(previous);
  assert.equal(previous.root.provider, "openai");
  assert.deepEqual(await files(directory), before);
});

test("synchronous native notifications observe asynchronous UI failures, even without a prompt", async () => {
  const ui: SettingsUI = {
    async prompt() {
      throw new Error("should not prompt");
    },
    async notify() {
      throw new Error("channel unavailable");
    },
  };
  await assert.rejects(
    runAuthInteraction(ui, context, async (interaction) => {
      interaction.notify({ type: "progress", message: "First" });
      interaction.notify({ type: "progress", message: "Second" });
      return "finished";
    }),
    /channel unavailable/,
  );
});
