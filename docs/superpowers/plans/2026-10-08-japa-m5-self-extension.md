# japa Milestone 5: Self-Extension and Safety Net (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** japa can extend itself and recover from its own mistakes:
- A `builder` job writes a skill, worker profile or extension in a staging worktree, then runs `japa check`.
- The CoS calls `install`, which commits the result to the `~/.japa` git workspace and hot-reloads it.
- A failure rolls back automatically.
- Undo, manual rollback, last-known-good tagging, runtime auto-rollback and boot safe mode keep the daemon recoverable.

**Architecture:**
- `~/.japa` is a git repo, and `<home>/.staging` is a git worktree of it.
- Every change in the workspace (install, undo, rollback, safe mode) ends with one kernel call, `reconcile()`. It:
  1. reloads the content (skills and worker profiles);
  2. re-imports each workspace extension whose files changed, using the cache-busting `?v=<hash>`;
  3. disposes the old contributions and activates the new ones;
  4. reinstalls the Pi Durable extensions under the same names;
  5. recomputes the root's extension selection, every active job's agent (tool list) and the capabilities text.

  The kernel package itself is never modified.

**Spec:** `docs/superpowers/specs/2026-10-07-japa-design.md`. This plan covers §10, the hot reload in §5.2, the tool-list recompute in §5.3, `change_undo` with commits from §9.3, and the CLI commands `check`, `rollback` and `safe-mode` from §12.

## Global Constraints

- All constraints from M1–M4 still apply. **Prime directive from the user:** don't overcomplicate. Write minimal code and no code for its own sake.
- Use git through the `git` CLI (`execFileSync("git", ["-C", home, ...])`), with no git library. Commits are made with `-c user.name=japa -c user.email=japa@localhost` so a missing global git config can't break them.
- Workspace layout:
  - Tracked: `extensions/`, `skills/`, `workers/`, `settings.json`, `package.json`.
  - `.gitignore` lists `state.db*`, `secrets/`, `japa.sock`, `daemon.lock`, `node_modules/`, `.staging/` and `boots.json`.
  - The secrets directory and the database are never committed.
- The last-known-good tag is `japa-lkg`.
- Tests use real git in temp homes and never use the network. Models are faux.
- Workspace extensions import only `japa/sdk` and Node built-ins. `src/sdk.ts` must re-export everything an extension needs (e.g. `defineTool`, `Type`, `defineDoc`, `defineTask`, the contract types, `logChange`).

## Rulings (binding)

- **One shared staging worktree, at `<home>/.staging` on branch `staging`.**
  - The `builder` profile's cwd is `$JAPA_HOME/.staging`. Worker profile `cwd` now expands a leading `$JAPA_HOME` as well as `~`.
  - `install` copies `<home>/.staging/<dir>/<name>` over `<home>/<dir>/<name>`, then commits on the main branch. Builders don't need to commit.
  - Concurrent builder jobs would share the directory. The identity text tells the CoS to run one builder at a time.
  - *If wrong:* parallel builders could collide.
- **`japa check` for extensions** runs the manifest checks, typecheck, the extension's own tests (if any `*.test.ts` exist), and a smoke load.
  - The **routing eval** and the **storage/environment conformance suites** (spec §10.3) are deferred.
  - *If wrong:* weaker guarantees on routing quality and on the correctness of custom storage/environment adapters.
- **Runtime auto-rollback uses a simple failure count.**
  - An extension is rolled back when one of these happens:
    - its tool calls fail `settings.safety.toolErrorThreshold` (default 5) times in a row;
    - one of its surfaces or triggers fails to start during a reconcile.
  - This simplifies "error rate".
  - *If wrong:* a flaky but mostly working tool could be rolled back.
- **The CLI commands `japa rollback` and `japa safe-mode` only change files and git.** They print `Restart the daemon to apply.` if a daemon is running.
  - *If wrong:* the user needs one extra restart.
- **The kernel boundary holds by construction, not by sandbox.**
  - `install`, `rollback` and safe mode touch only `<home>`.
  - Jobs run in the `local` environment and could technically write anywhere the user can.
  - *If wrong:* a misbehaving worker could edit the kernel package. This is the same exposure as any local coding agent.

## Review Focus

1. **A failed install changes nothing.** A failing check, or an extension that fails to activate, leaves `<home>`, the git history (apart from the revert commit) and the running daemon exactly as they were. The CoS gets a plain error. Tests in Task 4.
2. **Hot reload is complete.** After `reconcile()`:
   - a new or changed extension's tools reach the CoS and the running jobs that select them;
   - a removed extension's tools and activations are gone;
   - a reloaded provider still serves models;
   - nothing is activated twice.

   Tests in Task 2.
