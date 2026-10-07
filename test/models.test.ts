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
import { createProvider, type ModelsStoreEntry } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createModelsStore } from "../src/extensions/catalog.ts";
import {
  createNativeModels,
  modelRolesFromEnvironment,
  modelsFromEnvironment,
  prepareProviderModels,
} from "../src/extensions/models.ts";

async function home(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "japa-catalog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sample(id = "cached/main") {
  const template = createNativeModels({}).getModel("zai", "glm-5.3");
  assert(template);
  return { ...template, provider: "radius", id };
}

test("every native factory is registered by default, including dynamic providers and both ZAI deployment IDs", () => {
  const models = createNativeModels({});
  assert.deepEqual(
    models.getProviders().map((provider) => provider.id),
    builtinProviders().map((provider) => provider.id),
  );
  assert(models.getProvider("radius")?.refreshModels);
  for (const id of ["glm-5.3", "glm-5.3-flash"])
    assert.equal(models.getModel("zai", id)?.id, id);
  models.deleteProvider("zai");
  assert(
    createNativeModels({}).getProvider("zai"),
    "collections must not share mutable provider state",
  );
});

test("environment role overrides are independent; unknown providers/static model IDs fail closed", () => {
  const defaults = modelRolesFromEnvironment({});
  const rootOnly = modelRolesFromEnvironment({
    JAPA_MODEL: "anthropic/claude-sonnet-4-6",
  });
  assert.deepEqual(rootOnly.worker, defaults.worker);
  assert.throws(
    () => modelsFromEnvironment({ JAPA_MODEL: "unregistered/model" }),
    /Unknown model provider/,
  );
  assert.throws(
    () => modelsFromEnvironment({ JAPA_WORKER_MODEL: "zai/not-a-model" }),
    /Unknown worker model/,
  );
  const zai = modelsFromEnvironment({
    ZAI_API_KEY: "offline",
    JAPA_MODEL: "zai/glm-5.3",
    JAPA_WORKER_MODEL: "zai/glm-5.3-flash",
  });
  assert.equal(zai.root.modelId, "glm-5.3");
  assert.equal(zai.worker.modelId, "glm-5.3-flash");
});

test("native publication preserves catalog validators, private atomic files, reopen, and deletion", async (t) => {
  const directory = await home(t);
  const store = createModelsStore(directory);
  const entry: ModelsStoreEntry = {
    models: [sample()],
    etag: '"native-etag"',
    checkedAt: 123,
    lastModified: 100,
  };
  let persistedBeforeUpdate = false;
  let published = false;
  const models = createNativeModels(
    { RADIUS_API_KEY: "offline" },
    undefined,
    store,
  );
  const native = models.getProvider("radius");
  assert(native);
  models.setProvider({
    ...native,
    getModels: () => [],
    async refreshModels(ctx) {
      if (!ctx.allowNetwork) return;
      published = await ctx.publish({
        persist: entry,
        update() {
          assert(persistedBeforeUpdate);
        },
      });
    },
  });
  // Observe the native persistence-before-publication contract without intercepting publication.
  const observing = createNativeModels(
    { RADIUS_API_KEY: "offline" },
    undefined,
    {
      ...store,
      async write(id, data, opts) {
        await store.write(id, data, opts);
        persistedBeforeUpdate = true;
      },
    },
  );
  const provider = models.getProvider("radius");
  assert(provider);
  observing.setProvider(provider);
  const result = await observing.refresh({ providers: ["radius"] });
  assert.equal(result.errors.size, 0);
  assert(published);
  assert.deepEqual(await createModelsStore(directory).read("radius"), entry);
  assert.equal(
    (await stat(join(directory, "models", "radius.json"))).mode & 0o777,
    0o600,
  );
  assert.deepEqual(await readdir(join(directory, "models")), ["radius.json"]);

  const reopened = createNativeModels(
    {},
    undefined,
    createModelsStore(directory),
  );
  await prepareProviderModels(reopened, "radius", {
    modelIds: ["cached/main"],
    allowNetwork: false,
  });
  assert.equal(reopened.getModel("radius", "cached/main")?.id, "cached/main");
  reopened.setProvider({
    ...native,
    async refreshModels(ctx) {
      assert.deepEqual(ctx.stored, entry);
      await ctx.publish({ persist: null });
    },
  });
  await reopened.refresh({ providers: ["radius"], allowNetwork: false });
  assert.equal(await store.read("radius"), undefined);
});

