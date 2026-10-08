# Remove Extension-Defined Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the kernel's core contracts the only contracts: remove the manifest `contracts` field and everything that supports it, and make `web_search` call Brave directly.

**Architecture:** `web` stops defining and using `search-engine` first (it loads under either kernel). Then the kernel replaces its mutable contract map with one fixed `CONTRACTS` map, built from `CORE_CONTRACTS` and used by the loader, the runtime, boot and `japa check`; the extension-defined activation slot, reload bookkeeping and capabilities list go. Finally the agent-facing content and the main spec are brought in line.

**Tech Stack:** TypeScript on Node 24 (native type stripping), Pi Durable, vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-japa-remove-extension-contracts-design.md`

## Global Constraints

- Contracts are exactly `CORE_CONTRACTS` (provider, surface, trigger, tool, environment, storage, secrets); an extension cannot define new ones.
- A `provides` key that isn't a core contract fails the extension with the error `unknown contract "<name>"`.
- A manifest that still sets `contracts` has the field ignored (no special error).
- `japa/sdk` (`src/sdk.ts`) no longer exports `Contract` or `CORE_CONTRACTS`.
- `web` has no `settings` schema; its secret stays `web.brave.apiKey`; the missing-key reply text is unchanged.
- The escape hatch (`durable`) is unchanged.
- `npm test` and `npm run typecheck` pass after every task.

## Review Focus

- A workspace extension written for the old kernel (sets `contracts`, provides `search-engine`) must fail alone with `unknown contract "search-engine"`; every other extension still loads. → Task 2, loader test.
- A leftover `extensions.web.engine` in `settings.json` must not stop the daemon booting or `web` loading. → Task 1, test.
- Reloading `web` (install/rollback of any extension) must leave `web_search` working: no hidden module state left behind. → Task 1 keeps an install-then-search test.
- Activation order must still be provider → environment → tool → trigger → surface after the slot is removed. → Task 2, activation test.
- `japa check` of an extension must validate against the same core contracts as the daemon. → Task 2 (check.ts uses `CONTRACTS`; existing check tests).

---

### Task 1: `web_search` calls Brave directly

**Files:**
- Modify: `extensions/web/index.ts`
- Modify: `extensions/web/brave.ts` (doc comment only, if it mentions engines)
- Test: `test/web.test.ts`

**Interfaces:**
- Consumes: `KernelContext.secret(name)` (from `setup(ctx)`), `brave.search(query, count, secret)` and `MissingKey` from `extensions/web/brave.ts` (unchanged).
- Produces: the `web` manifest with `provides: { tool: [webFetch, webSearch] }`, no `contracts`, no `settings`.

- [ ] **Step 1: Replace the engine tests in `test/web.test.ts`**

Delete the `fake` extension and the tests `web_search uses the engine chosen in settings`, `web_search still uses the chosen engine after an extension install`, and `web_search names the engines when the chosen one is unknown`. Keep the two Brave tests and add:

```ts
test("web provides only its tools, and defines no contract or settings", async () => {
  const { default: web } = await import("../extensions/web/index.ts");
  expect(Object.keys(web.provides ?? {})).toEqual(["tool"]);
  expect(web.settings).toBeUndefined();
  expect("contracts" in web).toBe(false);
});

test("a leftover extensions.web.engine setting is ignored", async () => {
  const { daemon, faux } = await bootTest({ extensions: { web: { engine: "fake" } } });
  expect(daemon.status().errors).toEqual([]);
  expect(await tool(daemon, faux, "web_search", { query: "cats" })).toMatch(/^web_search needs a Brave Search API key/);
  await daemon.close();
});