3. **Undo and rollback restore the exact previous files and behaviour.** Tests in Tasks 4 and 5.
4. **Safe mode always lets the daemon start** when only workspace extensions are broken. A broken boot adapter gives one clear error that names `japa safe-mode --default-adapters`. Tests in Task 6.
5. **No secret or database file is ever committed.** Test in Task 1.

---

## File Structure

```
src/kernel/workspace.ts      ensureWorkspace, commit, revert, restorePath, tag, hasTag, dirHash
src/kernel/runtime.ts        the mutable runtime: per-extension activation, reconcile()
src/kernel/check.ts          checkSkill / checkWorker / checkExtension
src/kernel/install.ts        install tool, rollback tool, change_undo with commits
src/kernel/safety.ts         failure counting, auto-rollback, LKG timer, boot crash log / safe mode
src/kernel/boot.ts           slimmed: wires runtime, workspace, safety
src/cli/main.ts              + check, rollback, safe-mode
workers/builder.md           kernel builder profile
src/kernel/identity.md       + building and installing paragraph
```

---

### Task 1: Workspace git and the builder profile

**Files:**
- Create: `src/kernel/workspace.ts`, `workers/builder.md`
- Modify: `src/kernel/boot.ts`, `src/kernel/workers.ts`
- Test: `test/workspace.test.ts`, `test/workers.test.ts`

**Interfaces:**
- **`ensureWorkspace(home)`** runs at boot, right after `linkSdk`, and is idempotent:
  1. If `<home>/.git` is missing, run `git init -b main`.
  2. Write `.gitignore` if it is missing, then commit whatever is tracked as `Initial workspace`.
  3. If `<home>/.staging` is missing, run `git worktree add -B staging .staging main`.
- **`commit(home, paths: string[], message): string | undefined`** stages `paths` with `git add -A -- <paths>` and commits them. It returns the new sha, or `undefined` when nothing changed.
- **`revert(home, shas: string[]): string`** runs `git revert --no-edit` on the shas, newest first, and returns the new HEAD.
- **`restorePath(home, ref, path)`** restores `path` from `ref` with `git checkout <ref> -- <path>`. When `path` doesn't exist at `ref`, it removes the path instead (`git rm -r -q --ignore-unmatch`, then `rm -rf`).
- **`tag(home, name)`** runs `git tag -f <name> HEAD`, and **`hasTag(home, name)`** reports whether the tag exists.
- **`dirHash(dir): string`** returns a sha1 over the relative paths and contents of the files in `dir`, sorted. It returns `""` when `dir` is missing.
- **Worker `cwd`:** a leading `$JAPA_HOME` expands to `japaHome()`. `loadWorkers` takes `home` as a parameter so tests can pass it.
- **`workers/builder.md`:**
  - Frontmatter: `name: builder`, `tools: [read, write, edit, bash]`, `extensions: []`, `cwd: $JAPA_HOME/.staging`. The description is "Builds or changes japa's own skills, worker profiles and extensions in a staging copy of the workspace."
  - The body, in about 150 words:
    - Work only inside the current directory, which is a staging copy of `~/.japa`.
    - A skill goes in `skills/<name>/SKILL.md`, a worker profile in `workers/<name>.md`, and an extension in `extensions/<name>/index.ts`, importing only `japa/sdk`.
    - Read the authoring skills with `skill_read` when they exist.
    - Run `japa check <kind> <name>` until it passes.
    - Finish with `job_complete`, giving `kind` and `name` and saying how to use the result.
    - Never touch anything outside this directory.

