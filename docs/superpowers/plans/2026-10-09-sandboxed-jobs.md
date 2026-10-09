# Sandboxed jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace worker profiles and the `.staging` copy with one job type. Every job runs in a bubblewrap sandbox and
edits a private clone of `~/.japa`, and when the job finishes its changes are checked and merged, never copied over
the real workspace.

**Architecture:**
- **Sandbox:** the desktop extension's out-of-process `ExecutionEnv` (`env-server.ts` and the `remoteEnv` client)
  moves into the kernel. Each job gets one env-server, run under `bwrap`, with the job's git clone mounted at the
  home path.
- **Going live:** on `job_complete`, the `JobRun` task gains a `publish` phase: narrow, check (sandboxed), merge into
  the real repo under a workspace lock, reconcile, log. The report then ends with one outcome line.
- **Removals:** profiles, `install`, staging, the desktop environment and macOS.

**Tech Stack:** TypeScript on Node 24 (type stripping), pi-durable, pi-ai, vitest, git, bubblewrap.

**Spec:** `docs/superpowers/specs/2026-10-09-sandboxed-jobs-design.md`

## Global Constraints

- **Platform:** Linux only (WSL included). Jobs need `bwrap`; the binary is `process.env.JAPA_BWRAP ?? "bwrap"` (tests
  point it at a missing path to simulate its absence).
- **Probe:** `bwrap --ro-bind / / true` must exit 0.
- **Refusal copy:** `Jobs can't run: <reason>. Install bubblewrap: sudo apt install bubblewrap`.
- **Clones:**
  - Each lives at `<home>/.jobs/<jobId>`, and `.jobs/` is added to the workspace `IGNORED` list.
  - The starting commit is the clone's `refs/remotes/origin/main`.
  - Kept clones (and `.jobs/staging-archive`) are pruned after 7 days; orphaned clones are pruned too.
- **What gets merged:** only `extensions/` and `skills/`. Every other changed path is dropped and reported as
  `Dropped: <paths>.`
- **Check:** `japa check` runs per changed component, inside the sandbox, with a 10-minute timeout.
- **Commits:**
  - Commit and merge message: `Job <n>: <title>`.
  - Change title: `Job <n>: changed <comma-separated paths>`.
  - Adoption commit: `Edits made outside japa`.
- **Outcome lines** (exact copy, spec §4.5):
  - `Live: <paths> (change <id>).`
  - `Not live: check failed for <path>: <problems>. Kept at ~/.japa/.jobs/<id>.`
  - `Not live: <file> changed since this job started. Kept at ~/.japa/.jobs/<id>.` (conflicting files joined with
    `, `)
  - `Not live: <path> failed to load: <error>. Reverted. Kept at ~/.japa/.jobs/<id>.`
- **The sandbox's environment:** `PATH HOME USER SHELL LANG TZ TERM` only, copied from the daemon when set.
- **`jobs.thinking`:** one of `off|minimal|low|medium|high|xhigh`, default `medium`.
- **`job_start({ title, brief, model?, thinking? })`:** `model` is `"<provider>/<modelId>"`.
- **Git:** every git call in the real workspace goes through `workspace.ts`'s `git()`, which uses author
  `japa <japa@localhost>`.

## Review Focus

1. **The job sees its clone, not the real `~/.japa`, including git.** Inside the sandbox, `git -C ~/.japa log` works,
   and `git fetch` fails because the real repo is invisible. → Task 2 test `git works in the clone, origin is
   unreachable`.
2. **The real tree is dirty only in `settings.json` and the merge still works.** Settings tools write `settings.json`
   at any time. A merge whose job commit touches only components must succeed with `settings.json` modified. → Task 4
   test `merges while settings.json has local changes`.
3. **A cancelled job's clone is kept, not published.** If `job_stop` lands while `publish` is waiting on the lock, the
   job must not go live. → Task 5 test `a job stopped before publish is not merged`.
4. **Restart mid-publish.** The `JobRun` resumes in `publish`. The marker in the clone (`.git/japa-merged`) prevents a
   second merge, and boot aborts a leftover `MERGE_HEAD`. → Task 4 test `publish is idempotent after a merge`, and
   Task 6 test `boot aborts an unfinished merge`.
