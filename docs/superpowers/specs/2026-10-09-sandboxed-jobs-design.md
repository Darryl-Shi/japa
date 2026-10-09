# japa — sandboxed jobs: one job type, a private `~/.japa` per job, automatic going live

Date: 2026-10-09
Status: Draft for review
Amends: `2026-10-07-japa-design.md` (the "design spec") on worker profiles, staging, `install` and the job
environment; `2026-10-08-japa-computer-use-design.md` on operator jobs and the desktop environment.

## 1. Purpose

On 2026-10-09 japa on hermes stopped acting on messages. The CoS's tool calls were dropped because an install
reverted an earlier fix:

1. `a098b6e` fixed dropped tool calls in the `anthropic-sub` extension. It was committed straight to `~/.japa`
   `main`, outside staging.
2. `.staging` is created once from `main` (`ensureWorkspace`, `src/kernel/workspace.ts`) and never updated. It still
   held the pre-fix extension.
3. A builder job added prompt caching to that stale copy. `install` (`src/kernel/install.ts`) deleted the installed
   directory and copied staging over it (`b9196d4`), reverting the fix and deleting its regression tests. `check`
   passed, because the tests were overwritten along with the code.

The workspace changes without staging through several paths: hand edits, coder jobs, `rollback`, change undo,
auto-rollback and safe mode. So the stale copy and the overwrite are structural, not a one-off mistake. A second case
is waiting on hermes: `extensions/sudocode` has uncommitted edits in the workspace and a third, different version in
staging.

Worker profiles add to the problem without guarding against it:

- The rules that mattered are only in prompts. The builder's "never touch anything outside this directory" is not
  enforced: a profile's `cwd` is only a start directory, and job 50 read `~/.japa/secrets`.
- A rule that lives in one profile's prompt doesn't apply when another profile does the same work. The sudocode
  edits were made by a coder job, not a builder.
- The CoS has to choose a worker for every job, and it can get that wrong.

This spec removes worker profiles and staging. In their place it enforces the boundaries mechanically, so an agent
needs no instructions to do the right thing:

- Every job runs in a sandbox and sees its own clone of `~/.japa`.
- When the job finishes, its changes are checked and merged into the real workspace, never copied over it.

## 2. Decisions

| Question | Decision |
|---|---|
| Agent types | One. Every job has every built-in tool, every available extension and every skill. |
| Protection | Every job's `read`, `write`, `edit` and `bash` run in a bubblewrap sandbox. japa's secrets, database and socket are invisible to it. |
| Home directory | Visible and writable as for the user (git, `gh`, ssh work). Only japa's own secrets are hidden. |
| Desktop | Any job can use `computer` and `browser`, one job at a time through the existing lock. No job runs inside the container. |
| Concurrent jobs | Each job gets a private git clone of `~/.japa`, mounted at `~/.japa` inside its sandbox. |
| Going live | Automatic when the job completes: check, 3-way merge, load, log. Refused on a failed check or a conflict, never overwritten. |
| Model and thinking | Settings by default (`models.worker`, new `jobs.thinking`); the CoS may override them per job in `job_start`. |
| Platforms | Linux only (WSL included). macOS support is dropped. |

## 3. The sandbox

### 3.1 Mechanism

The desktop extension already runs a job's coding tools out of process. `extensions/desktop/env-server.ts` serves a
pi-durable `NodeExecutionEnv` over JSON lines, and `remoteEnv` in `extensions/desktop/env.ts` is its client. That
pair moves into the kernel (`src/kernel/sandbox/`).

- **Per job:** the kernel starts one `env-server` per job under `bwrap`. The job's `ExecutionEnv` is a `remoteEnv` on
  that server.
- **Nothing in the daemon process:** none of a job's file or shell operations run there.
- **The `local-env` extension:** keeps serving the CoS's read-only root environment (`createEnvDispatcher`,
  `src/kernel/env.ts`). Jobs no longer use it. The CoS can't read the secrets dirs, nor the paths hidden from jobs
  (by real path).

