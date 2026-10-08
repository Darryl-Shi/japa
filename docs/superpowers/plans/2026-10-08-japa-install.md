# Install, Setup and Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `curl … | sh` installs japa (with a private Node when needed), a manifest-driven `japa setup` wizard configures models, keys and extensions, `japa service` runs the daemon under systemd/launchd, and `japa update` upgrades safely.

**Architecture:** `install.sh` (POSIX sh) only bootstraps: clone, Node, `npm ci`, launcher, then hands off to the TypeScript CLI. Everything else lives in `src/cli/`: the wizard's logic talks to a `Prompter` interface (pi-tui in production, a scripted fake in tests); extension prompts are generated from manifest `secrets` and settings schemas; shell-outs to service managers go through an injectable `Exec`; `update` runs real git and takes its npm/Node/restart steps as injectable deps.

**Tech Stack:** TypeScript on Node 24 (type stripping, no build), `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, `node:util` `parseArgs`, vitest; git, systemd user units, launchd agents.

**Spec:** `docs/superpowers/specs/2026-10-08-japa-install-design.md`, extending `docs/superpowers/specs/2026-10-07-japa-design.md`.

## Global Constraints

- Prime directive: minimal code, no new dependencies. `npm test` and `npm run typecheck` pass after every task. `tsconfig` has `erasableSyntaxOnly`: no enums, no constructor parameter properties.
- Default install dir `~/.local/share/japa` (`$JAPA_INSTALL_DIR`, `--dir`); checkout `<dir>/app`; private Node `<dir>/node`; launcher `~/.local/bin/japa`; runtime home `japaHome()` (`$JAPA_HOME` or `~/.japa`), never touched by install or update except `setup.json`.
- Default repo `https://github.com/Darryl-Shi/japa.git`, default install branch `main`. `.node-version` = `24.14.1`. Minimum Node major: `24`.
- Node downloads: `https://nodejs.org/dist/v<ver>/node-v<ver>-<os>-<arch>.tar.gz` verified against `SHASUMS256.txt` in the same directory; `<os>` ∈ `linux|darwin`, `<arch>` ∈ `x64|arm64`.
- Dependencies install with **`npm ci`** (not `--omit=dev`): `japa check` runs japa's own `node_modules/.bin/tsc` and `vitest` (dev dependencies) when the CoS builds extensions.
- Launcher, verbatim shape (paths single-quoted by `shellQuote`):
  `#!/bin/sh` / `exec '<node>' --disable-warning=ExperimentalWarning '<app>/src/cli/main.ts' "$@"`
- systemd unit `~/.config/systemd/user/japa.service` (`$XDG_CONFIG_HOME` respected); launchd plist `~/Library/LaunchAgents/dev.japa.daemon.plist`, label `dev.japa.daemon`, log `<japaHome>/logs/daemon.log`.
- Workspace `IGNORED` gains `setup.json` and `logs/`.
- Daemon-socket waits: 30 s (30 000 ms).
- User-facing strings, verbatim: `japa is up to date (<short sha>)` · `your checkout has diverged from origin/<branch>; nothing changed` · `update failed at <step>: <error>; still on <old short sha>` · `restart \`japa daemon\` to apply` · `japa is already running in the foreground (pid <N>); stop it first` · `to keep japa running after you log out: sudo loginctl enable-linger <user>` · `run \`japa setup\` to configure` · `Restart japa to apply? [Y/n]` (as the confirm question `Restart japa to apply?`, default yes).
- Owner description (kernel-added `owner` property): `Your <extension> user id. Leave blank, message the bot, and it replies with your id.`

## Review Focus

- **First `japa update` on a home with no `setup.json`** (setup skipped, or `--skip-setup`): every configurable extension would look "new". Before applying, update records the *pre-update* manifests as offered. → Task 8, `a home without setup.json gets the old manifests as baseline`.
- **A pasted API key or token with surrounding whitespace or a trailing newline** must be stored trimmed, or every request fails with a baffling 401. → Task 4, `a pasted key is stored trimmed`.
- **An install dir containing spaces or a quote** must produce a launcher and service unit that still run. → Task 2, `launcher quotes paths with spaces and quotes`; Task 6, `unit quotes ExecStart`.
- **`japa update` from a developer checkout** (not under an install dir, on a non-`main` branch, no launcher pointing at it) must update that branch and must not write a launcher or download Node. → Task 8, `a dev checkout updates its own branch and writes no launcher`.
- **`japa setup` on a fresh machine where `~/.japa` doesn't exist yet.** → Task 4, `setup creates a missing home`.

## Decisions the spec leaves open