test("only the selected dynamic provider refreshes; failed network refresh uses a valid requested cache", async (t) => {
  const directory = await home(t);
  const store = createModelsStore(directory);
  await store.write("radius", { models: [sample()] });
  const models = createNativeModels(
    { RADIUS_API_KEY: "private-secret", ZAI_API_KEY: "other-secret" },
    undefined,
    store,
  );
  const radius = models.getProvider("radius");
  const zai = models.getProvider("zai");
  assert(radius && zai);
  let requests = 0;
  models.setProvider(
    createProvider({
      id: "radius",
      name: "Radius",
      models: [],
      auth: radius.auth,
      api: radius,
      async fetchModels() {
        requests++;
        throw new Error("private-secret upstream failure");
      },
    }),
  );
  models.setProvider({
    ...zai,
    async refreshModels() {
      assert.fail("Unselected provider must never refresh, even offline");
    },
  });
  await prepareProviderModels(models, "radius", { modelIds: ["cached/main"] });
  assert.equal(requests, 0);
  await prepareProviderModels(models, "radius", {
    modelIds: ["cached/main"],
    refresh: true,
  });
  assert.equal(requests, 1);
  assert(models.getModel("radius", "cached/main"));
  await assert.rejects(
    prepareProviderModels(models, "radius", { modelIds: ["missing"] }),
    (error: Error) => {
      assert(!error.message.includes("private-secret"));
      assert.equal(error.cause, undefined);
      return /catalog.*credentials and network/.test(error.message);
    },
  );
  assert.equal((await store.read("radius"))?.models[0]?.id, "cached/main");
  await assert.rejects(
    prepareProviderModels(models, "unknown-provider"),
    /Unknown model provider/,
  );
});

test("native refresh supersession/cancellation cannot publish late models over a newer cache", async (t) => {
  const directory = await home(t);
  const store = createModelsStore(directory);
  const models = createNativeModels(
    { RADIUS_API_KEY: "offline" },
    undefined,
    store,
  );
  const native = models.getProvider("radius");
  assert(native);
  const started = deferred();
  const release = deferred();
  const finished = deferred();
  let calls = 0;
  let latePublication: boolean | undefined;
  models.setProvider({
    ...native,
    async refreshModels(ctx) {
      if (!ctx.allowNetwork) return;
      if (++calls === 1) {
        started.resolve();
        await release.promise; // Intentionally uncooperative provider to exercise native generation guards.
        try {
          latePublication = await ctx.publish({
            persist: { models: [sample("late")] },
          });
        } catch {
          assert(ctx.signal.aborted);
          latePublication = false;
        } finally {
          finished.resolve();
        }
      } else {
        await ctx.publish({ persist: { models: [sample("newest")] } });
      }
    },
  });
  const abort = new AbortController();
  const first = models.refresh({ providers: ["radius"], signal: abort.signal });
  await started.promise;
  abort.abort();
  assert.equal((await first).aborted, true);
  const second = await models.refresh({ providers: ["radius"] });
  assert.equal(second.errors.size, 0);
  release.resolve();
  await finished.promise;
  assert.equal(latePublication, false);
  assert.equal(
    (await createModelsStore(directory).read("radius"))?.models[0]?.id,
    "newest",
  );
  assert.deepEqual(await readdir(join(directory, "models")), ["radius.json"]);
});

test("cache input validation, cancellation and path checks fail closed without content-bearing errors", async (t) => {
  const directory = await home(t);
  const store = createModelsStore(directory);
  await store.write("radius", { models: [sample()] });
  const path = join(directory, "models", "radius.json");
  const before = await readFile(path, "utf8");
  const abort = new AbortController();
  abort.abort(new Error("cancelled cache mutation"));
  await assert.rejects(
    store.write("radius", { models: [] }, { signal: abort.signal }),
    /cancelled cache mutation/,
  );
  await assert.rejects(
    store.delete("radius", { signal: abort.signal }),
    /cancelled cache mutation/,
  );
  assert.equal(await readFile(path, "utf8"), before);
  await assert.rejects(
    store.read("../credentials"),
    /Invalid model catalog provider ID/,
  );
  for (const value of [
    "{private-secret",
    JSON.stringify({ models: [{ ...sample(), provider: "openai" }] }),
    JSON.stringify({ models: [{}] }),
  ]) {
    await writeFile(path, value);
    await assert.rejects(
      store.read("radius"),
      (error: Error) =>
        !error.message.includes("private-secret") &&
        /Invalid/.test(error.message),
    );
    assert.equal(await readFile(path, "utf8"), value);
  }
});