### 3.2 What a job sees

The `bwrap` arguments, in this order (later mounts cover earlier ones):

- `--bind / /`: the host filesystem as the user sees it.
- `--dev /dev`, plus `--unshare-pid` and `--proc /proc`: a separate process namespace. The daemon's memory,
  environment and other processes are invisible.
- `--bind D D` for the user's home and every existing directory above a protected or hidden path, wherever it is
  (`/` aside), that the user could move: one it can write, or one in a directory it can write or owns (renaming
  takes write access to the parent). E.g. `~/.config`, `~/.local/share`. So a job can't rename it away and
  recreate the path, or move a hidden one out of its mask. None under `/dev` or `/proc`: the sandbox has its own
  (pinning `/dev/shm` would bring the host's in), so a hidden path there isn't masked either.
- `--ro-bind` over the protected paths. Otherwise a job could edit code or config the daemon later runs with access
  to secrets; jobs therefore can't patch japa itself on the host.
  - The japa app directory (`~/.local/share/japa`, including its Node) and the launcher (`~/.local/bin/japa`).
  - The daemon's Node directory, by real path, first in the daemon's `PATH`: elsewhere than the app directory with
    nvm or a dev checkout. And that Node's `<prefix>/lib/node`, where `require` still looks last (see below);
    `JAPA_NODE_LIB` stands in for it in tests, so no empty mount point is left in the real prefix.
  - `$XDG_CONFIG_HOME/systemd` (the unit, drop-ins and new units), `$XDG_DATA_HOME/systemd` and
    `$XDG_CONFIG_HOME/environment.d`, both at the `$XDG_*` location and the default one.
  - A protected path that doesn't exist gets an empty read-only placeholder, so a job can't create it; not one
    inside another protected directory, nor one only root could create (`/usr/lib/node`), where bwrap couldn't
    make the mount point and a job can't create it anyway. The directories above one left out are still pinned:
    one the user can't create in (another user's, in one it can write) can't be moved away and recreated as its
    own. One that is a symlink: its target is protected and the link's directory is made read-only.
  - Git config isn't protected: the daemon's git never reads it.
- `--bind <home>/.jobs/<id>.tmp /tmp` and `/var/tmp`: a private temp dir, so tmux, screen and X11 sockets in `/tmp`
  are out of reach.
- `--bind <home>/.jobs/<id> <home>`: the job's clone in place of the real `~/.japa`. That hides the real `secrets/`,
  `state.db`, `japa.sock`, `daemon.lock` and `.git`.
- `--bind <home>/desktop/shared <home>/desktop/shared`, when the desktop extension is installed: the folder for
  exchanging files with the desktop, which is otherwise covered by the clone.
- `--ro-bind` the real `<home>/attachments` (files the user sent) and `<home>/settings.json` over the clone's: a job
  can read the user's attachments and the current settings, not change them.
- `--tmpfs` over a secrets directory whose real path is outside `~/.japa` (`settings.secrets.dir`, or
  `~/.japa/secrets` as a symlink out of it), at that real path.
