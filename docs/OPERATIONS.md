# Operations

Japa is a single-process terminal backend on Pi Durable 1.0.4, not a hosted
service. Start with [README](../README.md); see [architecture](../ARCHITECTURE.md),
[contributing](../CONTRIBUTING.md), and [extensions](EXTENSIONS.md) for design,
development, and extension authoring.

## Install, run, and choose a home

Requires Node.js 24+ and npm. Run the installer from a checkout:

```sh
./install.sh --no-start
"$HOME/.local/bin/japa"
```

Without `--no-start`, installation launches only with terminal input and output.
No sudo, global npm install, daemon, or service setup is used. Add the launcher to PATH.

| Setting                | Default / precedence                                                         |
| ---------------------- | ---------------------------------------------------------------------------- |
| Application copy       | `JAPA_INSTALL_DIR`, otherwise `${XDG_DATA_HOME:-$HOME/.local/share}/japa`    |
| Launcher directory     | `JAPA_BIN_DIR`, otherwise `$HOME/.local/bin`                                 |
| Installed runtime home | Nonempty `JAPA_HOME`, otherwise `${XDG_STATE_HOME:-$HOME/.local/state}/japa` |
| Source runtime home    | `JAPA_HOME`, otherwise `./.japa`, relative to the working directory          |

The launcher remembers the install-time app location; changing `JAPA_INSTALL_DIR`
later does not relocate it. Keep application files separate from runtime state.

Source runs use the checkout and its pinned dependencies:

```sh
npm ci
JAPA_HOME="$HOME/.japa" npm start
# For an installed launcher using that same home instead:
# JAPA_HOME="$HOME/.japa" japa
```

Do not run both against the same home concurrently. Use an absolute, nonempty
`JAPA_HOME`; do not mistake a new empty home for lost history.

## Login and model settings

With no usable configuration, startup opens terminal setup before the Host.
Choose OpenAI or Anthropic and native OAuth login or hidden API-key entry.
Usable saved/environment configuration can bypass prompts. Prompts need a TTY;
OAuth may need a local browser callback or manual callback/code entry.

- `/settings` closes the running Host, opens settings under the same home lock,
  then resumes durable work when a usable configuration is returned.
- `japa --setup` or `npm start -- --setup` opens settings before startup.
- First-run setup chooses defaults. Settings offers main/worker model selection,
  login, logout, Save, and Cancel. Cancel retains a usable previous configuration;
  it cannot start an unconfigured installation.
- Saving logout when the selected roles no longer have usable credentials exits
  disconnected. Restart to log in. Logout is local, not upstream revocation;
  environment credentials still apply. Existing workers keep their chosen model,
  so removing its credentials can fail those jobs.

Model-selection precedence is independent of credential presence:

1. `JAPA_MODEL=provider/model` and `JAPA_WORKER_MODEL=provider/model` override their
   respective roles for this run, without replacing saved selections.
2. Otherwise saved roles in `settings.json` win, even if another provider's API
   key is present in the environment.
3. Without saved roles or overrides, OpenAI defaults to `gpt-5.4` for the main
   model and `gpt-5.4-mini` for workers. Anthropic defaults to `claude-sonnet-4-6`
   for both. `OPENAI_API_KEY` wins the initial provider choice when both API keys
   exist; Anthropic environment credentials select Anthropic otherwise, including
   `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN`.

