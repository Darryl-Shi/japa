# japa Milestone 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running `japa daemon` that boots from contracts and extensions, owns one durable CoS thread, and lets the user chat with it through `japa chat`.

**Architecture:** One npm package run directly on Node 24 (type stripping, no build). A small kernel (`src/kernel/`) defines the seven core contracts, loads extensions from `extensions/` and `~/.japa/extensions/`, selects boot adapters (storage, secrets), opens a Pi Durable harness, activates runtime contributions, and ensures the root conversation. Every default — SQLite storage, file secrets, local environment, model providers, the gateway surface and TUI — is an extension.

**Tech Stack:** TypeScript on Node 24, `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord`, `@earendil-works/pi-tui`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-japa-design.md` (this plan covers §2–§5, the four boot/runtime default extensions, `gateway`, and the `daemon`/`chat`/`status` CLI; later milestones cover the rest).

**Roadmap (later plans):** M2 jobs and worker profiles · M3 context lifecycle and memory · M4 skills, self-model, settings tools, changes log, secret requests · M5 self-extension and safety net · M6 `schedule`, `web`, default content. Deferred from spec §5 to later milestones: the CoS tool-result cap (M3), live settings getters (M4), hot reload (M5).

## Global Constraints

- Node ≥ 24, ESM (`"type": "module"`), no build step: code must be **erasable TypeScript** (no enums, namespaces, parameter properties) and relative imports use the `.ts` extension.
- Dependencies: `@earendil-works/pi-durable@^1.0.4`, `@earendil-works/pi-ai@^1.0.4`, `@earendil-works/chord@^1.0.4`, `@earendil-works/pi-tui@^1.0.4`. Dev: `typescript`, `vitest`, `@types/node`. Nothing else.
- Every async Pi Durable call takes a Chord `Context`; use `BACKGROUND_CONTEXT` from `@earendil-works/chord/context`.
- Home directory: `process.env.JAPA_HOME ?? ~/.japa`. Files: `settings.json`, `state.db`, `secrets/` (dir mode 700, files mode 600), `japa.sock`, `daemon.lock`, `extensions/`, `node_modules/japa` (symlink).
- Code principles (spec §1): simple, minimal, readable; small single-purpose files; plain functions and data; no abstraction without a second real use; lean on Pi Durable; few dependencies.
- Tests never touch the network: models come from pi-ai's `fauxProvider`.

## Review Focus

1. **No or unknown CoS model** — boot fails with one clear sentence naming `models.cos` and the settings path, not a stack trace. Test in Task 7.
2. **Second daemon / stale lock** — starting a daemon while one runs fails with "already running"; a lock left by a crashed process is taken over. Test in Task 2.
3. **Broken extension** — a workspace extension that throws on import or has an invalid manifest is skipped and reported in status; everything else boots. Tests in Tasks 4 and 8.
4. **Bad client input** — a malformed line or a client disconnecting mid-stream never affects the daemon or other clients. Test in Task 9.
5. **Restart** — after a daemon restart on SQLite the same thread and its history are there. Test in Task 7.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts
src/sdk.ts                       re-exports for extension authors ("japa/sdk")
src/kernel/settings.ts           japaHome(), Settings, loadSettings()
src/kernel/lock.ts               acquireLock()
src/kernel/contracts.ts          contribution types, Contract, CORE_CONTRACTS
src/kernel/extension.ts          JapaExtension, defineJapaExtension(), validateExtension()
src/kernel/loader.ts             discoverExtensions(), loadExtensions(), linkSdk()
src/kernel/env.ts                readOnly(), createEnvDispatcher()
src/kernel/identity.md           CoS identity text (minimal in M1)
src/kernel/cos.ts                cosExtension(), ensureRoot()
src/kernel/boot.ts               boot() -> Daemon
src/cli/main.ts                  japa daemon | chat | status
extensions/sqlite/index.ts       storage adapter "sqlite"
extensions/file-secrets/index.ts secrets adapter "file"
extensions/local-env/index.ts    environment "local"
extensions/providers/index.ts    pi-ai built-in providers
extensions/gateway/index.ts      surface "gateway" (socket server)
extensions/gateway/protocol.ts   message types, NDJSON helpers
extensions/gateway/client.ts     connect()
extensions/gateway/transcript.ts pure transcript model for the TUI
extensions/gateway/chat.ts       runChat() TUI
test/helpers.ts                  tempHome(), testKit()
test/*.test.ts
```

---