- **Testing the wizard:** pi-tui exports no virtual terminal, so wizard logic takes a `Prompter`; tests use `scripted()`; the pi-tui `tuiPrompter()` is thin and checked manually (Task 10 checklist).
- **Telegram `owner`:** the kernel's `settingsSchema(e)` (`src/kernel/settings-tools.ts`) already adds `owner` to every messaging extension; it gains the description above. Telegram gets no schema of its own. The wizard always uses `settingsSchema(e)`.
- **What's new runs in the new code:** ESM caches modules by URL, so the updating process cannot re-import changed manifests. After validating, update runs `<node> <app>/src/cli/main.ts setup --whats-new` (stdio inherited; `--non-interactive` appended without a tty) **before** the restart, so one restart applies code and configuration.
- **Baseline:** if `<home>/setup.json` is missing when update starts, update marks the current (pre-update) manifests as offered in-process before pulling.
- **Launcher and Node are managed only for installed copies:** an install is "managed" when `basename(app) === "app"` and `<dirname(app)>/` holds it; update writes the launcher only if `~/.local/bin/japa` exists and contains `shellQuote(<app>/src/cli/main.ts)`, and manages Node only when managed.
- **`--branch` default for update** is the checkout's current branch.
- **Ctrl-C/Esc in a prompt** throws `Cancelled`; `japa setup` catches it, prints `Cancelled; finished steps are saved.` and exits 130.
- **Uninstall from a dev checkout** removes only the service and a launcher pointing at it, never the checkout.

---

## File Structure

```
.node-version                     NEW  24.14.1
install.sh                        NEW  bootstrap (Task 9)
src/kernel/extension.ts           MOD  secrets entries may carry descriptions; secretNames()
src/kernel/boot.ts                MOD  use secretNames; export findAdapter, envKeyName
src/kernel/settings-tools.ts      MOD  owner description
src/kernel/workspace.ts           MOD  IGNORED += setup.json, logs/
src/cli/exec.ts                   NEW  Exec type and default (never throws)
src/cli/layout.ts                 NEW  install paths, shellQuote, launcherText, writeLauncher
src/cli/node.ts                   NEW  nodeDist, verifySha256, ensurePrivateNode, major
src/cli/prompt.ts                 NEW  Prompter, Cancelled, tuiPrompter
src/cli/context.ts                NEW  openSetupContext: manifests, secrets store, models
src/cli/models-step.ts            NEW  chooseModels
src/cli/configure.ts              NEW  configurable, isConfigured, configureExtension, offered/unseen/markOffered
src/cli/daemon.ts                 NEW  daemonStatus, waitForDaemon, foregroundPid
src/cli/service.ts                NEW  unit/plist text, install/uninstall/start/stop/restart/state/logs
src/cli/setup.ts                  NEW  runSetup (first run, menu, non-interactive, --whats-new)
src/cli/update.ts                 NEW  update()
src/cli/uninstall.ts              NEW  uninstall()
src/cli/main.ts                   MOD  --version, setup, update, service, uninstall; status via daemon.ts
extensions/{telegram,web,desktop}/index.ts  MOD  secret/setting descriptions
skills/building-extensions/SKILL.md         MOD  describe secrets and settings
README.md                                   MOD  Task 10
test/prompt-helpers.ts            NEW  scripted()
test/{manifest-secrets,layout,node,setup-models,configure,service,setup,update,install-sh}.test.ts  NEW
```

---

### Task 1: Describable secrets and settings

**Files:**
- Modify: `src/kernel/extension.ts`, `src/kernel/boot.ts:153-158` (`declared`), `src/kernel/settings-tools.ts:20-25`, `extensions/telegram/index.ts`, `extensions/web/index.ts`, `extensions/desktop/index.ts:58-64`, `skills/building-extensions/SKILL.md:44`
- Test: `test/manifest-secrets.test.ts`