5. **Deleting a component goes live.** A job that removes `skills/x` must merge the removal and skip `check` for it.
   → Task 4 test `a deleted skill goes live without a check`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/kernel/sandbox/env-server.ts` | Moved from `extensions/desktop/env-server.ts`, unchanged. |
| `src/kernel/sandbox/remote-env.ts` | Moved client from `extensions/desktop/env.ts`: `startEnvServer`, `remoteEnv`, `LOST`, `ENV_MODULE`, `SERVER`, `EnvServer`. No `isDesktop`. |
| `src/kernel/sandbox/bwrap.ts` | `probeSandbox`, `sandboxArgs`, `readOnlyPaths`, `runSandboxed`. |
| `src/kernel/sandbox/jobs.ts` | `createJobSandboxes`: the clone plus env-server per job, and closing them. |
| `src/kernel/jobs/clone.ts` | `cloneDir`, `ensureClone`, `pruneClones`. |
| `src/kernel/jobs/publish.ts` | `createPublisher`: narrow, check, merge, load, log; the outcome line. |
| `src/kernel/workspace-lock.ts` | `createWorkspaceLock`. |
| `src/kernel/workspace.ts` | Exports `git`; drops staging; adds `retireStaging`, `abortPending`, `adoptOutsideEdits`. |
| `src/kernel/frontmatter.ts` | Gains `parseFrontmatter` from `workers.ts`. |
| deleted | `src/kernel/workers.ts`, `workers/`, `skills/building-workers/`, `src/kernel/install.ts`'s `installTool` (`rollBack`, `rollBackAndLog` and `rollbackTool` stay, moved to `src/kernel/rollback.ts`), `test/workers.test.ts`, `test/install.test.ts` (its rollback cases move to `test/rollback.test.ts`). |

---

### Task 1: Move the out-of-process env into the kernel

**Files:**
- Create: `src/kernel/sandbox/env-server.ts` (`git mv` from `extensions/desktop/env-server.ts`)
- Create: `src/kernel/sandbox/remote-env.ts` (`git mv` from `extensions/desktop/env.ts`)
- Modify: `extensions/desktop/index.ts`, `extensions/desktop/lock.ts`, `test/desktop-env.test.ts` (rename to
  `test/remote-env.test.ts`), `test/desktop-helpers.ts`

**Interfaces:**
- Produces:
  - `startEnvServer(command: string[], lost = LOST): EnvServer`. `lost` is the message used when the server dies.
    The desktop keeps `LOST` ("The desktop connection was lost"); jobs pass `"The job's sandbox stopped"`.
  - `remoteEnv(server: () => Promise<EnvServer>, cwd: string, id: string): ExecutionEnv`
  - `LOST`, `ENV_MODULE`, `SERVER`, `type EnvServer`, all exported from `src/kernel/sandbox/remote-env.ts`
  - `src/sdk.ts` re-exports nothing new. The desktop imports by relative path `../../src/kernel/sandbox/remote-env.ts`,
    as it already imports `../../src/sdk.ts`.
  - `isDesktop` stays in `remote-env.ts` for now; Task 8 deletes it.

- [ ] **Step 1:** `git mv` both files and fix imports, including `SERVER`'s `new URL("./env-server.ts", …)`, which
  now resolves next to `remote-env.ts`.
- [ ] **Step 2:** Run `npx vitest --run test/remote-env.test.ts test/desktop.test.ts test/desktop-computer.test.ts
  test/desktop-browser.test.ts`. Expected: PASS, with no other changes.
- [ ] **Step 3:** Run `npm run typecheck`, then commit: `refactor: move the out-of-process env into the kernel`.

### Task 2: bwrap sandbox

**Files:**
- Create: `src/kernel/sandbox/bwrap.ts`
- Test: `test/sandbox.test.ts`

**Interfaces:**
- Produces:
  - `probeSandbox(): string | undefined`: the failure reason (stderr's last line, or the spawn error), or undefined
    when the probe passes.
  - `type SandboxSpec = { home: string; clone: string; readOnly: string[]; hidden: string[]; shared: string[] }`
    - `home`: the real japa home path, used as the mount point.
    - `hidden`: directories that get an empty tmpfs (the external secrets dir).
    - `shared`: real paths under `home` bound back in place (`<home>/desktop/shared`).
  - `readOnlyPaths(packageRoot: string, userHome = homedir()): string[]`:
    - `dirname(packageRoot)` when `basename(packageRoot) === "app"` (the installed layout, which includes `node/`),
      else `packageRoot`;
    - plus `<userHome>/.local/bin/japa` and `<userHome>/.config/systemd/user/japa.service`.
  - `sandboxArgs(spec: SandboxSpec): string[]`: the bwrap arguments before the command, in spec §3.2's order:
    - `--bind / /`
    - `--dev /dev`
    - `--unshare-pid`, `--proc /proc`
    - `--bind <clone> <home>`
    - `--bind-try` for each `shared`
    - `--tmpfs` for each existing `hidden`
    - `--ro-bind-try` for each `readOnly`
    - `--die-with-parent`, `--new-session`
    - `--clearenv`, then `--setenv` per allowed variable
    - `--chdir <cwd>`

    Its full signature is `sandboxArgs(spec: SandboxSpec, cwd = homedir()): string[]`.
  - `runSandboxed(spec: SandboxSpec, command: string[], o: { timeoutMs: number; cwd?: string }): Promise<{ code: number | null; output: string; timedOut: boolean }>`

- [ ] **Step 1: Write the failing tests.** Each runs `runSandboxed` with `bash -c` against a temp home that holds
  `secrets/x` and `state.db`, a clone made with `git clone --local`, a `readOnly` temp file, and a `hidden` temp dir.
  - `probe passes here, fails with JAPA_BWRAP=/nonexistent`: `probeSandbox()` is undefined; with the variable set,
    the reason is a non-empty string.
  - `the real home is replaced by the clone`: `test -e $HOME_PATH/secrets/x` fails, `test -e $HOME_PATH/state.db`
    fails, and `$HOME_PATH/marker` (committed in the clone) exists.
  - `git works in the clone, origin is unreachable`: `git -C <home> log --oneline` exits 0; `git -C <home> fetch`
    exits non-zero.
  - `read-only paths can't be written`: `echo x > <readOnly file>` exits non-zero.
  - `hidden dirs are empty`: `ls <hidden>` prints nothing.
  - `shared dirs are the real ones`: writing `<home>/desktop/shared/f` inside makes it exist on the host under the
    real home.
  - `no daemon in /proc, minimal env`: `ls /proc | grep -c '^[0-9]'` is under 5, and `env` prints only allowed names.
    Set `FOO_SECRET=1` in `process.env` first and assert it's absent.
  - `processes die with the sandbox`: start `sleep 300 &` and print its PID via `/proc` inside; when `runSandboxed`
    resolves, `pgrep -f "sleep 300"` on the host finds none.
  - `timeout`: `sleep 5` with `timeoutMs: 200` gives `timedOut: true`.
  - `cwd`: `pwd` with `cwd: <home>/skills` prints that path.