test("web_search still works after an extension install reloads the registry", { timeout: 60_000 }, async () => {
  const { daemon, faux, home } = await bootTest();
  stage(home, "extensions/dice/index.ts",
    `import { defineJapaExtension } from "japa/sdk";\nexport default defineJapaExtension({ name: "dice", summary: "Dice", examples: ["roll"], docs: "Dice." });\n`);
  expect(await tool(daemon, faux, "install", { kind: "extension", name: "dice" })).toBe("Installed extension dice. (change 1)");
  expect(await tool(daemon, faux, "web_search", { query: "cats" })).toMatch(/^web_search needs a Brave Search API key/);
  await daemon.close();
});
```

- [ ] **Step 2: Run the web tests and see the new manifest test fail**

Run: `npx vitest --run test/web.test.ts`
Expected: FAIL on `web provides only its tools…` (provides has `search-engine`, settings defined).

- [ ] **Step 3: Simplify `extensions/web/index.ts`**

Remove `SearchEngine`, `engines` (the `globalThis` map), `searchEngine`, the `settings` variable, the "No search engine" branch, `contracts`, the `"search-engine"` contribution and the `settings` schema. Keep a module variable `secret: KernelContext["secret"]` set in `setup: (ctx) => { secret = ctx.secret; }`; before setup runs it throws `new Error("web is not set up")`. `webSearch.execute` calls `brave.search(query, count, secret)` with the existing `MissingKey` and error handling. Manifest `docs`: replace the engine sentences with "web_search uses Brave Search and needs the secret web.brave.apiKey."

- [ ] **Step 4: Run the web tests, then everything**

Run: `npx vitest --run test/web.test.ts && npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/web test/web.test.ts
git commit -m "refactor(web): call Brave directly, drop the search-engine contract"
```

---

### Task 2: The kernel's contracts are the core contracts

**Files:**
- Modify: `src/kernel/contracts.ts` (add `CONTRACTS`; `ACTIVATION_ORDER` comment)
- Modify: `src/kernel/extension.ts` (drop `contracts` field; `validateExtension` signature)
- Modify: `src/kernel/loader.ts` (drop `isContract`, the duplicate check, the field check and the pruning loop)
- Modify: `src/kernel/runtime.ts` (drop the `contracts` input, `order()`, reconcile's contract bookkeeping)
- Modify: `src/kernel/boot.ts`, `src/kernel/check.ts` (use `CONTRACTS`; boot uses `ACTIVATION_ORDER`)
- Modify: `src/kernel/capabilities.ts` (drop the contracts input and list)
- Modify: `src/sdk.ts` (stop exporting `Contract`, `CORE_CONTRACTS`)
- Test: `test/loader.test.ts`, `test/activation.test.ts`, `test/capabilities.test.ts`, `test/extension.test.ts`, `test/settings-tools.test.ts`, `test/boot-adapters.test.ts`, `test/env.test.ts`

**Interfaces:**
- Consumes: `CORE_CONTRACTS: Contract[]` (unchanged).
- Produces:
  - `export const CONTRACTS: ReadonlyMap<string, Contract>` in `src/kernel/contracts.ts`, built from `CORE_CONTRACTS`.
  - `export const ACTIVATION_ORDER = ["provider", "environment", "tool", "trigger", "surface"]` (unchanged values, marker removed).
  - `validateExtension(e: JapaExtension): string[]` (validates against `CONTRACTS`).
  - `loadExtensions(found: FoundExtension[]): Promise<{ extensions: JapaExtension[]; errors: LoadError[] }>` — imports each module, checks the default export and name, validates each extension independently; never throws.
  - `capabilities(input: { extensions; profiles; models }): string` — as today, without the "Contracts:" lines.
  - `createRuntime` input loses `contracts`; the runtime loses `order()`. Callers use `ACTIVATION_ORDER` (boot: `ACTIVATION_ORDER.slice(1)`).

- [ ] **Step 1: Update the tests to the new interfaces**

- `test/loader.test.ts`: import nothing from contracts; call `loadExtensions(found)` with one argument. Delete the tests `an extension may contribute to a contract another extension defines`, `malformed contracts are reported, other extensions still load`, `a contract validate that throws is reported against the contributing extension`, `contracts from extensions that fail validation are not available to others`, `defining an existing contract name is an error`. Add:

```ts
test("an extension providing a non-core contract fails alone; a contracts field is ignored", async () => {
  const dir = tempDir();
  writeExtension(dir, "old", manifest(`name: "old", summary: "s", contracts: [{ name: "search-engine", docs: "d",
    phase: "runtime", cardinality: "many", validate: () => undefined }], provides: { "search-engine": [{ name: "e" }] }`));
  writeExtension(dir, "defines-only", manifest(`name: "defines-only", summary: "s", contracts: [{ name: "x" }]`));
  writeExtension(dir, "good", manifest(`name: "good", summary: "s"`));
  const { extensions, errors } = await loadExtensions(discoverExtensions([dir]));
  expect(extensions.map((e) => e.name)).toEqual(["defines-only", "good"]);
  expect(errors).toEqual([{ name: "old", error: 'unknown contract "search-engine"' }]);
});
```

- `test/activation.test.ts`: delete `extension-defined contracts activate between tools and triggers`; add `core contracts activate in order: environment, tool, trigger, surface` — one extension whose `environment` adapter's `create` is never needed but whose contributions record activation by wrapping: use a `setup` that pushes `"setup"`, a tool, a trigger `start` pushing `"trigger"` and a surface `start` pushing `"surface"`, and assert `order` equals `["setup", "trigger", "surface"]` and that the tool is in `daemon.registry.snapshot().tools()` before the trigger started (check inside the trigger's `start`). Drop the `Contract` import.
- `test/capabilities.test.ts`: rename to `capabilities lists extensions, workers, models and surfaces`; remove the `contracts` input and the `"Contracts:"`, `"- surface: …"`, `"- calendar: …"` expected lines.
- `test/extension.test.ts`: call `validateExtension(e)` with one argument; `all seven core contracts exist` checks `[...CONTRACTS.keys()].sort()` (import `CONTRACTS` from `../src/kernel/contracts.ts`).
- `test/settings-tools.test.ts` (`extension settings are validated against its schema…`): replace the `probe` contract with `setup: (k) => { kernel = k; }` and remove `contracts`/`provides`; drop the `Contract` import.
- `test/boot-adapters.test.ts`, `test/env.test.ts`: `validateExtension(x)` with one argument; remove the `CORE_CONTRACTS` imports from `../src/sdk.ts`.

- [ ] **Step 2: Run the typecheck and the changed tests; see them fail**

Run: `npm run typecheck`
Expected: FAIL — `loadExtensions`/`validateExtension` called with 1 argument, `CONTRACTS` not exported.

- [ ] **Step 3: Implement the interfaces above**

In `loader.ts`, `loadExtensions` keeps its import pass and validates each imported extension once with `validateExtension(e)` inside the existing try/catch (`check`), with no repeat loop. In `runtime.ts`, activation looks contracts up in `CONTRACTS`; `reconcile` calls `start(loaded, ACTIVATION_ORDER)` and its boot-phase notice uses `CONTRACTS.get(name)?.phase`. In `boot.ts`, delete the contract map and the `extensions.flatMap((e) => e.contracts …)` line; pass no contracts to the runtime. In `check.ts`, delete the module-level map. `sdk.ts` keeps every other export.

- [ ] **Step 4: Run everything**

Run: `npm run typecheck && npm test`
Expected: all PASS. Also `grep -rn "e\.contracts\|search-engine\|extension-defined" src extensions` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "refactor(kernel): core contracts only; remove extension-defined contracts"
```