**Interfaces:**
- Produces: `type SecretSpec = string | { name: string; description: string }`; `JapaExtension.secrets?: SecretSpec[]`; `secretNames(e: JapaExtension): string[]`; `secretDescription(e: JapaExtension, name: string): string | undefined` (all in `src/kernel/extension.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
test("secretNames accepts strings and described entries", () => {
  const e = { name: "x", summary: "x", secrets: ["a.key", { name: "b.key", description: "B" }] };
  expect(secretNames(e)).toEqual(["a.key", "b.key"]);
  expect(secretDescription(e, "b.key")).toBe("B");
  expect(secretDescription(e, "a.key")).toBeUndefined();
});
test("validateExtension rejects a secret entry without a name", () => {
  expect(validateExtension({ name: "x", summary: "x", secrets: [{ description: "d" } as never] }))
    .toContain("secrets[0]: must be a name or { name, description }");
});
test("a described secret can be read by its extension", async () => { /* boot a tempHome with an extension declaring
  secrets: [{ name: "x.key", description: "d" }] whose setup reads ctx.secret("x.key"); expect no error */ });
test("the messaging owner property is described", () => {
  const schema = settingsSchema({ name: "telegram", summary: "t", provides: { messaging: [{}] } }) as any;
  expect(schema.properties.owner.description)
    .toBe("Your telegram user id. Leave blank, message the bot, and it replies with your id.");
});
test("every packaged secret has a description", async () => {
  const { extensions } = await loadExtensions(discoverExtensions([REPO_EXTENSIONS]));
  for (const e of extensions) for (const n of secretNames(e)) expect(secretDescription(e, n), n).toBeTruthy();
});
```

- [ ] **Step 2: Run** `npx vitest --run test/manifest-secrets.test.ts` — Expected: FAIL (`secretNames` not exported).

- [ ] **Step 3: Implement**
  - `extension.ts`: the type, both helpers, and the validation error above (a string, or an object with string `name` and `description`).
  - `boot.ts` `declared`: `secretNames(ext).includes(name)`; grep for other `.secrets` reads of manifests and convert them.
  - `settings-tools.ts`: `owner: Type.Optional(Type.String({ description: \`Your ${e.name} user id. Leave blank, message the bot, and it replies with your id.\` }))`.
  - Descriptions: telegram `telegram.botToken` → `Bot token from @BotFather (/newbot)`; web `web.brave.apiKey` → `Brave Search API key, for web_search`; desktop `desktop.vncPassword` → `Password for watching the desktop in noVNC (generated on first use if unset)`, `cpus` → `CPUs for the desktop container (default 2)`, `memory` → `Memory limit, e.g. "4g" (default "4g")`, `shm` → `Shared memory, e.g. "2g" (default "2g")`, `bind` → `Address noVNC listens on (default "127.0.0.1")`.
  - SKILL.md line 44: secrets may be `{ name, description }`; give settings properties `description`s; both show in `japa setup`.

- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -am "feat(kernel): describable secrets and settings"` (add the new test file).

---

### Task 2: Install layout, launcher, private Node, `--version`

**Files:**
- Create: `.node-version`, `src/cli/exec.ts`, `src/cli/layout.ts`, `src/cli/node.ts`
- Modify: `src/cli/main.ts` (`--version`)
- Test: `test/layout.test.ts`, `test/node.test.ts`

**Interfaces:**
- Produces (`exec.ts`): `type ExecResult = { code: number; stdout: string; stderr: string }`; `type Exec = (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: "inherit" }) => Promise<ExecResult>`; `const exec: Exec` (never throws; a spawn error is `code: 127`).
- Produces (`layout.ts`):
  - `type Layout = { app: string; installDir: string | undefined; nodeDir: string | undefined; launcher: string }` — `installDir`/`nodeDir` only when managed (Decisions).
  - `layoutOf(app: string, userHome = homedir()): Layout`; `APP = fileURLToPath(new URL("../..", import.meta.url))`.
  - `shellQuote(s: string): string` (single quotes; `'` → `'\''`).
  - `launcherText(node: string, app: string): string`.
  - `writeLauncher(layout: Layout, node: string): void` (mkdir, mode 755).
  - `launcherPointsAt(layout: Layout): boolean`.
- Produces (`node.ts`):
  - `MIN_NODE_MAJOR = 24`; `major(version: string): number` (accepts `v24.1.0` / `24.1.0`).
  - `nodeDist(platform: NodeJS.Platform, arch: string): string` — `linux-x64` etc.; throws `japa supports Linux and macOS on x64 or arm64` otherwise.
  - `verifySha256(file: string, shasums: string, name: string): void` — throws `checksum mismatch for <name>` or `<name> is not in SHASUMS256.txt`.
  - `ensurePrivateNode(version: string, nodeDir: string, opts?: { baseUrl?: string; platform?: NodeJS.Platform; arch?: string }): Promise<string>` — downloads into `<nodeDir>.new`, verifies, `tar -xzf … --strip-components=1`, then moves the old `nodeDir` to `<nodeDir>.old` and `<nodeDir>.new` to `nodeDir`; returns `<nodeDir>/bin/node`. `baseUrl` default `https://nodejs.org/dist`. A failed request throws `could not download <url>: <status or reason>`.
  - `restoreNode(nodeDir: string): void` (puts `.old` back) and `dropOldNode(nodeDir: string): void`.

- [ ] **Step 1: Write the failing tests**

```ts
test("launcher quotes paths with spaces and quotes", () => {
  expect(launcherText("/a b/node", "/x/it's/app")).toBe(
    "#!/bin/sh\nexec '/a b/node' --disable-warning=ExperimentalWarning '/x/it'\\''s/app/src/cli/main.ts' \"$@\"\n");
});
test("layoutOf: managed only for <dir>/app", () => {
  expect(layoutOf("/h/.local/share/japa/app", "/h")).toEqual({ app: "/h/.local/share/japa/app",
    installDir: "/h/.local/share/japa", nodeDir: "/h/.local/share/japa/node", launcher: "/h/.local/bin/japa" });
  expect(layoutOf("/h/projects/japa", "/h").installDir).toBeUndefined();
});
test("launcherPointsAt is false for another checkout's launcher", () => { /* write launcherText(n, "/other") into a tmp launcher */ });
test("nodeDist", () => {
  expect(nodeDist("linux", "x64")).toBe("linux-x64");
  expect(nodeDist("darwin", "arm64")).toBe("darwin-arm64");
  expect(() => nodeDist("win32", "x64")).toThrow("japa supports Linux and macOS on x64 or arm64");
});
test("verifySha256 rejects a mismatch and a missing entry", () => { /* fixture file + SHASUMS text */ });
test("ensurePrivateNode installs from a mirror and keeps the old one aside", async () => {
  // local node:http server serving /v9.9.9/node-v9.9.9-linux-x64.tar.gz (a tar.gz of node-v9.9.9-linux-x64/bin/node,
  // a shell script printing v9.9.9) and its SHASUMS256.txt
  const node = await ensurePrivateNode("9.9.9", dir, { baseUrl, platform: "linux", arch: "x64" });
  expect(execFileSync(node, { encoding: "utf8" }).trim()).toBe("v9.9.9");
});
test("ensurePrivateNode with a bad checksum leaves nodeDir untouched", async () => { /* … rejects; old node still there */ });
test("a failed download names the URL", async () => { /* 404 → rejects with /could not download .*node-v9\.9\.9/ */ });
test("japa --version prints the version and sha", () => {
  expect(execFileSync(process.execPath, ["src/cli/main.ts", "--version"], { encoding: "utf8" })).toMatch(/^japa 0\.1\.0 \([0-9a-f]{7,}\)\n$/);
});
```