- [ ] **Step 2:** Run `npx vitest --run test/sandbox.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `bwrap.ts`. `runSandboxed` spawns `[bwrap, ...sandboxArgs(spec), ...command]` and kills
  it with SIGKILL on timeout.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(sandbox): bwrap sandbox with a per-job home`.

### Task 3: Job clones and the sandboxed job environment

**Files:**
- Create: `src/kernel/jobs/clone.ts`, `src/kernel/sandbox/jobs.ts`
- Modify:
  - `src/kernel/env.ts`: `createEnvDispatcher` loses the `environments` lookup for jobs.
  - `src/kernel/boot.ts`: wire it in, probe at boot.
  - `src/kernel/jobs/state.ts`: `JobDoc` becomes `{ jobId: string }`.
  - `src/kernel/workspace.ts`: add `.jobs/` to `IGNORED`.
- Test: `test/clone.test.ts`, `test/env.test.ts`, `test/jobs.test.ts`

**Interfaces:**
- Consumes: Task 1's `startEnvServer` and `remoteEnv`; Task 2's `sandboxArgs`, `readOnlyPaths` and `probeSandbox`.
- Produces:
  - `cloneDir(home: string, jobId: string): string`
  - `ensureClone(home: string, packageRoot: string, jobId: string): string`. If the clone is missing, it runs
    `git clone -q --local <home> <dir>` and `linkSdk(dir, packageRoot)`. It returns the dir.
  - `pruneClones(home: string, keep: (jobId: string) => boolean, now = Date.now()): void`. It deletes
    `<home>/.jobs/*` whose mtime is older than 7 days, or whose job `keep` rejects. It skips `staging-archive`
    except by age.
  - `type JobSandboxes = { env(conversationId: string, jobId: string): ExecutionEnv; spec(jobId: string): SandboxSpec; close(jobId: string): void; closeAll(): void; problem: string | undefined }`
  - `createJobSandboxes(o: { home: string; packageRoot: string; hidden: string[] }): JobSandboxes`
    - `env` lazily runs `ensureClone` and starts one env-server per job:
      `startEnvServer([bwrap, ...sandboxArgs(spec(jobId)), process.execPath, SERVER, ENV_MODULE])`, with
      `cwd = homedir()`.
    - A server that has closed is started again on the next call.
    - `problem` is `probeSandbox()`'s result, taken once at creation.
  - `createEnvDispatcher(local: EnvironmentAdapter, deny: string[], jobs: (conversationId: string) => Promise<ExecutionEnv>)`.
    The root conversation gets `readOnly(local)`, as now; any other conversation gets `jobs(id)`.
  - In `boot.ts`:
    - `hidden` is the external `settings.secrets.dir`, when it is outside `home`.
    - `jobs(id)` reads `JobDoc.jobId` and returns `sandboxes.env(id, jobId)`.
    - If `sandboxes.problem` is set, push `{ name: "sandbox", error: <refusal copy> }` onto `rt.errors`.