### Task 1: Project scaffold and API smoke test

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/sdk.ts`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Produces: `npm test` and `npm run typecheck` work; `src/sdk.ts` re-exports `defineTool`, `defineExtension`, `section`, `hook`, `wrapTool`, `defineDoc`, `defineTask` from `@earendil-works/pi-durable`, `Type` from `@earendil-works/pi-ai`, and (from Task 3) `defineJapaExtension` and the contract types.

- [ ] **Step 1: Create `package.json`**

`name: "japa"`, `private: true`, `type: "module"`, `engines.node: ">=24"`, `bin.japa: "./src/cli/main.ts"`, `exports: { "./sdk": "./src/sdk.ts" }`, scripts `test: "vitest --run"`, `typecheck: "tsc --noEmit"`. Install the Global Constraints dependencies with `npm install`.

- [ ] **Step 2: Create `tsconfig.json` and `vitest.config.ts`**

tsconfig: `target es2024`, `module/moduleResolution nodenext`, `strict`, `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `skipLibCheck`, `types: ["node"]`, include `src`, `extensions`, `test`. vitest: `test.include: ["test/**/*.test.ts"]`, `testTimeout: 20000`.

- [ ] **Step 3: Write the smoke test**

```ts
// test/smoke.test.ts
test("pi-durable answers with the faux provider", async () => {
  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText("Paris")])]);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: faux.getModel().id } } });
  const settled = await (await root.submit({ type: "input", content: "Capital of France?" }, ctx)).wait(ctx);
  expect(settled.status).toBe("done");
  await harness.close(ctx);
});
```

- [ ] **Step 4: Run** `npm test` → PASS; `npm run typecheck` → no errors.
- [ ] **Step 5: Commit** `chore: scaffold japa package`

---

### Task 2: Settings and the daemon lock

**Files:**
- Create: `src/kernel/settings.ts`, `src/kernel/lock.ts`, `test/helpers.ts`
- Test: `test/settings.test.ts`, `test/lock.test.ts`

**Interfaces:**
- Produces:
  - `japaHome(): string`
  - `type Settings = { models: { cos?: ModelRef }; storage: { adapter: string } & JsonObject; secrets: { adapter: string } & JsonObject; extensions: Record<string, JsonObject> }`
  - `DEFAULT_SETTINGS: Settings` — `{ models: {}, storage: { adapter: "sqlite" }, secrets: { adapter: "file" }, extensions: {} }`
  - `loadSettings(home: string): Settings` — missing file → defaults; present → shallow-merged over defaults per top-level key; invalid JSON → `Error("Invalid <path>: <parse message>")`.
  - `acquireLock(home: string): () => void` — returns a release function; throws `Error("japa daemon is already running (pid <pid>)")` if the lock's pid is alive.
  - `tempHome(settings?: object): string` in `test/helpers.ts` — `mkdtemp` dir, writes `settings.json` when given.

- [ ] **Step 1: Write failing tests**

```ts
test("defaults when settings.json is missing", () => {
  expect(loadSettings(tempHome())).toEqual(DEFAULT_SETTINGS);
});
test("merges user settings over defaults", () => {
  const s = loadSettings(tempHome({ models: { cos: { provider: "p", modelId: "m" } } }));
  expect(s.models.cos).toEqual({ provider: "p", modelId: "m" });
  expect(s.storage.adapter).toBe("sqlite");
});
test("invalid JSON names the file", () => {
  const home = tempHome(); writeFileSync(join(home, "settings.json"), "{nope");
  expect(() => loadSettings(home)).toThrow(/Invalid .*settings\.json/);
});
test("second lock while held fails", () => {
  const home = tempHome(); const release = acquireLock(home);
  expect(() => acquireLock(home)).toThrow(/already running/);
  release();
  acquireLock(home)();
});
test("stale lock from a dead pid is taken over", () => {
  const home = tempHome(); writeFileSync(join(home, "daemon.lock"), "999999999");
  expect(() => acquireLock(home)()).not.toThrow();
});
```