---

### Task 3: Content and main spec

**Files:**
- Modify: `src/kernel/identity.md:15`
- Modify: `skills/building-extensions/SKILL.md` (manifest bullets ~line 43; "Defining a contract" ~lines 86–94; escape-hatch intro ~line 97)
- Modify: `docs/superpowers/specs/2026-10-07-japa-design.md` (§4 intro, §4.3, §4.4, §5.1, §5.2, §9.4 capabilities text ~line 555, §10.3, §11.1, §11.2 skill list ~line 690, file map ~line 722, testing ~line 742)
- Test: `test/content.test.ts` if it exists for skills/identity; otherwise the grep in Step 2

**Interfaces:** none (text only).

- [ ] **Step 1: Edit the text**

- `identity.md`: delete the sentence "Extensions can also define new contracts."
- `building-extensions`: delete the `contracts` manifest bullet and the whole "Defining a contract" section; the escape-hatch section starts "When the core contracts aren't enough, …". Any example mentioning `search-engine` goes.
- Main spec: apply the spec's "Main spec" list (§4.3 removed; manifest example without `contracts: []` and `"search-engine"`; boot order without the extension-defined slot; "every `provides` key names a core contract"; the `web` row: "`web_fetch` (no key) and `web_search` (Brave; asks for its key with `secret_request` on first use)."; capabilities text "the core contracts" without "extension-defined"; skill list without "defining new contracts"; file map `extensions/web/ tools`; testing line without "extension-defined contracts").

- [ ] **Step 2: Verify no stale references remain**

Run: `grep -rn -i "extension-defined\|search-engine\|define new contracts\|defines new contracts\|Defining a contract" src skills workers extensions README.md docs/superpowers/specs/2026-10-07-japa-design.md`
Expected: no output.

Run: `npm test`
Expected: PASS (content tests, if any, still pass).

- [ ] **Step 3: Commit**

```bash
git add src/kernel/identity.md skills/building-extensions/SKILL.md docs/superpowers/specs/2026-10-07-japa-design.md
git commit -m "docs: core contracts only"
```