- [ ] **Step 2: Run** `npx vitest --run test/layout.test.ts test/node.test.ts` — Expected: FAIL (modules missing).

- [ ] **Step 3: Implement** the interfaces above. `--version` prints `japa <package.json version> (<git rev-parse --short HEAD in APP, or "unknown">)`; it is handled before the `commands` lookup in `main.ts` (which already statically imports the kernel, so a successful run proves the code loads). `.node-version` holds `24.14.1\n`.

- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(cli): install layout, launcher, private Node, --version"`.

---

### Task 3: Prompter

**Files:**
- Create: `src/cli/prompt.ts`, `test/prompt-helpers.ts`
- Test: `test/prompt-helpers.test.ts`

**Interfaces:**
- Produces (`prompt.ts`):
  ```ts
  export type Choice<T> = { label: string; value: T; hint?: string };
  export class Cancelled extends Error {}
  export type Prompter = {
    note(text: string): void;
    select<T>(question: string, choices: Choice<T>[], initial?: T): Promise<T>;
    text(question: string, opts?: { initial?: string; help?: string }): Promise<string>;   // trimmed
    secret(question: string, help?: string): Promise<string>;                              // trimmed; "" = keep/skip
    confirm(question: string, initial: boolean): Promise<boolean>;
  };
  export function tuiPrompter(): Prompter & { close(): void };
  ```
  `tuiPrompter`: one `TuiMainScreen(new ProcessTerminal())`, a `Text` history of answered questions, then per call a `SelectList` (filterable by typing, `initial` preselected), an `Input` (prefilled), the `MaskedInput` (move it from `extensions/gateway/chat.ts` to `prompt.ts` and import it back in chat), or a Yes/No `SelectList`. Esc or Ctrl-C rejects with `Cancelled`. `close()` stops the TUI; callers close in `finally`.
- Produces (`test/prompt-helpers.ts`): `scripted(steps: [match: string, answer: unknown | ((choices: Choice<unknown>[]) => unknown)][]): Prompter & { asked: string[]; notes: string[]; done(): void }` — each call takes the next step, asserts `question.includes(match)` (throws `expected "<match>", got "<question>"`), returns the answer (`"cancel"` throws `Cancelled`), and trims strings for `text`/`secret`; `done()` throws if steps remain.

- [ ] **Step 1: Write the failing test** `scripted answers in order, rejects an unexpected question, cancel throws Cancelled, done() fails with steps left`.
- [ ] **Step 2: Run** `npx vitest --run test/prompt-helpers.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** both files; update `chat.ts`'s import of `MaskedInput`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(cli): prompter"`.

---

### Task 4: Setup context and the models step

**Files:**
- Create: `src/cli/context.ts`, `src/cli/models-step.ts`
- Modify: `src/kernel/boot.ts` (export `findAdapter` — rename of `adapter` — and `envKeyName`, factored out of `missingKey`)
- Test: `test/setup-models.test.ts`

**Interfaces:**
- Consumes: `Prompter` (Task 3); `loadSettings`, `readUserSettings`, `saveSettings`, `checkModel` (`src/kernel/settings.ts`); `discoverExtensions`, `loadExtensions` (`loader.ts`); `ensureWorkspace`.
- Produces (`boot.ts`): `findAdapter<T extends { name: string }>(extensions: JapaExtension[], contract: string, name: string): T`; `envKeyName(models: Models, provider: string): Promise<string | undefined>` (the `*_API_KEY` env var the provider reads; `missingKey` uses it).
- Produces (`context.ts`):
  ```ts
  export type SetupContext = { home: string; extensions: JapaExtension[]; secrets: SecretsStore; models: Models };
  export function openSetupContext(home: string, extensionDirs?: string[]): Promise<SetupContext>;
  ```
  `mkdirSync(home, { recursive: true })`, `ensureWorkspace`, load manifests (default dirs `[<APP>/extensions, <home>/extensions]`), open `findAdapter<SecretsAdapter>(…, "secrets", settings.secrets.adapter)`, `createModels()` then `setProvider` each `provides.provider` entry.
- Produces (`models-step.ts`): `chooseModels(ctx: SetupContext, p: Prompter, env?: NodeJS.ProcessEnv): Promise<boolean>` (true when something was saved).
  1. `select("CoS provider", providers with ≥1 model, current or "anthropic")`; `select("CoS model", its models, current)`.
  2. `apiKey(provider)`: if `env[await envKeyName(...)]` is set, `note("<VAR> is set in this shell, but the background service won't see it; store the key too.")`; `secret("API key for <provider>", "Enter keeps the current key")` (help `"Enter skips"` when none is stored); non-empty → `secrets.set("<provider>.apiKey", value)`.
  3. `confirm("Use the CoS model for workers and memory consolidation?", true)`; on no, for `worker` then `consolidation`: provider/model selects (`"Worker provider"`, …), then `apiKey` only if `<provider>.apiKey` isn't stored and differs from providers already asked. On yes, delete `models.worker`/`models.consolidation` from user settings.
  4. `checkModel` each ref; `saveSettings` with the other user keys preserved.