- [ ] **Step 1: Write the failing tests:**
  - `clone.test.ts`:
    - `ensureClone makes a clone at HEAD with origin/main as its base`: `rev-parse origin/main` equals the real
      `HEAD`, and `node_modules/japa` links to the package root.
    - `ensureClone is idempotent`.
    - `pruneClones removes old and orphaned clones, keeps recent ones`: uses `utimesSync`.
  - `env.test.ts`: `jobs get the env from the jobs callback, the root a read-only local env`.
  - `jobs.test.ts`:
    - `a job's bash runs in its clone`: the faux worker calls `bash` with `ls <home>/secrets; cat <home>/marker`. The
      tool result has no secrets listing, and the clone file exists afterwards in `<home>/.jobs/1`.
    - `a dead sandbox fails one call, then restarts`: the worker runs `bash` with `kill -9 1`, which ends the
      sandbox. That tool result contains `The job's sandbox stopped`. The worker's next `bash` (`echo ok`) returns
      `ok`.
    - `job_start refuses without a sandbox`: set `JAPA_BWRAP=/nonexistent` before `bootTest`. The `job_start` reply is
      `Jobs can't run: … Install bubblewrap: sudo apt install bubblewrap`, and `daemon.status().errors` has
      `name: "sandbox"`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. `job_start` checks a `sandboxProblem: () => string | undefined` passed through
  `JobsOptions`, and refuses before committing.
- [ ] **Step 4:** Run `npx vitest --run test/clone.test.ts test/env.test.ts test/jobs.test.ts`. Expected: PASS. Then
  run the full suite: jobs tests that used the `local` environment now run sandboxed and must still pass.
- [ ] **Step 5:** Commit: `feat(jobs): every job runs in a sandbox on its own clone`.

### Task 4: Publishing a job's changes

**Files:**
- Create: `src/kernel/jobs/publish.ts`, `src/kernel/workspace-lock.ts`
- Modify: `src/kernel/workspace.ts` (export `git`)
- Test: `test/publish.test.ts`

**Interfaces:**
- Consumes: `git` and `head` from `workspace.ts`; Task 2's `runSandboxed`; Task 3's `cloneDir` and `JobSandboxes.spec`.
- Produces:
  - `createWorkspaceLock(): <T>(fn: () => Promise<T>) => Promise<T>`: a promise-chain mutex. A rejected `fn` doesn't
    poison the chain.
  - `type PublishDeps = { home: string; packageRoot: string; lock: ReturnType<typeof createWorkspaceLock>; check(jobId: string, kind: "skill" | "extension", name: string): Promise<string[]>; reconcile(): Promise<{ errors: LoadError[] }>; loaded(kind: "skill" | "extension", name: string): boolean; logChange(change: Omit<Change, "id" | "at">): Promise<string>; scheduleGood(): void }`
  - `createPublisher(deps: PublishDeps): (job: { id: string; title: string }) => Promise<string | undefined>`. It
    returns the outcome line, or undefined when nothing changed. Behaviour follows spec §4.3:
    - **Narrow:** `git add -A`. For each path in `git diff --cached --name-only origin/main` outside
      `extensions/`/`skills/`, restore it from `origin/main` (or `git rm --cached` and delete it when absent there).
    - **Commit:** if anything is still staged, commit `Job <n>: <title>`.
    - **Components:** the changed components are the unique `extensions/<x>` and `skills/<x>` prefixes of
      `git diff --name-only origin/main HEAD`.
    - **Check:** `deps.check` runs for each component that still exists in the clone.
    - **Merge:** under `deps.lock`, run `git fetch -q <clone> HEAD` and `git merge --no-ff -m … FETCH_HEAD`. On
      failure, collect `git diff --name-only --diff-filter=U` and run `git merge --abort`.
    - **Marker:** after a merge, write the merge sha to `<clone>/.git/japa-merged`. If the marker already exists,
      skip the merge and use its sha.
    - **Load:** call `reconcile`. A component fails when it has a load error by name (extensions), or when
      `!loaded("skill", x)` for a skill that exists. On failure run `git revert --no-edit -m 1 <sha>`, reconcile
      again, and remove the marker.
    - **Success:** call `logChange`, then `scheduleGood`, then delete the clone.
    - **No changes:** delete the clone and return undefined.
  - In `boot.ts`, `check` runs
    `runSandboxed(spec(jobId), [process.execPath, join(packageRoot, "src/cli/main.ts"), "check", kind, name], { timeoutMs: 600_000, cwd: home })`.
    Inside the sandbox `home` is the clone. A non-zero exit gives `[output]`; a timeout gives
    `["timed out after 10 minutes"]`.