- [ ] **Step 2: Run** `npx vitest --run test/settings.test.ts test/lock.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement** `settings.ts` and `lock.ts`. Lock: `openSync(path, "wx")` writing `process.pid`; on `EEXIST` read the pid, `process.kill(pid, 0)` to test liveness; dead → overwrite. Release unlinks only if the file still holds our pid.
- [ ] **Step 4: Run** the tests → PASS.
- [ ] **Step 5: Commit** `feat(kernel): settings and daemon lock`

---

### Task 3: Contracts and the extension manifest

**Files:**
- Create: `src/kernel/contracts.ts`, `src/kernel/extension.ts`; modify `src/sdk.ts` (export both)
- Test: `test/extension.test.ts`

**Interfaces:**
- Produces (`contracts.ts`):

```ts
type Dispose = () => void | Promise<void>;
type BootContext = { home: string };
type StorageAdapter = { name: string; open(config: JsonObject, ctx: BootContext): Promise<Storage> };
type SecretsStore = { get(name: string): Promise<string | undefined>; set(name: string, value: string): Promise<void>; delete(name: string): Promise<void>; list(): Promise<string[]> };
type SecretsAdapter = { name: string; open(config: JsonObject, ctx: BootContext): Promise<SecretsStore> };
type EnvironmentAdapter = { name: string; create(input: { conversationId: string; cwd?: string }): ExecutionEnv };
type Status = { model?: ModelRef; extensions: { name: string; summary: string; provides: string[] }[]; errors: { name: string; error: string }[] };
type SurfaceContext = {
  home: string;
  root: {
    submit(text: string, mode?: "steer" | "followUp"): Promise<void>;
    abort(): Promise<void>;
    events(listener: (events: readonly AgentEvent[]) => void): Promise<{ snapshot: SnapshotEvent; stop(): Promise<void> }>;
  };
  status(): Status;
};
type Surface = { name: string; start(ctx: SurfaceContext): Promise<Dispose> };
type TriggerContext = { home: string; emit(event: { key: string; text: string }): Promise<void> };
type Trigger = { name: string; start(ctx: TriggerContext): Promise<Dispose> };
type KernelContext = { home: string; extension: string; models: Models; environments: Map<string, EnvironmentAdapter>; surface: SurfaceContext; trigger: TriggerContext };
type Contract<C = unknown> = {
  name: string;
  docs: string;                                   // one paragraph, agent-facing
  phase: "boot" | "runtime";
  cardinality: "one" | "many";
  validate(c: unknown): string | undefined;       // error message, or undefined if valid
  activate?(c: C, ctx: KernelContext): Promise<Dispose>;
};
const CORE_CONTRACTS: Contract[];  // provider, surface, trigger, tool, environment, storage, secrets
const ACTIVATION_ORDER = ["provider", "environment", "tool", /* extension-defined */ "trigger", "surface"];
```

  Activation per core contract: `provider` → `models.setProvider(c)`, dispose `models.deleteProvider(c.id)`; `environment` → add to `environments` by name, dispose removes; `surface` → `c.start(ctx.surface)`; `trigger` → `c.start(ctx.trigger)`; `tool`, `storage`, `secrets` have no `activate` (tools are installed with the extension's Pi Durable extension, Task 8; boot adapters are used directly, Task 7). Validators check the contribution is an object with the fields its type requires (`name` string, required functions present; `tool` also `description` and `parameters`; `provider` an object with `id` string).

- Produces (`extension.ts`):

```ts
type JapaExtension = {
  name: string;                 // kebab-case, equals its directory name
  summary: string;
  examples?: string[];
  docs?: string;
  provides?: Record<string, unknown[]>;          // keyed by contract name
  contracts?: Contract[];                        // contracts this extension defines
  durable?: { sections?: PromptSection[]; hooks?: HookRegistration[]; wraps?: Wrap[]; tasks?: AnyTask[] };
  secrets?: string[];
};
function defineJapaExtension(e: JapaExtension): JapaExtension;   // identity, for types
function validateExtension(e: JapaExtension, contracts: ReadonlyMap<string, Contract>): string[];  // [] when valid
```

- [ ] **Step 1: Write failing tests**

```ts
const contracts = new Map(CORE_CONTRACTS.map((c) => [c.name, c]));
const tool = defineTool({ name: "t", description: "d", parameters: Type.Object({}), execute: async () => ({}) });
test("a minimal extension is valid", () => {
  expect(validateExtension({ name: "x", summary: "Does x" }, contracts)).toEqual([]);
});
test("summary is required", () => {
  expect(validateExtension({ name: "x", summary: "" }, contracts)).toContain("summary is required");
});
test("tools require examples and docs", () => {
  const errors = validateExtension({ name: "x", summary: "s", provides: { tool: [tool] } }, contracts);
  expect(errors).toEqual(expect.arrayContaining(["examples are required when providing tools", "docs are required when providing tools"]));
});
test("unknown contract is rejected", () => {
  expect(validateExtension({ name: "x", summary: "s", provides: { nope: [{}] } }, contracts)).toContain('unknown contract "nope"');
});
test("invalid contribution reports contract and index", () => {
  expect(validateExtension({ name: "x", summary: "s", provides: { surface: [{}] } }, contracts)[0]).toMatch(/^surface\[0\]: /);
});
test("all seven core contracts exist", () => {
  expect([...contracts.keys()].sort()).toEqual(["environment", "provider", "secrets", "storage", "surface", "tool", "trigger"]);
});
```

- [ ] **Step 2: Run** `npx vitest --run test/extension.test.ts` → FAIL.
- [ ] **Step 3: Implement** `contracts.ts` and `extension.ts` with the exact error strings above; also reject names not matching `/^[a-z][a-z0-9-]*$/` with `"name must be kebab-case"`.
- [ ] **Step 4: Run** → PASS; `npm run typecheck` → clean.
- [ ] **Step 5: Commit** `feat(kernel): contracts and extension manifest`

---

### Task 4: Extension loader

**Files:**
- Create: `src/kernel/loader.ts`
- Test: `test/loader.test.ts`

**Interfaces:**
- Consumes: `JapaExtension`, `validateExtension`, `Contract` (Task 3).
- Produces:
  - `discoverExtensions(dirs: string[]): { name: string; file: string }[]` — each `<dir>/<name>/index.ts`; a later dir overrides an earlier one by name; result sorted by name.
  - `loadExtensions(found: { name: string; file: string }[], contracts: ReadonlyMap<string, Contract>, version?: string): Promise<{ extensions: JapaExtension[]; errors: { name: string; error: string }[] }>` — imports each (`import(pathToFileURL(file).href + (version ? "?v=" + version : ""))`), requires a default export whose `name` equals the directory name (`"manifest name must match directory"`), validates against `contracts` **plus contracts defined by any loaded extension**, and moves failures (import throw, validation errors joined with `"; "`) to `errors`.
  - `linkSdk(home: string, packageRoot: string): void` — ensures `<home>/node_modules/japa` is a symlink to `packageRoot`.

- [ ] **Step 1: Write failing tests** (write fixture extensions into temp dirs; fixtures import from the repo's `src/sdk.ts` by absolute path)

```ts
test("workspace extension overrides packaged one by name", () => {
  // packaged/a, packaged/b, workspace/a
  expect(discoverExtensions([packaged, workspace])).toEqual([
    { name: "a", file: join(workspace, "a/index.ts") }, { name: "b", file: join(packaged, "b/index.ts") }]);
});
test("broken extensions are reported, valid ones load", async () => {
  // good/: valid; throws/: `throw new Error("boom")` at top level; invalid/: summary ""
  const { extensions, errors } = await loadExtensions(discoverExtensions([dir]), contracts);
  expect(extensions.map((e) => e.name)).toEqual(["good"]);
  expect(errors.map((e) => e.name).sort()).toEqual(["invalid", "throws"]);
  expect(errors.find((e) => e.name === "throws")!.error).toMatch(/boom/);
});
test("an extension may contribute to a contract another extension defines", async () => {
  // defines/: contracts: [{ name: "search-engine", ... }]; uses/: provides: { "search-engine": [{ name: "e" }] }
  expect((await loadExtensions(discoverExtensions([dir]), contracts)).errors).toEqual([]);
});
test("linkSdk creates the japa symlink", () => {
  linkSdk(home, repoRoot);
  expect(realpathSync(join(home, "node_modules/japa"))).toBe(realpathSync(repoRoot));
});
```

- [ ] **Step 2: Run** `npx vitest --run test/loader.test.ts` → FAIL.
- [ ] **Step 3: Implement** `loader.ts`. Two passes in `loadExtensions`: import all, then validate with the merged contract map.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(kernel): extension loader`