- [ ] **Step 1: Write the failing tests** (tempHome, `REPO_EXTENSIONS`, file secrets):
  - `first run writes models.cos and the key` — script: `["CoS provider","anthropic"], ["CoS model", c => c[0].value], ["API key","sk-1"], ["Use the CoS model", true]`; expect `settings.json` `models` = `{ cos: { provider: "anthropic", modelId: <first> } }` and `secrets/anthropic.apiKey` = `sk-1`.
  - `a pasted key is stored trimmed` — answer `"  sk-1\n"` → file `sk-1`.
  - `Enter keeps an existing key` — secret pre-written; answer `""`; file unchanged.
  - `an env key is noted` — env `{ ANTHROPIC_API_KEY: "x" }`; `notes[0]` contains `ANTHROPIC_API_KEY is set in this shell`.
  - `a worker on the same provider asks for no second key`.
  - `other user settings are kept` — pre-existing `{ jobs: { maxConcurrent: 2 } }` survives.
  - `setup creates a missing home` — `openSetupContext(join(tmp, "nope"))` succeeds and `.git` exists.
- [ ] **Step 2: Run** `npx vitest --run test/setup-models.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS (boot tests prove `missingKey` unchanged).
- [ ] **Step 5: Commit** `git commit -m "feat(cli): setup context and models step"`.

---

### Task 5: Extension configuration

**Files:**
- Create: `src/cli/configure.ts`
- Modify: `src/kernel/workspace.ts:9` (`IGNORED` += `"setup.json"`)
- Test: `test/configure.test.ts`

**Interfaces:**
- Consumes: `SetupContext` (Task 4), `secretNames`/`secretDescription` (Task 1), `settingsSchema` (`settings-tools.ts`), `readUserSettings`/`saveSettings`/`mergeSettings`/`validateSettings`.
- Produces:
  ```ts
  export function configurable(extensions: JapaExtension[]): JapaExtension[];            // has secrets or settingsSchema(e)
  export function isConfigured(ctx: SetupContext, e: JapaExtension): Promise<boolean>;    // spec §4.4 rule
  export function configureExtension(ctx: SetupContext, p: Prompter, e: JapaExtension): Promise<boolean>; // saved?
  export function configureStep(ctx: SetupContext, p: Prompter, only?: JapaExtension[]): Promise<boolean>;
  export function offerKeys(e: JapaExtension): string[];                 // "secret:<name>", "setting:<prop>"
  export function unseen(ctx: SetupContext): Promise<{ extension: JapaExtension; keys: string[]; isNew: boolean }[]>;
  export function markOffered(home: string, extensions: JapaExtension[]): void;  // merges into setup.json
  ```
  `configureStep`: for each (name order) `note("<name>: <summary>[ (configured)]")`, `confirm("Configure <name>?", false)`, `configureExtension` on yes; afterwards `markOffered(home, all configurable)`. `configureExtension`: each secret → `secret("<name>", description)`; each top-level property of `settingsSchema(e)`:
  - `string` → `text`; `number`/`integer` → `text` parsed with `Number` (re-prompt `"<prop> must be a number"` on NaN); `boolean` → `select` Yes/No; `enum` or `anyOf` of `const`s → `select` over the values;
  - other types → `note("edit extensions.<name>.<prop> in settings.json or ask the CoS")`;
  - prefilled with the current value, else the schema `default`; empty answer on an optional property → unset.
  - Then validate the merged settings with `validateSettings(mergeSettings(user), { [name]: schema })`; on error `note(error)` and re-prompt that property (the first path in the error), then save.
  `unseen`: keys not in `setup.json` `offered[name]`; `isNew` when the extension has no entry.

- [ ] **Step 1: Write the failing tests** (a fixture extension dir with `demo` declaring a described secret `demo.key` and settings `{ count?: integer, mode?: "a"|"b", on?: boolean, tags?: string[] }`, plus `REPO_EXTENSIONS`):
  - `configurable lists telegram, web, desktop, demo and not sqlite`.
  - `configuring demo writes its secret and typed settings` — expect `{ count: 3, mode: "b", on: true }` and `secrets/demo.key`; `tags` produced the edit-by-hand note.
  - `a non-number re-prompts`.
  - `declining leaves everything unchanged but marks it offered`.
  - `telegram owner is prompted with its description` (scripted `asked` includes `owner`).
  - `unseen reports a new extension, then a new secret on an existing one, then nothing`.
  - `setup.json is ignored by the workspace git`.
- [ ] **Step 2: Run** `npx vitest --run test/configure.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(cli): configure extensions from their manifests"`.

---

### Task 6: Service manager

**Files:**
- Create: `src/cli/daemon.ts`, `src/cli/service.ts`
- Modify: `src/kernel/workspace.ts:9` (`IGNORED` += `"logs/"`), `src/cli/main.ts` (`status` uses `daemonStatus`; `service` command)
- Test: `test/service.test.ts`