- [ ] **Step 1: Write the failing tests.** Use a temp workspace (`ensureWorkspace`), clones made by `ensureClone`, and
  fake `check`, `reconcile` and `loaded` deps:
  - `nothing changed: undefined, clone deleted`.
  - `an extension and a skill go live in one merge`: returns `Live: extensions/e, skills/s (change 1).`; the real
    `HEAD` is a merge commit with message `Job 1: t`; `logChange` was called once with `undo.commits` = [merge sha].
  - `settings.json is dropped and reported`: the line ends with ` Dropped: settings.json.`, and the real
    `settings.json` is unchanged.
  - `a failed check changes nothing`: `Not live: check failed for extensions/e: boom. Kept at ~/.japa/.jobs/1.`;
    `HEAD` is unchanged and the clone still exists.
  - `regression: a fix made since the job started is kept`: commit a change to `extensions/e/a.ts` in the real repo
    after cloning. The job changes `extensions/e/b.ts`. Both changes are in the real tree afterwards.
  - `regression: the same lines conflict`: both sides change line 1 of `extensions/e/index.ts`. The result is
    `Not live: extensions/e/index.ts changed since this job started. Kept at ~/.japa/.jobs/1.`; `HEAD` is unchanged
    and there is no `MERGE_HEAD`.
  - `a load failure reverts`: `reconcile` returns `{ errors: [{ name: "e", error: "bad" }] }`. The result is
    `Not live: extensions/e failed to load: bad. Reverted. Kept at …`, and the real tree equals its pre-merge
    contents.
  - `merges while settings.json has local changes`: Review Focus 2.
  - `a deleted skill goes live without a check`: Review Focus 5; `check` is never called with `s`.
  - `publish is idempotent after a merge`: call twice. The second call finds the marker and doesn't merge again
    (`git rev-list --merges --count HEAD` is 1).
  - `the lock serialises`: two `lock(fn)` calls run one after the other, and the second runs even if the first
    rejects.
- [ ] **Step 2:** Run `npx vitest --run test/publish.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `workspace-lock.ts` and `publish.ts`. Export `git` from `workspace.ts`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(jobs): publish a job's changes by merge, never by copy`.

### Task 5: Wire publishing into jobs; remove `install`; take the lock everywhere

**Files:**
- Modify:
  - `src/kernel/jobs/run.ts`: the `publish` phase.
  - `src/kernel/jobs/cos.ts`: `JobsOptions` gains `publish` and `closeSandbox`; `job_stop` closes the sandbox.
  - `src/kernel/boot.ts`: build the publisher; drop `installTool`; wrap `rollbackTool`, `messaging.rollback`, the
    `undone` revert and `createSafety`'s `autoRollback` in `lock`.
  - `src/kernel/settings-tools.ts`: `change_undo` takes a `lock`.
  - `src/kernel/safety.ts`: `autoRollback` takes a `lock`.
- Create: `src/kernel/rollback.ts` (`rollBack`, `rollBackAndLog`, `rollbackTool` moved from `install.ts`, kinds
  `["skill", "extension"]`)
- Delete: `src/kernel/install.ts`, `test/install.test.ts` (its rollback tests move to `test/rollback.test.ts`)
- Test: `test/jobs.test.ts`, `test/rollback.test.ts`