- [ ] **Step 1: Write failing tests:**
  - `ensureWorkspace` creates the repo, `.gitignore`, the initial commit and the staging worktree, and running it twice is fine.
  - Writing `secrets/x` and `state.db` and calling `commit(home, ["."], "m")` commits neither.
  - Round trip: `commit` a skill, change it and commit again, then `revert` the second commit to restore the first content.
  - `restorePath` from a ref where the path is absent removes the path.
  - `dirHash` changes when the content changes.
  - A profile with `cwd: $JAPA_HOME/.staging` resolves under the home.
  - The packaged `builder` profile loads.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(kernel): workspace git and builder profile`

---

### Task 2: Runtime and hot reload

**Files:**
- Create: `src/kernel/runtime.ts`
- Modify: `src/kernel/boot.ts`, `src/kernel/jobs/cos.ts` (export `agentOf` or a `reconfigureJobs`)
- Test: `test/reload.test.ts`

**Interfaces:**
- **Move the runtime state out of `boot.ts` into `createRuntime(...)`.** The state is the loaded extensions, the built Pi Durable extensions, per-extension disposers, profiles, skills, selection and the capabilities text.
  - Boot order and behaviour stay the same. All existing tests must pass unchanged.
- **Disposers are tracked per extension.** `Map<extensionName, Dispose[]>` records each extension's runtime activations, so one extension can be deactivated alone.
  - Shutdown order stays as in M1: runtime contracts, then the harness, then the environment and provider disposers.
- **`reconcile(): Promise<{ errors: LoadError[] }>`:**
  1. Re-discover workspace extensions in `<home>/extensions` and compare each one's `dirHash` with the hash recorded when it was loaded. Packaged extensions never reload.
  2. Load each new or changed extension with `loadExtensions([...], contracts, hash)`. A removed extension is simply dropped.
  3. For each changed or removed extension, run its disposers in reverse order, then `registry.uninstall` it.
  4. For each new or changed extension, activate its contributions in contract order: provider, environment, tool (registry install), extension-defined contracts, trigger, surface.
     - A contribution of a boot-phase contract (`storage`, `secrets`) is not activated. It is listed in the result as a notice: `<name>: storage/secrets changes apply after a restart`.
  5. Reload skills and profiles: rebuild `japa-skills` and `japa-jobs`, then `registry.install` them (same-name replace).
  6. Replace the root `selection` array's contents.
  7. Run `configure(conversation, agentOf(profile))` on every job whose status is `queued`, `running` or `needs_input`, in one commit.
  8. Refresh the capabilities text.
  9. Return the activation and load errors of this reconcile. They are also merged into `status().errors`, replacing any earlier errors for the same extension.
- **Provider order on reload:** dispose the old provider before activating the new one. This avoids the M1 note where disposing a replaced provider could remove the new one.
- **`Daemon.reconcile()`** is exposed for tests and for the Task 4–6 callers.

- [ ] **Step 1: Write failing tests**, all through a booted daemon on a temp home, with `<home>/extensions/<x>/index.ts` written by the test:
  - **Add:** write extension `echo` with tool `echo`, then call `reconcile()`. The CoS can call `echo`.
  - **Change:**
    1. Change `echo` to reply `v2` and call `reconcile()`. The next call returns `v2`.
    2. A trigger contribution in it was disposed exactly once and started again.
  - **Remove:** delete the dir and call `reconcile()`. The root's resolved tools no longer include `echo`.
  - **Running job:** a job whose profile omits `extensions` and is still `running` (held) gets the new tool in its resolved tools after `reconcile()`.
  - **Content:** add a skill and a worker profile, then call `reconcile()`. The skills section lists the skill, and `job_start` accepts the new worker.
  - **Errors:** an extension that throws on import is reported in the `reconcile()` errors and in `status().errors`. Everything else still works.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(kernel): hot reload`

---

### Task 3: `japa check`

**Files:**
- Create: `src/kernel/check.ts`
- Modify: `src/cli/main.ts`, `src/sdk.ts` (re-exports needed by extensions)
- Test: `test/check.test.ts`

**Interfaces:**
- **`check(kind: "skill" | "worker" | "extension", name, dir /* workspace or staging root */, home): Promise<string[]>`** returns a list of problems. An empty list means it passed.
- **skill:**
  - `<dir>/skills/<name>/SKILL.md` exists.
  - The frontmatter parses, `name` equals the dir name, and the description is non-empty.
- **worker:**
  - `<dir>/workers/<name>.md` parses as a profile (`loadWorkers` on that single file).
  - It resolves against the installed and staged world: the model through `createModels()` with the builtin providers, environment `local` or one provided by an extension in `<dir>/extensions` or the packaged extensions, the built-in tool names, extension names, and skill names (packaged plus `<dir>/skills`).
- **extension:**
  1. **Manifest:** `loadExtensions` on packaged extensions plus `<dir>/extensions/<name>` passes for `name`. Each tool's description is ≤ 1024 chars. No tool name collides with a tool of another loaded extension.
  2. **Typecheck:** run japa's own `tsc` (`<packageRoot>/node_modules/.bin/tsc`) with a temporary tsconfig. It includes `<dir>/extensions/<name>` and uses the same compiler options as japa's `tsconfig.json`. Resolution of `japa/sdk` goes through `<home>/node_modules/japa`. Report the compiler output as one problem when it fails.
  3. **Tests:** if `<dir>/extensions/<name>/**/*.test.ts` exist, run japa's `vitest run` on that dir and report failure output.
  4. **Smoke load:** `boot()` a throwaway daemon in a temp home with:
     - `extensionDirs: [packaged, <dir>/extensions]`;
     - a check kit, i.e. memory storage and a faux provider as `models.cos`. Move `testKit`'s essentials into `src/kernel/check.ts` (or a tiny `src/kernel/kit.ts`) so the CLI can use them; `test/helpers.ts` then reuses them.

     The extension must show up in `status().extensions`, have no `status().errors` entry, appear in the capabilities text, and close cleanly.