**Interfaces:**
- Produces (`daemon.ts`): `daemonStatus(home: string): Promise<Status>` (moved from `main.ts`'s `status`); `waitForDaemon(home: string, ms = 30_000): Promise<Status | undefined>` (retry `connect` every 500 ms); `foregroundPid(home: string): number | undefined` (pid in `daemon.lock` if alive — export `isAlive` from `lock.ts`).
- Produces (`service.ts`):
  ```ts
  export type ServiceEnv = { platform: NodeJS.Platform; userHome: string; configHome: string; launcher: string;
    japaHome: string; customHome: boolean; path: string; user: string; exec: Exec };
  export function serviceEnv(launcher: string): ServiceEnv;   // from process/os
  export function unitPath(env): string; export function unitText(env): string;    // systemd
  export function plistPath(env): string; export function plistText(env): string;  // launchd
  export function unavailable(env): Promise<string | undefined>;  // reason, or undefined when usable
  export function isInstalled(env): boolean;
  export function installService(env, log: (s: string) => void): Promise<void>;
  export function uninstallService(env, log): Promise<void>;
  export function startService(env, log): Promise<void>;
  export function stopService(env): Promise<void>;
  export function restartService(env): Promise<void>;
  export function serviceState(env): Promise<"active" | "inactive" | "not installed">;
  export function logsCommand(env): [string, string[]];
  export function serviceCommand(home: string, args: string[]): Promise<void>;  // CLI dispatcher
  ```
  Unit text per spec §7.1, `ExecStart=` with systemd quoting (`"…"` with `\` and `"` escaped), `Environment="PATH=…"`, `JAPA_HOME` only when `customHome`. Plist per §7.2 (XML-escape values). `unavailable`: Linux → `systemctl --user show-environment` non-zero → `systemd is not running for your user (WSL: add "[boot]\nsystemd=true" to /etc/wsl.conf and run "wsl --shutdown"); run "japa daemon" yourself`; macOS → none; other → `no supported service manager`. `installService`: write only if changed; Linux `daemon-reload`, `enable japa`, then `startService`, then `loginctl enable-linger <user>` (non-zero → the verbatim sudo line); macOS `bootout` (ignore failure) + `bootstrap gui/<uid> <plist>`. `startService` throws the verbatim foreground message when `serviceState` isn't `active` and `foregroundPid` is set. `restartService`: `systemctl --user restart japa` / `launchctl kickstart -k gui/<uid>/dev.japa.daemon`. `serviceCommand` subcommands per spec §7; `status` prints state then `statusText(await daemonStatus())` when it answers; `logs` spawns `logsCommand` with inherited stdio.

- [ ] **Step 1: Write the failing tests** with a fake `Exec` recording calls:
  - `unit quotes ExecStart` — launcher `/a b/japa` → line `ExecStart="/a b/japa" daemon`; `JAPA_HOME` line only with `customHome`.
  - `plist escapes and logs to <home>/logs/daemon.log`.
  - `install writes, reloads, enables, starts and lingers`; `a second install with the same text does not reload`.
  - `a lingering failure prints the sudo line`.
  - `no systemd → unavailable reason mentions /etc/wsl.conf`.
  - `start refuses while a foreground daemon holds the lock` (write `daemon.lock` with `process.pid`).
  - `logs/ is ignored by the workspace git`.
- [ ] **Step 2: Run** `npx vitest --run test/service.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; wire `service` into `main.ts` `commands` and add it to `USAGE`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(cli): japa service (systemd, launchd)"`.

---

### Task 7: `japa setup`

**Files:**
- Create: `src/cli/setup.ts`
- Modify: `src/cli/main.ts` (`setup` command, `USAGE`)
- Test: `test/setup.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6.
- Produces:
  ```ts
  export type SetupOptions = { interactive: boolean; service: boolean; whatsNew: boolean; env: NodeJS.ProcessEnv;
    serviceEnv: ServiceEnv; extensionDirs?: string[]; log: (s: string) => void };
  export function runSetup(home: string, p: Prompter | undefined, o: SetupOptions): Promise<number>; // exit code
  export function setupCommand(home: string, args: string[]): Promise<void>;
  ```
  Flags: `--non-interactive`, `--no-service`, `--whats-new`. Interactive = no `--non-interactive` and `process.stdin.isTTY`.
  - **Non-interactive** (spec §4.5): `JAPA_PROVIDER`+`JAPA_MODEL` → `models.cos` (checked), `JAPA_API_KEY` → `<provider>.apiKey`; service unless `--no-service`; `markOffered(all)`; if `models.cos` unset → log `missing: models.cos (set JAPA_PROVIDER and JAPA_MODEL, or run japa setup in a terminal)`, return 1.
  - **`--whats-new`**: `unseen(ctx)`; empty → return 0. Log each (`New: <name> — needs <keys>` / `<name> has a new setting <prop>` / `New extension: <name> — <summary>` for nothing-to-configure ones). Interactive: `confirm("Configure now?", true)` → `configureStep(ctx, p, those)`; else log `run \`japa setup\` to configure`. Then `markOffered`.
  - **First run** (`models.cos` unset): `chooseModels` → `configureStep` → service step → summary.
  - **Rerun:** loop `select("japa setup", Models | Extensions | Service | Done)`; Service → `select` install/start/stop/uninstall/status. On Done, if anything was saved and `serviceState === "active"`: `confirm("Restart japa to apply?", true)` → `restartService`.
  - **Service step:** if `!o.service` skip; `unavailable` → log reason and `start japa with: japa daemon`; else `confirm("Run japa in the background?", true)` → `installService`.
  - **Summary:** if the service was started, `waitForDaemon` and log `statusText`; on timeout log `japa didn't answer within 30 s; see: japa service logs`.
  - `setupCommand` builds the `tuiPrompter` (closed in `finally`), catches `Cancelled` (message per Decisions, exit 130).

- [ ] **Step 1: Write the failing tests** (tempHome, fake `ServiceEnv` exec where `show-environment` fails unless stated):
  - `first run writes models, key and extension choices, and reports no service manager`.
  - `a rerun with Done changes nothing` — byte-compare `settings.json` and secrets before/after.
  - `a rerun that saved asks to restart an active service` (fake exec: `is-active` → 0) and calls `systemctl --user restart japa`.
  - `non-interactive with env vars writes models.cos and returns 0`; `without them returns 1 and logs what is missing`.
  - `--whats-new lists a new fixture extension, configures it on yes, and stays quiet the second time`.
- [ ] **Step 2: Run** `npx vitest --run test/setup.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; wire `setup` into `main.ts`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(cli): japa setup"`.

---

### Task 8: `japa update`

**Files:**
- Create: `src/cli/update.ts`
- Modify: `src/cli/main.ts` (`update` command, `USAGE`)
- Test: `test/update.test.ts`

**Interfaces:**
- Consumes: `Layout`, `layoutOf`, `writeLauncher`, `launcherPointsAt` (Task 2); `major`, `MIN_NODE_MAJOR`, `ensurePrivateNode`, `restoreNode`, `dropOldNode` (Task 2); `openSetupContext`, `markOffered` (Tasks 4–5); service functions, `foregroundPid` (Task 6).
- Produces:
  ```ts
  export type UpdateOptions = { app: string; home: string; branch?: string; to?: string; check: boolean;
    restart: boolean; interactive: boolean; userHome?: string; log: (s: string) => void };
  export type UpdateDeps = {
    node: string;                                                    // node in use (process.execPath)
    ensureNode(version: string, nodeDir: string): Promise<string>;  // default ensurePrivateNode
    npmCi(app: string, node: string): Promise<void>;                // `npm ci` with dirname(node) first on PATH
    validate(app: string, node: string): Promise<void>;             // `<node> <app>/src/cli/main.ts --version`
    baseline(home: string): Promise<void>;                          // markOffered(openSetupContext(home).extensions)
    whatsNew(app: string, node: string, interactive: boolean): Promise<void>; // spawn setup --whats-new, inherit stdio
    restart(log: (s: string) => void): Promise<void>;               // service restart + waitForDaemon, or the lock hint
  };
  export function update(o: UpdateOptions, deps?: Partial<UpdateDeps>): Promise<"up to date" | "checked" | "updated">;
  export class UpdateFailed extends Error {}
  export function updateCommand(home: string, args: string[]): Promise<void>; // flags: --check --branch --to --no-restart
  ```
  Steps, in order, per spec §5.1 with these specifics:
  1. Must be on a branch (`git symbolic-ref --short HEAD`), else throw `UpdateFailed("not on a branch")`. If `setup.json` is missing → `deps.baseline(home)`. Dirty (`git status --porcelain`) → `git stash push -u -m "japa update"`.
  2. `git fetch origin <branch>`; target = `--to` (`git rev-parse --verify <to>^{commit}`) or `origin/<branch>`. Equal to HEAD → log `japa is up to date (<sha>)`. `--check` → log `<n> new commits` and the `git log --oneline HEAD..target`, return `"checked"`. Neither changes anything (pop the stash first).
  3. `git merge --ff-only <target>` (non-ff → pop stash, throw the verbatim diverged message); with `--to`: `git checkout -B <branch> <to>`.
  4. Node (managed layouts only): new `.node-version` ≠ running version and `deps.node` is under `nodeDir`, or `major(running) < major(.node-version)` → `deps.ensureNode`; launcher rewritten if `launcherPointsAt`.
  5. `package-lock.json` differs between old and new sha → `deps.npmCi`.
  6. `deps.validate`. Failure in 4–6 → `git reset --hard <old>`, `restoreNode`, launcher back, `npmCi` again if the lockfile had changed, pop stash; throw `UpdateFailed("update failed at <node|dependencies|validation>: <error>; still on <old>")`. Success → `dropOldNode`.
  7. `deps.whatsNew(app, node, interactive)` (before restart; Decisions).
  8. Unless `--no-restart`, `deps.restart(log)`.
  9. Pop stash (conflict → keep it, log `your local changes are kept in git stash; run: git -C <app> stash pop`); log `<old> → <new>` and up to 20 lines of `git log --oneline old..new`. Return `"updated"`.

- [ ] **Step 1: Write the failing tests** — a helper makes a bare repo with commits (each containing `package-lock.json`, `.node-version`, `README`) and clones it as `<tmp>/share/japa/app`; deps are recording stubs:
  - `up to date changes nothing`; `--check lists incoming commits and changes nothing`.
  - `fast-forward updates, skips npm when the lockfile is unchanged, runs whatsNew then restart`.
  - `a changed lockfile runs npm ci`.
  - `diverged history refuses and leaves HEAD`.
  - `local edits are stashed and restored`.
  - `a failing validate rolls back to the old sha and re-runs npm ci when the lockfile changed`.
  - `--to checks out an older commit`.
  - `a changed .node-version on a private Node downloads it and rewrites the launcher`.
  - `a dev checkout updates its own branch and writes no launcher` (clone at `<tmp>/projects/japa`, branch `dev`; `ensureNode` never called).
  - `a home without setup.json gets the old manifests as baseline` (baseline called before the merge — assert HEAD at call time equals the old sha).
- [ ] **Step 2: Run** `npx vitest --run test/update.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; `updateCommand` uses `APP`, interactive = `process.stdin.isTTY`, prints `UpdateFailed` messages and exits 1.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(cli): japa update"`.

---

### Task 9: `install.sh` and `japa uninstall`

**Files:**
- Create: `install.sh` (mode 755), `src/cli/uninstall.ts`, `test/fixtures/mini-japa/` (`package.json` with no dependencies, its `package-lock.json`, `.node-version`, `src/cli/main.ts` printing `japa 0.0.0 (fixture)` for `--version`, `update called <args>` for `update`, `setup called <args>` for `setup`)
- Modify: `src/cli/main.ts` (`uninstall`, `USAGE`)
- Test: `test/install-sh.test.ts`, `test/uninstall.test.ts`

**Interfaces:**
- Consumes: `launcherText` (Task 2) — the sh launcher must be byte-identical; service functions (Task 6).
- Produces: `uninstall(layout: Layout, home: string, o: { purge: boolean; confirm: () => Promise<string>; serviceEnv: ServiceEnv; log }): Promise<void>`.

`install.sh` follows spec §3 exactly, with: `set -eu`; `say()` step headings; flag parsing for the §3.2 table; `HOME`-relative defaults; Node detection `node -p 'process.versions.node'`; download via `curl -fsSL` or `wget -qO-`; sha via `sha256sum` or `shasum -a 256`; `npm ci` with `PATH="<node bin dir>:$PATH"`; launcher written with the same quoting as `shellQuote`; PATH line appended to the rc file only when missing (`export PATH="$HOME/.local/bin:$PATH"`, fish: `fish_add_path $HOME/.local/bin`); setup run as `"$launcher" setup [--no-service] < /dev/tty` when `/dev/tty` is readable and neither `--non-interactive` nor `--skip-setup`; existing install → `"$launcher" update [--branch b]` (or `node app/src/cli/main.ts update` when the launcher is missing); a `trap` that, on a fresh-install failure, removes the `app/` and `node/` this run created and prints `install failed at: <step>`.

`uninstall`: `uninstallService`; remove the launcher if `launcherPointsAt`; remove `installDir` when managed, else log `not an installed copy; left <app> in place`; log `kept <home>` — or with `--purge`, require `confirm()` to return `delete`, then remove `home`; log that PATH lines added to shell rc files were left.

- [ ] **Step 1: Write the failing tests**
  - `install.sh installs the fixture` — `git init --bare` + push the fixture; run `sh install.sh --dir <tmp>/d --repo <bare> --branch main --non-interactive --skip-setup` with `HOME=<tmp>/h` and the test's Node on PATH; expect `<tmp>/d/app/.git`, no `<tmp>/d/node`, and `readFileSync(<tmp>/h/.local/bin/japa)` === `launcherText(<output of \`sh -c 'command -v node'\` with the same PATH>, <tmp>/d/app)`; running the launcher with `--version` prints `japa 0.0.0 (fixture)`.
  - `a second run takes the update path` — output contains `update called`.
  - `a failed clone removes what it created` — bad `--repo`; `<tmp>/d/app` absent; output contains `install failed at: clone`.
  - `an unsupported platform is refused` — `PATH` with a fake `uname` printing `FreeBSD` → message from Global Constraints.
  - `uninstall removes a managed install and keeps home`; `--purge without "delete" removes nothing`; `a dev checkout is left in place`.
- [ ] **Step 2: Run** `npx vitest --run test/install-sh.test.ts test/uninstall.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Also run `sh -n install.sh` and, if available, `shellcheck install.sh`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: install.sh and japa uninstall"`.

---

### Task 10: README and manual verification

**Files:**
- Modify: `README.md` (Requirements, Install, First run, Running; new Updating; keep "Install from a checkout" for development)

- [ ] **Step 1:** Rewrite per spec §11: `curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | sh`; flags table; `japa setup` (rerun to change settings); `japa service <…>`; Updating (`japa update`, `--check`, `--to`, `--no-restart`, re-running install.sh); `japa uninstall [--purge]`. Requirements drop "Node 24" to "git and curl (Node 24 is installed if missing)". Add the new commands to the command table.
- [ ] **Step 2: Manual checklist** (record results in the commit message body):
  - Linux with systemd: fresh `curl | sh` → wizard (arrow keys, filtering, masked key, Esc cancels cleanly and restores the terminal) → service active → `japa chat` answers → `japa update` with a new commit restarts it.
  - WSL without systemd: wizard reports the reason; `japa daemon` works.
  - macOS: launchd agent loads; `japa service logs` tails the log.
  - System Node 20 on PATH: private Node is downloaded and used by the launcher and the service.
- [ ] **Step 3: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 4: Commit** `git commit -am "docs: install, setup and update"`.