**Interfaces:**
- Consumes: Task 4's `createPublisher` and `createWorkspaceLock`; Task 3's `JobSandboxes.close`.
- Produces:
  - `JobRunState` gains `{ phase: "publish"; report: { seq: number; content: string } }`.
  - `decide` returns `{ report: string; completed: true }` for a `job_complete` run.
  - `deliver` checkpoints to `publish` for those, and to `report` otherwise.
  - The `publish` phase:
    - If the job is `cancelled`, go to `report` with no outcome line.
    - Otherwise call `options.publish({ id, title })` and append `\n\n<line>` to `report.content` when there is a
      line.
    - Then checkpoint `report`.
  - The `report` phase ends by calling `options.closeSandbox(jobId)` when the job is `done`, `failed` or
    `cancelled`.
  - `jobRun(settings, hooks: { publish(job: { id: string; title: string }): Promise<string | undefined>; closeSandbox(jobId: string): void })`

- [ ] **Step 1: Write the failing tests** in `jobs.test.ts`, with a faux worker that writes
  `<home>/skills/hello/SKILL.md` with `bash`, then calls `job_complete`:
  - `a job's skill goes live when it completes`:
    - the report ends with `Live: skills/hello (change 1).`;
    - the real `<home>/skills/hello/SKILL.md` exists;
    - `daemon` skills include `hello`;
    - `<home>/.jobs/1` is gone.
  - `a job stopped before publish is not merged`: Review Focus 3. Hold the worker's final response, call `job_stop`,
    then release it. The real tree has no `skills/hello`, and `<home>/.jobs/1` remains.
  - `the CoS has no install tool`: the root tools exclude `install` and include `rollback`.
  - `rollback.test.ts` keeps the former `install.test.ts` rollback cases, with kinds `skill` and `extension`, plus
    `rollback waits for a publish in progress`: hold `lock`, start a rollback, and assert it resolves only after
    release.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement the publish phase, the hooks, the lock wiring and the `rollback.ts` move. Then delete
  `install.ts`.
- [ ] **Step 4:** Run `npx vitest --run test/jobs.test.ts test/rollback.test.ts test/safety.test.ts
  test/settings-tools.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(jobs): completed jobs publish their changes; remove install`.

### Task 6: Workspace hygiene at boot; retire staging

**Files:**
- Modify:
  - `src/kernel/workspace.ts`: `ensureWorkspace` no longer creates `.staging`. Add `retireStaging`, `abortPending`
    and `adoptOutsideEdits`.
  - `src/kernel/boot.ts`: call them after `ensureWorkspace` and before loading extensions; log the adoption once
    `root` exists; prune clones at boot and hourly.
  - `src/kernel/safety.ts`: `enterSafeMode` paths become `["extensions", "skills"]`, and it commits only those.
- Test: `test/workspace.test.ts`, `test/boot.test.ts`

**Interfaces:**
- Produces:
  - `retireStaging(home: string): void`. If `.staging` exists, move its untracked files (`git -C .staging ls-files
    --others --exclude-standard`) under `.jobs/staging-archive/`, then run `git worktree remove --force .staging`
    and `git branch -D staging`. Errors from a missing branch are ignored.
  - `abortPending(home: string): void`. If `.git/MERGE_HEAD` exists, run `git merge --abort`; if
    `.git/REVERT_HEAD` exists, run `git revert --abort`.
  - `adoptOutsideEdits(home: string): string | undefined`. It runs
    `commit(home, ["extensions", "skills"], "Edits made outside japa")` and returns the sha.
  - In boot, when the sha is defined, log the change `{ title: "Edits made outside japa", howToUse: "", undo: { commits: [sha] } }`.
  - `pruneClones(home, (id) => id in jobs && active-or-kept)` runs at boot and inside the hourly `pruneOld`.

- [ ] **Step 1: Write the failing tests:**
  - `retireStaging archives untracked files and removes the worktree and branch`.
  - `ensureWorkspace no longer creates .staging`.
  - `adoptOutsideEdits commits only extensions and skills`: a dirty `settings.json` stays uncommitted.
  - `boot aborts an unfinished merge`: Review Focus 4. Leave a conflicting `git merge` in progress in the home, then
    boot. Afterwards there is no `MERGE_HEAD`.
  - `boot logs adopted edits as a change`: `changes_list` shows `Edits made outside japa`.
- [ ] **Step 2:** Run `npx vitest --run test/workspace.test.ts test/boot.test.ts test/safe-mode.test.ts`. Expected:
  FAIL.