---

### Task 5: Boot adapters — `sqlite` and `file-secrets`

**Files:**
- Create: `extensions/sqlite/index.ts`, `extensions/file-secrets/index.ts`
- Test: `test/boot-adapters.test.ts`

**Interfaces:**
- Consumes: `defineJapaExtension`, `StorageAdapter`, `SecretsAdapter` from `japa/sdk`-equivalent relative import `../../src/sdk.ts`.
- Produces:
  - extension `sqlite`: `provides.storage = [{ name: "sqlite", open(config, { home }) }]` → `openNodeSqliteStorage(config.file ?? join(home, "state.db"))`.
  - extension `file-secrets`: `provides.secrets = [{ name: "file", open(config, { home }) }]` → a `SecretsStore` over `config.dir ?? join(home, "secrets")`; dir created with mode 700, each secret one file with mode 600; names must match `/^[a-zA-Z0-9._-]+$/` (else throw `Error("Invalid secret name")`).

- [ ] **Step 1: Write failing tests**

```ts
test("file secrets round-trip with private permissions", async () => {
  const store = await fileSecrets.provides!.secrets![0].open({}, { home });
  await store.set("openai.apiKey", "sk-1");
  expect(await store.get("openai.apiKey")).toBe("sk-1");
  expect(await store.list()).toEqual(["openai.apiKey"]);
  expect(statSync(join(home, "secrets/openai.apiKey")).mode & 0o777).toBe(0o600);
  await store.delete("openai.apiKey");
  expect(await store.get("openai.apiKey")).toBeUndefined();
});
test("secret names cannot escape the directory", async () => {
  const store = await fileSecrets.provides!.secrets![0].open({}, { home });
  await expect(store.set("../x", "v")).rejects.toThrow(/Invalid secret name/);
});
test("sqlite storage opens at <home>/state.db", async () => {
  const storage = await sqlite.provides!.storage![0].open({}, { home });
  const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, ctx);
  await harness.close(ctx);
  expect(existsSync(join(home, "state.db"))).toBe(true);
});
```