- **CLI `japa check <kind> <name>`:** uses `dir = process.cwd()` and the home from `japaHome()`. It prints `ok` and exits 0, or prints each problem and exits 1.
- **`src/sdk.ts`** additionally re-exports what an extension needs, at minimum `defineTool`, `defineExtension`, `defineDoc`, `defineTask`, `section`, `hook`, `wrapTool`, `Type`, `StringEnum`, `logChange`, `ROOT_CONVERSATION_ID` and the contract types. Check what is already there.

- [ ] **Step 1: Write failing tests** (the extension tests may be slow; give them a 60 s timeout):
  - **Skills:** a skill whose `name` doesn't match its dir fails, and a good skill passes.
  - **Workers:** a worker naming an unknown tool fails, and a good worker passes.
  - **Extensions:**
    - An extension with a type error fails with tsc output.
    - An extension whose tool collides with `job_start`, or with another extension's tool, fails.
    - An extension whose activation throws fails the smoke load.
    - A good extension with one tool, importing `japa/sdk`, passes.
  - **CLI:** run in a temp staging dir with a good skill; it exits 0 and prints `ok`.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(kernel): japa check`

---

### Task 4: Install and undo

**Files:**
- Create: `src/kernel/install.ts`
- Modify: `src/kernel/settings-tools.ts` (`change_undo` with commits), `src/kernel/cos.ts`, `src/kernel/identity.md`, `src/kernel/boot.ts`
- Test: `test/install.test.ts`

**Interfaces:**
- **CoS tool `install({ kind, name })`:**
  1. Run `check(kind, name, <home>/.staging, home)`. If it finds problems, reply `Not installed: <problems>` and change nothing.
  2. Copy `.staging/<dir>/<name>` over `<home>/<dir>/<name>`. The dir is `skills/`, `workers/` (a `.md` file) or `extensions/`.
  3. Call `commit(home, [path], "Install <kind> <name>")`. If nothing changed, reply `Already installed.`
  4. Call `reconcile()`.
  5. **Health check:** the reconcile returned no errors for `name`. For a skill or worker, it must also appear in the loaded skills or profiles.
  6. **On failure:**
     - `revert(home, [sha])`, then `reconcile()` again, which reactivates the previous version.
     - Reply `Not installed — <errors>. Nothing changed.`
     - Nothing is logged in `japa.changes`.
  7. **On success:**
     - Log `{ title: "Installed <kind> <name>", howToUse: "", undo: { commits: [sha] } }`.
     - Reply `Installed <kind> <name>. (change <id>)`, followed by any restart notice from the reconcile.
- **`change_undo` with commits:** `revert(home, commits)`, then `reconcile()`, then remove the entry and reply `Undid: <title>`. Changes that have both `configOps` and `commits` apply both, commits first.
- **`identity.md`** gets one short paragraph on building:
  - Choose the mechanism with the ladder.
  - Start one `builder` job at a time, with a brief that states the requirement and the chosen mechanism.
  - When it completes, call `install({ kind, name })`.
  - Verify with a real dry run, then report.
  - If the install fails, retry through the builder or tell the user plainly.

- [ ] **Step 1: Write failing tests:**
  - **Skill:**
    1. A good skill written into `.staging/skills/s/SKILL.md` installs: it is committed, listed in the skills section and logged.
    2. `change_undo` removes it from the workspace and the section.
  - **Extension:**
    1. A good extension in staging installs, and its tool works for the CoS.
    2. Undo removes the tool.
  - **Failed check:** a skill with bad frontmatter replies `Not installed:`, and nothing is committed.
  - **Failed activation:**
    1. Install a working `echo` (v1).
    2. Stage a v2 whose trigger throws on start, or whose tool name collides. Make sure it would pass `check`, or check its activation at install. The point is that activation failure *at install* is caught.
    3. The install fails, the git log shows the install and its revert, and `echo` v1 still works.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(kernel): install and undo`

---

### Task 5: Rollback, last-known-good, runtime auto-rollback

**Files:**
- Create: `src/kernel/safety.ts`
- Modify: `src/kernel/install.ts` (rollback tool), `src/kernel/settings.ts` (`safety` defaults), `src/kernel/runtime.ts`, `src/cli/main.ts`
- Test: `test/safety.test.ts`