- [ ] **Step 3:** Implement. Remove `stage()` from `test/helpers.ts` along with the tests that used it.
- [ ] **Step 4:** Run the same tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(workspace): keep the real workspace clean; retire staging`.

### Task 7: One job type: no profiles, `model` and `thinking` on `job_start`

**Files:**
- Modify:
  - `src/kernel/jobs/cos.ts`: `agentOf(options, job)`, `job_start` params, `reconfigureJobs`.
  - `src/kernel/jobs/state.ts`: `Job` loses `worker` and gains `model?: string` and `thinking?: ThinkingLevel`.
  - `src/kernel/runtime.ts`: `reloadContent` has no workers; drop `runtime.profiles`; push a `workers` notice.
  - `src/kernel/skills.ts`: drop the `JobDoc.skills` filter.
  - `src/kernel/capabilities.ts`: no "Workers:".
  - `src/kernel/check.ts`: `CHECK_KINDS = ["skill", "extension"]`; delete `checkWorker`.
  - `src/cli/main.ts`: the usage text.
  - `src/kernel/settings.ts`: `jobs.thinking`.
  - `src/kernel/messaging/menu/jobs.ts`: show the model and thinking level.
  - `src/kernel/messaging/menu/settings.ts`: add a `Job thinking` row next to the models.
  - `src/kernel/frontmatter.ts`: gains `parseFrontmatter`.
- Delete: `src/kernel/workers.ts`, `workers/`, `test/workers.test.ts` (its `parseFrontmatter` cases move to
  `test/frontmatter.test.ts`)
- Test:
  - `test/jobs.test.ts`, `test/check.test.ts`, `test/capabilities.test.ts`, `test/messaging-menu.test.ts`,
    `test/settings.test.ts`.
  - The profile cases in `test/skills.test.ts`, `test/availability.test.ts` and `test/reload.test.ts` are rewritten
    for profile-less jobs.

**Interfaces:**
- Produces:
  - `JobsOptions = { settings; models: Models; extensions; available; skills; safety; sandboxProblem(): string | undefined; publish; closeSandbox }`
  - `agentOf(options, job: Pick<Job, "model" | "thinking">)` returns:
    - `model`: `parse(job.model) ?? settings.models.worker ?? settings.models.cos`
    - `thinkingLevel`: `job.thinking ?? settings.jobs.thinking`
    - `extensions`: `[WorkerExtension, CodingTools, skills, safety, ...all available]`
    - no `tools.remove` and no `cwd`
  - `job_start` parameters:
    - `title`, `brief`;
    - `model?: string`, refused when `parse` fails or `models.getModel` is undefined, with the reply
      `Unknown model "<m>". Models: <provider/id, …>`;
    - `thinking?: StringEnum([...levels])`.
  - `Settings.jobs.thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"`, default `"medium"`, with
    schema validation.
  - `/jobs` detail line: `${icon} ${status} · ${model} · thinking ${level}`.
  - When `<home>/workers` exists, `rt.errors` gets
    `{ name: "workers", error: "~/.japa/workers/ is no longer used: jobs have no profiles" }`.

- [ ] **Step 1: Write the failing tests:**
  - `job_start without model or thinking uses the settings`: the job conversation's configured model is
    `models.worker`, and `thinkingLevel` is `medium`.
  - `job_start with model and thinking stores and uses them`: `Job.model === "faux/x"`, `thinking === "high"`.
  - `an unknown model is refused with the list`.
  - `every job has all four coding tools and every available extension`: assert on the job agent's tool names,
    including `bash` and `write`, and an extension tool from a test extension.
  - `a stored job with worker and environment still loads`: seed `JobsDoc` and `JobDoc` with the legacy fields, then
    boot.
  - `japa check worker is refused`: the CLI usage lists only skill and extension.
  - `capabilities have no Workers section`.
  - `a leftover workers dir shows in status`.
  - `/jobs shows model and thinking`.
  - `jobs.thinking rejects an unknown level`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement and delete the profile code. `reconfigureJobs` applies `agentOf(options, job)` to each
  unfinished job.