The native providers use stored OAuth/API-key credentials ahead of ambient
credentials; a failed stored OAuth refresh does not silently switch to an
environment key. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` support unattended use.
Use private environment injection rather than pasting keys into shell history.

`settings.json` stores selections/installation identity; `credentials.json` stores
credentials separately. Both are atomically replaced with mode `0600`, not as one
transaction. Credentials are **plaintext**, not encrypted or in a keychain. OAuth
refresh uses Pi's credential-store protocol. Local credential availability does not
prove subscription entitlement, quota, network access, or a successful live request.

**Never put secrets in chats, worker briefs, MEMORY.md, or support reports.**
Setup input does not become a chat message; trusted workers can nevertheless read
files and environment variables accessible to the process.

## Lifecycle and scheduling

The CLI's single-home lock covers SQLite and credential refresh; only one process
may own the home. Library users must supply equivalent coordination. After a crash,
let stale-lock recovery retry; do not delete a potentially live process's lock.

Use `/exit`, Ctrl+C, or SIGTERM for orderly shutdown and wait for process exit
before maintenance. A crash/SIGKILL is not a clean backup boundary. EOF can wait
for admitted work; use `/exit` rather than assuming closing input stops immediately.
Pending native SQLite jobs and wakes resume on restart, not while stopped.
Jobs default to four active attempts and fifteen-minute deadlines; downtime
counts toward the deadline. Stopping is not the same as cancelling a job.

Wakes are one-shot absolute deadlines, with at most 32 pending. Overdue wakes are
admitted once on resume. They are silent unless notification is requested or the
assistant chooses to notify. A commitment's due date does not schedule a wake;
cancellation cannot retract an admitted wake. There is no cron recurrence, permanent
monitoring guarantee, or wake while stopped. A sleeping laptop is not always-on hosting.

Stop before reinstalling, then rerun `./install.sh` from the intended checkout.
The installer retains the previous managed app, leaves state alone, and refuses
unmanaged directories/unrelated launchers. This is not a state backup or downgrade
guarantee. Back up before upgrades and retain matching code/dependencies.

## Offline backup and nondestructive restore

Back up the **whole home**, not only `japa.sqlite`:

- Database plus any `japa.sqlite-wal`, `japa.sqlite-shm`, journal, or other sidecars.
  Never discard a WAL to make a copy look tidy.
- `workspace/`, including artifacts and hidden files.
- `extensions/` sources and bundles **together with** their manifest/replay
  receipts in the database (`japa.extensions`), not a separate manifest JSON.
- `MEMORY.md`, `settings.json`, `credentials.json`, and any other home files.

Stop Japa, confirm no process or external writer uses the home, and keep it stopped.
After a crash preserve untouched files first; do not selectively copy or manually
repair SQLite sidecars. This is an offline copy, not a live SQLite backup facility.

In a shell, replace the home path with the actual absolute path:

```sh
home="/absolute/path/to/japa-home"
umask 077
backup=$(mktemp -d "$HOME/japa-backup.XXXXXX") &&
cp -a -- "$home" "$backup/home" &&
printf 'Backup: %s\n' "$backup"
```

Check copy success before restarting. Back up outside the home and retain a
protected off-device copy for disk failure. Backups contain plaintext secrets and
history; Japa does not encrypt them. External files, external symlink targets,
environment-only credentials, and upstream services need separate recovery plans.

Record the app location, checkout revision, dependency lockfile, and Node version.
Bundles can reference absolute runtime imports; workers retain working-directory
paths. Prefer the same absolute home/app paths and matching runtime on restore.
A relocated home is not a guaranteed portable export.

For an existing home, stop Japa again and confirm exclusive offline access. Stage
an inspected backup in a fresh sibling directory, without changing the live home:

```sh
home="/absolute/path/to/japa-home"
backup="/absolute/path/to/japa-backup.XXXXXX"
umask 077
stage=$(mktemp -d "$(dirname -- "$home")/japa-restore.XXXXXX") &&
cp -a -- "$backup/home" "$stage/home"
```

Verify completeness, ownership, permissions, and sidecars. Do not start Japa against
the staged copy to inspect it: startup resumes work and may perform external actions.
After verification, retain the current home intact in a fresh rollback directory:

```sh
rollback=$(mktemp -d "$(dirname -- "$home")/japa-before-restore.XXXXXX") &&
mv -- "$home" "$rollback/home" &&
mv -- "$stage/home" "$home" &&
printf 'Previous home retained: %s\n' "$rollback/home"
```

Proceed only after each step succeeds. If placement fails, remain offline; inspect
retained directories without merging/overwriting them. Keep both old copies until verified.

**Before restarting:** review what may replay and reconcile external systems.
Rollback can reintroduce pending jobs, approvals, wakes, messages, and old OAuth
refresh tokens; re-login may be necessary. Never run original and restored copies
in parallel against the same external accounts. Delivery is at-least-once unless
a channel deduplicates keys. Shell commands and external effects are not made
exactly-once, nor undone by restoring files. Internal deduplication cannot protect
against effects whose receipts were rolled back. Safe mode is not an offline or
read-only restore verifier.

## Safe mode and extension recovery

Start with `japa --safe` or `npm start -- --safe` to skip generated-extension
restoration. Packaged tools, model calls, jobs, wakes, filesystem/shell access,
and the worker extension guide/catalog/install tools remain available. Workers
can still install new code in safe mode; durable work still resumes.

For a suspected bad extension, stop and back up. Use safe mode in a trusted/isolated
environment; ask a worker to inspect `extension_catalog` diagnostics. `active: null`
means not loaded, not uninstalled. See [extensions](EXTENSIONS.md) for repair details.

Normal startup quarantines interrupted activation and tries previous known-good
code when available. A good revision that fails startup loading is quarantined with
diagnostics, not guaranteed fallback. Safe mode skips this recovery pass; pending
installs can block installation until normal-start recovery. Runtime failures do
**not** trigger automatic rollback. Recovery never reverses migrations/external effects.

Identical accepted source returns a receipt, not reactivation/rollback; quarantined
content must be edited before retrying. Do not edit hashed bundles or prune receipts
to force activation. Limits are 32 extensions and 16 revisions each; reaching them
requires maintenance, not silent cleanup. Child probes run trusted code, not a sandbox.

## Memory maintenance

`MEMORY.md` is a reflective note limited to 6,000 characters. Oversize files/rewrites
fail without truncation. Stop Japa, preserve a copy, compact deliberately, and restart.
For revision conflicts, reread and reconcile before retrying; never resubmit stale
text blindly. Atomic replacement and in-process serialization cannot prevent every
external-editor race, so prefer offline manual editing.

Legacy `japa.memory` records migrate once when no file exists. Any existing file,
even empty, wins. If legacy import exceeds the limit, originals remain in SQLite;
create a reviewed note within the limit, or an intentionally empty file to skip
import, and restart. After migration, a missing file does not reimport old facts.
Forgetting via the memory tool can clear stale conversational context; manual
editing alone does not do that. Neither is secure erasure: transcripts, jobs,
legacy records, and backups remain. There is no comprehensive deletion facility.

## Troubleshooting

| Symptom                              | Check / next step                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `japa` not found / wrong home        | Check launcher PATH and explicit `JAPA_HOME`; installed and source defaults differ.                                                                          |
| Lock acquisition fails               | Confirm another process is not running; wait for stale-lock recovery after a crash. Never bypass a live owner.                                               |
| Setup needs a terminal               | Run interactively, or supply usable provider credentials and valid role selections before unattended startup.                                                |
| Auth/model request fails             | Check `/settings`, role environment overrides, provider entitlement/quota, and network access. A saved login is not a live validation.                       |
| Invalid settings/credentials JSON    | Startup refuses to overwrite it. Preserve the files offline and repair privately or restore a coherent backup; never paste credential contents into reports. |
| Wake did not notify / job expired    | Confirm host uptime, wake status/notification choice, and elapsed job deadline including downtime.                                                           |
| Memory startup error                 | Compact an oversize note or follow the explicit legacy-import guidance above; retain originals.                                                              |
| Extension missing or install blocked | Inspect catalog status/diagnostics in safe mode; pending recovery requires normal startup. Retain bundles and database receipts together.                    |

## Trust boundary and unsupported production features

Workers/extensions have full process privileges. Workspace is not confinement;
policy/approvals are safeguards, not isolation. Use a dedicated account/container/VM
with restricted mounts, network, and credentials. Probes do not make untrusted code safe.

There is no production multitenancy, tenant authentication/isolation, managed
background hosting, distributed failover, comprehensive cost budgeting, automatic
retention/compaction, or guaranteed scheduling SLA. Pi Durable is experimental.
Treat this as a trusted single-user backend, not an internet-facing service.