**Interfaces:**
- **Settings:** `safety: { toolErrorThreshold: 5, goodAfterMinutes: 10 }`.
- **Last-known-good:**
  - At boot, `ensureWorkspace` tags `japa-lkg` if the tag is absent.
  - After a successful install or undo, `safety` schedules an unref'd timer for `goodAfterMinutes`. If no auto-rollback has happened since, the timer tags `japa-lkg` at HEAD.
  - Expose `daemon.markGood()` so tests can force the tag.
- **Runtime failure counting:** a kernel Pi Durable extension `japa-safety`, selected by the root and by every job, has an `afterTool` hook.
  - It maps the tool name to its extension through the runtime's built extensions.
  - An error result increments that extension's counter, and a success resets it.
  - When a counter reaches `toolErrorThreshold`, it calls `autoRollback(name, reason)`.
- **Surface and trigger start failures during `reconcile()`** also call `autoRollback`. This does not apply at boot, where safe mode covers it.
- **`autoRollback(name, reason)`:**
  1. `restorePath(home, "japa-lkg", "extensions/<name>")`.
  2. `commit(..., "Roll back extension <name>")`.
  3. `reconcile()`.
  4. Post `[japa] I rolled back <name> to its last working version: <reason>` to the root, with requestId `rollback:<sha>`.
  5. Log a change: `{ title: "Rolled back <name>", undo: { commits: [sha] } }`.
- **CoS tool `rollback({ kind, name, to? })`:** restores the path from `to ?? "japa-lkg"`, commits, reconciles, logs a change and replies `Rolled back <kind> <name>.`
- **CLI `japa rollback <kind> <name> [to]`:** does the same with git only, then prints `Rolled back. Restart the daemon to apply.`

- [ ] **Step 1: Write failing tests:**
  - **Auto-rollback:**
    1. Install `flaky` v1, which works, then call `markGood()`.
    2. Install v2, whose tool throws.
    3. After 5 failing CoS calls, `flaky` is v1 again (the tool works), a `[japa] I rolled back flaky` input reached the root once, and the change is logged.
  - **Manual rollback:** `rollback({ kind: "skill", name })` to `japa-lkg` restores the tagged version.
  - **CLI rollback:** `japa rollback` on a temp home works without a daemon.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(kernel): rollback and auto-rollback`

---

### Task 6: Boot safe mode

**Files:**
- Modify: `src/kernel/safety.ts`, `src/kernel/boot.ts`, `src/cli/main.ts`
- Test: `test/safe-mode.test.ts`

**Interfaces:**
- **Crash log:**
  - At its start, boot appends `Date.now()` to `<home>/boots.json`, an array.
  - A daemon that stays up for 5 minutes (unref'd timer) or closes cleanly clears the file.
  - If, before appending, the file holds ≥ 3 timestamps within the last 5 minutes, boot enters safe mode first.
- **`enterSafeMode(home, { defaultAdapters })`:**
  1. If `japa-lkg` exists, `restorePath(home, "japa-lkg", p)` for each of `extensions`, `skills` and `workers`.
  2. With `defaultAdapters`, set `storage.adapter = "sqlite"` and `secrets.adapter = "file"` in the user `settings.json`.
  3. Commit `Safe mode: restored last-known-good`.
  4. Clear `boots.json`.
- **After a safe-mode boot,** post once to the root: `[japa] I restarted in safe mode after repeated crashes and restored the last working setup.` The requestId is `safe-mode:<sha>`.
- **Boot adapter failure:** if a boot adapter (storage/secrets) still fails, append ` — run "japa safe-mode --default-adapters" to restore the defaults.` to the error.
- **CLI `japa safe-mode [--default-adapters]`:** runs `enterSafeMode` and prints `Restored the last working setup. Start the daemon with: japa daemon`.

- [ ] **Step 1: Write failing tests:**
  - **Safe mode boot:**
    1. Install a good extension and call `markGood()`.
    2. Write a workspace extension whose module throws at import. That alone doesn't crash boot, so simulate the crash loop by writing `boots.json` with 3 recent timestamps.
    3. Boot: the broken extension's dir is restored to its `japa-lkg` state (absent), and the safe-mode notice reaches the root.
  - **Broken boot adapter:**
    1. Set `storage.adapter` to `"broken"`. Boot fails with the safe-mode hint.
    2. `enterSafeMode(home, { defaultAdapters: true })` leaves `storage.adapter` as `"sqlite"`.
    3. Boot then succeeds. This uses a temp home with the real sqlite adapter.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(kernel): boot safe mode`