- [ ] **Step 4:** Run the full suite (`npm test`) and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(jobs): one job type; model and thinking per job`.

### Task 8: The desktop from any job

**Files:**
- Modify:
  - `extensions/desktop/index.ts`: no `environment` contribution; the env-server code goes.
  - `extensions/desktop/lock.ts`: no `isDesktop` and no `OPERATOR`.
  - `extensions/desktop/computer.ts` and `extensions/desktop/browser.ts`: acting actions call `desktop.ready(true)`;
    the `upload` description changes.
  - `src/kernel/sandbox/remote-env.ts`: delete `isDesktop`.
- Test: `test/desktop.test.ts`, `test/desktop-computer.test.ts`, `test/desktop-browser.test.ts`,
  `test/desktop-docker.test.ts`

**Interfaces:**
- Produces:
  - `claimDesktop(api, context)`: no environment refusal.
  - While another job holds the lock, the waiting job's progress keeps the existing text `Waiting for the desktop (in
    use by job <h>)`. That already names the holder; there is no new refusal copy.
  - `upload` description: `Paths are on the desktop: put files in ~/.japa/desktop/shared and upload them from
    ~/shared/<name>.`

- [ ] **Step 1: Write the failing tests:**
  - `a job outside the container can act on the desktop`: no `OPERATOR` refusal.
  - `a second job waits while the first holds the desktop`: the progress names job 1.
  - `the desktop extension provides no environment`.
  - Delete the `OPERATOR` assertions.
- [ ] **Step 2:** Run the desktop tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the desktop tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(desktop): any job can use the desktop`.

### Task 9: Prompts, skills, docs

**Files:**
- Modify:
  - `src/kernel/jobs/worker.ts`: `WORKER_TEXT`.
  - `src/kernel/identity.md`.
  - `skills/building-extensions/SKILL.md`, `skills/building-skills/SKILL.md`, `skills/writing-job-briefs/SKILL.md`,
    `skills/choosing-a-mechanism/SKILL.md`, `skills/reporting-changes/SKILL.md`.
  - `extensions/desktop/skills/using-the-desktop/SKILL.md`.
  - `src/kernel/contracts.ts:259`: drop the profile mention.
  - `README.md`.
- Delete: `skills/building-workers/`
- Test: `test/capabilities.test.ts`, `test/content.test.ts` (text checks that exist), plus one new test in
  `test/content.test.ts`: `no packaged text mentions staging, install, worker profiles or operator jobs`. It greps
  `skills/`, `extensions/*/skills/`, `src/kernel/identity.md` and `src/kernel/jobs/worker.ts` for
  `/\.staging|staging copy|install\(|worker profile|operator job|builder job/i`, and expects no matches.

**Interfaces:**
- `WORKER_TEXT`, exact copy:

  > You are working on a job for the chief of staff. Work in the directory the brief names; if it names none and you
  > need one, ask with job_ask. Report notable progress with job_progress. When finished, call job_complete with a
  > short summary of what you did and found. If you need an answer to continue, call job_ask with one clear question.

- `identity.md` "Building": start one job with the requirement and the chosen mechanism. Its report ends with whether
  the change went live (`Live: …` or `Not live: …`). On `Live`, verify with a real use, then tell the user. On
  `Not live`, start a new job on the current version, giving it the kept path.
- Building skills: write in `~/.japa/extensions/<name>` or `~/.japa/skills/<name>`. You may run
  `japa check <kind> <name>`. Your change goes live when you finish, if the check passes.

- [ ] **Step 1:** Write the content test. Expected: FAIL (matches exist).
- [ ] **Step 2:** Rewrite the texts, delete `building-workers`, and update the README:
  - remove the worker-profile, staging and install sections and the macOS mentions;
  - add a "Jobs" paragraph on the sandbox, the clones and going live.
- [ ] **Step 3:** Run `npx vitest --run test/content.test.ts test/capabilities.test.ts`. Expected: PASS.
- [ ] **Step 4:** Commit: `docs: one job type, sandboxed, changes go live on completion`.

### Task 10: Linux only; setup checks bubblewrap

**Files:**
- Modify:
  - `src/cli/service.ts`: delete the launchd/plist code.
  - `src/cli/setup.ts`: refuse on Darwin; probe bwrap.
  - `install.sh`: refuse on Darwin.
  - `src/cli/node.ts`: no darwin assets.
- Test: `test/service.test.ts`, `test/setup.test.ts`, `test/install-sh.test.ts`, `test/node.test.ts`

**Interfaces:**
- Produces:
  - Setup on Darwin exits 1 with `japa runs on Linux only (WSL works).` `install.sh` prints the same on `Darwin`.
  - Setup on Linux, when `probeSandbox()` gives a reason, prints
    `Jobs need bubblewrap: <reason>. Install it with: sudo apt install bubblewrap` and continues (the daemon still
    runs the CoS).

- [ ] **Step 1: Write the failing tests:** setup refuses on `platform: "darwin"`; `install.sh` with `uname` stubbed to
  `Darwin` exits 1 with the message; setup prints the bubblewrap line with `JAPA_BWRAP=/nonexistent`. Delete the
  launchd tests.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement and delete the macOS paths.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: Linux only; setup checks bubblewrap`.