(Type the `provides` lookups with a small cast helper in the test; the manifest type is deliberately loose.)

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(extensions): sqlite storage and file secrets`

---

### Task 6: Environments — `local-env` and the read-only CoS wrapper

**Files:**
- Create: `extensions/local-env/index.ts`, `src/kernel/env.ts`
- Test: `test/env.test.ts`

**Interfaces:**
- Produces:
  - extension `local-env`: `provides.environment = [{ name: "local", create: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? homedir() }) }]`.
  - `readOnly(env: ExecutionEnv): ExecutionEnv` — a `Proxy` that returns, for `writeFile`, `appendFile`, `truncateFile`, `renameFile`, `createDir`, `remove`, `createTempDir`, `createTempFile`: `err(new FileError("permission_denied", READ_ONLY_MESSAGE, path))`; for `exec`: `err(new ExecutionError("unknown", READ_ONLY_MESSAGE))`; everything else bound to the original.
  - `READ_ONLY_MESSAGE = "Read-only here: delegate changes and commands to a job."`
  - `createEnvDispatcher(environments: ReadonlyMap<string, EnvironmentAdapter>, defaultName = "local"): NonNullable<HarnessOptions["env"]>` — builds the default environment for the target; wraps it with `readOnly` when `target.conversationId === ROOT_CONVERSATION_ID`; throws `Error('No environment "<name>" is installed')` if missing. (M2 adds per-profile environments for jobs.)

- [ ] **Step 1: Write failing tests**

```ts
test("read-only env reads but cannot write or exec", async () => {
  writeFileSync(join(dir, "a.txt"), "hi");
  const env = readOnly(new NodeExecutionEnv({ cwd: dir }));
  expect(getOrThrow(await env.readTextFile(join(dir, "a.txt"), ctx))).toBe("hi");
  const w = await env.writeFile(join(dir, "b.txt"), "x", ctx);
  expect(w.ok).toBe(false);
  expect(existsSync(join(dir, "b.txt"))).toBe(false);
  expect((await env.exec("echo hi", undefined, ctx)).ok).toBe(false);
});
test("dispatcher wraps the root conversation only", async () => {
  const dispatch = createEnvDispatcher(new Map([["local", localAdapter]]));
  const rootEnv = await dispatch({ conversationId: ROOT_CONVERSATION_ID, cwd: dir, read } as EnvTarget, ctx);
  const otherEnv = await dispatch({ conversationId: "other" as ConversationId, cwd: dir, read } as EnvTarget, ctx);
  expect((await rootEnv!.writeFile(join(dir, "c.txt"), "x", ctx)).ok).toBe(false);
  expect((await otherEnv!.writeFile(join(dir, "c.txt"), "x", ctx)).ok).toBe(true);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(kernel): environments and read-only CoS env`

---

### Task 7: Boot — providers, root conversation, persistence

**Files:**
- Create: `extensions/providers/index.ts`, `src/kernel/identity.md`, `src/kernel/cos.ts`, `src/kernel/boot.ts`; extend `test/helpers.ts`
- Test: `test/boot.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  - extension `providers`: `provides.provider = builtinProviders()` (from `@earendil-works/pi-ai/providers/all`; keys from env vars in M1, secrets-backed credentials arrive in M4).
  - `identity.md` (M1 text, expanded in M4):
    ```
    You are the user's chief of staff. You are their single point of contact.
    Be concise and direct. Do quick things yourself. You cannot change files or run commands here.
    ```
  - `cosExtension(): Extension` — Pi Durable extension `"japa-cos"`: `sections: [section("identity", () => identityText, { tag: false })]`, `tools: [createReadTool()]`.
  - `ensureRoot(harness: Harness, model: ModelRef, context: Context): Promise<Conversation>` — `harness.root(context, { agent: { model } })`, then `root.configure({ model }, context)` so a changed setting applies.
  - `type BootOptions = { home: string; extensionDirs?: string[]; extensions?: JapaExtension[] }` — `extensionDirs` defaults to `[<packageRoot>/extensions, <home>/extensions]`; `extensions` are added after discovered ones, overriding by name (used by tests).
  - `type Daemon = { harness: Harness; root: Conversation; status(): Status; close(): Promise<void> }`
  - `boot(options: BootOptions): Promise<Daemon>` — steps 1–4 and 6 of spec §5.2 in this task (runtime activation in Task 8): acquire lock → `loadSettings` → `linkSdk` → discover + load extensions → open selected secrets adapter, then storage adapter → `createModels()`, register providers → resolve `models.cos` → `Harness.open(storage, { models, registry, env: createEnvDispatcher(...) })` → install `cosExtension()` → `ensureRoot` → `harness.resume()`.
  - Errors (exact): `Set models.cos in <home>/settings.json, for example {"models":{"cos":{"provider":"anthropic","modelId":"<model>"}}}`; `Unknown model <provider>/<modelId>`; `No storage adapter "<name>" is installed`; `No secrets adapter "<name>" is installed`. Boot releases the lock when it fails.
  - `test/helpers.ts`: `testKit(): { faux: FauxProvider; extension: JapaExtension; model: ModelRef }` — extension `"test-kit"` providing `storage: [{ name: "memory", open: async () => new MemoryStorage() }]` and `provider: [faux.provider]`; `bootTest(settings?: object, extra?: JapaExtension[]): Promise<{ daemon: Daemon; faux: FauxProvider; home: string }>` — temp home with `storage.adapter: "memory"` and `models.cos` set to the faux model, `extensionDirs: [<repo>/extensions]`.

- [ ] **Step 1: Write failing tests**

```ts
test("the CoS answers in the root conversation", async () => {
  const { daemon, faux } = await bootTest();
  faux.setResponses([fauxAssistantMessage([fauxText("Hello!")])]);
  const settled = await (await daemon.root.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
  expect(settled.status).toBe("done");
  await daemon.close();
});
test("the identity section reaches the model", async () => {
  const { daemon, faux } = await bootTest();
  let systemPrompt = "";
  faux.setResponses([(context) => { systemPrompt = context.systemPrompt ?? ""; return fauxAssistantMessage([fauxText("ok")]); }]);
  await (await daemon.root.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
  expect(systemPrompt).toContain("chief of staff");
  await daemon.close();
});
test("missing models.cos is one clear error", async () => {
  await expect(boot({ home: tempHome({}) })).rejects.toThrow(/^Set models\.cos in .*settings\.json/);
});
test("unknown model is one clear error", async () => {
  await expect(bootTest({ models: { cos: { provider: "faux", modelId: "nope" } } })).rejects.toThrow("Unknown model faux/nope");
});
test("history survives a restart on sqlite", async () => {
  const kit = testKit();
  const home = tempHome({ models: { cos: kit.model } });            // default storage: sqlite
  let d = await boot({ home, extensions: [kit.extension] });
  kit.faux.setResponses([fauxAssistantMessage([fauxText("first")])]);
  await (await d.root.submit({ type: "input", content: "remember me" }, ctx)).wait(ctx);
  await d.close();
  d = await boot({ home, extensions: [kit.extension] });
  const page = await d.root.entries({}, 100, undefined, ctx);
  expect(JSON.stringify(page.items)).toContain("remember me");
  await d.close();
});
```

- [ ] **Step 2: Run** `npx vitest --run test/boot.test.ts` → FAIL.
- [ ] **Step 3: Implement** `providers`, `identity.md`, `cos.ts`, `boot.ts`. Read `identity.md` with `readFileSync(new URL("./identity.md", import.meta.url))`.
- [ ] **Step 4: Run** → PASS; full `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(kernel): boot the CoS from contracts`

---

### Task 8: Runtime activation — tools, triggers, surfaces, extension-defined contracts

**Files:**
- Modify: `src/kernel/boot.ts`
- Test: `test/activation.test.ts`

**Interfaces:**
- Consumes: `ACTIVATION_ORDER`, `Contract.activate`, `KernelContext` (Task 3); `Daemon` (Task 7).
- Produces (inside `boot`, step 5 of spec §5.2, after `Harness.open` and before `ensureRoot` returns the daemon):
  - For each extension with `provides.tool` or `durable`: `registry.install(defineExtension({ name: ext.name, tools, ...durable }))`.
  - For each contract name in `ACTIVATION_ORDER` (extension-defined contracts in load order at the marked position), each contribution, call `contract.activate` with a `KernelContext` whose `extension` is the contributing extension. A throw is caught and recorded in `status().errors` as `{ name: <extension>, error: "<contract>: <message>" }`; boot continues.
  - `SurfaceContext.root.submit(text, mode)` → `root.submit({ type: "input", content: text, whenBusy: mode ?? "followUp" })`; `abort()` → `root.abort(ctx)`; `events(listener)` → `watchEvents(harness, ROOT_CONVERSATION_ID, ctx)`, `start` forwarding batches to `listener`, returns `{ snapshot, stop }`.
  - `TriggerContext.emit({ key, text })` → `root.submit({ type: "input", content: "[" + extension + "] " + text, requestId: "trigger:" + extension + ":" + key })`.
  - `status()` → `{ model, extensions: [{ name, summary, provides: Object.keys(provides ?? {}) }], errors }` including loader errors.
  - `close()` disposes activations in reverse order, closes the harness, releases the lock.

- [ ] **Step 1: Write failing tests**

```ts
test("an extension tool is offered to the CoS", async () => {
  const echo = defineTool({ name: "echo", description: "Echo", parameters: Type.Object({ text: Type.String() }),
    execute: async (a) => ({ content: [{ type: "text", text: a.text }] }) });
  const ext = defineJapaExtension({ name: "echo", summary: "Echoes", examples: ["echo hi"], docs: "Echo text.", provides: { tool: [echo] } });
  const { daemon, faux } = await bootTest({}, [ext]);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("echo", { text: "pong" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  await (await daemon.root.submit({ type: "input", content: "echo pong" }, ctx)).wait(ctx);
  const page = await daemon.root.entries({}, 100, undefined, ctx);
  expect(JSON.stringify(page.items)).toContain("pong");
  await daemon.close();
});
test("trigger events are delivered once per key", async () => {
  let emit!: TriggerContext["emit"];
  const ext = defineJapaExtension({ name: "tick", summary: "Ticks", provides: { trigger: [{ name: "tick", start: async (c) => { emit = c.emit; return () => {}; } }] } });
  const { daemon, faux } = await bootTest({}, [ext]);
  faux.setResponses([fauxAssistantMessage([fauxText("noted")])]);
  await emit({ key: "k1", text: "wake up" });
  await emit({ key: "k1", text: "wake up" });
  await daemon.root.waitForIdle(ctx);
  const page = await daemon.root.entries({}, 100, undefined, ctx);
  expect(JSON.stringify(page.items).match(/\[tick\] wake up/g)).toHaveLength(1);
  await daemon.close();
});
test("a failing surface is reported and boot continues", async () => {
  const ext = defineJapaExtension({ name: "bad-ui", summary: "Breaks", provides: { surface: [{ name: "bad", start: async () => { throw new Error("no tty"); } }] } });
  const { daemon } = await bootTest({}, [ext]);
  expect(daemon.status().errors).toContainEqual({ name: "bad-ui", error: "surface: no tty" });
  await daemon.close();
});
test("extension-defined contracts activate between tools and triggers", async () => {
  const order: string[] = [];
  const probe: Contract = { name: "probe", docs: "Test seam.", phase: "runtime", cardinality: "many",
    validate: () => undefined, activate: async () => { order.push("probe"); return () => {}; } };
  const ext = defineJapaExtension({ name: "recorder", summary: "Records", contracts: [probe], provides: {
    probe: [{}],
    trigger: [{ name: "t", start: async () => { order.push("trigger"); return () => {}; } }],
    surface: [{ name: "s", start: async () => { order.push("surface"); return () => {}; } }],
  } });
  const { daemon } = await bootTest({}, [ext]);
  expect(order).toEqual(["probe", "trigger", "surface"]);
  await daemon.close();
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(kernel): activate runtime contracts`

---

### Task 9: The `gateway` surface and protocol

**Files:**
- Create: `extensions/gateway/protocol.ts`, `extensions/gateway/client.ts`, `extensions/gateway/index.ts`
- Test: `test/gateway.test.ts`

**Interfaces:**
- Consumes: `Surface`, `SurfaceContext`, `Status` (Task 3).
- Produces:
  - `protocol.ts`:
    ```ts
    type ClientMessage = { type: "attach" } | { type: "submit"; text: string; mode?: "steer" | "followUp" } | { type: "abort" } | { type: "status" };
    type ServerMessage = { type: "snapshot"; snapshot: SnapshotEvent } | { type: "events"; events: AgentEvent[] } | { type: "status"; status: Status } | { type: "error"; message: string };
    function socketPath(home: string): string;            // join(home, "japa.sock")
    function writeMessage(socket: Socket, message: ClientMessage | ServerMessage): void;   // JSON + "\n"
    function readMessages(socket: Socket, onMessage: (m: unknown) => void): void;         // splits on "\n", buffers partial lines, ignores empty lines, passes JSON.parse failures as undefined
    ```
  - extension `gateway`: `summary: "Lets you chat with japa from the terminal (japa chat)"`, `provides.surface = [{ name: "gateway", start }]`. `start(ctx)`: if `socketPath` exists, try to connect — success → throw `Error("Another japa daemon owns <path>")`, failure → unlink the stale file; `net.createServer` listening on the socket. Per connection: `attach` → `ctx.root.events(...)` sending `snapshot` then each batch as `events`; `submit` → `ctx.root.submit`; `abort` → `ctx.root.abort`; `status` → `status` reply; unparseable or unknown message → `error` reply `"Invalid message"`. On socket close/error → stop that connection's event stream. Dispose: close server, destroy sockets, unlink socket.
  - `client.ts`: `connect(home: string): Promise<{ send(m: ClientMessage): void; onMessage(cb: (m: ServerMessage) => void): void; close(): void }>` — rejects with `Error("japa is not running. Start it with: japa daemon")` on `ENOENT`/`ECONNREFUSED`.

- [ ] **Step 1: Write failing tests** (boot with `bootTest({}, [])` using the real `gateway` from `extensions/`)

```ts
test("attach, submit, and receive the answer", async () => {
  const { daemon, faux, home } = await bootTest();
  faux.setResponses([fauxAssistantMessage([fauxText("Hi there")])]);
  const client = await connect(home);
  const seen: ServerMessage[] = [];
  client.onMessage((m) => seen.push(m));
  client.send({ type: "attach" });
  client.send({ type: "submit", text: "hello" });
  await vi.waitFor(() => expect(JSON.stringify(seen)).toContain("Hi there"));
  expect(seen[0].type).toBe("snapshot");
  client.close(); await daemon.close();
});
test("malformed lines and abrupt disconnects do not affect other clients", async () => {
  const { daemon, home } = await bootTest();
  const raw = createConnection(socketPath(home)); raw.write("{not json\n"); raw.destroy();
  const client = await connect(home); const seen: ServerMessage[] = [];
  client.onMessage((m) => seen.push(m)); client.send({ type: "status" });
  await vi.waitFor(() => expect(seen.some((m) => m.type === "status")).toBe(true));
  client.close(); await daemon.close();
});
test("status lists extensions and errors", async () => {
  const { daemon, home } = await bootTest();
  const client = await connect(home); const seen: ServerMessage[] = [];
  client.onMessage((m) => seen.push(m)); client.send({ type: "status" });
  await vi.waitFor(() => expect(seen.find((m) => m.type === "status")).toBeTruthy());
  const status = (seen.find((m) => m.type === "status") as { status: Status }).status;
  expect(status.extensions.map((e) => e.name)).toEqual(expect.arrayContaining(["gateway", "local-env", "providers", "test-kit"]));
  client.close(); await daemon.close();
});
test("connect fails clearly when the daemon is not running", async () => {
  await expect(connect(tempHome())).rejects.toThrow("japa is not running. Start it with: japa daemon");
});
test("a stale socket file is replaced", async () => {
  const kit = testKit(); const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  writeFileSync(socketPath(home), "");
  const daemon = await boot({ home, extensions: [kit.extension] });
  expect(daemon.status().errors).toEqual([]);
  await daemon.close();
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(gateway): socket surface and client`

---

### Task 10: `japa chat`, `japa daemon`, `japa status`

**Files:**
- Create: `extensions/gateway/transcript.ts`, `extensions/gateway/chat.ts`, `src/cli/main.ts`
- Test: `test/transcript.test.ts`

**Interfaces:**
- Consumes: `connect`, `ServerMessage` (Task 9); `boot`, `japaHome` (Tasks 2, 7).
- Produces:
  - `transcript.ts` (pure):
    ```ts
    type Line = { kind: "user" | "assistant" | "tool" | "info"; text: string };
    type Transcript = { lines: Line[]; streaming: string; busy: boolean };
    function fromSnapshot(snapshot: SnapshotEvent): Transcript;
    function applyEvents(t: Transcript, events: readonly AgentEvent[]): Transcript;   // returns a new value
    ```
    Lines come from each entry's `model` messages: `user` → text content; `assistant` → joined text blocks, plus one `tool` line `"⚙ <name>"` per tool call; `toolResult` → nothing. Events: `text_delta` appends to `streaming`; `message_end` appends the entry's lines and clears `streaming`; `entry_appended` appends lines for user entries; `run_start`/`run_end` set `busy`; `auto_retry_start` adds an `info` line `"retrying: <errorMessage>"`.
  - `chat.ts`: `runChat(home: string): Promise<void>` — pi-tui `TuiMainScreen`: a `Container` of transcript `Text`/`Markdown` lines, a status `Text` ("thinking…" while `busy`), an `Editor`; Enter submits (`followUp`, or `steer` while busy), Esc sends `abort`, Ctrl+C exits. Re-renders from `Transcript` on each message.
  - `main.ts` (shebang `#!/usr/bin/env node`): `japa daemon` → `boot({ home: japaHome() })`, print `"japa is running (<socket path>)"`, close on SIGINT/SIGTERM; `japa chat` → `runChat(japaHome())`; `japa status` → connect, send `status`, print model, extensions (`name — summary`), and errors, exit; unknown command → usage text, exit code 1. Errors print `error.message` only, exit code 1.

- [ ] **Step 1: Write the failing test** (drive a real daemon, feed gateway messages into the reducer)

```ts
test("transcript shows the exchange from real gateway events", async () => {
  const { daemon, faux, home } = await bootTest();
  faux.setResponses([fauxAssistantMessage([fauxText("Hi there")])]);
  const client = await connect(home);
  let t: Transcript | undefined;
  client.onMessage((m) => {
    if (m.type === "snapshot") t = fromSnapshot(m.snapshot);
    if (m.type === "events" && t) t = applyEvents(t, m.events);
  });
  client.send({ type: "attach" });
  await vi.waitFor(() => expect(t).toBeDefined());
  client.send({ type: "submit", text: "hello" });
  await vi.waitFor(() => expect(t!.lines).toEqual([{ kind: "user", text: "hello" }, { kind: "assistant", text: "Hi there" }]));
  expect(t!.busy).toBe(false);
  client.close(); await daemon.close();
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `transcript.ts`, `chat.ts`, `main.ts`. **Step 4: Run** → PASS; `npm test` and `npm run typecheck` → clean.
- [ ] **Step 5: Manual check**

```bash
export JAPA_HOME=$(mktemp -d)
echo '{"models":{"cos":{"provider":"anthropic","modelId":"<a model you have>"}}}' > $JAPA_HOME/settings.json
node src/cli/main.ts daemon &      # prints: japa is running (.../japa.sock)
node src/cli/main.ts status        # lists gateway, local-env, providers, sqlite, file-secrets
node src/cli/main.ts chat          # say hi, get an answer; Ctrl+C; reopen chat: history is there
node src/cli/main.ts daemon        # second daemon: "japa daemon is already running (pid …)"
```

- [ ] **Step 6: Commit** `feat: japa daemon, chat, and status`