- `--dev-bind /dev/null` over a storage database outside `~/.japa` (`settings.storage.file`) and its `-wal` and
  `-shm`, by real path: they read empty. (`--ro-bind` mounts it `nodev`, where `/dev/null` can't be opened.)
  - A hidden path that is or holds `~/.japa` would cover the clone: it isn't hidden, and boot reports it.
  - A sandbox doesn't start while a hidden path that existed at boot is missing (the call fails): moved away, it
    would be found nowhere to hide.
- `--tmpfs /run/user/<uid>` and `/run/screen`: hides the D-Bus session bus, the systemd user manager, ssh-agent,
  keyring and screen sockets. Otherwise `systemd-run --user` runs any command outside the sandbox.
- `--ro-bind /dev/null` over the Docker sockets that exist (`/run/docker.sock`, `/var/run/docker.sock`): Docker
  access is root access.
- `--die-with-parent`, `--new-session`.
- `--clearenv`, then `--setenv` for `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `TZ`, `TERM` from the daemon's
  environment. Provider API keys set as environment variables don't reach jobs. bwrap itself starts with only those
  (its own environment is readable inside, at `/proc/1/environ`), found through the daemon's `PATH`.

The network is shared, as now.

Consequences, accepted:
- bwrap sets `no_new_privs`, so `sudo` and other setuid programs don't work inside: jobs can't install system
  packages. Abstract unix sockets in the shared network namespace stay reachable. The rest of the home, shell startup files
  included, stays writable: the boundary covers japa's secrets and what japa itself runs, not programs the user
  later runs from his home.
- The daemon never runs a job-controlled program outside the sandbox: git commands in a clone (narrowing,
  committing) run inside the job's sandbox; the real repo only fetches from it and merges, with hooks off and no
  global git config, ignore or attributes file; the clone is made with `--no-hardlinks`; and the daemon's own `PATH` holds only system
  directories and its Node (jobs keep the original `PATH`). CommonJS `require`'s global folders are only Node's
  `<prefix>/lib/node` (read-only to jobs): at boot, and first in every CLI command (`japa check` boots the daemon's
  code too), `NODE_PATH` is unset and `Module._initPaths()` runs without
  `HOME`, so a dependency's missing optional module isn't looked for in `~/.node_modules`, `~/.node_libraries` or
  `NODE_PATH`.

### 3.3 Lifetime

- **One sandbox per job:** created on the job's first tool call (also after a restart) and closed when the job reaches a final state (`done`,
  `failed`, `cancelled`).
- **Processes:** closing the sandbox kills every process the job started (`--die-with-parent` on the server, and the
  PID namespace ends with it).
- **Waiting for input:** a job in `needs_input` keeps its sandbox.
- **Servers that should keep running:** can't be started from a job (the systemd user manager is hidden); the user
  starts them.

### 3.4 When bwrap is unavailable

- **Setup:** checks that `bwrap --ro-bind / / true` works and, if not, prints how to install it
  (`apt install bubblewrap`).
- **At boot:** the kernel runs the same probe and records the result.
- **If the probe fails:**
  - `job_start` refuses: `Jobs can't run: <reason>. Install bubblewrap: sudo apt install bubblewrap`.
  - `/status` shows the same.
  - Jobs that were running when the daemon started stay `queued` until the probe succeeds after a restart.

## 4. A private `~/.japa` per job

### 4.1 At job start

1. `git clone --local --no-hardlinks <home> <home>/.jobs/<id>` at `HEAD` (objects are copied: no shared inodes, no
   alternates). Also `<home>/.jobs/<id>.tmp`, the job's private `/tmp`. The real tree is always clean
   (§6.1), so `HEAD` is exactly what's installed. A `--local` clone holds its own objects, so it works without the
   real `.git` (hidden in the sandbox). `.jobs/` is added to the workspace `.gitignore`.
2. Create `<clone>/node_modules/japa` as `linkSdk` does for the real workspace, so `japa/sdk` imports and
   `japa check` work inside the job.
3. The starting commit is written to `<home>/.jobs/<id>.base`, outside the clone, and the clone's `origin` remote is
   removed: inside the sandbox a job could `git fetch` and move `origin/main`. The clone is made on the job's first
   tool call, so `job_start` itself writes nothing to disk.

### 4.2 While the job runs

- **Editing:** the job edits `~/.japa` like any other directory. Prompts and skills need to say nothing about how
  changes go live.
- **Checking:** `japa check <kind> <name>` works inside the job against the clone, which is useful while building.
- **Skills:** `skill_read` is an in-daemon tool and keeps reading the installed skills from the real `~/.japa`.

### 4.3 Going live

When a job's `job_complete` is accepted, its `JobRun` task runs these steps in a `publish` phase, between deciding
the report and posting it ("completing" below means that phase; `JobStatus` is unchanged). Then its report is
delivered.

1. **Narrow.** In the clone, restore every path outside `extensions/` and `skills/` to the starting commit and list them
   as dropped. If nothing is left changed, delete the clone and stop. Otherwise commit with the message
   `Job <n>: <title>` (author `japa`).
2. **Check.** For each changed `extensions/<name>` or `skills/<name>`, including deletions, run `japa check` inside
   the job's sandbox against the clone, with a 10-minute timeout per component. Any failure: nothing goes live.
3. **Merge.** Take the workspace lock (§4.4); the sandbox's job is done with the clone by now, and §3.3 closes the
   sandbox only after these steps. In the real repo, `git fetch <clone> HEAD`, then
   `git merge --no-ff -m "Job <n>: <title>" FETCH_HEAD`.
   - Git merges against the starting commit, so changes made to `main` since the job started are kept.
   - On a conflict: `git merge --abort`, report the conflicting paths, nothing changes.
4. **Load.** Reconcile.
   - If a changed component fails to load: `git revert -m 1` the merge commit, reconcile again, and report the load
     errors.
   - Changes to boot-phase extensions (storage, secrets) still need a restart, as now. The report says so.
5. **Log.** One change, titled `Job <n>: changed extensions/x, skills/y`, with `undo.commits = [merge sha]`. Then
   `scheduleGood`, as `install` does today.
6. **Release** the lock. Delete the clone after success. Keep it after a failed check, a conflict or a load failure.

### 4.4 The workspace lock

One in-process mutex serialises everything that changes the real `~/.japa`:

- going live (§4.3, steps 3–5);
- `rollback`;
- change undo;
- auto-rollback;
- safe mode;
- the boot-time adoption of edits made outside japa (§6.1).

### 4.5 What the CoS is told

The job's report (`[job <n> "<title>" done] …`) ends with exactly one outcome line, written by the kernel:

| Outcome | Line |
|---|---|
| Nothing changed | *(no line)* |
| Live | `Live: extensions/anthropic-sub, skills/x (change 17).` plus `Dropped: settings.json.` when relevant |
| Check failed | `Not live: check failed for extensions/x: <problems>. Kept at ~/.japa/.jobs/<id>.` |
| Conflict | `Not live: extensions/x/index.ts changed since this job started. Kept at ~/.japa/.jobs/<id>.` |
| Load failure | `Not live: extensions/x failed to load: <error>. Reverted. Kept at ~/.japa/.jobs/<id>.` |

On a "Not live" result, the CoS starts a new job on the current version and passes the kept clone's path in the
brief.

### 4.6 Clean-up

- **Clones kept after a failure:** those of jobs that ended `failed` or `cancelled`, or that didn't go live, are
  kept for 7 days.
- **Pruning:** at boot and with the hourly job pruning, japa deletes kept clones older than that, and orphaned clones (no matching job).

## 5. One kind of job

### 5.1 `job_start`

```
job_start({ title, brief, model?, thinking? })
```

- **`model`:** `"<provider>/<modelId>"`. It defaults to `models.worker`, falling back to `models.cos`. An unknown
  or unavailable model is refused with the list of available ones.
- **`thinking`:** `off | minimal | low | medium | high | xhigh`. It defaults to the new setting `jobs.thinking`
  (default `medium`), which can be edited from the Settings menu next to the models.
- **On the job:** both are stored (`Job.model`, `Job.thinking`). `/jobs` shows them where it showed the worker.
- **`worker`:** the argument is removed.

### 5.2 What every job gets

- **Tools:** `read`, `write`, `edit`, `bash`, the job tools (`job_progress`, `job_ask`, `job_complete`), the skills
  tools and the safety extension.
- **Extensions:** every available extension (`available()` in `src/kernel/runtime.ts`), re-applied on availability
  changes as `reconfigureJobs` does now.
- **Skills:** all of them. The per-job skill filter (`JobDoc.skills`) is removed.

### 5.3 Instructions

- **The worker prompt:** `WORKER_TEXT` (`src/kernel/jobs/worker.ts`) is the only prompt for jobs. It absorbs the
  general guidance from the `coder` and `general` profiles:
  - work in the directory the brief names; if it names none, ask with `job_ask`;
  - report progress on long work;
  - finish with `job_complete` and a short result that states what was done and found.
- **Role guidance moves into skills:**
  - Operating the desktop: `extensions/desktop/skills/using-the-desktop`, updated with the operator profile's
    guidance.
  - Research: the existing `research` skill.
  - Building: `building-extensions` and `building-skills`, rewritten. Write in `~/.japa/extensions/<name>` or
    `~/.japa/skills/<name>`, optionally run `japa check`, and the change goes live when the job finishes if it
    passes. No mention of staging, `install` or `../node_modules`.

### 5.4 The CoS

- **`identity.md`:**
  - "Jobs and workers" no longer mentions profiles.
  - "Building" becomes: start a job with the requirement; its report says whether the change went live; verify with
    a real use, then tell the user.
  - The ladder loses the worker-profile rung.
- **`install` tool:** removed. `rollback` stays, for `skill` and `extension`.
- **Skills:**
  - `writing-job-briefs` loses "Choosing the worker" and "one builder at a time".
  - `choosing-a-mechanism` loses its profile example.
  - `reporting-changes` refers to the outcome line instead of `install`.
  - `building-workers` is deleted.
- **Capabilities section** (`src/kernel/capabilities.ts`): loses its "Workers:" list.

### 5.5 Removed

- **Profiles:** the packaged `workers/` directory, profile loading and `profileError` in `src/kernel/workers.ts`
  (`parseFrontmatter` stays and moves to `frontmatter.ts`), `runtime.profiles`, and `Job.worker` lookups in
  `reconfigureJobs`.
- **Worker checks:** `japa check worker` and `checkWorker`. `CHECK_KINDS` becomes `["skill", "extension"]`.
- **Staging:** the `.staging` worktree creation in `ensureWorkspace` and the copy-based install in
  `src/kernel/install.ts`.
- **The desktop environment adapter:** the job-facing `environment: [desktop]` contribution.
  - Also `isDesktop` and the operator refusal in `extensions/desktop/lock.ts`.
  - `claimDesktop` now refuses only when another job holds the lock, and names that job.
  - The acting actions of `computer` and `browser` wait for the desktop image (`desktop.ready(true)`), as operator jobs
    do now. Read-only actions keep their current behaviour.
- **macOS:** the launchd service code in `src/cli/service.ts`, the macOS branches of `install.sh` and
  `src/cli/node.ts`, and the macOS parts of the README.
  - Setup and the installer refuse on Darwin, with a clear message.

### 5.6 The desktop from a host job

- **Browser uploads:** `browser`'s `upload` takes paths on the desktop. Its description and the desktop skill say to
  put files in `~/.japa/desktop/shared` (visible in the container as `~/shared`) and upload from `~/shared/...`.
- **Screenshots and downloads:** these already land in the shared folder or come back as images. That doesn't
  change.

## 6. The real `~/.japa`

### 6.1 Always clean

Only these change the real `extensions/` and `skills/` (the components the daemon loads), each under the workspace
lock, each ending in a commit. `settings.json` keeps changing through the settings tools, as now:

- going live;
- `rollback`;
- change undo;
- auto-rollback;
- safe mode.

At every boot, before loading anything:

1. If `MERGE_HEAD` or `REVERT_HEAD` exists, abort that operation.
2. If `extensions/` or `skills/` has uncommitted changes (edits made by hand or by an older version), commit
   them as `Edits made outside japa` and log a change for it. They are what was running, because the daemon loaded
   the working tree.

The daemon keeps loading components from the real working tree (with the existing `cachedCopy` for extension
imports). Since that tree only ever holds installed commits, what's loaded is always what's committed.

### 6.2 Upgrade

On the first boot of this version:

1. **Archive staging:** move `.staging`'s untracked contents to `.jobs/staging-archive/`, kept 7 days and then
   pruned.
2. **Retire staging:** run `git worktree remove --force .staging` and `git branch -D staging`.
3. **Adopt hand edits:** run §6.1. On hermes this commits the uncommitted `extensions/sudocode` edits.
4. **Old job records:** `Job.worker` and `JobDoc.environment`/`skills` in stored documents are tolerated and
   ignored.
5. **Resumed jobs:** a job resumed after the upgrade gets its clone and sandbox on its next tool call, starting from
   the current `HEAD`.
6. **Leftover profiles:** a leftover `~/.japa/workers/` is ignored. `/status` notes that it's no longer used while it exists.

## 7. Failures

| Failure | Behaviour |
|---|---|
| bwrap missing or broken | `job_start` refuses with how to fix it; `/status` shows it (§3.4). |
| Clone fails | The job's first tool call fails with the reason; the next call tries again. |
| Sandbox server dies mid-job | The tool call in flight fails with "The job's sandbox stopped: <last stderr line>"; the next call starts a new sandbox on the same clone (background processes are gone). |
| Daemon crash while going live | At boot an unfinished merge is aborted (§6.1). The job's `JobRun` resumes its `publish` phase and runs §4.3 again. If its commit is already an ancestor of `HEAD`, the merge is skipped and it goes on to load and report. |
| `check` hangs | A 10-minute timeout per component counts as a failed check. |
| Going live while rolling back or undoing | Serialised by the workspace lock. |

## 8. Testing

**Sandbox** (Linux with bwrap; skipped only where the probe fails). Every check is made from inside a job:

- `~/.japa/secrets`, `state.db`, `japa.sock` and the real `.git` don't exist.
- `~/.japa` is the clone.
- The app directory, launcher and service unit can't be written.
- `/proc` shows no daemon.
- The environment is exactly the minimal set.
- The network works, and `~/.japa/desktop/shared` is the real shared folder.
- A background process started by the job is gone after the job ends.

**Going live:**

- No changes: no clone left, no outcome line.
- A changed extension and a changed skill go live in one merge commit, one logged change, and undo reverts both.
- A change to `settings.json` is dropped and reported.
- A failed check leaves `main` unchanged and the clone kept.
- A load failure reverts the merge and reports it.
- A crash between merge and load recovers at the next boot.
- **Today's bug, as a regression test:** job A starts; a fix to extension X lands on `main`. A changes a different
  part of X, and both changes are live. In a second case, A changes the same lines: the merge is refused, naming the
  conflicting file, and `main` is unchanged.
- Rollback and undo during going live are serialised.

**One job type:**

- `job_start` works without `model`/`thinking` (settings used) and with them (stored, used, shown in `/jobs`).
- An unknown model is refused with the list.
- A job has all four built-in tools, every available extension and every skill.
- A job not in the container can drive the browser, and is refused while another job holds the desktop (the
  refusal names that job).

**Upgrade:**

- `.staging` is archived and removed, and the `staging` branch deleted.
- A dirty tree is committed and logged.
- Stored jobs with `worker`/`environment` load.
- A leftover `workers/` directory shows the `/status` note.
- Setup refuses on Darwin.

## 9. Out of scope

- Confining the home directory or the network beyond §3.2.
- Merging changes outside `extensions/` and `skills/` (settings changes go through the settings tools).
- Hot reload when files under `~/.japa` change by hand. Those edits are adopted at the next boot, as now.
